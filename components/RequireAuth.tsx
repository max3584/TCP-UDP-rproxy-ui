// サインインしていなければ Keycloak のサインインへ移す（サインイン後は元のページに戻る）。
// データは API（/api/forward/*）がサーバ側でセッションを確かめて守っている。これは画面を出さないための確認。

import React, { useEffect } from 'react';
import { signIn, useSession } from 'next-auth/react';
import type { sessionUser } from './lib';
import { NO_ROLE_MESSAGE } from './messages';

// サインインしていなくても開けるページ（Profile はサインインのボタンがある入口）
export const PUBLIC_PATHS: readonly string[] = ['/profile'];

export const isPublicPath = (pathname: string): boolean => PUBLIC_PATHS.includes(pathname);

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data, status } = useSession();

  useEffect(() => {
    if (status === 'unauthenticated') {
      // callbackUrl を省くと、サインイン後に今のページ（例 /rules/new）へ戻る
      void signIn('keycloak');
    }
  }, [status]);

  if (status !== 'authenticated') {
    return (
      <p role="status" className="text-center text-gray-700 py-12">
        {status === 'loading' ? 'サインインを確認しています…' : 'サインインのページへ移動しています…'}
      </p>
    );
  }
  // ロールがない（API も 403 no_role で断る）。古いセッション（access なし）は API に任せる
  if ((data as sessionUser | null)?.user?.access === 'none') {
    return (
      <div role="alert" className="max-w-xl mx-auto my-12 rounded border border-amber-400 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">403: 権限がありません</p>
        <p className="mt-2 text-sm">{NO_ROLE_MESSAGE}</p>
      </div>
    );
  }
  return <>{children}</>;
};

export default RequireAuth;
