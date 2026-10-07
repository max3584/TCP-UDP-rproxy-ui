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
    planAdd: vi.fn(),
    planModify: vi.fn(),
    planDelete: vi.fn(),
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
  planAdd: mocks.planAdd,
  planModify: mocks.planModify,
  planDelete: mocks.planDelete,
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



const admin = { user: { ...session.user, id: 'admin-1', roles: ['rproxy-admin'] }, expires: '' };

const live = (over: Record<string, unknown> = {}) => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9000, remote_addr: '10.0.0.9', remote_port: 80, source_ip: 'proxy', udp_idle_secs: 30,
  tls: { mode: 'passthrough' }, state: 'running', error: null, resolved: [], connections: 1, ...over,
});

const stored = { node: 'host1', protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9100, spec: JSON.stringify({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9100, remote_addr: '10.0.0.10', remote_port: 81 }), created_by: 'ci-deploy', created_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'ci-deploy', updated_at: new Date('2026-10-01T00:00:00Z') };

// pool.query を SQL ごとに返す
function poolRows(rules: unknown[], apiRows: unknown[] | Error) {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM rproxy_rules')) {
      if (apiRows instanceof Error) throw apiRows;
      return apiRows;
    }
    return rules;
  });
}

describe('rproxy の API のルール（#76）', () => {
  it('管理者のダッシュボードに、rproxy で動く API のルールと rproxy_rules にあるが動いていないルールを出す', async () => {
    mocks.getServerSession.mockResolvedValue(admin);
    poolRows([], [stored]);
    mocks.listRules.mockResolvedValue([
      live({ origin: 'api', persisted: true, created_by: 'ci-deploy', created_at: 1790000000 }),
      live({ listen_port: 9001, origin: 'dynamic', ruleset: 'k8s/default/web' }),
      live({ listen_port: 9002, origin: 'static' }),
    ]);
    const { body } = await call('dashboard', undefined, 'GET');
    const byPort = Object.fromEntries(body.rules.map((r: any) => [r.srcPort, r]));
    expect(byPort[9000]).toMatchObject({ origin: 'api', persisted: true, createdBy: 'ci-deploy', createdAt: 1790000000, state: 'running' });
    expect(byPort[9001]).toMatchObject({ origin: 'api', ruleset: 'k8s/default/web', persisted: false });
    expect(byPort[9002].origin).toBe('static');
    expect(byPort[9100]).toMatchObject({ origin: 'api', state: 'missing', persisted: true, createdBy: 'ci-deploy', distAddr: '10.0.0.10', createdAt: 1790812800 });
  });

  it('利用者には API のルールを出さない（固定ルールは出す）。rproxy_rules がなくても動く', async () => {
    poolRows([], new Error('no table'));
    mocks.listRules.mockResolvedValue([live({ origin: 'api' }), live({ listen_port: 9002, origin: 'static' })]);
    const { body } = await call('dashboard', undefined, 'GET');
    expect(body.rules.map((r: any) => r.srcPort)).toEqual([9002]);
    expect(pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes('rproxy_rules'))).toBe(false);

    mocks.getServerSession.mockResolvedValue(admin);
    poolRows([], Object.assign(new Error("Table 'rproxy.rproxy_rules' doesn't exist"), { errno: 1146 }));
    const again = await call('dashboard', undefined, 'GET');
    expect(again.status).toBe(200);
    expect(again.body.rules.map((r: any) => r.srcPort).sort()).toEqual([9000, 9002]);
  });

  it('UI のルールと同じキーを API のルールが使っていれば shadowedBy', async () => {
    poolRows([{ id: 1, auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 9000, src_port_end: null, dist_addr: '10.0.0.9', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null }], []);
    mocks.listRules.mockResolvedValue([live({ origin: 'api', created_by: 'ci-deploy' })]);
    const { body } = await call('dashboard', undefined, 'GET');
    expect(body.rules[0]).toMatchObject({ origin: 'dynamic', shadowedBy: { origin: 'api', createdBy: 'ci-deploy' } });
  });

  it('1 件：管理者には API のルール、利用者には 404', async () => {
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ origin: 'api', persisted: false }));
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '9000' })).status).toBe(404);
    mocks.getServerSession.mockResolvedValue(admin);
    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '9000' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ origin: 'api', persisted: false });
  });

  it('api-modify は rproxy の PATCH だけで変え（DB に書かない）、保存されなくなったら warning', async () => {
    mocks.getServerSession.mockResolvedValue(admin);
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ origin: 'api', persisted: true, labels: { tenant: 'a' } }));
    mocks.modifyRule.mockResolvedValue({ ...live({ origin: 'api' }), persisted: false });
    const { status, body } = await call('api-modify', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 9000, distAddr: '10.0.0.20', distPort: 8080, labels: { tenant: 'b' } });
    expect(status).toBe(200);
    expect(mocks.modifyRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9000 }, expect.objectContaining({ remote_addr: '10.0.0.20', remote_port: 8080, labels: { tenant: 'b' } }));
    expect(body.persisted).toBe(false);
    expect(body.warning).toContain('保存しませんでした');
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('api-modify / api-delete は管理者だけ、組のルールは 409 owned、UI のルールは 409 ui_rule', async () => {
    const key = { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 9000 };
    expect((await call('api-delete', key)).status).toBe(403);
    mocks.getServerSession.mockResolvedValue(admin);
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ ruleset: 'k8s/default/web' }));
    const owned = await call('api-delete', key);
    expect(owned.status).toBe(409);
    expect(owned.body.code).toBe('owned');
    pool.query.mockResolvedValue([{ id: 1 }]);
    expect((await call('api-delete', key)).body.code).toBe('ui_rule');
    expect(mocks.deleteRule).not.toHaveBeenCalled();

    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ origin: 'api' }));
    mocks.deleteRule.mockResolvedValue(undefined);
    expect((await call('api-delete', key)).status).toBe(200);
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9000 });
  });

  it('plan（api-modify）は rproxy の今の内容に本文を重ねて聞く', async () => {
    mocks.getServerSession.mockResolvedValue(admin);
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ origin: 'api' }));
    mocks.planModify.mockResolvedValue({ dry_run: true, action: 'update', change: 'in_place', rule: 'tcp/0.0.0.0:9000', diff: [], warnings: [] });
    const { body } = await call('plan', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 9000, distAddr: '10.0.0.9', distPort: 80, labels: { a: 'b' }, action: 'api-modify' });
    expect(body.results[0].plan.change).toBe('in_place');
    expect(mocks.planModify.mock.calls[0][1]).toMatchObject({ remote_addr: '10.0.0.9', labels: { a: 'b' } });
  });
});
