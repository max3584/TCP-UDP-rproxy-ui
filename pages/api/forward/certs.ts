import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { RproxyError, listCerts, withNode } from '@/components/rproxy';
import { NodesConfigError, loadNodes, probeNode, targetNodes, visibleNodes } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { accessOf, nodesAllowed, roleConfig } from '@/components/roles';
import { certAllowed } from '@/components/userlimits';
import { localizedApi } from '@/i18n/server';

// rproxy の証明書の API に登録した証明書（GET /certs。rproxy-api v0.4.2、#155）。フォームの「登録済みの証明書」の選択肢。
// 名前・名前の一覧（sans）・期限だけを返す（鍵は rproxy も返さない）。利用者には RPROXY_UI_USER_CERTS の名前だけ。
// 読めない（UI のトークンに certs:read がない 403・古い rproxy の 404）ときは 200 の available: false
export interface CertsInfo {
  available: boolean;
  certs: { name: string; sans: string[]; not_after: string | null }[];
}

export function certsFromRproxy(raw: unknown, prefixes: string[] | null): CertsInfo['certs'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).name === 'string')
    .filter((c) => certAllowed(String(c.name), prefixes))
    .map((c) => ({
      name: String(c.name),
      sans: Array.isArray(c.sans) ? c.sans.filter((n): n is string => typeof n === 'string') : [],
      not_after: typeof c.not_after === 'string' ? c.not_after : null,
    }));
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    const roles = roleConfig();
    const admin = accessOf(session.user.roles ?? [], roles) === 'admin';
    // ノードを設定していれば ?target= のノード（グループなら先頭のノード）に聞く。利用者は RPROXY_UI_USER_NODES のノードだけ
    // （見るだけの Kubernetes の rproxy も外す）
    const cfg = visibleNodes(loadNodes(), admin);
    const target = typeof req.query.target === 'string' && req.query.target !== '' ? req.query.target : undefined;
    let node;
    try {
      node = probeNode(cfg, target);
    } catch (err) {
      if (err instanceof NodesConfigError) return res.status(400).json({ error: err.message, code: 'unknown_target' });
      throw err;
    }
    if (!admin && cfg.configured) {
      const name = target ?? cfg.defaultTarget ?? cfg.nodes[0]?.name ?? '';
      const members = (targetNodes(cfg, name) ?? []).map((n) => n.name);
      if (!nodesAllowed('user', roles, members)) {
        return res.status(403).json({ error: `ノード ${members.join(', ')} は管理者だけが触れます。`, code: 'node_not_allowed' });
      }
    }
    const raw = node ? await withNode(node, () => listCerts()) : await listCerts();
    const info: CertsInfo = { available: true, certs: certsFromRproxy(raw, admin ? null : roles.userCerts) };
    return res.status(200).json(info);
  } catch (err) {
    if (err instanceof RproxyError && (err.status === 403 || err.status === 404)) {
      return res.status(200).json({ available: false, certs: [] } satisfies CertsInfo);
    }
    Logger('info', { action: 'certs' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
