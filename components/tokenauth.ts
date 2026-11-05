// トークンでのサインイン（#179。tests/tokenauth.test.ts）。Keycloak なしの最小構成（UI・MariaDB・rproxy だけ）で使う。
// - RPROXY_UI_AUTH=keycloak|token|both（authMode）。既定は今までどおり keycloak。RPROXY_UI_AUTH がなく、KEYCLOAK_ISSUER がなく
//   RPROXY_UI_TOKENS_FILE があれば token。
// - トークンのファイル（RPROXY_UI_TOKENS_FILE、YAML）：tokens: [{name, sha256, role: admin|user, sub?}]。平文のトークンは置かない。
//   ファイルは UI のユーザーの持ち物で 0600（group・other の権限なし）。Kubernetes の Secret のボリューム（root の持ち物、
//   group は fsGroup、0440）のために、root の持ち物ならグループが読めるのは認める（tokenFileModeProblem）。ほかは読まずに断る。
// - ファイルは変わったら（stat の更新時刻・大きさ・inode）読み直す（TokenStore）。読めない・誤りのあるときはどのトークンも通さない。
// - 照合は sha256 を全部の行と一定時間で比べる（verifyToken）。失敗の続く送信元は締め出す（Lockout。429）。
// - セッションは Keycloak と同じ長さ（RPROXY_UI_SESSION_MAX_AGE）。セッションを確かめるたびにファイルを見て、トークンが消えた・
//   入れ替わった・ロールや sub が変わったら無効にする（checkTokenSession）。
// サーバ側だけで使う（node:fs・node:crypto）
import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, statSync, type Stats } from 'node:fs';
import { parse } from 'yaml';
import { parseCidr } from './cidr';
import { Logger } from './lib';
import { roleConfig, type RoleConfig } from './roles';
import { SessionInvalid, type SessionConfig, type SessionToken } from './session';
import { cidrContains, toIp } from './usertargets';

type Env = Record<string, string | undefined>;

const log = Logger('info', { action: 'token-auth' });

export type AuthMode = 'keycloak' | 'token' | 'both';
export const AUTH_MODES: AuthMode[] = ['keycloak', 'token', 'both'];

export class AuthConfigError extends Error {}

export interface AuthSettings {
  mode: AuthMode;
  keycloak: boolean;
  token: boolean;
  // RPROXY_UI_TOKENS_FILE（token・both のとき）
  tokensFile: string | null;
}

// RPROXY_UI_AUTH と、ないときの既定。誤りは AuthConfigError（起動時に止める。instrumentation-node.ts）
export function authSettings(env: Env = process.env): AuthSettings {
  const raw = (env.RPROXY_UI_AUTH ?? '').trim().toLowerCase();
  const file = (env.RPROXY_UI_TOKENS_FILE ?? '').trim();
  let mode: AuthMode;
  if (raw === '') {
    mode = (env.KEYCLOAK_ISSUER ?? '').trim() === '' && file !== '' ? 'token' : 'keycloak';
  } else if ((AUTH_MODES as string[]).includes(raw)) {
    mode = raw as AuthMode;
  } else {
    throw new AuthConfigError(`RPROXY_UI_AUTH は keycloak・token・both のどれかにしてください: ${env.RPROXY_UI_AUTH}`);
  }
  const token = mode !== 'keycloak';
  if (token && file === '') throw new AuthConfigError(`RPROXY_UI_AUTH=${mode} には RPROXY_UI_TOKENS_FILE（トークンのファイル）が要ります`);
  return { mode, keycloak: mode !== 'token', token, tokensFile: token ? file : null };
}

export type TokenRole = 'admin' | 'user';

export interface TokenEntry {
  name: string;
  // 小文字の 16 進（64 文字）
  sha256: string;
  role: TokenRole;
  // 履歴の auth_id・ルールの持ち主。書かなければ token:<name>
  sub: string;
}

export class TokenFileError extends Error {}

export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = new Set(['name', 'sha256', 'role', 'sub']);
// 受け取るトークンの長さ（これより長いものはハッシュもしない）
export const MAX_TOKEN_LENGTH = 512;

export const tokenSub = (name: string): string => `token:${name}`;

