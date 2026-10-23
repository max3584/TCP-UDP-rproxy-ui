// セッションの長さ・Keycloak でのロールの聞き直し・サインアウト（components/session.ts、pages/api/auth/[...nextauth].ts）。
// Keycloak のトークンのエンドポイントは fetch をモックする
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Account } from 'next-auth';
import {
  DEFAULT_ROLE_REFRESH_SECS, DEFAULT_SESSION_MAX_AGE, SessionInvalid, checkSession, keycloakEndpoints, keycloakLogout,
  keycloakRefresh, sessionConfig, sharedRefresher, signInToken, type RefreshResult, type SessionToken,
} from '@/components/session';

const jwtOf = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const access = (roles: string[]) => jwtOf({ realm_access: { roles } });
const ENV = { KEYCLOAK_ISSUER: 'https://kc.example/realms/r/', KEYCLOAK_CLIENT_ID: 'ui', KEYCLOAK_CLIENT_SECRET: 'sec' };
const CFG = { maxAgeSecs: 8 * 3600, refreshSecs: 300 };
const T0 = 1_800_000_000;

const account = (roles: string[], refresh = 'rt-1'): Account =>
  ({ provider: 'keycloak', type: 'oauth', providerAccountId: 'u1', access_token: access(roles), refresh_token: refresh });

