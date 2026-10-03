import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { RproxyError, getConfigStatus } from '@/components/rproxy';
import { requireRole } from '@/components/apiguard';
import { configStatusView } from '@/components/dashboard';

// rproxy の設定ファイルの状態（GET /config）。ダッシュボードの注意の表示に使う。
// UI のトークンで読めない（403）・古い rproxy（404）・設定ファイルを使っていない・rproxy に届かないときは
// 何も出さない（{"show": false}）。ダッシュボードの表示を止めないように、失敗しても 200 で返す
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    const status = await getConfigStatus();
    return res.status(200).json(configStatusView(status));
  } catch (err) {
    const quiet = err instanceof RproxyError && (err.status === 403 || err.status === 404);
    if (!quiet) Logger('info', { action: 'config' }).warn(`rproxy の設定ファイルの状態を取得できません: ${err}`);
    return res.status(200).json(configStatusView(null));
  }
}