// トークンのファイルの中身を確かめる。誤りは TokenFileError（行の名前か番号を付ける。トークンやハッシュは出さない）
export function parseTokensFile(text: string): TokenEntry[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new TokenFileError(`YAML として読めません: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new TokenFileError('先頭は tokens: の一覧にしてください');
  const keys = Object.keys(doc);
  const unknown = keys.find((k) => k !== 'tokens');
  if (unknown !== undefined) throw new TokenFileError(`知らない項目です: ${unknown}`);
  const list = (doc as { tokens?: unknown }).tokens ?? [];
  if (!Array.isArray(list)) throw new TokenFileError('tokens は一覧にしてください');
  const names = new Set<string>();
  const hashes = new Set<string>();
  return list.map((item, i) => {
    const at = `tokens[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new TokenFileError(`${at}: name・sha256・role を書いてください`);
    const e = item as Record<string, unknown>;
    const extra = Object.keys(e).find((k) => !ENTRY_KEYS.has(k));
    if (extra !== undefined) throw new TokenFileError(`${at}: 知らない項目です: ${extra}（平文のトークンは書かず、sha256 だけを書きます）`);
    const name = e.name;
    if (typeof name !== 'string' || !TOKEN_NAME.test(name)) {
      throw new TokenFileError(`${at}: name は英数字で始まる 64 文字までの英数字・. _ - にしてください`);
    }
    const where = `${at}（${name}）`;
    if (names.has(name)) throw new TokenFileError(`${where}: 同じ name がほかにもあります`);
    names.add(name);
    const sha = typeof e.sha256 === 'string' ? e.sha256.trim().toLowerCase() : '';
    if (!SHA256_HEX.test(sha)) throw new TokenFileError(`${where}: sha256 はトークンの SHA-256 の 16 進（64 文字）にしてください`);
    if (hashes.has(sha)) throw new TokenFileError(`${where}: 同じ sha256 がほかの行にもあります`);
    hashes.add(sha);
    if (e.role !== 'admin' && e.role !== 'user') throw new TokenFileError(`${where}: role は admin か user にしてください`);
    let sub = tokenSub(name);
    if (e.sub !== undefined && e.sub !== null) {
      if (typeof e.sub !== 'string' || e.sub.trim() === '' || e.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(e.sub)) {
        throw new TokenFileError(`${where}: sub は 255 文字までの文字列にしてください`);
      }
      sub = e.sub.trim();
    }
    return { name, sha256: sha, role: e.role, sub };
  });
}

// ファイルの持ち主と権限。問題があればその理由、なければ null。
// - UI のユーザーの持ち物：group・other の権限なし（0600・0400）
// - root の持ち物（Kubernetes の Secret のボリューム）：other の権限なし、group は読むだけ（0440 まで）
// - ほかの利用者の持ち物は断る（その人がトークンを足せてしまう）
export interface ProcessIds {
  uid: number;
}

export function tokenFileModeProblem(st: Pick<Stats, 'uid' | 'mode'>, proc: ProcessIds): string | null {
  const perm = st.mode & 0o777;
  const octal = perm.toString(8).padStart(4, '0');
  if (st.uid === proc.uid) {
    return (perm & 0o077) === 0 ? null : `権限が ${octal} です。UI のユーザーだけが読めるように chmod 600 にしてください`;
  }
  if (st.uid === 0) {
    return (perm & 0o037) === 0 ? null : `権限が ${octal} です（root の持ち物なら group は読むだけ、other は権限なしにしてください）`;
  }
  return `持ち主（uid ${st.uid}）が UI のユーザー（uid ${proc.uid}）でも root でもありません。chown してください`;
}

function processIds(): ProcessIds | null {
  return typeof process.getuid === 'function' ? { uid: process.geteuid?.() ?? process.getuid() } : null;
}

type Loaded = { ok: true; entries: TokenEntry[] } | { ok: false; error: string };

