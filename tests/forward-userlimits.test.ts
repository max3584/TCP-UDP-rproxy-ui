// 利用者（admin でない人）のルールの制限（#155）：ファイルのパス・登録済みの証明書の名前・転送先を API が断り、
// 管理者は今までどおり、利用者の自分のルールに前からある値は変えなければ残せる。ほかの人のルール（固定ルール）のパスは伏せる
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query: vi.fn() };
  const pool = { getConnection: vi.fn(), query: vi.fn() };
  return {
    conn, pool,
    getServerSession: vi.fn(),
    addRule: vi.fn(), modifyRule: vi.fn(), deleteRule: vi.fn(), listRules: vi.fn(), getRule: vi.fn(), getInterfaces: vi.fn(),
  };
});

vi.mock('mariadb', () => ({ default: { createPool: () => mocks.pool } }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  addRule: mocks.addRule, modifyRule: mocks.modifyRule, deleteRule: mocks.deleteRule, listRules: mocks.listRules, getRule: mocks.getRule,
  getInterfaces: mocks.getInterfaces,
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';
import { HIDDEN_FILE } from '@/components/userlimits';

const { conn, pool } = mocks;

const user = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };
const admin = { ...user, user: { ...user.user, id: 'admin-1', role: 'rproxy-admin', roles: ['rproxy-admin'] } };

const tcpRule = { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8443, distAddr: '192.0.2.5', distPort: 8080, sourceIp: 'proxy', udpIdleSecs: 30 };
const fileTls = { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/tls/a.pem', key_file: '/etc/rproxy/tls/a.key' }] };

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body, headers: { 'sec-fetch-site': 'same-origin' } } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

// 変更のときに DB にある自分のルール（lockOwnRule の行）
function storedRule(over: { dist_addr?: string; dist_port?: number; options?: unknown } = {}) {
  const row = { src_port_end: null, dist_addr: over.dist_addr ?? '192.0.2.5', dist_port: over.dist_port ?? 8080, source_ip: 'proxy', udp_idle_secs: 30, options: over.options === undefined ? null : JSON.stringify(over.options) };
  conn.query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT src_port_end') ? [row] : { affectedRows: 1 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getServerSession.mockResolvedValue(user);
  pool.getConnection.mockResolvedValue(conn);
  pool.query.mockResolvedValue([]);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
  mocks.addRule.mockResolvedValue({});
  mocks.modifyRule.mockResolvedValue({});
  mocks.getRule.mockRejectedValue(new RproxyError('not found', 'not_found', 404));
  mocks.getInterfaces.mockResolvedValue({ interfaces: [], reserved: [] });
});

