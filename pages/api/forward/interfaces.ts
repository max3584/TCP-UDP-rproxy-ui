import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getInterfaces } from '@/components/rproxy';
import { requireRole, rproxyFailure } from '@/components/apiguard';

// rproxy のホストのインターフェース（待ち受けアドレスの候補）と、rproxy 自身が使うアドレス
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    const info = await getInterfaces();
    return res.status(200).json(info);
  } catch (err) {
    Logger('info', { action: 'interfaces' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}
