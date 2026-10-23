// サインインのセッション（NextAuth の JWT）の長さと、Keycloak に聞き直してロールを更新する仕組み（tests/session.test.ts）。
// - セッションはサインインから RPROXY_UI_SESSION_MAX_AGE 秒（既定 8 時間）で切れる。使い続けても延びない（authTime から数える）。
// - RPROXY_UI_ROLE_REFRESH_SECS 秒（既定 300、0 で止める）ごとに refresh_token で Keycloak のトークンのエンドポイントに聞き直し、
//   新しいアクセストークンのロールに置き換える。Keycloak が断ったら（利用者の無効化・SSO セッションの終わり・取り消し）セッションを無効にする。
//   Keycloak に届かない・5xx のときは、最後に確かめてから 3 回分の間隔までは今のロールのまま使い、それを過ぎたら無効にする。
// - サインアウトでは Keycloak の end_session（logout）のエンドポイントにも refresh_token を送り、SSO のセッションも終わらせる。
// NextAuth v4 は jwt のコールバックが例外を投げるとセッションのクッキーを消す（getServerSession は null）。それで無効にする。
import type { Account } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import { Logger } from './lib';
import { roleConfig, rolesFromToken } from './roles';

type Env = Record<string, string | undefined>;

export const DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60;
export const DEFAULT_ROLE_REFRESH_SECS = 300;
// 届かないときに今のロールで使ってよいのは、最後に確かめてから間隔の何回分までか
const UNAVAILABLE_GRACE_INTERVALS = 3;
// 届かなかったあと、次に聞き直すまでの秒
const UNAVAILABLE_RETRY_SECS = 60;
const KEYCLOAK_TIMEOUT_MS = 5000;
const log = Logger('info', { action: 'session' });

export interface SessionConfig {
  maxAgeSecs: number;
  // 0 なら聞き直さない
  refreshSecs: number;
}

function intEnv(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    log.warn({ name, value: raw }, `${name} は ${min} 以上の整数（秒）で書いてください。既定の ${fallback} を使います`);
    return fallback;
  }
  return n;
}

export function sessionConfig(env: Env = process.env): SessionConfig {
  return {
    maxAgeSecs: intEnv(env, 'RPROXY_UI_SESSION_MAX_AGE', DEFAULT_SESSION_MAX_AGE, 300),
    refreshSecs: intEnv(env, 'RPROXY_UI_ROLE_REFRESH_SECS', DEFAULT_ROLE_REFRESH_SECS, 0),
  };
}

// JWT に入れる項目（NextAuth の token に足す）
export interface SessionToken extends JWT {
  roles?: string[];
  refreshToken?: string;
  // サインインした時刻（Unix 秒）。セッションの長さはここから数える
  authTime?: number;
  // 最後に Keycloak でロールを確かめた時刻（Unix 秒）
  rolesAt?: number;
  // 届かなかったとき、次に聞き直してよい時刻（Unix 秒）
  retryAt?: number;
}

export class SessionInvalid extends Error {}

export type RefreshResult =
  | { kind: 'ok'; accessToken: string; refreshToken?: string }
  // Keycloak が断った（4xx。invalid_grant など）
  | { kind: 'refused'; status: number; error: string }
  // 届かない・5xx・読めない応答
  | { kind: 'unavailable'; reason: string };

export type Refresher = (refreshToken: string) => Promise<RefreshResult>;

const nowSecs = (): number => Math.floor(Date.now() / 1000);

// サインインの時の token を作る
export function signInToken(token: JWT, account: Account, env: Env = process.env, now = nowSecs()): SessionToken {
  const next: SessionToken = { ...token, authTime: now, rolesAt: now };
  next.roles = account.access_token ? rolesFromToken(account.access_token, roleConfig(env).claim) : [];
  if (account.refresh_token) next.refreshToken = account.refresh_token;
  delete next.retryAt;
  return next;
}

// セッションが絶対に切れる時刻（ミリ秒）。authTime のない古いセッションは null
export function sessionDeadline(token: SessionToken, cfg: SessionConfig): number | null {
  return typeof token.authTime === 'number' ? (token.authTime + cfg.maxAgeSecs) * 1000 : null;
}