describe('server files (#155)', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['certificate files', { tls: fileTls }],
    ['client_auth CA', { tls: { mode: 'terminate', certificates: [{ cert: 'tenant-a' }], client_auth: { mode: 'required', ca_file: '/etc/rproxy/ca.pem' } } }],
    ['upstream client certificate', { tls: { mode: 'terminate', certificates: [{ cert: 'tenant-a' }], upstream: { tls: true, cert_file: '/c.pem', key_file: '/c.key' } } }],
    ['route upstream CA', { tls: { mode: 'terminate', certificates: [{ cert: 'tenant-a' }], routes: [{ server_name: 'a.example.com', remote_addr: '192.0.2.9', remote_port: 443, upstream: { ca_file: '/ca.pem' } }] } }],
    ['L7 service tls', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'https://192.0.2.9' }], tls: { ca_file: '/ca.pem' } } } } }],
    ['basic_auth users_file', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['a'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { a: { basic_auth: { users_file: '/etc/rproxy/htpasswd' } } } } }],
    ['oidc secret files', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['o'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { o: { oidc: { issuer: 'https://idp.example.com', client_id: 'c', client_secret_file: '/s/c', cookie_secret_file: '/s/k' } } } } }],
  ];

  it.each(cases)('a user may not add a rule with %s (403 file_not_allowed); an admin may', async (_name, over) => {
    const res = await call('add', { ...tcpRule, ...over });
    expect([res.status, res.body.code]).toEqual([403, 'file_not_allowed']);
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();

    mocks.getServerSession.mockResolvedValue(admin);
    const ok = await call('add', { ...tcpRule, ...over });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(mocks.addRule).toHaveBeenCalledTimes(1);
  });

  it('a user may pick a certificate by name from the certificate store', async () => {
    const res = await call('add', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: 'tenant-a' }] } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mocks.addRule.mock.calls[0][0].tls.certificates).toEqual([{ cert: 'tenant-a' }]);
  });

  it('RPROXY_UI_USER_CERTS limits the names a user may pick (403 cert_not_allowed); admins may pick any', async () => {
    vi.stubEnv('RPROXY_UI_USER_CERTS', 'tenant-');
    const bad = await call('add', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: 'dashboard' }] } });
    expect([bad.status, bad.body.code]).toEqual([403, 'cert_not_allowed']);
    expect((await call('add', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: 'tenant-b' }] } })).status).toBe(200);
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await call('add', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: 'dashboard' }] } })).status).toBe(200);
  });

  // #160：利用者・ロールごとの割り当て。割り当てのある利用者は RPROXY_UI_USER_CERTS の代わりにその先頭だけ
  it('RPROXY_UI_USER_CERTS_BY_ROLE / _BY_SUB replace the shared prefixes for the users they name', async () => {
    vi.stubEnv('RPROXY_UI_USER_CERTS', 'shared-');
    vi.stubEnv('RPROXY_UI_USER_CERTS_BY_ROLE', 'tenant-a:tenant-a-,tenant-b:tenant-b-');
    vi.stubEnv('RPROXY_UI_USER_CERTS_BY_SUB', 'user-9:special-');
    const add = (cert: string) => call('add', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: cert }] } });
    mocks.getServerSession.mockResolvedValue({ ...user, user: { ...user.user, roles: ['rproxy-user', 'tenant-a'] } });
    expect((await add('tenant-a-www')).status).toBe(200);
    const other = await add('tenant-b-www');
    expect([other.status, other.body.code]).toEqual([403, 'cert_not_allowed']);
    // 割り当てのある利用者には、共通の先頭は効かない
    expect((await add('shared-www')).status).toBe(403);
    // sub の割り当てとロールの割り当ては足し合わせる
    mocks.getServerSession.mockResolvedValue({ ...user, user: { ...user.user, id: 'user-9', roles: ['rproxy-user', 'tenant-b'] } });
    expect((await add('special-x')).status).toBe(200);
    expect((await add('tenant-b-www')).status).toBe(200);
    // 割り当てを設定したら、割り当てのない利用者は共通の先頭（RPROXY_UI_USER_CERTS）にも戻らず、何も選べない
    mocks.getServerSession.mockResolvedValue(user);
    expect((await add('shared-www')).status).toBe(403);
    expect((await add('tenant-a-www')).status).toBe(403);
    // 割り当てを外せば共通の先頭（今までどおり）
    vi.stubEnv('RPROXY_UI_USER_CERTS_BY_ROLE', '');
    vi.stubEnv('RPROXY_UI_USER_CERTS_BY_SUB', '');
    expect((await add('shared-www')).status).toBe(200);
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await add('tenant-b-www')).status).toBe(200);
  });

  it('a user keeps a stored certificate already on the own rule even outside the assignment', async () => {
    vi.stubEnv('RPROXY_UI_USER_CERTS_BY_ROLE', 'tenant-a:tenant-a-');
    storedRule({ options: { tls: { mode: 'terminate', certificates: [{ cert: 'legacy' }] } } });
    expect((await call('modify', { ...tcpRule, distPort: 8081, tls: { mode: 'terminate', certificates: [{ cert: 'legacy' }] } })).status).toBe(200);
    const swapped = await call('modify', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert: 'tenant-b-x' }] } });
    expect([swapped.status, swapped.body.code]).toEqual([403, 'cert_not_allowed']);
  });

  it('on modify, a user keeps the files already on the own rule, but may not change or add one', async () => {
    const options = { tls: fileTls, starttls: null, starttls_required: true };
    storedRule({ options: options });
    // unchanged files and another field changed: allowed
    const kept = await call('modify', { ...tcpRule, distPort: 8081, tls: fileTls });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(mocks.modifyRule).toHaveBeenCalledTimes(1);
    // body without tls keeps the stored one too
    expect((await call('modify', { ...tcpRule, distPort: 8082 })).status).toBe(200);

    mocks.modifyRule.mockClear();
    const changed = await call('modify', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/tls/a.pem', key_file: '/etc/rproxy/tls/dashboard.key' }] } });
    expect([changed.status, changed.body.code]).toEqual([403, 'file_not_allowed']);
    expect(changed.body.error).toContain('tls.certificates[].key_file');
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();

    // admins may change it
    mocks.getServerSession.mockResolvedValue(admin);
    storedRule({ options: options });
    const byAdmin = await call('modify', { ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/tls/b.pem', key_file: '/etc/rproxy/tls/b.key' }] } });
    expect(byAdmin.status).toBe(200);
  });

  it('plan (dry run) refuses the same as add and modify', async () => {
    const res = await call('plan', { action: 'add', ...tcpRule, tls: fileTls });
    expect([res.status, res.body.code]).toEqual([403, 'file_not_allowed']);
  });
});

describe('destinations (#155)', () => {
  it.each([
    ['loopback (the UI, the DB, the control API on this host)', { distAddr: '127.0.0.1', distPort: 3000 }],
    ['cloud metadata', { distAddr: '169.254.169.254', distPort: 80 }],
    ['a name that resolves to loopback', { distAddr: 'localhost', distPort: 9000 }],
    ['a name that does not resolve', { distAddr: 'nowhere.invalid', distPort: 80 }],
    ['IPv6 loopback in targets', { distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '::1', port: 80 }] }],
    ['a tls route to loopback', { tls: { mode: 'sni', routes: [{ server_name: 'a.example.com', remote_addr: '127.0.0.1', remote_port: 8080 }] } }],
    ['an L7 service URL', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'http://127.0.0.1:3306' }] } } } }],
    ['an L7 route to', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', to: 'http://169.254.169.254/latest' }] } }],
    ['a forward_auth address', { distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['fa'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { fa: { forward_auth: { address: 'http://127.0.0.1:4181/auth' } } } } }],
  ])('a user may not forward to %s (403 target_not_allowed); an admin may', async (_name, over) => {
    const res = await call('add', { ...tcpRule, ...over });
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([403, 'target_not_allowed']);
    expect(mocks.addRule).not.toHaveBeenCalled();
    mocks.getServerSession.mockResolvedValue(admin);
    const ok = await call('add', { ...tcpRule, ...over });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('RPROXY_UI_USER_TARGETS limits users to its CIDRs and names', async () => {
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8,backend.example.com');
    expect((await call('add', { ...tcpRule, distAddr: '10.1.2.3' })).status).toBe(200);
    expect((await call('add', { ...tcpRule, srcPort: 8444, distAddr: 'backend.example.com' })).status).toBe(200);
    const outside = await call('add', { ...tcpRule, srcPort: 8445, distAddr: '192.0.2.5' });
    expect([outside.status, outside.body.code]).toEqual([403, 'target_not_allowed']);
    // the test resolver gives 192.0.2.10 for other names: outside the CIDRs
    expect((await call('add', { ...tcpRule, srcPort: 8446, distAddr: 'other.example.com' })).status).toBe(403);
  });

  it('the control API reported by GET /interfaces is refused even inside the allow-list', async () => {
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '192.0.2.0/24');
    mocks.getInterfaces.mockResolvedValue({ interfaces: [{ name: 'eth0', addr: '192.0.2.50', family: 'ipv4', loopback: false, link_local: false }], reserved: [{ protocol: 'tcp', addr: '0.0.0.0', port: 8080, purpose: 'control api' }] });
    const res = await call('add', { ...tcpRule, distAddr: '192.0.2.50', distPort: 8080 });
    expect([res.status, res.body.code]).toEqual([403, 'target_not_allowed']);
    expect(res.body.error).toContain('rproxy の制御 API');
    expect((await call('add', { ...tcpRule, distAddr: '192.0.2.50', distPort: 8081 })).status).toBe(200);
  });

  it('on modify, a user keeps an existing destination but may not point it elsewhere (also a new port)', async () => {
    storedRule({ dist_addr: '127.0.0.1', dist_port: 9000 });
    const kept = await call('modify', { ...tcpRule, distAddr: '127.0.0.1', distPort: 9000, allowFrom: ['10.0.0.0/8'] });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const port = await call('modify', { ...tcpRule, distAddr: '127.0.0.1', distPort: 3306 });
    expect([port.status, port.body.code]).toEqual([403, 'target_not_allowed']);
    const other = await call('modify', { ...tcpRule, distAddr: '169.254.169.254', distPort: 80 });
    expect(other.status).toBe(403);
  });
});

