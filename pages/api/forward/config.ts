import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { RproxyError, getConfigStatus, withNode } from '@/components/rproxy';
import { requireRole } from '@/components/apiguard';
import { configStatusView, mergeConfigStatusViews } from '@/components/dashboard';
import { loadNodes, toRproxyNode } from '@/components/nodes';
import { accessOf, nodesAllowed, roleConfig } from '@/components/roles';
import { SYSTEM_CONFIG_ERROR_HIDDEN } from '@/components/system';
import type { ConfigStatusView } from '@/components/dashboard';
import { localizedApi } from '@/i18n/server';

// 1 台の設定ファイルの状態。読めない（403 / 404 / 届かない）ときは何も出さない形
async function statusView(fetchStatus: () => ReturnType<typeof getConfigStatus>, node?: string) {
  try {
    return configStatusView(await fetchStatus());
  } catch (err) {
    const quiet = err instanceof RproxyError && (err.status === 403 || err.status === 404);
    if (!quiet) Logger('info', { action: 'config' }).warn(`rproxy${node ? `（${node}）` : ''} の設定ファイルの状態を取得できません: ${err}`);
    return configStatusView(null);
  }
}

// rproxy の設定ファイルの状態（GET /config）。ダッシュボードの注意の表示に使う。
// UI のトークンで読めない（403）・古い rproxy（404）・設定ファイルを使っていない・rproxy に届かないときは
// 何も出さない（{"show": false}）。ダッシュボードの表示を止めないように、失敗しても 200 で返す。
// ノードを設定していれば全ノードに聞き、注意のあるノードを「ノード名: 」付きで 1 つにまとめる（#98）
// 管理者でなければ、設定ファイルのパスと誤りの中身を省き（誤りがあることだけ）、RPROXY_UI_USER_NODES の外のノードは聞かない（セキュリティレビュー M3）
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  const roles = roleConfig();
  const access = accessOf(session.user.roles ?? [], roles);
  const forUser = (v: ConfigStatusView): ConfigStatusView => (access === 'admin' ? v : { ...v, path: null, error: v.error !== null ? SYSTEM_CONFIG_ERROR_HIDDEN : null });
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  let cfg;
  try {
    cfg = loadNodes();
  } catch (err) {
    Logger('info', { action: 'config' }).error(`${err}`);
    return res.status(200).json(configStatusView(null));
  }
  if (!cfg.configured) {
    const view = await statusView(() => getConfigStatus());
    return res.status(200).json(forUser(view));
  }
  const nodes = cfg.nodes.filter((n) => nodesAllowed(access, roles, [n.name])).map(toRproxyNode);
  const views = await Promise.all(nodes.map(async (node) => ({
    node: node.name,
    view: await statusView(() => withNode(node, () => getConfigStatus()), node.name),
  })));
  const merged = mergeConfigStatusViews(views.map((v) => ({ node: v.node, view: forUser(v.view) })));
  return res.status(200).json(merged);
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