// ファイルを読む（開いたファイルの fstat で持ち主と権限を確かめてから読む。確かめたものを読む）
export function readTokensFile(path: string, proc: ProcessIds | null = processIds()): TokenEntry[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    throw new TokenFileError(`読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TokenFileError('ふつうのファイルではありません');
    if (proc) {
      const problem = tokenFileModeProblem(st, proc);
      if (problem) throw new TokenFileError(problem);
    }
    return parseTokensFile(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

// ファイルの変化を見て読み直す。変わっていなければ stat だけ
export class TokenStore {
  private key = '';
  private loaded: Loaded = { ok: false, error: 'not loaded' };
  private digests: Buffer[] = [];

  constructor(readonly path: string, private readonly proc: ProcessIds | null = processIds()) {}

  private stamp(): string {
    try {
      const st = statSync(this.path);
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}`;
    } catch (err) {
      return `missing:${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err)}`;
    }
  }

  current(): Loaded {
    const key = this.stamp();
    if (key === this.key) return this.loaded;
    this.key = key;
    try {
      const entries = readTokensFile(this.path, this.proc);
      this.loaded = { ok: true, entries };
      this.digests = entries.map((e) => Buffer.from(e.sha256, 'hex'));
      log.info({ file: this.path, tokens: entries.map((e) => `${e.name}(${e.role})`) }, 'RPROXY_UI_TOKENS_FILE を読みました');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.loaded = { ok: false, error };
      this.digests = [];
      // 前に読めた内容も使わない（取り消しのつもりの書き換えに誤りがあっても、古いトークンを通さない）
      log.error({ file: this.path, error }, 'RPROXY_UI_TOKENS_FILE を使えません。どのトークンでもサインインできません');
    }
    return this.loaded;
  }

  entries(): TokenEntry[] {
    const c = this.current();
    return c.ok ? c.entries : [];
  }

  // 出したトークンに一致する行。全部の行と一定時間で比べる（途中で止めない）
  verify(presented: unknown): TokenEntry | null {
    const entries = this.entries();
    if (typeof presented !== 'string' || presented === '' || presented.length > MAX_TOKEN_LENGTH) return null;
    const digest = createHash('sha256').update(presented, 'utf8').digest();
    let found = -1;
    for (let i = 0; i < this.digests.length; i++) {
      if (timingSafeEqual(this.digests[i], digest) && found < 0) found = i;
    }
    return found >= 0 ? entries[found] : null;
  }
}

export const sha256Hex = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

// セッションに入れる行の印（sha256 そのものはクッキーに入れない）。トークンを入れ替えたら変わる
export const tokenFingerprint = (entry: Pick<TokenEntry, 'sha256'>): string =>
  createHash('sha256').update(`rproxy-ui-token:${entry.sha256}`).digest('hex').slice(0, 32);

// ロールの名前（API route は roles から accessOf で決める）。user は RPROXY_UI_USER_ROLE（空なら利用者はいない：403 no_role）
export function tokenRoles(role: TokenRole, cfg: RoleConfig = roleConfig()): string[] {
  if (role === 'admin') return [cfg.adminRole];
  return cfg.userRole === '' ? [] : [cfg.userRole];
}

// NextAuth の authorize が返す利用者（jwt のコールバックに渡る）
export interface TokenUser {
  id: string;
  name: string;
  email: null;
  tokenName: string;
  tokenFp: string;
  tokenRole: TokenRole;
}

export function tokenUser(entry: TokenEntry): TokenUser {
  return { id: entry.sub, name: entry.name, email: null, tokenName: entry.name, tokenFp: tokenFingerprint(entry), tokenRole: entry.role };
}

const nowSecs = (): number => Math.floor(Date.now() / 1000);

// サインインの時の JWT（期限はサインインした時刻から数える）
export function tokenSignInToken(token: SessionToken, user: TokenUser, env: Env = process.env, now = nowSecs()): SessionToken {
  const next: SessionToken = {
    ...token, sub: user.id, name: user.name, email: null, picture: null,
    authMethod: 'token', tokenName: user.tokenName, tokenFp: user.tokenFp, tokenRole: user.tokenRole,
    roles: tokenRoles(user.tokenRole, roleConfig(env)), authTime: now, rolesAt: now,
  };
  delete next.refreshToken;
  delete next.retryAt;
  return next;
}

// サインインのあとのリクエストごと。期限と、ファイルの今の内容（消えた・入れ替えた・ロールや sub が変わった）を確かめる。
// ファイルは stat で変化を見るだけなので、RPROXY_UI_ROLE_REFRESH_SECS を待たずに毎回確かめる
export function checkTokenSession(token: SessionToken, cfg: SessionConfig, store: TokenStore | null, env: Env = process.env, now = nowSecs()): SessionToken {
  if (typeof token.authTime !== 'number') throw new SessionInvalid('session without authTime');
  if (now >= token.authTime + cfg.maxAgeSecs) throw new SessionInvalid('session expired');
  if (!store) throw new SessionInvalid('token sign-in is not enabled');
  const entry = store.entries().find((e) => e.name === token.tokenName);
  let why: string | null = null;
  if (!entry) why = 'token removed';
  else if (tokenFingerprint(entry) !== token.tokenFp) why = 'token replaced';
  else if (entry.role !== token.tokenRole) why = 'role changed';
  else if (entry.sub !== token.sub) why = 'sub changed';
  if (why) {
    log.info({ name: token.tokenName, sub: token.sub, why }, 'トークンのファイルが変わったのでセッションを無効にします');
    throw new SessionInvalid(why);
  }
  return { ...token, roles: tokenRoles(entry!.role, roleConfig(env)), rolesAt: now };
}

