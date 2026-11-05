import type { NextApiRequest, NextApiResponse } from 'next';
import NextAuth, { NextAuthOptions, type User } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { isCrossSiteRequest } from '@/components/apiguard';
import { Logger, sessionUser } from '@/components/lib';
import { accessOf, roleConfig } from '@/components/roles';
import {
  checkSession, keycloakLogout, keycloakRefresh, sessionConfig, sessionDeadline, sharedRefresher, signInToken, type SessionToken,
} from '@/components/session';
import {
  AuthConfigError, Lockout, TokenStore, authSettings, checkTokenSession, sourceKey, tokenSignInToken, tokenUser, trustedProxies,
  type AuthSettings, type TokenUser,
} from '@/components/tokenauth';

// セッションの長さとロールの聞き直し（components/session.ts。RPROXY_UI_SESSION_MAX_AGE・RPROXY_UI_ROLE_REFRESH_SECS）
const sessionCfg = sessionConfig();
const refresh = sharedRefresher((refreshToken) => keycloakRefresh(refreshToken));
const log = Logger('info', { action: 'token-auth' });

// サインインの方法（RPROXY_UI_AUTH。components/tokenauth.ts）。誤りは instrumentation-node.ts が起動時に止める。
// ここでは今までどおり Keycloak だけにする（ビルドの時など、起動時の確認を通らずに読まれることがある）
function settings(): { auth: AuthSettings; trusted: string[] } {
  try {
    return { auth: authSettings(), trusted: trustedProxies() };
  } catch (err) {
    if (!(err instanceof AuthConfigError)) throw err;
    return { auth: { mode: 'keycloak', keycloak: true, token: false, tokensFile: null }, trusted: [] };
  }
}
const { auth, trusted } = settings();
const tokens = auth.tokensFile ? new TokenStore(auth.tokensFile) : null;
const lockout = new Lockout();

// トークンでのサインイン（NextAuth の Credentials）。source（締め出しの単位の送信元）は、サインインの要求を受けた handler が渡す。
// getServerSession が使う authOptions では source がなく、authorize は何も通さない
function tokenProvider(source: string | null) {
  return CredentialsProvider({
    id: 'token',
    name: 'Token',
    credentials: { token: { label: 'Token', type: 'password' } },
    async authorize(credentials): Promise<User | null> {
      if (!tokens || source === null) return null;
      const entry = tokens.verify(credentials?.token);
      // トークンそのものはログに出さない
      if (!entry) {
        log.warn({ source }, 'トークンでのサインインに失敗しました（一致するトークンがありません）');
        return null;
      }
      lockout.succeeded(source);
      log.info({ source, name: entry.name, sub: entry.sub, role: entry.role }, 'トークンでサインインしました');
      return tokenUser(entry) as unknown as User;
    },
  });
}

// Keycloak（RPROXY_UI_AUTH=keycloak・both）とトークン（token・both）
function providers(source: string | null): NextAuthOptions['providers'] {
  return [
    ...(auth.keycloak ? [KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? '',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',
      issuer: process.env.KEYCLOAK_ISSUER,
      // max_age：Keycloak での認証が RPROXY_UI_SESSION_MAX_AGE より古ければ、SSO のセッションがあっても認証し直させる（components/session.ts）
      authorization: { params: { scope: 'openid email profile', max_age: sessionCfg.maxAgeSecs } },
      // NextAuth のサインインのページが authjs.dev から読むロゴを出さない（CSP の img-src 'self' で止まる。外のサイトにも聞かない）
      style: { logo: '', bg: '#fff', text: '#000' },
    })] : []),
    ...(auth.token ? [tokenProvider(source)] : []),
  ];
}

export const authOptions: NextAuthOptions = {
  providers: providers(null),
  // トークンを使うときは UI のサインインのページ（pages/signin.tsx。トークンの欄と、both なら Keycloak のボタン）
  ...(auth.token ? { pages: { signIn: '/signin' } } : {}),
  session: { strategy: 'jwt', maxAge: sessionCfg.maxAgeSecs },
  callbacks: {
    async jwt({ token, account, user }) {
      if (account?.provider === 'token' && user) return tokenSignInToken(token as SessionToken, user as unknown as TokenUser);
      // サインイン時だけ account が渡される。ロールは既定で realm_access.roles（RPROXY_UI_ROLES_CLAIM で変えられる）
      if (account) return signInToken(token, account);
      // トークンのセッションは、トークンのファイルの今の内容で確かめる（消えた・入れ替えた・ロールが変わったら無効）
      if ((token as SessionToken).authMethod === 'token') return checkTokenSession(token as SessionToken, sessionCfg, tokens);
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
    // Keycloak の SSO セッションも終わらせる（end_session。失敗はログに出し、UI のサインアウトは続ける）。トークンのセッションには何もしない
    async signOut({ token }) {
      if ((token as SessionToken | null)?.authMethod === 'token') return;
      await keycloakLogout((token as SessionToken | null)?.refreshToken);
    },
  },
}

const isTokenSignIn = (req: NextApiRequest): boolean => {
  const parts = req.query.nextauth;
  return String(req.method).toUpperCase() === 'POST' && Array.isArray(parts) && parts[0] === 'callback' && parts[1] === 'token';
};

// トークンのサインインの要求（POST /api/auth/callback/token）だけ、NextAuth の前に確かめる：
// ほかのサイトからの要求は 403（NextAuth の CSRF トークンに加えて。#164 と同じ確認）、失敗の続く送信元は 429（Retry-After）
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!auth.token || !isTokenSignIn(req)) return NextAuth(req, res, authOptions);
  if (isCrossSiteRequest(req)) {
    res.status(403).json({ code: 'csrf' });
    return;
  }
  const source = sourceKey(req.socket?.remoteAddress, req.headers['x-forwarded-for'], trusted);
  const wait = lockout.attempt(source);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ code: 'too_many_attempts', retryAfter: wait });
    return;
  }
  return NextAuth(req, res, { ...authOptions, providers: providers(source) });
}
