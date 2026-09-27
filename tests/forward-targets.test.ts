// 宛先を複数にしたルール（targets / balance / health_check。rproxy v0.3.3）の API route
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

function call(action: string, body?: unknown, method = 'POST') {
  const req = { method, query: { forward: action }, body } as unknown as NextApiRequest;
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

function reset() {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
}

beforeEach(reset);

const targets = [{ addr: '10.0.0.11', port: 5432, weight: 2 }, { addr: 'db2.internal', port: 5432 }, { addr: '10.0.0.13', port: 5432, backup: true }];
const key = { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 5432 };
const body = { ...key, sourceIp: 'proxy', udpIdleSecs: 30, distAddr: '', distPort: 0, targets: targets, balance: 'least_conn', healthCheck: { interval: '10s' } };
const stored = { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, targets: targets, balance: 'least_conn', health_check: { interval: '10s' } };
const multiRow = (over: Record<string, unknown> = {}) => ({
  src_port_end: null, dist_addr: '', dist_port: 0, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify(stored), ...over,
});
const updateCall = () => sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));

describe('/api/forward/[forward]: several targets', () => {
  it('add stores targets in options (dist_addr empty) and sends them instead of remote_addr / remote_port', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', body);
    expect(status).toBe(200);
    const insert = sqlCalls()[0][1];
    expect(insert.slice(5, 7)).toEqual(['', 0]);
    expect(JSON.parse(insert[9] as string)).toEqual(stored);
    const rule = mocks.addRule.mock.calls[0][0];
    expect(rule).toMatchObject({ targets: targets, balance: 'least_conn', health_check: { interval: '10s' } });
    expect(rule).not.toHaveProperty('remote_addr');
    expect(rule).not.toHaveProperty('remote_port');
  });

  it('add checks targets like rproxy', async () => {
    let res = await call('add', { ...body, targets: [{ addr: 'bad host', port: 1 }] });
    expect([res.status, res.body.code]).toEqual([400, 'invalid']);
    res = await call('add', { ...body, targets: [{ addr: '10.0.0.1', port: 1, backup: true }] });
    expect(res.body.error).toContain('予備（backup）でない宛先');
    res = await call('add', { ...body, protocol: 'udp', healthCheck: { interval: '5s' } });
    expect(res.body.error).toContain('UDP のルールのヘルスチェックには');
    res = await call('add', { ...body, srcPortEnd: 5500, targets: [{ addr: '10.0.0.1', port: 65500 }] });
    expect(res.body.error).toContain('ポート範囲の長さ');
    res = await call('add', { ...body, balance: 'random' });
    expect(res.body.code).toBe('invalid');
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('a single target still needs distAddr, and a health check alone is refused', async () => {
    expect((await call('add', { ...key, sourceIp: 'proxy', udpIdleSecs: 30, distAddr: '', distPort: 0 })).status).toBe(400);
    const res = await call('add', { ...key, sourceIp: 'proxy', udpIdleSecs: 30, distAddr: 'example.com', distPort: 80, healthCheck: { interval: '10s' } });
    expect(res.body.error).toContain('宛先を複数にしたときだけ');
  });

  it('modify keeps the stored targets when the body has none', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    mocks.modifyRule.mockResolvedValue({});

    const res = await call('modify', { ...key, sourceIp: 'proxy', udpIdleSecs: 30, allowFrom: ['10.0.0.0/8'] });
    expect(res.status).toBe(200);
    const patch = mocks.modifyRule.mock.calls[0][1];
    expect(patch).toMatchObject({ targets: targets, balance: 'least_conn', health_check: { interval: '10s' }, allow_from: ['10.0.0.0/8'] });
    expect(patch).not.toHaveProperty('remote_addr');
    expect(JSON.parse(updateCall()?.[1][3] as string)).toEqual({ ...stored, allow_from: ['10.0.0.0/8'] });
  });

  it('modify replaces targets, balance and the health check when given', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    mocks.modifyRule.mockResolvedValue({});
    const two = [{ addr: '10.0.0.21', port: 5432 }, { addr: '10.0.0.22', port: 5432 }];

    const res = await call('modify', { ...body, targets: two, balance: 'failover', healthCheck: null });
    expect(res.status).toBe(200);
    const patch = mocks.modifyRule.mock.calls[0][1];
    expect(patch).toMatchObject({ targets: two, balance: 'failover' });
    expect(patch).not.toHaveProperty('health_check');
    expect(updateCall()?.[1].slice(0, 2)).toEqual(['', 0]);
    expect(JSON.parse(updateCall()?.[1][3] as string)).toEqual({
      tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, targets: two, balance: 'failover',
    });
  });

  it('modify back to a single target sends remote_addr with targets: [] and clears the stored list', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    mocks.modifyRule.mockResolvedValue({});

    const res = await call('modify', { ...key, sourceIp: 'proxy', udpIdleSecs: 30, distAddr: '10.0.0.11', distPort: 5432, targets: [] });
    expect(res.status).toBe(200);
    const patch = mocks.modifyRule.mock.calls[0][1];
    expect(patch).toMatchObject({ remote_addr: '10.0.0.11', remote_port: 5432, targets: [] });
    expect(patch).not.toHaveProperty('balance');
    expect(updateCall()?.[1].slice(0, 2)).toEqual(['10.0.0.11', 5432]);
    expect(updateCall()?.[1][3]).toBeNull();
  });

  it('the undo after a failed COMMIT restores the previous targets', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));
    mocks.modifyRule.mockResolvedValue({});

    await call('modify', { ...key, sourceIp: 'proxy', udpIdleSecs: 30, distAddr: '10.0.0.11', distPort: 5432, targets: [] });
    expect(mocks.modifyRule).toHaveBeenCalledTimes(2);
    const undo = mocks.modifyRule.mock.calls[1][1];
    expect(undo).toMatchObject({ targets: targets, balance: 'least_conn', health_check: { interval: '10s' } });
    expect(undo).not.toHaveProperty('remote_addr');
  });

  it('a rule missing in rproxy is re-created with its targets', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    mocks.modifyRule.mockRejectedValueOnce(new RproxyError('not found', 'not_found', 404));
    mocks.addRule.mockResolvedValue({});

    await call('modify', { ...key, sourceIp: 'proxy', udpIdleSecs: 30 });
    expect(mocks.addRule.mock.calls[0][0]).toMatchObject({ targets: targets, balance: 'least_conn' });
    expect(mocks.addRule.mock.calls[0][0]).not.toHaveProperty('remote_addr');
  });

  it('delete puts the targets back when COMMIT fails', async () => {
    conn.query.mockResolvedValueOnce([multiRow()]);
    mocks.deleteRule.mockResolvedValue(undefined);
    mocks.addRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    await call('delete', key);
    expect(mocks.addRule.mock.calls[0][0]).toMatchObject({ targets: targets, balance: 'least_conn' });
  });

  it('refuses targets on an L7 rule', async () => {
    const res = await call('add', {
      ...body,
      http: { routes: [{ name: 'all', match: 'PathPrefix(`/`)', to: 'http://10.0.0.1:80' }] },
    });
    expect([res.status, res.body.code]).toEqual([400, 'invalid']);
    expect(res.body.error).toContain('L7（HTTP）のルールでは宛先を複数にできません');
  });

  it('lists rules read back from the DB with their targets', async () => {
    pool.query.mockResolvedValueOnce([{ id: 1, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 5432, ...multiRow() }]);
    mocks.listRules.mockResolvedValue([]);

    const { status, body: rules } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(rules[0]).toMatchObject({ targets: targets, balance: 'least_conn', healthCheck: { interval: '10s' }, distAddr: '' });
  });
});
