import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { requireRole } from '@/components/apiguard';
import { loadNodes, visibleNodes } from '@/components/nodes';
import { accessOf, roleConfig } from '@/components/roles';
import { versionsView } from '@/components/versioncheck';
import { localizedApi } from '@/i18n/server';

// UI の版と、各ノードの rproxy-api の版（GET /capabilities の version。#106）。サイドバーとダッシュボードに出す。
// ノードに問い合わせできなくても 200 で返す（そのノードは reachable: false。ダッシュボードの表示を止めない）
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }
  try {
    // Kubernetes の rproxy（見るだけ）は管理者だけ
    const view = await versionsView(visibleNodes(loadNodes(), accessOf(session.user.roles ?? [], roleConfig()) === 'admin'));
    return res.status(200).json(view);
  } catch (err) {
    // RPROXY_UI_NODES の誤りなど（起動時に止まるので、ふつうは来ない）
    Logger('info', { action: 'versions' }).error(`versions: ${err}`);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal' });
  }
}

export default localizedApi(handler);