// 失敗の続く送信元の締め出し。window 秒の中で maxAttempts 回まで試せる（成功で数え直す）。超えたら lock 秒は断る（正しいトークンでも）。
// 照合の前に数える（同時にたくさん送っても maxAttempts を超えない）。プロセスの中だけ（UI を複数動かせばそれぞれで数える）
export interface LockoutOptions {
  maxAttempts: number;
  windowSecs: number;
  lockSecs: number;
  // 覚えておく送信元の数（超えたら古いものから忘れる）
  maxEntries: number;
}

export const DEFAULT_LOCKOUT: LockoutOptions = { maxAttempts: 5, windowSecs: 15 * 60, lockSecs: 15 * 60, maxEntries: 10_000 };

export class Lockout {
  private readonly seen = new Map<string, { first: number; count: number; until: number }>();

  constructor(private readonly opts: LockoutOptions = DEFAULT_LOCKOUT) {}

  // 試してよければ 0（数を 1 つ増やす）、締め出し中なら待つ秒
  attempt(source: string, now = nowSecs()): number {
    let s = this.seen.get(source);
    if (s && s.until > now) return s.until - now;
    if (!s || now - s.first >= this.opts.windowSecs || s.until !== 0) s = { first: now, count: 0, until: 0 };
    s.count += 1;
    if (s.count > this.opts.maxAttempts) {
      s.until = now + this.opts.lockSecs;
      this.remember(source, s);
      log.warn({ source, lockSecs: this.opts.lockSecs }, 'トークンでのサインインの失敗が続いたので、この送信元を締め出します');
      return this.opts.lockSecs;
    }
    this.remember(source, s);
    return 0;
  }

  succeeded(source: string): void {
    this.seen.delete(source);
  }

  private remember(source: string, s: { first: number; count: number; until: number }): void {
    this.seen.delete(source);
    this.seen.set(source, s);
    while (this.seen.size > this.opts.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

// 信頼する前段のプロキシ（RPROXY_UI_TRUSTED_PROXIES。CIDR をカンマで）。Ingress・Gateway など HTTP のプロキシの後ろで、
// 送信元を X-Forwarded-For から取るため。空（既定）なら接続の相手のアドレス
export function trustedProxies(env: Env = process.env): string[] {
  const list = (env.RPROXY_UI_TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.map((item) => {
    const c = parseCidr(item);
    if (!c.ok) throw new AuthConfigError(`RPROXY_UI_TRUSTED_PROXIES は CIDR か IP アドレスをカンマで区切って書いてください: ${item}`);
    return c.value;
  });
}

// 締め出しの単位（送信元）。IPv6 は /64 ごと（1 つの利用者が持つ範囲）。接続の相手が信頼するプロキシなら、
// X-Forwarded-For を右から見て、信頼するプロキシでない最初のアドレス
export function sourceKey(remote: string | undefined, forwardedFor: string | string[] | undefined, trusted: string[]): string {
  const isTrusted = (ip: string) => trusted.some((c) => cidrContains(c, ip));
  let ip = toIp(remote ?? '') ?? 'unknown';
  if (ip !== 'unknown' && isTrusted(ip)) {
    const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = toIp(hops[i]);
      if (hop === null) break;
      ip = hop;
      if (!isTrusted(hop)) break;
    }
  }
  if (ip.includes(':')) {
    const c = parseCidr(`${ip}/64`);
    if (c.ok) return c.value;
  }
  return ip;
}

// 起動時の確認（instrumentation-node.ts）：RPROXY_UI_AUTH・RPROXY_UI_TRUSTED_PROXIES の誤り、使えないトークンのファイル
// （読めない・持ち主や権限が違う・中身の誤り）は理由を出して止める。動いている間に壊れたときは止めずに、どのトークンも通さない
export function checkAuthAtStartup(env: Env = process.env): void {
  try {
    const auth = authSettings(env);
    trustedProxies(env);
    if (!auth.tokensFile) return;
    const entries = readTokensFile(auth.tokensFile);
    const cfg = roleConfig(env);
    console.log(`rproxy-ui: RPROXY_UI_AUTH=${auth.mode}; RPROXY_UI_TOKENS_FILE: ${entries.length} token(s)`);
    if (cfg.userRole === '' && entries.some((e) => e.role === 'user')) {
      console.warn('rproxy-ui: RPROXY_UI_USER_ROLE が空なので、role: user のトークンでは使えません（403 no_role）。RPROXY_UI_USER_ROLE=rproxy-user などを設定してください');
    }
  } catch (err) {
    const file = (env.RPROXY_UI_TOKENS_FILE ?? '').trim();
    const where = err instanceof TokenFileError ? `RPROXY_UI_TOKENS_FILE（${file}）: ` : '';
    console.error(`rproxy-ui: ${where}${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
