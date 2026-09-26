// API route で共通の確認（サインインとロール）と、rproxy のエラーの返し方。サーバ側だけで使う

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import type { sessionUser } from './lib';
import { NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE } from './messages';
import { accessOf, roleConfig } from './roles';
import { RproxyError } from './rproxy';

// サインインしていて rproxy-user / rproxy-admin のロールがあれば session を返す。なければ応答を返して null
export async function requireRole(req: NextApiRequest, res: NextApiResponse): Promise<sessionUser | null> {
  const session = (await getServerSession(req, res, authOptions)) as sessionUser | null;
  if (!session?.user?.id) {
    res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
    return null;
  }
  if (accessOf(session.user.roles ?? [], roleConfig()) === 'none') {
    res.status(403).json({ error: NO_ROLE_MESSAGE, code: 'no_role' });
    return null;
  }
  return session;
}

// rproxy への問い合わせの失敗は 502。rproxy の 401 は UI のトークンの問題なので code を rproxy_unauthorized にする
export function rproxyFailure(err: unknown): { error: string; code: string } {
  if (err instanceof RproxyError && err.status === 401) {
    return { error: RPROXY_UNAUTHORIZED_MESSAGE, code: 'rproxy_unauthorized' };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof RproxyError ? err.code : 'internal',
  };
}
