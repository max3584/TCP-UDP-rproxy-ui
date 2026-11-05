// トークンでのサインイン（#179。components/tokenauth.ts・components/signin.ts・scripts/rproxy-ui-token.mjs）
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';
import { roleConfig } from '@/components/roles';
import { SessionInvalid, type SessionToken } from '@/components/session';
import {
  AuthConfigError, DEFAULT_LOCKOUT, Lockout, TOKEN_NAME, lockoutOptions, warnUntrustedForwarded, TokenFileError, TokenStore, authSettings, checkTokenSession, parseTokensFile, readTokensFile,
  sha256Hex, sourceKey, tokenFileModeProblem, tokenFingerprint, tokenRoles, tokenSignInToken, tokenSub, tokenUser, trustedProxies,
} from '@/components/tokenauth';
import { safeCallbackUrl, tokenSignInResult } from '@/components/signin';
import * as tool from '@/scripts/rproxy-ui-token.mjs';

const TOKEN_A = 'rpui_admin-token-for-tests-0000000000000000000';
const TOKEN_B = 'rpui_user-token-for-tests-11111111111111111111';
const fileText = (rows: object[]) => YAML.stringify({ tokens: rows });
const ROW_A = { name: 'admin', sha256: sha256Hex(TOKEN_A), role: 'admin' };
const ROW_B = { name: 'alice', sha256: sha256Hex(TOKEN_B), role: 'user', sub: 'kc-sub-alice' };
const ME = { uid: typeof process.getuid === 'function' ? process.getuid() : 1000 };
const CFG = { maxAgeSecs: 8 * 3600, refreshSecs: 300 };
const ENV = { RPROXY_UI_USER_ROLE: 'rproxy-user' };
const T0 = 1_800_000_000;

describe('authSettings (RPROXY_UI_AUTH)', () => {
  it('defaults to keycloak, and to token without Keycloak but with a tokens file', () => {
    expect(authSettings({})).toEqual({ mode: 'keycloak', keycloak: true, token: false, tokensFile: null });
    expect(authSettings({ KEYCLOAK_ISSUER: 'https://kc/realms/r', RPROXY_UI_TOKENS_FILE: '/t.yaml' }).mode).toBe('keycloak');
    expect(authSettings({ RPROXY_UI_TOKENS_FILE: '/t.yaml' })).toEqual({ mode: 'token', keycloak: false, token: true, tokensFile: '/t.yaml' });
  });

  it('reads keycloak | token | both and needs a tokens file for token and both', () => {
    expect(authSettings({ RPROXY_UI_AUTH: 'both', RPROXY_UI_TOKENS_FILE: '/t.yaml' })).toMatchObject({ keycloak: true, token: true });
    expect(authSettings({ RPROXY_UI_AUTH: 'Token', RPROXY_UI_TOKENS_FILE: '/t.yaml' })).toMatchObject({ keycloak: false, token: true });
    expect(authSettings({ RPROXY_UI_AUTH: 'keycloak', RPROXY_UI_TOKENS_FILE: '/t.yaml' })).toMatchObject({ token: false, tokensFile: null });
    expect(() => authSettings({ RPROXY_UI_AUTH: 'token' })).toThrow(AuthConfigError);
    expect(() => authSettings({ RPROXY_UI_AUTH: 'password' })).toThrow(/keycloak・token・both/);
  });
});

