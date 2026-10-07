// エクスポート / インポート（#60）と、変更の履歴・巻き戻し（#61）の API route
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => {
  const conn = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    query: vi.fn(),
  };
  const pool = {
    getConnection: vi.fn(),
    query: vi.fn(),
  };
  return {
    conn,
    pool,
    getServerSession: vi.fn(),
    addRule: vi.fn(),
    modifyRule: vi.fn(),
    deleteRule: vi.fn(),
    listRules: vi.fn(),
    getRule: vi.fn(),
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
  addRule: mocks.addRule,
  modifyRule: mocks.modifyRule,
  deleteRule: mocks.deleteRule,
  listRules: mocks.listRules,
  getRule: mocks.getRule,
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';
import { DEFAULT_BALANCE, DEFAULT_UDP_IDLE_SECS, ForwardRule } from '@/components/lib';
import { optionsJson } from '@/components/tls';
import { exportDoc, formatDoc, parseDoc, settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { ruleChanges } from '@/components/history';

const { conn, pool } = mocks;

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };
const asAdmin = () => mocks.getServerSession.mockResolvedValue({ ...session, user: { ...session.user, id: 'admin-1', roles: ['rproxy-admin'], role: 'rproxy-admin' } });

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body } as unknown as NextApiRequest;
  const res: any = { headers: {} as Record<string, string> };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.setHeader = vi.fn((k: string, v: string) => { res.headers[k] = v; return res; });
  return handler(req, res as NextApiResponse).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
    text: res.send.mock.calls[0]?.[0] as string | undefined,
    headers: res.headers as Record<string, string>,
  }));
}

function rule(patch: Partial<ForwardRule>): ForwardRule {
  return {
    protocol: 'tcp',
    srcAddr: '0.0.0.0',
    srcPort: 8000,
    srcPortEnd: null,
    distAddr: '10.0.0.10',
    distPort: 80,
    sourceIp: 'proxy',
    udpIdleSecs: DEFAULT_UDP_IDLE_SECS,
    tls: { mode: 'passthrough' },
    starttls: null,
    starttlsRequired: true,
    allowFrom: [],
    http: null,
    crowdsec: false,
    targets: [],
    balance: DEFAULT_BALANCE,
    healthCheck: null,
    extraListenAddrs: [],
    ...patch,
  };
}

// DB の forward_rules / forward_rules_log の行
function row(r: ForwardRule, extra: Record<string, unknown> = {}) {
  return {
    auth_id: 'user-1',
    protocol: r.protocol,
    src_addr: r.srcAddr,
    src_port: r.srcPort,
    src_port_end: r.srcPortEnd,
    dist_addr: r.distAddr,
    dist_port: r.distPort,
    source_ip: r.sourceIp,
    udp_idle_secs: r.udpIdleSecs,
    options: optionsJson(r.tls, r.starttls, r.starttlsRequired, r.allowFrom, r.http, r.crowdsec,
      { targets: r.targets, balance: r.balance, healthCheck: r.healthCheck }, r.extraListenAddrs ?? []),
    ...extra,
  };
}

// rproxy-api の docs/API.md「Gateway API 向けの L7・TLS」の例（cleanHttp の形）
const GATEWAY_HTTP = {
  routes: [{
    name: 'r0', match: 'Host(`app.example`) && PathPrefix(`/api/`)', service: 'r0',
    middlewares: ['r0-hdr', 'r0-cors', 'r0-mirror', 'r0-retry'], timeouts: { request: '10s', backend_request: '2s' },
  }],
  services: {
    r0: {
      servers: [
        { url: 'http://10.1.0.5:8080', weight: 5, middlewares: ['r0-b0'] },
        { status: 500, weight: 10 },
      ],
      protocol: 'h2c',
    },
    'r0-shadow': { servers: [{ url: 'http://10.1.0.9:8080' }] },
    'tls-svc': {
      servers: [{ url: 'https://10.1.0.7:8443' }],
      tls: { server_name: 'abc.example.com', ca_file: '/var/run/certs/ca.crt', subject_alt_names: ['abc.example.com', 'spiffe://abc.example.com/id'] },
    },
  },
  middlewares: {
    'r0-hdr': { headers: { request: { set: { 'X-Header-Set': 'v' }, add: { 'X-Header-Add': 'v' }, remove: ['X-Header-Remove'] } } },
    'r0-b0': { headers: { request: { set: { Backend: 'v1' } } } },
    'r0-cors': { cors: { allow_origins: ['https://www.foo.com', 'https://*.bar.com'], allow_methods: ['GET', 'OPTIONS'], allow_credentials: true, max_age: 3600 } },
    'r0-mirror': { mirror: { service: 'r0-shadow', fraction: { numerator: 1, denominator: 3 } } },
    'r0-retry': { retry: { attempts: 4, status: ['500', '502-504'], initial_interval: '100ms' } },
    'r0-host': { replace_host: { host: 'one.example.org' } },
    'r0-redirect': { redirect_regex: { regex: '^http://([^/:]+)(:\\d+)?/(.*)$', replacement: 'https://$1/$3', status: 303 } },
  },
};