// サインインのあとのリクエストごと。期限と、必要ならロールの聞き直し。無効なら SessionInvalid を投げる
export async function checkSession(
  token: SessionToken, cfg: SessionConfig, refresh: Refresher, env: Env = process.env, now = nowSecs(),
): Promise<SessionToken> {
  // この版より前のセッション（authTime がない）は長さが分からないので、サインインし直してもらう
  if (typeof token.authTime !== 'number') throw new SessionInvalid('session without authTime');
  if (now >= token.authTime + cfg.maxAgeSecs) throw new SessionInvalid('session expired');
  if (cfg.refreshSecs === 0) return token;
  const checkedAt = typeof token.rolesAt === 'number' ? token.rolesAt : token.authTime;
  if (now - checkedAt < cfg.refreshSecs) return token;
  if (typeof token.retryAt === 'number' && now < token.retryAt) return token;
  if (!token.refreshToken) throw new SessionInvalid('no refresh token');

  const result = await refresh(token.refreshToken);
  if (result.kind === 'ok') {
    const next: SessionToken = { ...token, roles: rolesFromToken(result.accessToken, roleConfig(env).claim), rolesAt: now };
    if (result.refreshToken) next.refreshToken = result.refreshToken;
    delete next.retryAt;
    return next;
  }
  if (result.kind === 'refused') {
    log.info({ sub: token.sub, status: result.status, error: result.error }, 'Keycloak がトークンの更新を断ったのでセッションを無効にします');
    throw new SessionInvalid(`refresh refused: ${result.error}`);
  }
  if (now - checkedAt >= cfg.refreshSecs * UNAVAILABLE_GRACE_INTERVALS) {
    log.warn({ sub: token.sub, reason: result.reason }, 'Keycloak に長い間ロールを確かめられないのでセッションを無効にします');
    throw new SessionInvalid(`keycloak unavailable: ${result.reason}`);
  }
  log.warn({ sub: token.sub, reason: result.reason }, 'Keycloak でロールを確かめられませんでした。今のロールのまま使い、あとで聞き直します');
  return { ...token, retryAt: now + UNAVAILABLE_RETRY_SECS };
}

// Keycloak のエンドポイント（KEYCLOAK_ISSUER = https://<host>/realms/<realm>）
export function keycloakEndpoints(env: Env = process.env): { token: string; logout: string } | null {
  const issuer = env.KEYCLOAK_ISSUER?.trim().replace(/\/+$/, '');
  if (!issuer) return null;
  return { token: `${issuer}/protocol/openid-connect/token`, logout: `${issuer}/protocol/openid-connect/logout` };
}

function clientParams(env: Env): Record<string, string> {
  return { client_id: env.KEYCLOAK_CLIENT_ID ?? '', client_secret: env.KEYCLOAK_CLIENT_SECRET ?? '' };
}

// refresh_token で Keycloak に聞く
export async function keycloakRefresh(refreshToken: string, env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<RefreshResult> {
  const ep = keycloakEndpoints(env);
  if (!ep) return { kind: 'unavailable', reason: 'KEYCLOAK_ISSUER is not set' };
  let res: Response;
  try {
    res = await fetchImpl(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, ...clientParams(env) }),
      signal: AbortSignal.timeout(KEYCLOAK_TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    // 読めない本文は下で扱う
  }
  if (res.status >= 400 && res.status < 500) {
    return { kind: 'refused', status: res.status, error: typeof body.error === 'string' ? body.error : `http ${res.status}` };
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    return { kind: 'unavailable', reason: `http ${res.status}` };
  }
  return {
    kind: 'ok',
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
  };
}

// 同じ refresh_token の聞き直しを 1 つにまとめる（同じ時に来た複数のリクエストと、少し遅れて古いクッキーで来たリクエスト）。
// Keycloak で refresh_token を使い捨てにしている（Revoke Refresh Token）と、同じものを 2 回送ると 2 回目は断られるため。
// まとめるのはこのプロセスの中だけ（UI を複数動かすなら、Revoke Refresh Token は使わない。docs/PRODUCTION.md）
const SHARE_MS = 30_000;

export function sharedRefresher(refresh: Refresher, shareMs = SHARE_MS): Refresher {
  const inflight = new Map<string, { at: number; result: Promise<RefreshResult> }>();
  return (refreshToken) => {
    const now = Date.now();
    for (const [key, v] of inflight) if (now - v.at > shareMs) inflight.delete(key);
    const hit = inflight.get(refreshToken);
    if (hit) return hit.result;
    const result = refresh(refreshToken);
    inflight.set(refreshToken, { at: now, result });
    // 届かなかったときは次に新しく聞けるように外す
    void result.then((r) => { if (r.kind === 'unavailable') inflight.delete(refreshToken); }, () => inflight.delete(refreshToken));
    return result;
  };
}

// サインアウトで Keycloak の SSO セッションも終わらせる（失敗してもサインアウトは続ける）
export async function keycloakLogout(refreshToken: string | undefined, env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const ep = keycloakEndpoints(env);
  if (!ep || !refreshToken) return false;
  try {
    const res = await fetchImpl(ep.logout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, ...clientParams(env) }),
      signal: AbortSignal.timeout(KEYCLOAK_TIMEOUT_MS),
    });
    if (!res.ok) log.warn({ status: res.status }, 'Keycloak のサインアウト（end_session）が失敗しました');
    return res.ok;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Keycloak のサインアウト（end_session）に届きませんでした');
    return false;
  }
}