describe('parseTokensFile', () => {
  it('reads name, sha256, role and sub (token:<name> when there is none)', () => {
    const entries = parseTokensFile(fileText([ROW_A, { ...ROW_B, sha256: ROW_B.sha256.toUpperCase() }]));
    expect(entries).toEqual([
      { name: 'admin', sha256: ROW_A.sha256, role: 'admin', sub: 'token:admin' },
      { name: 'alice', sha256: ROW_B.sha256, role: 'user', sub: 'kc-sub-alice' },
    ]);
    expect(parseTokensFile('')).toEqual([]);
    expect(parseTokensFile('tokens: []\n')).toEqual([]);
    expect(tokenSub('x')).toBe('token:x');
  });

  it('refuses plaintext tokens, unknown keys, bad names, roles and hashes, and duplicates', () => {
    const bad: [string, RegExp][] = [
      [fileText([{ ...ROW_A, token: TOKEN_A }]), /知らない項目です: token/],
      ['tokens:\n  - x\n', /name・sha256・role/],
      ['users: []\n', /知らない項目です: users/],
      ['- a\n', /tokens: の一覧/],
      ['tokens: {}\n', /一覧にしてください/],
      [fileText([{ ...ROW_A, name: '-x' }]), /name は/],
      [fileText([{ ...ROW_A, name: 'a b' }]), /name は/],
      [fileText([{ ...ROW_A, sha256: 'abc' }]), /sha256 は/],
      [fileText([{ ...ROW_A, role: 'root' }]), /role は admin か user/],
      [fileText([{ ...ROW_A, sub: '' }]), /sub は/],
      [fileText([{ ...ROW_A, sub: 'a\nb' }]), /sub は/],
      [fileText([ROW_A, { ...ROW_B, name: 'admin' }]), /同じ name/],
      [fileText([ROW_A, { ...ROW_B, sha256: ROW_A.sha256 }]), /同じ sha256/],
      ['tokens: [\n', /YAML として読めません/],
    ];
    for (const [text, re] of bad) expect(() => parseTokensFile(text), text).toThrow(re);
    // the error never carries the hash
    try {
      parseTokensFile(fileText([ROW_A, { ...ROW_B, sha256: ROW_A.sha256 }]));
    } catch (e) {
      expect(e).toBeInstanceOf(TokenFileError);
      expect(String((e as Error).message)).not.toContain(ROW_A.sha256);
    }
  });
});

describe('tokenFileModeProblem (owner and mode)', () => {
  const file = (uid: number, mode: number) => ({ uid, mode: 0o100000 | mode });
  it('takes the UI user\'s 0600 / 0400 files and root\'s Secret volumes (group read only)', () => {
    expect(tokenFileModeProblem(file(1000, 0o600), { uid: 1000 })).toBeNull();
    expect(tokenFileModeProblem(file(1000, 0o400), { uid: 1000 })).toBeNull();
    expect(tokenFileModeProblem(file(0, 0o440), { uid: 1000 })).toBeNull();
    expect(tokenFileModeProblem(file(0, 0o600), { uid: 0 })).toBeNull();
  });

  it('refuses group / other access and files of other users', () => {
    expect(tokenFileModeProblem(file(1000, 0o640), { uid: 1000 })).toMatch(/0640.*chmod 600/);
    expect(tokenFileModeProblem(file(1000, 0o604), { uid: 1000 })).toMatch(/0604/);
    expect(tokenFileModeProblem(file(0, 0o444), { uid: 1000 })).toMatch(/0444/);
    expect(tokenFileModeProblem(file(0, 0o460), { uid: 1000 })).toMatch(/0460/);
    expect(tokenFileModeProblem(file(1001, 0o600), { uid: 1000 })).toMatch(/uid 1001/);
  });
});

describe('TokenStore (reading, comparing, reloading)', () => {
  let dir: string;
  let path: string;
  const write = (rows: object[], mode = 0o600) => {
    writeFileSync(path, fileText(rows));
    chmodSync(path, mode);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-tokens-'));
    path = join(dir, 'tokens.yaml');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the matching row by the token\'s sha256 and nothing else', () => {
    write([ROW_A, ROW_B]);
    const store = new TokenStore(path, ME);
    expect(store.verify(TOKEN_A)?.name).toBe('admin');
    expect(store.verify(TOKEN_B)?.sub).toBe('kc-sub-alice');
    for (const wrong of [ROW_A.sha256, `${TOKEN_A} `, '', undefined, 42, 'x'.repeat(10_000)]) expect(store.verify(wrong)).toBeNull();
  });

  it('reloads when the file changes: a removed row stops working at once', () => {
    write([ROW_A, ROW_B]);
    const store = new TokenStore(path, ME);
    expect(store.verify(TOKEN_B)).not.toBeNull();
    write([ROW_A]);
    expect(store.verify(TOKEN_B)).toBeNull();
    expect(store.verify(TOKEN_A)).not.toBeNull();
  });

  it('lets no token in when the file is missing, broken or readable by others (no fallback to the last good file)', () => {
    write([ROW_A]);
    const store = new TokenStore(path, ME);
    expect(store.verify(TOKEN_A)).not.toBeNull();
    writeFileSync(path, 'tokens: [\n');
    expect(store.current()).toMatchObject({ ok: false });
    expect(store.verify(TOKEN_A)).toBeNull();
    write([ROW_A], 0o644);
    expect(store.current()).toMatchObject({ ok: false, error: expect.stringMatching(/0644/) });
    expect(store.verify(TOKEN_A)).toBeNull();
    rmSync(path);
    expect(store.verify(TOKEN_A)).toBeNull();
    write([ROW_A]);
    expect(store.verify(TOKEN_A)).not.toBeNull();
  });

  it('readTokensFile checks the opened file', () => {
    write([ROW_A], 0o640);
    expect(() => readTokensFile(path, ME)).toThrow(/chmod 600/);
    expect(() => readTokensFile(join(dir, 'none.yaml'), ME)).toThrow(/読めません/);
    expect(() => readTokensFile(dir, ME)).toThrow(TokenFileError);
  });
});

