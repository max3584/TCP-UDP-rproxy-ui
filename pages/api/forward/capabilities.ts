import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getCapabilities, withNode } from '@/components/rproxy';
import { loadNodes, probeNode } from '@/components/nodes';
import { requireRole, rproxyFailure } from '@/components/apiguard';
import { localizedApi } from '@/i18n/server';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    // ノードを設定していれば ?target= のノード（グループなら先頭のノード）に聞く
    const node = probeNode(loadNodes(), typeof req.query.target === 'string' ? req.query.target : undefined);
    const capabilities = node ? await withNode(node, () => getCapabilities()) : await getCapabilities();
    return res.status(200).json(capabilities);
  } catch (err) {
    Logger('info', { action: 'capabilities' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
