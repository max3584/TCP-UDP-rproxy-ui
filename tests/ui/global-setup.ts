// サインインした状態を作る: NextAuth の JWT を NEXTAUTH_SECRET で暗号化してクッキーに入れる（Keycloak は通さない）
import fs from 'node:fs';
import path from 'node:path';
import { encode } from 'next-auth/jwt';
import { NEXTAUTH_SECRET, baseURL } from '../../playwright.config';

// 既定のセッションは管理者（画面の試験はファイルのパスの証明書と 127.0.0.1 の転送先を使う。利用者はどちらも使えない、#155）
export const E2E_USER = { sub: 'ui-e2e-user', name: 'UI E2E', email: 'ui-e2e@example.invalid', roles: ['rproxy-admin'] };
// 利用者のセッション（tests/ui/.auth/user.json。CI の e2e ジョブは RPROXY_UI_USER_ROLE=rproxy-user）
export const E2E_PLAIN_USER = { sub: 'ui-e2e-plain-user', name: 'UI E2E user', email: 'ui-e2e-user@example.invalid', roles: ['rproxy-user'] };
export const USER_STATE = 'tests/ui/.auth/user.json';

export default async function globalSetup(): Promise<void> {
  const { hostname } = new URL(baseURL);
  const write = async (who: typeof E2E_USER, name: string) => {
    // authTime（サインインした時刻）がないセッションは断られる（components/session.ts）
    const token = await encode({ token: { ...who, authTime: Math.floor(Date.now() / 1000) }, secret: NEXTAUTH_SECRET, maxAge: 60 * 60 });
    const state = {
      cookies: [{
        name: 'next-auth.session-token', value: token, domain: hostname, path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: 'Lax' as const,
      }],
      origins: [],
    };
    const file = path.join(__dirname, '.auth', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  };
  await write(E2E_USER, 'session.json');
  await write(E2E_PLAIN_USER, 'user.json');
}
