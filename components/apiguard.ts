// API route で共通の確認（サインインとロール）と、rproxy のエラーの返し方。サーバ側だけで使う

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import type { sessionUser } from './lib';
import { NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE, lockedOutText } from './messages';
import { NodesConfigError, loadNodes, probeNode, targetNodes, visibleNodes } from './nodes';
import { accessOf, nodesAllowed, roleConfig } from './roles';
import type { RoleConfig } from './roles';
import { RproxyError } from './rproxy';
import type { RproxyNode } from './rproxy';

// ほかのサイトからの状態を変える要求（CSRF）を断る（セキュリティレビュー L2。SameSite=Lax の cookie に加えた多層防御）。
// GET / HEAD / OPTIONS は見ない。ブラウザの要求なら Sec-Fetch-Site が same-origin（か none）で、Origin（なければ Referer）の
// host が要求の Host・X-Forwarded-Host・NEXTAUTH_URL のどれかと同じでなければならない。
// Sec-Fetch-Site も Origin・Referer もない要求も断る（#164。古いブラウザ・ヘッダを落とすプロキシの抜け道を残さない）。
// スクリプトから呼ぶときは Origin に UI の URL（NEXTAUTH_URL の origin）を付ける
export const CROSS_SITE_MESSAGE = 'ほかのサイトからの変更の要求は受け付けません。この画面を開き直してから操作してください。';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

export function isCrossSiteRequest(req: Pick<NextApiRequest, 'method' | 'headers'>, env: Record<string, string | undefined> = process.env): boolean {
  if (SAFE_METHODS.has(String(req.method ?? 'GET').toUpperCase())) return false;
  const h = req.headers ?? {};
  const site = headerValue(h['sec-fetch-site']).toLowerCase();
  if (site !== '' && site !== 'same-origin' && site !== 'none') return true;
  const origin = headerValue(h.origin);
  if (origin.toLowerCase() === 'null') return true;
  const source = origin || headerValue(h.referer);
  // Sec-Fetch-Site（same-origin・none）だけがあれば通す。どちらもなければ断る
  if (source === '') return site === '';
  let host: string;
  try {
    host = new URL(source).host.toLowerCase();
  } catch {
    return true;
  }
  const allowed = new Set<string>();
  const add = (v: string) => { if (v) allowed.add(v.toLowerCase()); };
  add(headerValue(h.host));
  add(headerValue(h['x-forwarded-host']).split(',')[0].trim());
  try {
    if (env.NEXTAUTH_URL) add(new URL(env.NEXTAUTH_URL).host);
  } catch {
    // NEXTAUTH_URL が読めなければ Host だけで比べる
  }
  return !allowed.has(host);
}

// 状態を変える要求がほかのサイトからなら 403 csrf を返して true
export function rejectCrossSite(req: NextApiRequest, res: NextApiResponse): boolean {
  if (!isCrossSiteRequest(req)) return false;
  res.status(403).json({ error: CROSS_SITE_MESSAGE, code: 'csrf' });
  return true;
}

// サインインしていて rproxy-user / rproxy-admin のロールがあれば session を返す。なければ応答を返して null。
// 状態を変える要求（POST など）は、ほかのサイトからなら 403 csrf
export async function requireRole(req: NextApiRequest, res: NextApiResponse): Promise<sessionUser | null> {
  if (rejectCrossSite(req, res)) return null;
  const session = (await getServerSession(req, res, authOptions)) as sessionUser | null;
  if (!session?.user?.id) {
    res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
    return null;
  }
  if (accessOf(session.user.roles ?? [], roleConfig()) === 'none') {
    res.status(403).json({ error: NO_ROLE_MESSAGE, code: 'no_role' });
    return null;
  }
  return session;
}

// 1 台に聞く API（capabilities・interfaces・acme・certs）の相手（?target= のノード、グループなら先頭のノード）。
// 利用者には見るだけのノード（Kubernetes の rproxy）を外し、RPROXY_UI_USER_NODES の内だけにする（#164）。
// target を書かなければ既定（default_target・最初のノード）、利用者が触れなければ触れる最初のノード。
// ノードを設定していなければ node は null（RPROXY_API_URL の 1 台）
export type ViewerProbe =
  | { ok: true; node: RproxyNode | null; admin: boolean; roles: RoleConfig }
  | { ok: false; status: number; body: { error: string; code: string } };

export function viewerProbe(session: sessionUser, rawTarget: unknown): ViewerProbe {
  const roles = roleConfig();
  const admin = accessOf(session.user.roles ?? [], roles) === 'admin';
  const cfg = visibleNodes(loadNodes(), admin);
  const target = typeof rawTarget === 'string' && rawTarget !== '' ? rawTarget : undefined;
  if (!cfg.configured) return { ok: true, node: null, admin: admin, roles: roles };
  const access = admin ? 'admin' : 'user';
  const allowed = (name: string) => nodesAllowed(access, roles, (targetNodes(cfg, name) ?? []).map((n) => n.name));
  const refuse = (name: string): ViewerProbe => ({
    ok: false, status: 403,
    body: { error: `ノード ${(targetNodes(cfg, name) ?? []).map((n) => n.name).join(', ') || name} は管理者だけが触れます。`, code: 'node_not_allowed' },
  });
  let name: string;
  if (target !== undefined) {
    if (targetNodes(cfg, target) === null) return { ok: false, status: 400, body: { error: `ノード／グループ ${target} は設定にありません。`, code: 'unknown_target' } };
    if (!allowed(target)) return refuse(target);
    name = target;
  } else {
    const first = cfg.defaultTarget ?? cfg.nodes[0]?.name;
    const fallback = first !== undefined && allowed(first) ? first : cfg.nodes.find((n) => allowed(n.name))?.name;
    if (fallback === undefined) return refuse(first ?? '');
    name = fallback;
  }
  try {
    return { ok: true, node: probeNode(cfg, name), admin: admin, roles: roles };
  } catch (err) {
    if (err instanceof NodesConfigError) return { ok: false, status: 400, body: { error: err.message, code: 'unknown_target' } };
    throw err;
  }
}

// rproxy への問い合わせの失敗は 502。rproxy の 401 は UI のトークンの問題なので code を rproxy_unauthorized にする
export function rproxyFailure(err: unknown): { error: string; code: string } {
  if (err instanceof RproxyError && err.status === 401) {
    return { error: RPROXY_UNAUTHORIZED_MESSAGE, code: 'rproxy_unauthorized' };
  }
  if (err instanceof RproxyError && err.status === 429) {
    return { error: lockedOutText(err.retryAfter), code: 'rproxy_locked_out' };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof RproxyError ? err.code : 'internal',
  };
}
