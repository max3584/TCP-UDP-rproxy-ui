// サインインした状態を作る: NextAuth の JWT を NEXTAUTH_SECRET で暗号化してクッキーに入れる（Keycloak は通さない）
import fs from 'node:fs';
import path from 'node:path';
import { encode } from 'next-auth/jwt';
import { NEXTAUTH_SECRET, baseURL } from '../../playwright.config';

export const E2E_USER = { sub: 'ui-e2e-user', name: 'UI E2E', email: 'ui-e2e@example.invalid', roles: ['rproxy-user'] };

export default async function globalSetup(): Promise<void> {
  const token = await encode({ token: E2E_USER, secret: NEXTAUTH_SECRET, maxAge: 60 * 60 });
  const { hostname } = new URL(baseURL);
  const state = {
    cookies: [{
      name: 'next-auth.session-token', value: token, domain: hostname, path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: 'Lax' as const,
    }],
    origins: [],
  };
  const file = path.join(__dirname, '.auth', 'session.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}