describe('roles and the session', () => {
  let dir: string;
  let path: string;
  let store: TokenStore;
  const write = (rows: object[]) => {
    writeFileSync(path, fileText(rows));
    chmodSync(path, 0o600);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-tokens-'));
    path = join(dir, 'tokens.yaml');
    write([ROW_A, ROW_B]);
    store = new TokenStore(path, ME);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps admin and user to RPROXY_UI_ADMIN_ROLE and RPROXY_UI_USER_ROLE (no user role: no access)', () => {
    expect(tokenRoles('admin', roleConfig({}))).toEqual(['rproxy-admin']);
    expect(tokenRoles('admin', roleConfig({ RPROXY_UI_ADMIN_ROLE: 'ops' }))).toEqual(['ops']);
    expect(tokenRoles('user', roleConfig({ RPROXY_UI_USER_ROLE: 'rproxy-user' }))).toEqual(['rproxy-user']);
    expect(tokenRoles('user', roleConfig({}))).toEqual([]);
  });

  const signIn = (name: string, now = T0): SessionToken =>
    tokenSignInToken({ name: 'x', email: 'x@example', picture: 'p', refreshToken: 'stale' } as SessionToken, tokenUser(store.entries().find((e) => e.name === name)!), ENV, now);

  it('stores the sub (token:<name> or sub), the roles and a fingerprint, never the hash or the token', () => {
    const t = signIn('admin');
    expect(t).toMatchObject({ sub: 'token:admin', name: 'admin', authMethod: 'token', tokenName: 'admin', tokenRole: 'admin', roles: ['rproxy-admin'], authTime: T0 });
    expect(t.refreshToken).toBeUndefined();
    expect(t.email).toBeNull();
    expect(JSON.stringify(t)).not.toContain(ROW_A.sha256);
    expect(JSON.stringify(t)).not.toContain(TOKEN_A);
    expect(t.tokenFp).toBe(tokenFingerprint(ROW_A));
    expect(signIn('alice')).toMatchObject({ sub: 'kc-sub-alice', roles: ['rproxy-user'] });
  });

  it('keeps the session while the row is unchanged, up to RPROXY_UI_SESSION_MAX_AGE from sign-in', () => {
    const t = signIn('alice');
    expect(checkTokenSession(t, CFG, store, ENV, T0 + 60)).toMatchObject({ roles: ['rproxy-user'], rolesAt: T0 + 60 });
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + CFG.maxAgeSecs)).toThrow(SessionInvalid);
    expect(() => checkTokenSession({ ...t, authTime: undefined }, CFG, store, ENV, T0)).toThrow(/authTime/);
    expect(() => checkTokenSession(t, CFG, null, ENV, T0)).toThrow(/not enabled/);
  });

  it('ends the session at the next check when the row is removed, replaced, or its role or sub changes', () => {
    const t = signIn('alice');
    write([ROW_A]);
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + 1)).toThrow(/removed/);
    write([ROW_A, { ...ROW_B, sha256: sha256Hex('rpui_new') }]);
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + 1)).toThrow(/replaced/);
    write([ROW_A, { ...ROW_B, role: 'admin' }]);
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + 1)).toThrow(/role changed/);
    write([ROW_A, { ...ROW_B, sub: 'other' }]);
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + 1)).toThrow(/sub changed/);
    writeFileSync(path, 'tokens: [\n');
    expect(() => checkTokenSession(t, CFG, store, ENV, T0 + 1)).toThrow(SessionInvalid);
    write([ROW_A, ROW_B]);
    expect(checkTokenSession(t, CFG, store, ENV, T0 + 1).tokenName).toBe('alice');
  });
});

