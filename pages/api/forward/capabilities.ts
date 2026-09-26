import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@/components/lib';
import { getCapabilities } from '@/components/rproxy';
import { requireRole, rproxyFailure } from '@/components/apiguard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireRole(req, res))) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    const capabilities = await getCapabilities();
    return res.status(200).json(capabilities);
  } catch (err) {
    Logger('info', { action: 'capabilities' }).error(`rproxy error: ${err}`);
    return res.status(502).json(rproxyFailure(err));
  }
}