// Keycloak のトークンのエンドポイントの代わり
function tokenEndpoint(reply: (body: URLSearchParams) => { status: number; json?: unknown } | Error) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url: String(url), body });
    const r = reply(body);
    if (r instanceof Error) throw r;
    return new Response(r.status === 204 ? null : r.json === undefined ? 'not json' : JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('session config', () => {
  it('defaults to 8 hours and a role check every 5 minutes, and reads the env', () => {
    expect(sessionConfig({})).toEqual({ maxAgeSecs: DEFAULT_SESSION_MAX_AGE, refreshSecs: DEFAULT_ROLE_REFRESH_SECS });
    expect(DEFAULT_SESSION_MAX_AGE).toBe(28800);
    expect(sessionConfig({ RPROXY_UI_SESSION_MAX_AGE: '3600', RPROXY_UI_ROLE_REFRESH_SECS: '0' })).toEqual({ maxAgeSecs: 3600, refreshSecs: 0 });
    // bad values fall back to the defaults
    expect(sessionConfig({ RPROXY_UI_SESSION_MAX_AGE: '10', RPROXY_UI_ROLE_REFRESH_SECS: 'x' })).toEqual({ maxAgeSecs: 28800, refreshSecs: 300 });
  });

  it('derives the Keycloak endpoints from the issuer', () => {
    expect(keycloakEndpoints(ENV)).toEqual({
      token: 'https://kc.example/realms/r/protocol/openid-connect/token',
      logout: 'https://kc.example/realms/r/protocol/openid-connect/logout',
    });
    expect(keycloakEndpoints({})).toBeNull();
  });
});

describe('checkSession', () => {
  const signedIn = (roles = ['rproxy-admin']): SessionToken => signInToken({ sub: 'u1' }, account(roles), ENV, T0);

  it('keeps the roles and the refresh token from sign-in', () => {
    const t = signedIn();
    expect(t).toMatchObject({ sub: 'u1', roles: ['rproxy-admin'], refreshToken: 'rt-1', authTime: T0, rolesAt: T0 });
  });

  it('does not ask Keycloak before the interval', async () => {
    const refresh = vi.fn<(rt: string) => Promise<RefreshResult>>();
    const t = signedIn();
    expect(await checkSession(t, CFG, refresh, ENV, T0 + 299)).toBe(t);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('drops a revoked role after the interval (new access token from the refresh token)', async () => {
    const kc = tokenEndpoint((body) => body.get('refresh_token') === 'rt-1'
      ? { status: 200, json: { access_token: access(['rproxy-user']), refresh_token: 'rt-2' } }
      : { status: 400, json: { error: 'invalid_grant' } });
    const refresh = (rt: string) => keycloakRefresh(rt, ENV, kc.fetchImpl);
    const t = await checkSession(signedIn(), CFG, refresh, ENV, T0 + 300);
    expect(t.roles).toEqual(['rproxy-user']);
    expect(t.refreshToken).toBe('rt-2');
    expect(t.rolesAt).toBe(T0 + 300);
    expect(kc.calls).toHaveLength(1);
    expect(kc.calls[0].url).toBe('https://kc.example/realms/r/protocol/openid-connect/token');
    expect(Object.fromEntries(kc.calls[0].body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'ui', client_secret: 'sec' });
  });

  it('invalidates the session when Keycloak refuses (user disabled, SSO session ended)', async () => {
    const kc = tokenEndpoint(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Session not active' } }));
    const refresh = (rt: string) => keycloakRefresh(rt, ENV, kc.fetchImpl);
    await expect(checkSession(signedIn(), CFG, refresh, ENV, T0 + 600)).rejects.toThrow(SessionInvalid);
    const unauthorized = tokenEndpoint(() => ({ status: 401, json: { error: 'unauthorized_client' } }));
    await expect(checkSession(signedIn(), CFG, (rt) => keycloakRefresh(rt, ENV, unauthorized.fetchImpl), ENV, T0 + 600)).rejects.toThrow(/unauthorized_client/);
  });

  it('expires 8 hours after sign-in even when used all the time', async () => {
    const kc = tokenEndpoint(() => ({ status: 200, json: { access_token: access(['rproxy-admin']) } }));
    const refresh = (rt: string) => keycloakRefresh(rt, ENV, kc.fetchImpl);
    let t = signedIn();
    for (let at = T0 + 300; at < T0 + CFG.maxAgeSecs; at += 300) t = await checkSession(t, CFG, refresh, ENV, at);
    expect(t.roles).toEqual(['rproxy-admin']);
    await expect(checkSession(t, CFG, refresh, ENV, T0 + CFG.maxAgeSecs)).rejects.toThrow(/expired/);
    // even with the role refresh switched off
    await expect(checkSession(signedIn(), { ...CFG, refreshSecs: 0 }, refresh, ENV, T0 + CFG.maxAgeSecs)).rejects.toThrow(/expired/);
  });

  it('refuses sessions from before this version (no authTime) and sessions without a refresh token', async () => {
    const refresh = vi.fn<(rt: string) => Promise<RefreshResult>>();
    await expect(checkSession({ sub: 'u1', roles: ['rproxy-admin'] }, CFG, refresh, ENV, T0)).rejects.toThrow(SessionInvalid);
    const noRefresh = signInToken({ sub: 'u1' }, { ...account(['rproxy-admin']), refresh_token: undefined }, ENV, T0);
    await expect(checkSession(noRefresh, CFG, refresh, ENV, T0 + 300)).rejects.toThrow(/no refresh token/);
    // without the refresh it is fine until it expires
    expect(await checkSession(noRefresh, { ...CFG, refreshSecs: 0 }, refresh, ENV, T0 + 300)).toBe(noRefresh);
  });

  it('keeps the roles for a while when Keycloak is unreachable, then gives up', async () => {
    const kc = tokenEndpoint(() => new TypeError('fetch failed'));
    const refresh = vi.fn((rt: string) => keycloakRefresh(rt, ENV, kc.fetchImpl));
    let t = await checkSession(signedIn(), CFG, refresh, ENV, T0 + 300);
    expect(t.roles).toEqual(['rproxy-admin']);
    expect(t.retryAt).toBe(T0 + 360);
    // not asked again until retryAt
    t = await checkSession(t, CFG, refresh, ENV, T0 + 330);
    expect(refresh).toHaveBeenCalledTimes(1);
    // a 5xx counts as unreachable too
    const down = tokenEndpoint(() => ({ status: 503 }));
    t = await checkSession(t, CFG, (rt) => keycloakRefresh(rt, ENV, down.fetchImpl), ENV, T0 + 400);
    expect(t.roles).toEqual(['rproxy-admin']);
    // 3 intervals after the last successful check
    await expect(checkSession(t, CFG, refresh, ENV, T0 + 900)).rejects.toThrow(/unavailable/);
  });
});

describe('sharedRefresher', () => {
  it('sends one request for concurrent and slightly late uses of the same refresh token', async () => {
    let n = 0;
    const refresh = sharedRefresher(async () => { n++; return { kind: 'ok', accessToken: access([]) } as const; });
    await Promise.all([refresh('a'), refresh('a'), refresh('a')]);
    await refresh('a');
    expect(n).toBe(1);
    await refresh('b');
    expect(n).toBe(2);
  });

  it('asks again after an unreachable Keycloak', async () => {
    let n = 0;
    const refresh = sharedRefresher(async () => { n++; return { kind: 'unavailable', reason: 'down' } as const; });
    await refresh('a');
    await refresh('a');
    expect(n).toBe(2);
  });
});

describe('keycloakLogout', () => {
  it('posts the refresh token to the end_session endpoint', async () => {
    const kc = tokenEndpoint(() => ({ status: 204 }));
    expect(await keycloakLogout('rt-9', ENV, kc.fetchImpl)).toBe(true);
    expect(kc.calls[0].url).toBe('https://kc.example/realms/r/protocol/openid-connect/logout');
    expect(Object.fromEntries(kc.calls[0].body)).toEqual({ refresh_token: 'rt-9', client_id: 'ui', client_secret: 'sec' });
  });

  it('does not throw when Keycloak is unreachable or there is no refresh token', async () => {
    const kc = tokenEndpoint(() => new TypeError('fetch failed'));
    expect(await keycloakLogout('rt-9', ENV, kc.fetchImpl)).toBe(false);
    expect(await keycloakLogout(undefined, ENV, kc.fetchImpl)).toBe(false);
    expect(kc.calls).toHaveLength(1);
  });
});

// NextAuth のコールバックをつないだ形（getServerSession が通る道）
describe('NextAuth callbacks', () => {
  let authOptions: typeof import('@/pages/api/auth/[...nextauth]').authOptions;
  const keycloakRoles = { current: ['rproxy-admin'] as string[] | null };
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/logout')) return new Response(null, { status: 204 });
    if (keycloakRoles.current === null) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ access_token: access(keycloakRoles.current) }), { status: 200 });
  });

  beforeAll(async () => {
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://kc.example/realms/r');
    vi.stubEnv('RPROXY_UI_SESSION_MAX_AGE', '7200');
    vi.stubEnv('RPROXY_UI_ROLE_REFRESH_SECS', '300');
    vi.stubGlobal('fetch', fetchMock);
    ({ authOptions } = await import('@/pages/api/auth/[...nextauth]'));
  });
  afterEach(() => vi.useRealTimers());

  const jwt = (token: SessionToken, acct?: Account) =>
    authOptions.callbacks!.jwt!({ token, account: acct ?? null, user: undefined as never }) as Promise<SessionToken>;
  const session = async (token: SessionToken) =>
    authOptions.callbacks!.session!({ session: { expires: new Date(Date.now() + 7200_000).toISOString() } as never, token, user: undefined as never, newSession: undefined, trigger: 'update' }) as Promise<{ user: { access: string; roles: string[] }; expires: string }>;

  it('uses a short session and turns an admin into a user, then signs the session out when Keycloak refuses', async () => {
    expect(authOptions.session).toMatchObject({ strategy: 'jwt', maxAge: 7200 });
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['Date'] });
    keycloakRoles.current = ['rproxy-admin'];
    let t = await jwt({ sub: 'u1' }, account(['rproxy-admin']));
    expect((await session(t)).user.access).toBe('admin');
    expect((await session(t)).expires).toBe(new Date((T0 + 7200) * 1000).toISOString());

    // the admin role is removed in Keycloak
    keycloakRoles.current = ['rproxy-user'];
    vi.setSystemTime((T0 + 301) * 1000);
    t = await jwt(t);
    expect((await session(t)).user).toMatchObject({ access: 'user', roles: ['rproxy-user'] });

    // the user is disabled in Keycloak: the callback throws and NextAuth clears the cookie
    keycloakRoles.current = null;
    vi.setSystemTime((T0 + 602) * 1000);
    await expect(jwt(t)).rejects.toThrow(SessionInvalid);
  });

  it('ends the Keycloak session on sign-out', async () => {
    fetchMock.mockClear();
    await authOptions.events!.signOut!({ token: { sub: 'u1', refreshToken: 'rt-x' }, session: undefined as never });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://kc.example/realms/r/protocol/openid-connect/logout');
  });
});
