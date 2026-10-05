// GET /api/forward/ha/ready?node=<ノード>（#109）：そのノードが昇格してよいか（そのノードを含む active_standby のグループの
// ルールが、すべてそのノードで DB の定義どおりに動いているか）。揃っていれば 200、揃っていなければ 503（中身つき）。
// keepalived の track_script（contrib/keepalived/rproxy-ui-ready.sh）が見る。認証は RPROXY_UI_HA_TOKEN_FILE のトークン
import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { loadNodes } from '@/components/nodes';
import { checkHaToken } from '@/components/hatoken';
import { nodeReadiness } from '@/components/hasync';
import { localizedApi } from '@/i18n/server';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  const auth = checkHaToken(req.headers.authorization);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  const logger = Logger('info', { action: 'ha-ready' });
  try {
    const cfg = loadNodes();
    const node = typeof req.query.node === 'string' ? req.query.node : '';
    if (!cfg.configured || !cfg.nodes.some((n) => n.name === node)) {
      return res.status(400).json({ error: `ノード ${node} は設定にありません。`, code: 'unknown_node' });
    }
    const readiness = await nodeReadiness(cfg, node, logger);
    return res.status(readiness.ready ? 200 : 503).json(readiness);
  } catch (err) {
    // 500 は「揃っていない」ではない（スクリプトは 503 のときだけ優先度を下げる）
    logger.error(`揃っているかを確かめられません: ${err}`);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal' });
  }
}

export default localizedApi(handler);
