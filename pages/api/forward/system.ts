import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getCapabilities, getConfigStatus, withNode } from '@/components/rproxy';
import type { Capabilities, RproxyConfigStatus } from '@/components/rproxy';
import { loadNodes, toRproxyNode } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { accessOf, nodesAllowed, roleConfig } from '@/components/roles';
import { nodeSystemView, userSystemView } from '@/components/system';
import { localizedApi } from '@/i18n/server';

// rproxy の機能と設定（読み取り専用。/system の画面）。各ノードの GET /capabilities と GET /config をまとめる。
// 問い合わせできないノードがあっても 200（そのノードは reachable: false）。GET /config を読めない（403 / 404）ときは config.readable: false
// 管理者でなければ、設定ファイルのパス・誤り・バイナリのハッシュ・通信の失敗の文を省き（userSystemView）、
// RPROXY_UI_USER_NODES で絞った利用者には触れるノードだけを返す
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }
  const logger = Logger('info', { action: 'system' });
  let cfg;
  try {
    cfg = loadNodes();
  } catch (err) {
    logger.error(`${err}`);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'nodes_config' });
  }
  const one = async (name: string, run: <T>(fn: () => Promise<T>) => Promise<T>) => {
    let caps: Capabilities | null = null;
    let error: string | null = null;
    try {
      caps = await run(() => getCapabilities());
    } catch (err) {
      error = rproxyFailure(err).error;
    }
    let config: RproxyConfigStatus | null = null;
    if (caps) {
      try {
        config = await run(() => getConfigStatus());
      } catch (err) {
        logger.warn(`rproxy（${name}）の設定ファイルの状態を取得できません: ${err}`);
      }
    }
    return nodeSystemView(name, caps, config, error);
  };
  const roles = roleConfig();
  const access = accessOf(session.user.roles ?? [], roles);
  const admin = access === 'admin';
  const visible = cfg.configured ? cfg.nodes.filter((n) => nodesAllowed(access, roles, [n.name])) : cfg.nodes;
  const nodes = cfg.configured
    ? await Promise.all(visible.map((n) => one(n.name, (fn) => withNode(toRproxyNode(n), fn))))
    : [await one(cfg.nodes[0].name, (fn) => fn())];
  return res.status(200).json({ nodes: admin ? nodes : nodes.map(userSystemView), ...(admin ? { admin: true } : {}) });
}

export default localizedApi(handler);
