// サインインしていなければ Keycloak のサインインへ移す（サインイン後は元のページに戻る）。
// データは API（/api/forward/*）がサーバ側でセッションを確かめて守っている。これは画面を出さないための確認。

import React, { useEffect } from 'react';
import { signIn, useSession } from 'next-auth/react';

// サインインしていなくても開けるページ（Profile はサインインのボタンがある入口）
export const PUBLIC_PATHS: readonly string[] = ['/profile'];

export const isPublicPath = (pathname: string): boolean => PUBLIC_PATHS.includes(pathname);

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status } = useSession();

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
  return <>{children}</>;
};

export default RequireAuth;