// いろいろな設定のルール（エクスポートして読み込み直すと同じになること）
const RULES: ForwardRule[] = [
  rule({}),
  rule({ protocol: 'udp', srcPort: 5000, srcPortEnd: 5010, distPort: 6000, sourceIp: 'proxy_v2', udpIdleSecs: 120, allowFrom: ['10.0.0.0/8'] }),
  rule({
    srcPort: 443,
    distAddr: '',
    distPort: 0,
    tls: {
      mode: 'terminate',
      // normalizeTls の並び（DB の行はこの形で入っている）
      routes: [{ server_names: ['registry.example.com', '**.tenant.example.com'], remote_addr: '10.0.1.10', remote_port: 443, passthrough: true }],
      certificates: [{ cert_file: '/etc/rproxy/tls/a.pem', key_file: '/etc/rproxy/tls/a.key' }],
    },
    http: { routes: [{ name: 'all', match: 'PathPrefix(`/`)', to: 'http://10.0.0.20:8080' }] },
  }),
  rule({
    srcPort: 5432,
    distAddr: '',
    distPort: 0,
    targets: [{ addr: '10.0.0.11', port: 5432, weight: 2 }, { addr: 'db-backup.internal', port: 5432, backup: true }],
    balance: 'least_conn',
    healthCheck: { interval: '10s', timeout: '3s' },
    extraListenAddrs: ['::'],
    crowdsec: true,
  }),
  rule({ srcPort: 587, tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/c.key' }] }, starttls: 'smtp', starttlsRequired: false }),
  // Gateway API 向けの L7 の項目（rproxy-api #237）
  rule({ srcPort: 8443, distAddr: '', distPort: 0, http: GATEWAY_HTTP }),
  // tls.routes[] の targets / balance（#234）
  rule({
    srcPort: 9443,
    tls: {
      mode: 'sni',
      routes: [
        { server_name: 'a.example.com', targets: [{ addr: '10.0.2.1', port: 443, weight: 3 }, { addr: '10.0.2.2', port: 443, backup: true }], balance: 'failover' },
        { server_name: 'b.example.com', remote_addr: '10.0.3.1', remote_port: 443 },
      ],
    },
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
  mocks.listRules.mockResolvedValue([]);
  mocks.getRule.mockRejectedValue(new RproxyError('not found', 'not_found', 404));
});

describe('settings document conversion', () => {
  it('leaves out default values but keeps everything else', () => {
    expect(toSettingsRule(RULES[0])).toEqual({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8000, remote_addr: '10.0.0.10', remote_port: 80 });
    const udp = toSettingsRule(RULES[1]);
    expect(udp).toMatchObject({ listen_port_end: 5010, source_ip: 'proxy_v2', udp_idle_secs: 120, allow_from: ['10.0.0.0/8'] });
    expect(toSettingsRule(RULES[3])).toMatchObject({ balance: 'least_conn', health_check: { interval: '10s', timeout: '3s' }, crowdsec: true, extra_listen_addrs: ['::'] });
    expect(toSettingsRule(RULES[3])).not.toHaveProperty('remote_addr');
  });

  it('reads the settings file shape and a plain array, and rejects unknown keys', () => {
    expect(parseDoc('version: 1\nglobal: {trusted_proxies: [10.0.0.0/8]}\nrules:\n  - {protocol: tcp}\n')).toEqual({ rules: [{ protocol: 'tcp' }], ignoredGlobal: true, uiExport: false });
    expect(parseDoc('[{"protocol": "udp"}]')).toEqual({ rules: [{ protocol: 'udp' }], ignoredGlobal: false, uiExport: false });
    expect(() => parseDoc('version: 2\nrules: []')).toThrow(/version/);
    expect(() => parseDoc('rulez: []')).toThrow(/知らない項目/);
    expect(() => parseDoc('rules: {a: 1}')).toThrow(/配列/);
    expect(() => parseDoc(': : :')).toThrow();
    expect(() => settingsRuleToBody({ protocol: 'tcp', remote: 'x' })).toThrow(/remote/);
    expect(settingsRuleToBody({ listen_addr: '::1', health_check: { port: 1 } })).toEqual({ srcAddr: '::1', healthCheck: { port: 1 } });
  });

  it('exports JSON marked as a UI export, which rproxy would refuse as a settings file', () => {
    const doc = exportDoc([RULES[0]], '2026-09-28T00:00:00.000Z');
    expect(doc).toMatchObject({ format: 'rproxy-ui-export', version: 1, exported_at: '2026-09-28T00:00:00.000Z' });
    expect(JSON.parse(formatDoc(doc))).toEqual(doc);
    // the export reads back; the format marker tells it apart from a settings file
    expect(parseDoc(formatDoc(doc))).toMatchObject({ uiExport: true, rules: doc.rules });
    expect(parseDoc('version: 1\nrules: []\n').uiExport).toBe(false);
    expect(() => parseDoc('{"format": "other", "rules": []}')).toThrow(/format/);
    expect(() => parseDoc('{"format": "rproxy-ui-export", "global": {}, "rules": []}')).toThrow(/global/);
    // enabled (paused) belongs to the UI export only
    expect(() => parseDoc('version: 1\nrules:\n  - {protocol: tcp, enabled: false}\n')).toThrow(/enabled/);
    expect(parseDoc('{"format": "rproxy-ui-export", "version": 1, "rules": [{"protocol": "tcp", "enabled": false}]}').rules).toHaveLength(1);
  });
});

describe('/api/forward/export and /api/forward/import', () => {
  it('exports own rules (admin: all or one owner) as a downloadable file', async () => {
    pool.query.mockResolvedValueOnce(RULES.map((r) => row(r)));
    const out = await call('export', undefined, 'GET');
    expect(out.status).toBe(200);
    expect(out.headers['Content-Disposition']).toMatch(/attachment; filename="rproxy-ui-export-\d{8}\.json"/);
    expect(out.headers['Content-Type']).toContain('application/json');
    const exported = JSON.parse(out.text ?? '');
    expect({ ...exported, exported_at: undefined }).toEqual({ ...exportDoc(RULES), exported_at: undefined });
    expect(pool.query.mock.calls[0]).toEqual([expect.stringContaining('WHERE auth_id = ?'), ['user-1']]);

    asAdmin();
    pool.query.mockResolvedValueOnce([]);
    await call('export', undefined, 'GET');
    expect(pool.query.mock.calls[1][0]).not.toContain('WHERE');
    pool.query.mockResolvedValueOnce([]);
    const json = await call('export', undefined, 'GET', { owner: 'user-2' });
    expect(pool.query.mock.calls[2]).toEqual([expect.stringContaining('WHERE auth_id = ?'), ['user-2']]);
    expect(json.headers['Content-Type']).toContain('application/json');
  });

  it('exported rules imported again give the same rules (DB options and what rproxy receives)', async () => {
    pool.query.mockResolvedValueOnce(RULES.map((r) => row(r)));
    const exported = (await call('export', undefined, 'GET', {})).text ?? '';

    pool.query.mockResolvedValue([]); // nothing in the DB yet
    const out = await call('import', { text: exported });
    expect(out.status).toBe(200);
    expect(out.body.results.map((r: { result: string }) => r.result)).toEqual(RULES.map(() => 'added'));
    // rproxy got exactly the same rules
    expect(mocks.addRule.mock.calls.map((c) => c[0])).toEqual(RULES.map(toRproxyRule));
    // and the DB the same rows
    const inserts = conn.query.mock.calls.filter((c) => String(c[0]).startsWith('INSERT INTO forward_rules ('));
    expect(inserts.map((c) => (c[1] as unknown[]).slice(1))).toEqual(RULES.map((r) => {
      const x = row(r);
      return [x.protocol, x.src_addr, x.src_port, x.src_port_end, x.dist_addr, x.dist_port, x.source_ip, x.udp_idle_secs, x.options];
    }));
  });

  it('checks first (dry run) and reports new / existing / errors without changing anything', async () => {
    pool.query.mockResolvedValueOnce([
      { auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8000 },
      { auth_id: 'user-2', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 9000 },
    ]);
    mocks.listRules.mockResolvedValueOnce([{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9100, origin: 'static' }]);
    const text = [
      'version: 1',
      'global: {trusted_proxies: [10.0.0.0/8]}',
      'rules:',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8000, remote_addr: a.example, remote_port: 80}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8001, remote_addr: a.example, remote_port: 80}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8001, remote_addr: b.example, remote_port: 80}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 9000, remote_addr: a.example, remote_port: 80}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 9100, remote_addr: a.example, remote_port: 80}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8002, remote_addr: a.example, remote_port: 0}',
      '  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8003, remote_addr: a.example, remote_port: 80, color: red}',
    ].join('\n');
    const out = await call('import', { text: text, dryRun: true });
    expect(out.status).toBe(200);
    expect(out.body.ignoredGlobal).toBe(true);
    expect(out.body.items.map((i: { key: string; status: string }) => [i.key, i.status])).toEqual([
      ['tcp|0.0.0.0|8000', 'exists'],
      ['tcp|0.0.0.0|8001', 'new'],
      ['tcp|0.0.0.0|8001', 'error'],
      ['tcp|0.0.0.0|9000', 'error'],
      ['tcp|0.0.0.0|9100', 'error'],
      ['tcp|0.0.0.0|8002', 'error'],
      ['tcp|0.0.0.0|8003', 'error'],
    ]);
    const messages = out.body.items.map((i: { message?: string }) => i.message ?? '');
    expect(messages[2]).toMatch(/2 つ/);
    expect(messages[3]).toMatch(/ほかの利用者/);
    expect(messages[4]).toMatch(/固定ルール/);
    expect(messages[5]).toMatch(/ポート番号/);
    expect(messages[6]).toMatch(/color/);
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('skips existing rules unless asked to replace them, and keeps going after a failure', async () => {
    const existing = rule({ srcPort: 8000, distAddr: 'old.example' });
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT auth_id, protocol, src_addr, src_port FROM forward_rules')) {
        return [{ auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8000 }];
      }
      if (sql.startsWith('SELECT auth_id, protocol')) return [row(existing)];
      return [];
    });
    conn.query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? [row(existing)] : { affectedRows: 1 }));
    mocks.addRule.mockRejectedValueOnce(new RproxyError('port in use', 'bind_failed', 409));
    const text = [
      '- {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8000, remote_addr: new.example, remote_port: 80}',
      '- {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8001, remote_addr: a.example, remote_port: 80}',
      '- {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 8002, remote_addr: a.example, remote_port: 80}',
    ].join('\n');

    const skipped = await call('import', { text: text });
    expect(skipped.body.results.map((r: { result: string }) => r.result)).toEqual(['skipped', 'error', 'added']);
    expect(skipped.body.results[1].message).toBe('port in use');
    expect(mocks.modifyRule).not.toHaveBeenCalled();

    mocks.addRule.mockClear();
    const replaced = await call('import', { text: text, replace: ['tcp|0.0.0.0|8000'] });
    expect(replaced.body.results.map((r: { result: string }) => r.result)).toEqual(['replaced', 'added', 'added']);
    expect(mocks.modifyRule).toHaveBeenCalledWith(
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8000 },
      expect.objectContaining({ remote_addr: 'new.example', remote_port: 80 }),
    );
  });

  it('respects RPROXY_UI_USER_PORTS and refuses empty input', async () => {
    vi.stubEnv('RPROXY_UI_USER_PORTS', '1024-65535');
    pool.query.mockResolvedValue([]);
    const out = await call('import', { text: '- {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 443, remote_addr: a.example, remote_port: 80}', dryRun: true });
    expect(out.body.items[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/管理者だけ/) });
    expect((await call('import', { text: '  ' })).status).toBe(400);
    expect((await call('import', { text: 'rules: [' })).status).toBe(400);
  });
});