describe('Lockout', () => {
  const opts = { maxAttempts: 3, windowSecs: 60, lockSecs: 120, maxEntries: 3 };

  it('allows maxAttempts wrong tokens in the window, then answers wrong tokens with 429 for lockSecs', () => {
    const l = new Lockout(opts);
    expect([l.failed('a', T0), l.failed('a', T0 + 1), l.failed('a', T0 + 2)]).toEqual([0, 0, 0]);
    expect(l.failed('a', T0 + 3)).toBe(120);
    expect(l.failed('a', T0 + 63)).toBe(60);
    // another source is not affected
    expect(l.failed('b', T0 + 3)).toBe(0);
    // after the lock: a fresh window
    expect(l.failed('a', T0 + 123)).toBe(0);
  });

  it('starts over only after the window (no reset by a success)', () => {
    const w = new Lockout(opts);
    w.failed('a', T0);
    w.failed('a', T0);
    w.failed('a', T0);
    expect(w.failed('a', T0 + 59)).toBe(120);
    const x = new Lockout(opts);
    x.failed('a', T0);
    x.failed('a', T0);
    x.failed('a', T0);
    expect(x.failed('a', T0 + 60)).toBe(0);
  });

  it('forgets the oldest sources beyond maxEntries', () => {
    const l = new Lockout(opts);
    for (let i = 0; i < 4; i++) l.failed('a', T0);
    expect(l.failed('a', T0)).toBeGreaterThan(0);
    for (const s of ['b', 'c', 'd']) l.failed(s, T0);
    expect(l.failed('a', T0)).toBe(0);
  });

  it('reads RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS and RPROXY_UI_TOKEN_LOCKOUT_SECS', () => {
    expect(lockoutOptions({})).toEqual(DEFAULT_LOCKOUT);
    expect(DEFAULT_LOCKOUT).toMatchObject({ maxAttempts: 5, windowSecs: 900, lockSecs: 900 });
    expect(lockoutOptions({ RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS: '10', RPROXY_UI_TOKEN_LOCKOUT_SECS: '60' })).toMatchObject({ maxAttempts: 10, windowSecs: 60, lockSecs: 60 });
    for (const bad of ['0', '-1', '1.5', 'x', '100000']) {
      expect(() => lockoutOptions({ RPROXY_UI_TOKEN_LOCKOUT_SECS: bad }), bad).toThrow(AuthConfigError);
      expect(() => lockoutOptions({ RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS: bad === '100000' ? '1001' : bad }), bad).toThrow(AuthConfigError);
    }
  });

  it('warns once about X-Forwarded-For without RPROXY_UI_TRUSTED_PROXIES', () => {
    expect(warnUntrustedForwarded('203.0.113.5', ['10.0.0.0/8'])).toBe(false);
    expect(warnUntrustedForwarded(undefined, [])).toBe(false);
    expect(warnUntrustedForwarded('203.0.113.5', [])).toBe(true);
    expect(warnUntrustedForwarded('203.0.113.5', [])).toBe(false);
  });
});

describe('sourceKey', () => {
  it('uses the peer address; IPv6 per /64; IPv4-mapped as IPv4', () => {
    expect(sourceKey('192.0.2.7', '203.0.113.9', [])).toBe('192.0.2.7');
    expect(sourceKey('::ffff:192.0.2.7', undefined, [])).toBe('192.0.2.7');
    expect(sourceKey('2001:db8:1:2:3:4:5:6', undefined, [])).toBe('2001:db8:1:2::/64');
    expect(sourceKey(undefined, undefined, [])).toBe('unknown');
  });

  it('reads X-Forwarded-For from the right only through trusted proxies', () => {
    const trusted = trustedProxies({ RPROXY_UI_TRUSTED_PROXIES: '10.0.0.0/8, 192.0.2.1' });
    expect(trusted).toEqual(['10.0.0.0/8', '192.0.2.1/32']);
    expect(sourceKey('10.1.2.3', '198.51.100.1, 203.0.113.5, 10.9.9.9', trusted)).toBe('203.0.113.5');
    expect(sourceKey('10.1.2.3', ['198.51.100.1', '203.0.113.5'], trusted)).toBe('203.0.113.5');
    expect(sourceKey('10.1.2.3', 'garbage, 203.0.113.5', trusted)).toBe('203.0.113.5');
    expect(sourceKey('10.1.2.3', 'garbage', trusted)).toBe('10.1.2.3');
    expect(sourceKey('10.1.2.3', '2001:db8::1', trusted)).toBe('2001:db8::/64');
    // a client that is not a trusted proxy cannot choose its key
    expect(sourceKey('203.0.113.5', '198.51.100.1', trusted)).toBe('203.0.113.5');
    expect(() => trustedProxies({ RPROXY_UI_TRUSTED_PROXIES: 'proxy.example' })).toThrow(AuthConfigError);
  });
});

