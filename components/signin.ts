// 画面からサインインを始める（RequireAuth・ヘッダー・Profile）。#179。
// トークンでのサインインが使える（RPROXY_UI_AUTH=token・both）なら UI のサインインのページ（pages/signin.tsx。
// signIn() が /api/auth/signin に移り、NextAuth が pages.signIn に移す）、Keycloak だけなら今までどおり Keycloak へ
import { getProviders, signIn } from 'next-auth/react';

export async function startSignIn(): Promise<void> {
  const providers = await getProviders();
  if (providers && 'token' in providers) {
    await signIn();
    return;
  }
  await signIn('keycloak');
}

// サインインのあとに戻る先。同じサイトのパスだけ（ほかのサイトへ移す罠にしない）。読めなければ /。
// バックスラッシュ・制御文字を含むもの、正規化したあとに // や /\ で始まるもの（/.//evil.example・/%2e//evil.example など。
// ブラウザはプロトコル相対の URL としてほかのサイトへ移る）も / にする
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

export function safeCallbackUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value === '' || UNSAFE_CHARS.test(value)) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return '/';
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || UNSAFE_CHARS.test(path)) return '/';
    return path;
  } catch {
    return '/';
  }
}

// POST /api/auth/callback/token の応答から、画面に出す結果
export type TokenSignInResult =
  | { kind: 'ok'; url: string }
  | { kind: 'invalid' }
  | { kind: 'locked'; retryAfter: number }
  | { kind: 'csrf' }
  | { kind: 'error'; status: number };

export function tokenSignInResult(status: number, body: unknown, retryAfterHeader: string | null): TokenSignInResult {
  const data = (typeof body === 'object' && body !== null ? body : {}) as { url?: unknown; retryAfter?: unknown; code?: unknown };
  if (status === 429) {
    const secs = Number(data.retryAfter ?? retryAfterHeader);
    return { kind: 'locked', retryAfter: Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : 900 };
  }
  if (status === 401) return { kind: 'invalid' };
  if (status === 403) return { kind: 'csrf' };
  if (status === 200 && typeof data.url === 'string') {
    // NextAuth は CSRF トークンの合わないときも 200 で、サインインのページ（?csrf=true）を返す
    try {
      const url = new URL(data.url, 'http://x.invalid');
      if (url.searchParams.get('csrf') === 'true') return { kind: 'csrf' };
    } catch {
      return { kind: 'error', status };
    }
    return { kind: 'ok', url: data.url };
  }
  return { kind: 'error', status };
}
