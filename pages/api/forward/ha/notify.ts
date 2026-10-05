// POST /api/forward/ha/notify?node=<ノード>&state=MASTER（#109）：keepalived の notify_master（contrib/keepalived/rproxy-ui-notify.sh）が、
// そのノードが昇格した直後に呼ぶ。そのノードを含む active_standby のグループのずれ・未登録をすぐ送り直す（auto_resend に関係なく。
// 履歴は RESEND、操作者は system）。MASTER 以外の state は何もしない。認証は RPROXY_UI_HA_TOKEN_FILE のトークン
import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { loadNodes } from '@/components/nodes';
import { checkHaToken } from '@/components/hatoken';
import { SYSTEM_ACTOR, syncNode } from '@/components/hasync';
import { localizedApi } from '@/i18n/server';

function param(req: NextApiRequest, name: string): string {
  const q = req.query[name];
  if (typeof q === 'string') return q;
  const b = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>)[name] : undefined;
  return typeof b === 'string' ? b : '';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  const auth = checkHaToken(req.headers.authorization);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  const logger = Logger('info', { action: 'ha-notify' });
  try {
    const cfg = loadNodes();
    const node = param(req, 'node');
    if (!cfg.configured || !cfg.nodes.some((n) => n.name === node)) {
      return res.status(400).json({ error: `ノード ${node} は設定にありません。`, code: 'unknown_node' });
    }
    const st = (param(req, 'state') || 'MASTER').toUpperCase();
    if (st !== 'MASTER') return res.status(200).json({ node: node, state: st, results: [] });
    logger.info(`ノード ${node} が昇格したので、すぐ送り直します`);
    const out = await syncNode(cfg, node, { onlyAuto: false, actor: SYSTEM_ACTOR, logger: logger });
    return res.status(200).json({ node: node, state: st, ready: out.results.every((r) => r.result !== 'error') && out.readiness.issues.every((i) => i.state !== 'unknown'), results: out.results });
  } catch (err) {
    logger.error(`昇格したノードに送り直せませんでした: ${err}`);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal' });
  }
}

export default localizedApi(handler);