describe('rules users do not own (#155)', () => {
  const staticRule = {
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, listen_port_end: null, remote_addr: '127.0.0.1', remote_port: 3000,
    source_ip: 'proxy', udp_idle_secs: 30, allow_from: [], starttls: null, starttls_required: true,
    tls: { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/tls/dashboard.pem', key_file: '/etc/rproxy/tls/dashboard.key' }], client_auth: { mode: 'none', ca_file: null }, alpn: [], unmatched: 'default' },
    cert_status: [{ role: 'server', file: '/etc/rproxy/tls/dashboard.pem', not_after: 1, days_left: 10, state: 'ok' }],
    state: 'failed', error: 'cannot read /etc/rproxy/tls/dashboard.key', resolved: [], connections: 0, origin: 'static',
  };

  it('the dashboard and the detail show static rules to users without file paths; admins see them', async () => {
    mocks.listRules.mockResolvedValue([staticRule]);
    const dash = await call('dashboard', undefined, 'GET');
    expect(dash.status).toBe(200);
    const row = dash.body.rules.find((r: { origin: string }) => r.origin === 'static');
    expect(JSON.stringify(row)).not.toContain('/etc/rproxy');
    expect(row.tls.certificates[0]).toEqual({ cert_file: HIDDEN_FILE, key_file: HIDDEN_FILE });
    expect(row.error).toBe(`cannot read ${HIDDEN_FILE}`);

    mocks.getRule.mockResolvedValue(staticRule);
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toContain('/etc/rproxy');

    mocks.getServerSession.mockResolvedValue(admin);
    const adminDash = await call('dashboard', undefined, 'GET');
    expect(JSON.stringify(adminDash.body)).toContain('/etc/rproxy/tls/dashboard.key');
  });
});

describe('import (#155)', () => {
  it('the dry run already reports a user’s new rule with a file path or a refused destination', async () => {
    const text = JSON.stringify({ format: 'rproxy-ui-export', version: 1, rules: [
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9001, remote_addr: '192.0.2.5', remote_port: 80 },
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9002, remote_addr: '127.0.0.1', remote_port: 3306 },
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9003, remote_addr: '192.0.2.5', remote_port: 80, tls: { mode: 'terminate', certificates: [{ cert_file: '/a.pem', key_file: '/a.key' }] } },
    ] });
    const res = await call('import', { text: text, dryRun: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((i: { status: string }) => i.status)).toEqual(['new', 'error', 'error']);
    mocks.getServerSession.mockResolvedValue(admin);
    const byAdmin = await call('import', { text: text, dryRun: true });
    expect(byAdmin.body.items.map((i: { status: string }) => i.status)).toEqual(['new', 'new', 'new']);
  });
});