describe('/api/forward/history and /api/forward/revert', () => {
  const v1 = rule({ srcPort: 8000, distAddr: 'one.example' });
  const v2 = rule({ srcPort: 8000, distAddr: 'two.example', allowFrom: ['10.0.0.0/8'] });
  const logRow = (id: number, r: ForwardRule, action: string, extra: Record<string, unknown> = {}) =>
    ({ ...row(r), id: id, update_action: action, updated_at: new Date('2026-09-27T10:00:00Z'), ...extra });

  it('lists the history with the change from the previous version; users see only their own', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: BigInt(2) }];
      if (sql.includes('l.id < ?')) return [logRow(1, v1, 'ADD')];
      return [logRow(2, v2, 'UPDATE'), logRow(1, v1, 'ADD')];
    });
    const out = await call('history', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8000', action: 'update', from: '2026-09-01', to: '2026-09-30', page: '2', per_page: '10' });
    expect(out.status).toBe(200);
    expect(out.body.total).toBe(2);
    expect(out.body.page).toBe(2);
    expect(out.body.entries[0]).toMatchObject({ id: 2, action: 'UPDATE', actor: 'user-1', at: '2026-09-27T10:00:00.000Z', revertible: true });
    expect(out.body.entries[0].changes).toEqual(ruleChanges(v1, v2));
    expect(out.body.entries[0].changes).toContain('転送先: one.example:80 → two.example:80');
    expect(out.body.entries[1].changes).toEqual([]);

    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(countSql).toContain('l.auth_id = ? OR EXISTS');
    expect(countParams).toEqual(['user-1', 'user-1', 'tcp', '0.0.0.0', 8000, 'UPDATE', '2026-09-01 00:00:00', '2026-09-30 00:00:00']);
    const pageCall = pool.query.mock.calls[1];
    expect(pageCall[1].slice(-2)).toEqual([10, 10]);
  });

  it('admin sees everything and can filter by user; bad filters are 400', async () => {
    asAdmin();
    pool.query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT COUNT(*)') ? [{ n: 0 }] : []));
    await call('history', undefined, 'GET', { user: 'user-2' });
    expect(pool.query.mock.calls[0][0]).not.toContain('EXISTS');
    expect(pool.query.mock.calls[0][1]).toEqual(['user-2']);
    const bad: Record<string, string>[] = [{ protocol: 'sctp' }, { addr: 'x' }, { port: '0' }, { action: 'MOVE' }, { from: '2026/09/01' }];
    for (const q of bad) {
      expect((await call('history', undefined, 'GET', q)).status).toBe(400);
    }
  });

  it('reverts: re-creates a deleted rule, replaces an existing one, refuses what the user cannot see', async () => {
    // deleted: not in forward_rules any more
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM forward_rules_log l')) return [logRow(5, v1, 'DELETE')];
      return [];
    });
    const added = await call('revert', { id: 5 });
    expect(added.status).toBe(200);
    expect(added.body.result).toBe('added');
    expect(mocks.addRule).toHaveBeenCalledWith(toRproxyRule(v1));

    // exists: replaced in place (PATCH)
    mocks.addRule.mockClear();
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM forward_rules_log l')) return [logRow(6, v1, 'UPDATE')];
      if (sql.startsWith('SELECT auth_id FROM forward_rules')) return [{ auth_id: 'user-1' }];
      if (sql.startsWith('SELECT auth_id, protocol')) return [row(v2)];
      return [];
    });
    conn.query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? [row(v2)] : { affectedRows: 1 }));
    const modified = await call('revert', { id: 6 });
    expect(modified.body.result).toBe('modified');
    expect(mocks.modifyRule).toHaveBeenCalledWith(
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8000 },
      expect.objectContaining({ remote_addr: 'one.example', allow_from: [] }),
    );
    expect(mocks.addRule).not.toHaveBeenCalled();

    // a version with a different source_ip is re-created (delete + add)
    const v3 = rule({ srcPort: 8000, distAddr: 'three.example', sourceIp: 'proxy_v2' });
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM forward_rules_log l')) return [logRow(7, v3, 'UPDATE')];
      if (sql.startsWith('SELECT auth_id FROM forward_rules')) return [{ auth_id: 'user-1' }];
      if (sql.startsWith('SELECT auth_id, protocol')) return [row(v2)];
      return [];
    });
    const recreated = await call('revert', { id: 7 });
    expect(recreated.body.result).toBe('recreated');
    expect(mocks.deleteRule).toHaveBeenCalled();
    expect(mocks.addRule).toHaveBeenCalledWith(toRproxyRule(v3));

    // outside the user's history: 404; bad id: 400; static rule: 409
    pool.query.mockResolvedValue([]);
    expect((await call('revert', { id: 99 })).status).toBe(404);
    expect((await call('revert', { id: 'x' })).status).toBe(400);
    pool.query.mockImplementation(async (sql: string) => (sql.includes('FROM forward_rules_log l') ? [logRow(8, v1, 'ADD')] : []));
    mocks.getRule.mockResolvedValueOnce({ origin: 'static' });
    expect((await call('revert', { id: 8 })).status).toBe(409);
  });
});
