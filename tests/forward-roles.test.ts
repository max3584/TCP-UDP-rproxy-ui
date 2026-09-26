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

const { conn, pool } = mocks;

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };

const tcpRule = {
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8888,
  distAddr: 'example.com',
  distPort: 80,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
};

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
  }));
}

function sqlCalls(): [string, unknown[]][] {
  return conn.query.mock.calls as [string, unknown[]][];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
});

// ロール（rproxy-admin / rproxy-user）と、rproxy が UI のトークンを断ったとき（#4、#44）
describe('/api/forward/[forward]: roles and the UI token', () => {
  const as = (roles: string[], id = 'user-1') =>
    mocks.getServerSession.mockResolvedValue({ ...session, user: { ...session.user, id: id, roles: roles, role: roles.join(',') } });

  it('refuses users without rproxy-user or rproxy-admin (403 no_role) before touching the DB', async () => {
    vi.stubEnv('RPROXY_UI_USER_ROLE', 'rproxy-user');
    for (const roles of [[], ['offline_access']]) {
      as(roles);
      for (const [action, method] of [['list', 'GET'], ['dashboard', 'GET'], ['add', 'POST'], ['modify', 'POST'], ['delete', 'POST']]) {
        const { status, body } = await call(action, tcpRule, method);
        expect([action, status, body.code]).toEqual([action, 403, 'no_role']);
      }
    }
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('an old session without roles is refused too when a user role is required', async () => {
    vi.stubEnv('RPROXY_UI_USER_ROLE', 'rproxy-user');
    mocks.getServerSession.mockResolvedValue({ ...session, user: { ...session.user, roles: undefined } });
    expect((await call('list', undefined, 'GET')).status).toBe(403);
    vi.unstubAllEnvs();
  });

  it('by default (RPROXY_UI_USER_ROLE unset or empty) everyone who signs in is a user', async () => {
    vi.stubEnv('RPROXY_UI_USER_ROLE', '');
    try {
      as([]);
      pool.query.mockResolvedValue([]);
      mocks.listRules.mockResolvedValue([]);
      expect((await call('list', undefined, 'GET')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a user lists only own rules; an admin lists everyone’s with the owner', async () => {
    const row = { id: 1, auth_id: 'someone-else', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 80, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30 };
    pool.query.mockResolvedValue([row]);
    mocks.listRules.mockResolvedValue([]);

    as(['rproxy-user']);
    let res = await call('dashboard', undefined, 'GET');
    let [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE auth_id = ?');
    expect(params).toEqual(['user-1']);
    expect(res.body.admin).toBeUndefined();
    expect(res.body.rules[0].owner).toBeUndefined();

    pool.query.mockClear();
    as(['rproxy-admin']);
    res = await call('dashboard', undefined, 'GET');
    [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('auth_id = ?');
    expect(params).toEqual([]);
    expect(res.body.admin).toBe(true);
    expect(res.body.rules[0].owner).toBe('someone-else');
  });

  it('an admin changes and deletes another user’s rule; the log records the admin', async () => {
    as(['rproxy-admin'], 'admin-1');
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old', dist_port: 81, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.modifyRule.mockResolvedValue({});
    expect((await call('modify', tcpRule)).status).toBe(200);
    const [lock, lockParams] = sqlCalls()[0];
    expect(lock).toMatch(/^SELECT .* WHERE protocol = \? AND src_addr = \? AND src_port = \? FOR UPDATE$/);
    expect(lockParams).toEqual(['tcp', '0.0.0.0', 8888]);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    expect(update?.[0]).not.toContain('auth_id');
    const log = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules_log'));
    expect(log?.[1][0]).toBe('admin-1');

    conn.query.mockReset();
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old', dist_port: 81, source_ip: 'proxy', udp_idle_secs: 30 }]);
    conn.query.mockResolvedValue({ affectedRows: 1 });
    mocks.deleteRule.mockResolvedValue(undefined);
    expect((await call('delete', tcpRule)).status).toBe(200);
    const del = sqlCalls().find(([sql]) => sql.startsWith('DELETE FROM forward_rules'));
    expect(del?.[0]).not.toContain('auth_id');
  });

  it('an admin reads another user’s rule; a user gets 404 for it', async () => {
    const row = { id: 5, auth_id: 'someone-else', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8888, dist_addr: 'a', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 };
    mocks.getRule.mockRejectedValue(new RproxyError('no', 'not_found', 404));
    as(['rproxy-admin'], 'admin-1');
    pool.query.mockResolvedValueOnce([row]);
    let res = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8888' });
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe('someone-else');

    as(['rproxy-user']);
    pool.query.mockResolvedValueOnce([]);
    res = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8888' });
    expect(res.status).toBe(404);
  });

  it('RPROXY_UI_USER_PORTS limits users (not admins) to a listen port range', async () => {
    vi.stubEnv('RPROXY_UI_USER_PORTS', '1024-65535');
    try {
      as(['rproxy-user']);
      let res = await call('add', { ...tcpRule, srcPort: 443 });
      expect([res.status, res.body.code]).toEqual([403, 'port_not_allowed']);
      res = await call('add', { ...tcpRule, srcPort: 1000, srcPortEnd: 1100 });
      expect([res.status, res.body.code]).toEqual([403, 'port_not_allowed']);
      expect(mocks.addRule).not.toHaveBeenCalled();

      mocks.addRule.mockResolvedValue({});
      expect((await call('add', { ...tcpRule, srcPort: 8443 })).status).toBe(200);
      as(['rproxy-admin']);
      expect((await call('add', { ...tcpRule, srcPort: 443 })).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rproxy refusing the UI token (401) is a 502 rproxy_unauthorized, not "sign in again"', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('missing or invalid bearer token', 'unauthorized', 401));
    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('rproxy_unauthorized');
    expect(body.error).toContain('RPROXY_API_TOKEN');

    pool.query.mockResolvedValue([]);
    mocks.listRules.mockRejectedValue(new RproxyError('missing or invalid bearer token', 'unauthorized', 401));
    const dash = await call('dashboard', undefined, 'GET');
    expect(dash.body.rproxyError).toContain('RPROXY_API_TOKEN');
  });
});

// ルールの crowdsec（L4 の CrowdSec。rproxy v0.3.2 から）
describe('/api/forward/[forward]: crowdsec on L4 rules', () => {
  it('add sends crowdsec only when on and stores it in options', async () => {
    mocks.addRule.mockResolvedValue({});
    expect((await call('add', { ...tcpRule, crowdsec: true })).status).toBe(200);
    expect(mocks.addRule.mock.calls[0][0].crowdsec).toBe(true);
    expect(JSON.parse(sqlCalls()[0][1][9] as string).crowdsec).toBe(true);

    conn.query.mockClear();
    expect((await call('add', { ...tcpRule, srcPort: 8889 })).status).toBe(200);
    // 既定（false）は送らず、options も NULL のまま（古い rproxy は知らない項目を拒否する）
    expect(mocks.addRule.mock.calls[1][0]).not.toHaveProperty('crowdsec');
    expect(sqlCalls()[0][1][9]).toBeNull();

    expect((await call('add', { ...tcpRule, crowdsec: 'yes' })).status).toBe(400);
  });

  it('modify toggles crowdsec with PATCH, keeps it when omitted, and undoes it', async () => {
    const stored = JSON.stringify({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, crowdsec: true });
    const row = { dist_addr: 'a', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: stored };
    mocks.modifyRule.mockResolvedValue({});

    conn.query.mockResolvedValueOnce([row]);
    expect((await call('modify', { ...tcpRule, crowdsec: false })).status).toBe(200);
    expect(mocks.modifyRule.mock.calls[0][1].crowdsec).toBe(false);

    conn.query.mockResolvedValueOnce([row]);
    expect((await call('modify', tcpRule)).status).toBe(200);
    expect(mocks.modifyRule.mock.calls[1][1].crowdsec).toBe(true);

    // L4 で使っていない（false のまま）なら PATCH に付けない
    conn.query.mockResolvedValueOnce([{ ...row, options: null }]);
    expect((await call('modify', { ...tcpRule, crowdsec: false })).status).toBe(200);
    expect(mocks.modifyRule.mock.calls[2][1]).not.toHaveProperty('crowdsec');

    // COMMIT に失敗したら元の値（true）に戻す
    mocks.modifyRule.mockClear();
    conn.query.mockResolvedValueOnce([row]);
    conn.commit.mockRejectedValueOnce(new Error('commit failed'));
    await call('modify', { ...tcpRule, crowdsec: false });
    expect(mocks.modifyRule.mock.calls.map((c) => c[1].crowdsec)).toEqual([false, true]);
  });
});
