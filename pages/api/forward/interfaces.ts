import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { Logger } from '@/components/lib';
import { RproxyError, getInterfaces } from '@/components/rproxy';

// rproxy のホストのインターフェース（待ち受けアドレスの候補）と、rproxy 自身が使うアドレス
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  try {
    const info = await getInterfaces();
    return res.status(200).json(info);
  } catch (err) {
    Logger('info', { action: 'interfaces' }).error(`rproxy error: ${err}`);
    const code = err instanceof RproxyError ? err.code : 'internal';
    const message = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: message, code: code });
  }
}