describe('sign-in page helpers (components/signin.ts)', () => {
  const origin = 'https://ui.example';
  it('keeps the callback URL on this site', () => {
    expect(safeCallbackUrl('/rules/new?x=1#a', origin)).toBe('/rules/new?x=1#a');
    expect(safeCallbackUrl('https://ui.example/history', origin)).toBe('/history');
    const bad = [
      'https://evil.example/', '//evil.example/x', 'javascript:alert(1)', '', undefined, ['/x'],
      // normalized into a protocol-relative path (M1 of the review)
      '/.//evil.example', '/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example', 'https://ui.example//evil.example',
      '/./\\evil.example', '/\\evil.example', '\\\\evil.example', '/x\\y', '/a\tb', '/a\nb', '/a\u0000b',
    ];
    for (const v of bad) expect(safeCallbackUrl(v, origin), String(v)).toBe('/');
    expect(safeCallbackUrl('/a//b', origin)).toBe('/a//b');
  });

  it('reads the answer of POST /api/auth/callback/token', () => {
    expect(tokenSignInResult(200, { url: 'https://ui.example/rules' }, null)).toEqual({ kind: 'ok', url: 'https://ui.example/rules' });
    expect(tokenSignInResult(401, { url: 'https://ui.example/api/auth/error?error=CredentialsSignin' }, null)).toEqual({ kind: 'invalid' });
    expect(tokenSignInResult(429, { code: 'too_many_attempts', retryAfter: 61 }, '61')).toEqual({ kind: 'locked', retryAfter: 61 });
    expect(tokenSignInResult(429, null, '30')).toEqual({ kind: 'locked', retryAfter: 30 });
    expect(tokenSignInResult(403, { code: 'csrf' }, null)).toEqual({ kind: 'csrf' });
    // NextAuth answers a wrong CSRF token with 200 and its sign-in page
    expect(tokenSignInResult(200, { url: 'https://ui.example/api/auth/signin?csrf=true' }, null)).toEqual({ kind: 'csrf' });
    expect(tokenSignInResult(500, null, null)).toEqual({ kind: 'error', status: 500 });
  });
});