describe('review fixes (#155)', () => {
  const l7 = (url: string, extra: Record<string, unknown> = {}) => ({ routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: url }] } }, ...extra });

  it.each(['http://169.254.169.254:65536/', 'http://127.0.0.1:8a/', 'http://[fe80::1%25eth0]/'])('a service URL %s is refused for everyone (400 invalid)', async (url) => {
    const res = await call('add', { ...tcpRule, distAddr: '', distPort: 0, http: l7(url) });
    expect([res.status, res.body.code]).toEqual([400, 'invalid']);
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await call('add', { ...tcpRule, distAddr: '', distPort: 0, http: l7(url) })).status).toBe(400);
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('an unreadable URL already stored on a user’s rule is refused on modify (403 target_not_allowed), not kept', async () => {
    storedRule({ dist_addr: '', dist_port: 0, options: { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, http: l7('http://169.254.169.254:65536/') } });
    const res = await call('modify', { ...tcpRule, distAddr: '', distPort: 0, allowFrom: ['10.0.0.0/8'] });
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([403, 'target_not_allowed']);
    expect(mocks.modifyRule).not.toHaveBeenCalled();
  });

  it('a user keeps an unchanged oidc middleware but may not change it (403 middleware_not_allowed)', async () => {
    const oidc = { issuer: 'https://idp.example.com/realms/x', client_id: 'c', client_secret_file: '/s/c', cookie_secret_file: '/s/k' };
    const http = (o: Record<string, unknown>) => ({ routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['o'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { o: { oidc: o } } });
    storedRule({ dist_addr: '', dist_port: 0, options: { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, http: http(oidc) } });
    expect((await call('modify', { ...tcpRule, distAddr: '', distPort: 0, http: http(oidc) })).status).toBe(200);
    const changed = await call('modify', { ...tcpRule, distAddr: '', distPort: 0, http: http({ ...oidc, client_id: 'other' }) });
    expect([changed.status, changed.body.code]).toEqual([403, 'middleware_not_allowed']);
  });

  // #175：cache の大きさの上限と、共有の設定
  it('a user\'s cache must stay within RPROXY_UI_USER_CACHE_MAX_* and may not share after auth (403)', async () => {
    const http = (cache: Record<string, unknown>) => ({ routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['c'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { c: { cache } } });
    const add = (cache: Record<string, unknown>) => call('add', { ...tcpRule, distAddr: '', distPort: 0, http: http(cache) });
    const omitted = await add({ ttl: '1s' });
    expect([omitted.status, omitted.body.code]).toEqual([403, 'cache_limit']);
    expect(omitted.body.error).toContain('RPROXY_UI_USER_CACHE_MAX_MEMORY');
    expect((await add({ ttl: '1s', max_memory: 8388608, share_after_auth: true })).body.code).toBe('middleware_not_allowed');
    expect((await add({ ttl: '1s', max_memory: 8388608, share_credentials: true })).body.code).toBe('middleware_not_allowed');
    expect(mocks.addRule).not.toHaveBeenCalled();
    vi.stubEnv('RPROXY_UI_USER_CACHE_MAX_MEMORY', '128MiB');
    expect((await add({ ttl: '1s' })).status).toBe(200);
    vi.stubEnv('RPROXY_UI_USER_CACHE_MAX_ENTRIES', '10');
    expect((await add({ ttl: '1s', max_entries: 11 })).body.code).toBe('cache_limit');
    // admins are not limited
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await add({ ttl: '1s', max_entries: 5000, share_after_auth: true })).status).toBe(200);
  });

  it('a user keeps an unchanged cache over the limits but may not change it', async () => {
    const http = (cache: Record<string, unknown>) => ({ routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's', middlewares: ['c'] }], services: { s: { servers: [{ url: 'http://192.0.2.9' }] } }, middlewares: { c: { cache } } });
    const stored = { ttl: '1s', share_after_auth: true };
    storedRule({ dist_addr: '', dist_port: 0, options: { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, http: http(stored) } });
    expect((await call('modify', { ...tcpRule, distAddr: '', distPort: 0, http: http(stored) })).status).toBe(200);
    const changed = await call('modify', { ...tcpRule, distAddr: '', distPort: 0, http: http({ ...stored, ttl: '2s' }) });
    expect([changed.status, changed.body.code]).toEqual([403, 'middleware_not_allowed']);
  });

  it('the L4 health check port and RPROXY_UI_PROTECTED_TARGETS are checked', async () => {
    vi.stubEnv('RPROXY_UI_PROTECTED_TARGETS', '192.0.2.1:3306');
    const body = { ...tcpRule, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }], healthCheck: { port: 3306 } };
    const res = await call('add', body);
    expect([res.status, res.body.code]).toEqual([403, 'target_not_allowed']);
    expect(res.body.error).toContain('RPROXY_UI_PROTECTED_TARGETS');
    expect((await call('add', { ...body, healthCheck: { port: 8080 } })).status).toBe(200);
  });

});
