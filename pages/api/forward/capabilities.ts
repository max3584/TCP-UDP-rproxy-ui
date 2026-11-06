import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getCapabilities, withNode } from '@/components/rproxy';
import { requireRole, rproxyFailure, viewerProbe } from '@/components/apiguard';
import { localizedApi } from '@/i18n/server';
import { connectTimeoutRestore } from '@/components/restorable';
import type { PlacementRestore } from '@/components/restorable';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    // ノードを設定していれば ?target= のノード（グループなら先頭のノード）に聞く。利用者は RPROXY_UI_USER_NODES の内だけ
    // （見るだけの Kubernetes の rproxy も外す。#164）
    const probe = viewerProbe(session, req.query.target);
    if (!probe.ok) return res.status(probe.status).json(probe.body);
    const node = probe.node;
    const capabilities = node ? await withNode(node, () => getCapabilities()) : await getCapabilities();
    // グループ（ノードが 2 つ以上）なら、connect_timeout を UI の DB から戻せるかを置き場所のすべてのノードで確かめる（UI #184。
    // 1 台でも戻せない・聞けないノードがあれば、フォームは欄を読み取り専用にする）。ほかのノードは並べて聞く
    if (probe.placement.length > 1 && capabilities.features?.db_connect_timeout === true) {
      const rest = probe.placement.filter((n) => n.name !== node?.name);
      const check = await connectTimeoutRestore(rest, rest.map((n) => n.name));
      const placement: PlacementRestore = {
        nodes: probe.placement.map((n) => n.name),
        db_connect_timeout: check.lacking.length === 0 && check.unreachable.length === 0,
        lacking: check.lacking,
        unreachable: check.unreachable,
      };
      return res.status(200).json({ ...capabilities, placement: placement });
    }
    return res.status(200).json(capabilities);
  } catch (err) {
    Logger('info', { action: 'capabilities' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