describe('scripts/rproxy-ui-token.mjs', () => {
  it('uses the same name rule as the UI', () => {
    expect(String(tool.TOKEN_NAME)).toBe(String(TOKEN_NAME));
  });

  it('makes random tokens and entries the UI reads, and removes them', () => {
    const a = tool.newToken();
    const b = tool.newToken();
    expect(a).toMatch(/^rpui_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    let text = tool.addEntry(YAML, '', tool.entryFor({ name: 'admin', role: 'admin', sub: '' }, a));
    text = tool.addEntry(YAML, text, tool.entryFor({ name: 'alice', role: 'user', sub: 'kc-1' }, b));
    expect(text).not.toContain(a);
    expect(text).toMatch(/^# rproxy-ui/);
    const entries = parseTokensFile(text);
    expect(entries.map((e) => [e.name, e.role, e.sub])).toEqual([['admin', 'admin', 'token:admin'], ['alice', 'user', 'kc-1']]);
    expect(entries[0].sha256).toBe(sha256Hex(a));
    expect(() => tool.addEntry(YAML, text, tool.entryFor({ name: 'admin', role: 'user', sub: '' }, tool.newToken()))).toThrow(/同じ name/);
    expect(() => tool.entryFor({ name: 'a b', role: 'user', sub: '' }, a)).toThrow(/--name/);
    expect(() => tool.entryFor({ name: 'a', role: 'root', sub: '' }, a)).toThrow(/--role/);
    const removed = tool.removeEntry(YAML, `# kept comment\n${text}`, 'admin');
    expect(removed).toContain('# kept comment');
    expect(parseTokensFile(removed).map((e) => e.name)).toEqual(['alice']);
    expect(() => tool.removeEntry(YAML, removed, 'admin')).toThrow(/ありません/);
  });

  it('writes a 0600 file, prints the token once, and refuses files readable by others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-tokens-'));
    try {
      const path = join(dir, 'tokens.yaml');
      const out: string[] = [];
      const err: string[] = [];
      const sink = (a: string[]) => ({ write: (s: string) => { a.push(s); return true; } });
      // root（CI のコンテナ）が新しく作るときは --owner が要る（root:root 0600 は UI が読めない）
      const root = process.getuid?.() === 0;
      if (root) await expect(tool.main(['new', '--name', 'admin', '--role', 'admin', '--file', path], {}, sink(out), sink(err))).rejects.toThrow(/--owner/);
      expect(await tool.main(['new', '--name', 'admin', '--role', 'admin', '--file', path, ...(root ? ['--owner', '0'] : [])], {}, sink(out), sink(err))).toBe(0);
      const token = out.join('').trim();
      expect(token).toMatch(/^rpui_/);
      expect(err.join('')).not.toContain(token);
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain(token);
      expect(new TokenStore(path, ME).verify(token)?.name).toBe('admin');
      chmodSync(path, 0o640);
      await expect(tool.main(['new', '--name', 'b', '--role', 'user', '--file', path], {}, sink(out), sink(err))).rejects.toThrow(/chmod 600/);
      chmodSync(path, 0o600);
      expect(await tool.main(['remove', '--name', 'admin'], { RPROXY_UI_TOKENS_FILE: path }, sink(out), sink(err))).toBe(0);
      expect(new TokenStore(path, ME).verify(token)).toBeNull();
      await expect(tool.main(['list'], {}, sink(out), sink(err))).rejects.toThrow(/--file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// pages/api/auth/[...nextauth].ts の handler：トークンのサインインの要求だけ、CSRF と締め出しを NextAuth の前に確かめる
describe('the NextAuth handler', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-tokens-'));
    writeFileSync(join(dir, 'tokens.yaml'), fileText([ROW_A]));
    chmodSync(join(dir, 'tokens.yaml'), 0o600);
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
    vi.doUnmock('next-auth');
  });

  // NextAuth の代わり：Credentials の authorize を呼んで 200 / 401 を返す
  async function load(env: Record<string, string>) {
    Object.assign(process.env, env);
    const calls: { providers: string[] }[] = [];
    vi.doMock('next-auth', () => ({
      default: async (req: { body: Record<string, string> }, res: Res, opts: { providers: { id: string; options?: { id?: string; authorize?: (c: unknown) => Promise<unknown> } }[] }) => {
        calls.push({ providers: opts.providers.map((p) => p.options?.id ?? p.id) });
        const token = opts.providers.find((p) => p.options?.id === 'token');
        const user = token ? await token.options!.authorize!(req.body) : null;
        res.status(user ? 200 : 401).json({ user });
      },
      getServerSession: async () => null,
    }));
    const mod = await import('@/pages/api/auth/[...nextauth]');
    return { mod, calls };
  }

  type Res = { status: (n: number) => Res; json: (b: unknown) => Res; setHeader: (k: string, v: string) => Res; statusCode: number; body: unknown; headers: Record<string, string> };
  const res = (): Res => {
    const r: Res = {
      statusCode: 0, body: undefined, headers: {},
      status(n) { r.statusCode = n; return r; },
      json(b) { r.body = b; return r; },
      setHeader(k, v) { r.headers[k.toLowerCase()] = v; return r; },
    };
    return r;
  };
  const post = (token: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }, ip = '192.0.2.50') => ({
    method: 'POST', query: { nextauth: ['callback', 'token'] }, headers, body: { token, csrfToken: 'x' }, socket: { remoteAddress: ip },
  });

  it('keeps Keycloak alone (and no sign-in page) with RPROXY_UI_AUTH=keycloak', async () => {
    const { mod, calls } = await load({ RPROXY_UI_AUTH: 'keycloak', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml'), KEYCLOAK_ISSUER: 'https://kc.example/realms/r' });
    expect(mod.authOptions.providers.map((p) => p.id)).toEqual(['keycloak']);
    expect(mod.authOptions.pages).toBeUndefined();
    const r = res();
    await mod.default(post(TOKEN_A) as never, r as never);
    expect(calls).toEqual([{ providers: ['keycloak'] }]);
    expect(r.statusCode).toBe(401);
  });

  it('signs in with a right token, refuses cross-site requests, and locks out a source after repeated failures', async () => {
    const { mod } = await load({ RPROXY_UI_AUTH: 'both', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml'), KEYCLOAK_ISSUER: 'https://kc.example/realms/r' });
    expect(mod.authOptions.pages).toEqual({ signIn: '/signin' });
    let r = res();
    await mod.default(post(TOKEN_A) as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ user: { id: 'token:admin', name: 'admin', tokenRole: 'admin' } });
    r = res();
    await mod.default(post(TOKEN_A, { 'sec-fetch-site': 'cross-site' }) as never, r as never);
    expect(r.statusCode).toBe(403);
    for (let i = 0; i < 5; i++) {
      r = res();
      await mod.default(post('rpui_wrong') as never, r as never);
      expect(r.statusCode).toBe(401);
    }
    r = res();
    await mod.default(post('rpui_wrong') as never, r as never);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body).toMatchObject({ code: 'too_many_attempts' });
    // the right token still signs in while the source is locked (the lockout only stops guesses) ...
    r = res();
    await mod.default(post(TOKEN_A) as never, r as never);
    expect(r.statusCode).toBe(200);
    // ... and does not reset the count
    r = res();
    await mod.default(post('rpui_wrong') as never, r as never);
    expect(r.statusCode).toBe(429);
    // another source is not locked
    r = res();
    await mod.default(post('rpui_wrong', undefined, '198.51.100.7') as never, r as never);
    expect(r.statusCode).toBe(401);
  });

  it('a success does not reset the count of wrong tokens; the limits come from the env', async () => {
    const { mod } = await load({ RPROXY_UI_AUTH: 'token', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml'), RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS: '2' });
    const statuses: number[] = [];
    for (const t of ['rpui_wrong', TOKEN_A, 'rpui_wrong', 'rpui_wrong']) {
      const r = res();
      await mod.default(post(t) as never, r as never);
      statuses.push(r.statusCode);
    }
    expect(statuses).toEqual([401, 200, 401, 429]);
  });

  it('token only: a Keycloak session (no authMethod) is refused; both: it goes on to the Keycloak check', async () => {
    const kc = { sub: 'kc-1', roles: ['rproxy-admin'], authTime: Math.floor(Date.now() / 1000), rolesAt: Math.floor(Date.now() / 1000) };
    const jwt = (m: { authOptions: { callbacks?: { jwt?: (a: never) => unknown } } }) => m.authOptions.callbacks!.jwt!({ token: kc } as never);
    const only = await load({ RPROXY_UI_AUTH: 'token', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml') });
    await expect(jwt(only.mod)).rejects.toThrow(/keycloak sign-in is not enabled/);
    vi.resetModules();
    const both = await load({ RPROXY_UI_AUTH: 'both', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml'), KEYCLOAK_ISSUER: 'https://kc.example/realms/r' });
    await expect(jwt(both.mod)).resolves.toMatchObject({ sub: 'kc-1' });
  });

  it('a session check from getServerSession cannot sign in (no source)', async () => {
    const { mod } = await load({ RPROXY_UI_AUTH: 'token', RPROXY_UI_TOKENS_FILE: join(dir, 'tokens.yaml') });
    const provider = mod.authOptions.providers.find((p) => (p as { options?: { id?: string } }).options?.id === 'token') as unknown as { options: { authorize: (c: unknown) => Promise<unknown> } };
    expect(await provider.options.authorize({ token: TOKEN_A })).toBeNull();
    expect(mod.authOptions.providers.map((p) => (p as { options?: { id?: string } }).options?.id ?? p.id)).toEqual(['token']);
  });
});
