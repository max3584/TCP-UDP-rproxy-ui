// サインインのページ（#179。RPROXY_UI_AUTH=token・both のとき NextAuth の pages.signIn）。トークンの欄と、both なら Keycloak のボタン。
// トークンは NextAuth の Credentials（POST /api/auth/callback/token、CSRF トークン付き）に送る。画面にもログにも残さない。
// 失敗の続く送信元は 429（締め出し。components/tokenauth.ts の Lockout）
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { getCsrfToken, getProviders, signIn, useSession } from 'next-auth/react';
import { t } from '@/i18n/core';
import { safeCallbackUrl, tokenSignInResult } from '@/components/signin';

const inputClass = 'border border-gray-300 rounded-sm px-2 py-2 w-full bg-white text-gray-900 font-mono focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';

function message(kind: string, retryAfter = 0): string {
  switch (kind) {
    case 'invalid': return t('トークンが違います。');
    case 'locked': return t('失敗が続いたため、この送信元からはしばらくサインインできません。{0} 秒後にもう一度試してください。', { 0: retryAfter });
    case 'csrf': return t('サインインのページが古くなっています。ページを読み込み直してから、もう一度試してください。');
    default: return t('サインインできませんでした。しばらくしてからもう一度試してください。');
  }
}

const SignIn: React.FC = () => {
  const router = useRouter();
  const { status } = useSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keycloak, setKeycloak] = useState(false);
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const callbackUrl = safeCallbackUrl(router.query.callbackUrl, origin);
  // NextAuth が付けるエラー（both で Keycloak のサインインに失敗したときなど）
  const queryError = typeof router.query.error === 'string' && router.query.error !== '' ? router.query.error : '';

  useEffect(() => {
    let alive = true;
    // 初回の取得（await の後でだけ state を変える）
    void getProviders().then((p) => { if (alive) setKeycloak(!!p && 'keycloak' in p); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (status === 'authenticated' && router.isReady) void router.replace(callbackUrl);
  }, [status, router, callbackUrl]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const value = token.trim();
    if (value === '') {
      setError(t('トークンを入力してください。'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const csrfToken = (await getCsrfToken()) ?? '';
      const res = await fetch('/api/auth/callback/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: value, csrfToken, callbackUrl, json: 'true' }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // 読めない本文は下で扱う
      }
      const result = tokenSignInResult(res.status, body, res.headers.get('Retry-After'));
      if (result.kind === 'ok') {
        setToken('');
        // サーバ（NextAuth の redirect のコールバック）が同じサイトに限った URL。ページを読み直してセッションを読む
        window.location.assign(safeCallbackUrl(result.url, window.location.origin));
        return;
      }
      setToken('');
      setError(message(result.kind, result.kind === 'locked' ? result.retryAfter : 0));
    } catch {
      setError(message('error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center py-12">
      <div className="card p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center">サインイン</h1>
        {(error || queryError) && (
          <div role="alert" className="bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded-sm mb-4 break-all">
            {error || message('error')}
          </div>
        )}
        <form onSubmit={(e) => void submit(e)} noValidate>
          <label htmlFor="signin-token" className="block text-sm font-medium text-gray-700 mb-1">アクセストークン</label>
          <input
            id="signin-token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={inputClass}
            aria-describedby="signin-token-help"
          />
          <p id="signin-token-help" className="text-xs text-gray-600 mt-1">管理者が発行したトークンを入力してください。</p>
          <button type="submit" className="btn-primary w-full mt-4 max-lg:min-h-11" disabled={busy}>
            {busy ? 'サインインしています…' : 'トークンでサインイン'}
          </button>
        </form>
        {keycloak && (
          <div className="mt-6 border-t border-gray-200 pt-4 text-center">
            <button type="button" className="btn-secondary w-full max-lg:min-h-11" onClick={() => void signIn('keycloak', { callbackUrl })}>
              Keycloak でサインイン
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SignIn;
