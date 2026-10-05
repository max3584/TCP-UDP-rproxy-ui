import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getInterfaces, withNode } from '@/components/rproxy';
import { loadNodes, probeNode } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { localizedApi } from '@/i18n/server';

// rproxy のホストのインターフェース（待ち受けアドレスの候補）と、rproxy 自身が使うアドレス
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    // ノードを設定していれば ?target= のノード（グループなら先頭のノード）に聞く
    const node = probeNode(loadNodes(), typeof req.query.target === 'string' ? req.query.target : undefined);
    const info = node ? await withNode(node, () => getInterfaces()) : await getInterfaces();
    return res.status(200).json(info);
  } catch (err) {
    Logger('info', { action: 'interfaces' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
