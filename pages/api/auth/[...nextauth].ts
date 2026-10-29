import NextAuth, { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { sessionUser } from '@/components/lib';
import { accessOf, roleConfig } from '@/components/roles';
import {
  checkSession, keycloakLogout, keycloakRefresh, sessionConfig, sessionDeadline, sharedRefresher, signInToken, type SessionToken,
} from '@/components/session';

// セッションの長さとロールの聞き直し（components/session.ts。RPROXY_UI_SESSION_MAX_AGE・RPROXY_UI_ROLE_REFRESH_SECS）
const sessionCfg = sessionConfig();
const refresh = sharedRefresher((refreshToken) => keycloakRefresh(refreshToken));

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
      issuer: process.env.KEYCLOAK_ISSUER,
      // max_age：Keycloak での認証が RPROXY_UI_SESSION_MAX_AGE より古ければ、SSO のセッションがあっても認証し直させる（components/session.ts）
      authorization: { params: { scope: 'openid email profile', max_age: sessionCfg.maxAgeSecs } },
      // NextAuth のサインインのページが authjs.dev から読むロゴを出さない（CSP の img-src 'self' で止まる。外のサイトにも聞かない）
      style: { logo: '', bg: '#fff', text: '#000' },
    })
  ],
  session: { strategy: 'jwt', maxAge: sessionCfg.maxAgeSecs },
  callbacks: {
    async jwt({ token, account }) {
      // サインイン時だけ account が渡される。ロールは既定で realm_access.roles（RPROXY_UI_ROLES_CLAIM で変えられる）
      if (account) return signInToken(token, account);
      // 期限を過ぎた・Keycloak が断ったら例外になり、NextAuth がセッションのクッキーを消す
      return checkSession(token as SessionToken, sessionCfg, refresh);
    },
    async session({ session, token }): Promise<sessionUser> {
      const roles = Array.isArray(token.roles) ? (token.roles as string[]) : [];
      const cfg = roleConfig();
      const access = accessOf(roles, cfg);
      // NextAuth の expires は使うたびに延びるので、サインインからの期限のほうが早ければそちらを出す
      const deadline = sessionDeadline(token as SessionToken, sessionCfg);
      const sliding = session.expires ? Date.parse(session.expires) : NaN;
      const expires = deadline !== null && !(sliding < deadline) ? new Date(deadline).toISOString() : session.expires;
      return {
        user: {
          name: token.name || '',
          email: token.email || '',
          image: token.picture || '',
          id: token.sub || '',
          role: roles.join(','),
          roles: roles,
          // 画面の表示用。API route はリクエストごとに roles から決め直す
          access: access,
          ...(access === 'admin' ? {} : { cacheCaps: { maxMemory: cfg.userCacheMaxMemory, maxEntries: cfg.userCacheMaxEntries } }),
        },
        expires: expires || ''
      };
    },
  },
  events: {
    // Keycloak の SSO セッションも終わらせる（end_session。失敗はログに出し、UI のサインアウトは続ける）
    async signOut({ token }) {
      await keycloakLogout((token as SessionToken | null)?.refreshToken);
    },
  },
}

export default NextAuth(authOptions);
