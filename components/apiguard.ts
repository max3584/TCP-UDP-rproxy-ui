// API route で共通の確認（サインインとロール）と、rproxy のエラーの返し方。サーバ側だけで使う

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import type { sessionUser } from './lib';
import { NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE, lockedOutText } from './messages';
import { accessOf, roleConfig } from './roles';
import { RproxyError } from './rproxy';

// ほかのサイトからの状態を変える要求（CSRF）を断る（セキュリティレビュー L2。SameSite=Lax の cookie に加えた多層防御）。
// GET / HEAD / OPTIONS は見ない。ブラウザの要求なら Sec-Fetch-Site が same-origin（か none）で、Origin（なければ Referer）の
// host が要求の Host・X-Forwarded-Host・NEXTAUTH_URL のどれかと同じでなければならない。どちらのヘッダもない要求（curl など、
// ブラウザでないもの）は通す（cookie を勝手に付けられるのはブラウザだけ）
export const CROSS_SITE_MESSAGE = 'ほかのサイトからの変更の要求は受け付けません。この画面を開き直してから操作してください。';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

export function isCrossSiteRequest(req: Pick<NextApiRequest, 'method' | 'headers'>, env: Record<string, string | undefined> = process.env): boolean {
  if (SAFE_METHODS.has(String(req.method ?? 'GET').toUpperCase())) return false;
  const h = req.headers ?? {};
  const site = headerValue(h['sec-fetch-site']).toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') return true;
  const origin = headerValue(h.origin);
  if (origin.toLowerCase() === 'null') return true;
  const source = origin || headerValue(h.referer);
  if (source === '') return false;
  let host: string;
  try {
    host = new URL(source).host.toLowerCase();
  } catch {
    return true;
  }
  const allowed = new Set<string>();
  const add = (v: string) => { if (v) allowed.add(v.toLowerCase()); };
  add(headerValue(h.host));
  add(headerValue(h['x-forwarded-host']).split(',')[0].trim());
  try {
    if (env.NEXTAUTH_URL) add(new URL(env.NEXTAUTH_URL).host);
  } catch {
    // NEXTAUTH_URL が読めなければ Host だけで比べる
  }
  return !allowed.has(host);
}

// 状態を変える要求がほかのサイトからなら 403 csrf を返して true
export function rejectCrossSite(req: NextApiRequest, res: NextApiResponse): boolean {
  if (!isCrossSiteRequest(req)) return false;
  res.status(403).json({ error: CROSS_SITE_MESSAGE, code: 'csrf' });
  return true;
}

// サインインしていて rproxy-user / rproxy-admin のロールがあれば session を返す。なければ応答を返して null。
// 状態を変える要求（POST など）は、ほかのサイトからなら 403 csrf
export async function requireRole(req: NextApiRequest, res: NextApiResponse): Promise<sessionUser | null> {
  if (rejectCrossSite(req, res)) return null;
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
  if (err instanceof RproxyError && err.status === 429) {
    return { error: lockedOutText(err.retryAfter), code: 'rproxy_locked_out' };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof RproxyError ? err.code : 'internal',
  };
}
