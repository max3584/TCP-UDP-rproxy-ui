import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { RproxyError, getAcme, withNode } from '@/components/rproxy';
import { loadNodes, probeNode } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { ACME_NOT_CONFIGURED, acmeInfoFromRproxy } from '@/components/acme';
import { localizedApi } from '@/i18n/server';

// rproxy の ACME の resolver・アカウント・DNS のプロバイダの名前と許可する名前、証明書の状態（GET /acme）。
// 画面に要るものだけを返す（acmeInfoFromRproxy。秘密は rproxy も返さない）。
// rproxy に global.acme がない（404）・ACME を知らない古い rproxy（404）なら configured: false
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    // ノードを設定していれば ?target= のノード（グループなら先頭のノード）に聞く
    const node = probeNode(loadNodes(), typeof req.query.target === 'string' ? req.query.target : undefined);
    const raw = node ? await withNode(node, () => getAcme()) : await getAcme();
    const info = acmeInfoFromRproxy(raw);
    return res.status(200).json(info);
  } catch (err) {
    if (err instanceof RproxyError && err.status === 404) {
      return res.status(200).json(ACME_NOT_CONFIGURED);
    }
    Logger('info', { action: 'acme' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
