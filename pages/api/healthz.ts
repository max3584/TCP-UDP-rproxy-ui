import type { NextApiRequest, NextApiResponse } from 'next';

// liveness・readiness のプローブ（Kubernetes の chart。docs/KUBERNETES.md）。サインインは要らない。
// 中身は {"ok":true} だけ（版も出さない）。DB・rproxy には聞かない（DB の失敗で全レプリカが同時にサービスから外れないように）
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false });
  }
  return res.status(200).json({ ok: true });
}
