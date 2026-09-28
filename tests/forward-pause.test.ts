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
  mocks.getRule.mockRejectedValue(new RproxyError('not found', 'not_found', 404));
});

// SELECT ... FOR UPDATE（lockOwnRule）が返す行
function lockedRow(options: unknown) {
  return [{ src_port_end: null, dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: options === null ? null : JSON.stringify(options) }];
}

function answerLock(options: unknown) {
  conn.query.mockImplementation(async (sql: string) => (sql.includes('FOR UPDATE') ? lockedRow(options) : { affectedRows: 1 }));
}

const PASS = { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true };

// 一時停止と再開（#63）
describe('/api/forward/[forward]: pause and resume', () => {
  it('pause keeps the rule in the DB with enabled: false, logs it and deletes it from rproxy', async () => {
    answerLock(null);
    const { status } = await call('pause', tcpRule);
    expect(status).toBe(200);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules SET options'));
    expect(JSON.parse(update![1][0] as string)).toMatchObject({ enabled: false });
    const log = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules_log'));
    expect(log![1].at(-1)).toBe('UPDATE');
    expect(JSON.parse(log![1].at(-2) as string)).toMatchObject({ enabled: false });
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
    expect(conn.commit).toHaveBeenCalled();
  });

  it('pausing a rule missing in rproxy still pauses it', async () => {
    answerLock(null);
    mocks.deleteRule.mockRejectedValueOnce(new RproxyError('not found', 'not_found', 404));
    expect((await call('pause', tcpRule)).status).toBe(200);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('resume removes the mark and creates the rule in rproxy from the DB', async () => {
    answerLock({ ...PASS, enabled: false });
    const { status } = await call('resume', tcpRule);
    expect(status).toBe(200);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules SET options'));
    // 既定の設定だけに戻れば options は NULL
    expect(update![1][0]).toBeNull();
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ listen_port: 8888, remote_addr: 'example.com' }));
    expect(mocks.addRule.mock.calls[0][0]).not.toHaveProperty('enabled');
  });

  it('refuses to pause a paused rule or resume a running one', async () => {
    answerLock({ ...PASS, enabled: false });
    expect(await call('pause', tcpRule)).toMatchObject({ status: 409, body: { code: 'already_paused' } });
    answerLock(null);
    expect(await call('resume', tcpRule)).toMatchObject({ status: 409, body: { code: 'not_paused' } });
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('undoes the rproxy side when COMMIT fails', async () => {
    answerLock(null);
    conn.commit.mockRejectedValueOnce(new Error('commit failed'));
    expect((await call('pause', tcpRule)).status).toBe(500);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ listen_port: 8888 }));

    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue(session);
    pool.getConnection.mockResolvedValue(conn);
    answerLock({ ...PASS, enabled: false });
    conn.commit.mockRejectedValueOnce(new Error('commit failed'));
    expect((await call('resume', tcpRule)).status).toBe(500);
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
  });

  it('modify of a paused rule changes only the DB and keeps it paused', async () => {
    answerLock({ ...PASS, enabled: false });
    const { status } = await call('modify', { ...tcpRule, distAddr: 'other.example' });
    expect(status).toBe(200);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules SET dist_addr'));
    expect(update![1][0]).toBe('other.example');
    expect(JSON.parse(update![1][3] as string)).toMatchObject({ enabled: false });
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('modify of a running rule cannot pause it by sending enabled: false', async () => {
    answerLock(null);
    expect((await call('modify', { ...tcpRule, enabled: false })).status).toBe(200);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules SET dist_addr'));
    expect(update![1][3]).toBeNull();
    expect(mocks.modifyRule).toHaveBeenCalled();
  });

  it('delete of a paused rule deletes only from the DB', async () => {
    answerLock({ ...PASS, enabled: false });
    expect((await call('delete', tcpRule)).status).toBe(200);
    expect(sqlCalls().some(([sql]) => sql.startsWith('DELETE FROM forward_rules'))).toBe(true);
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('adding a rule with enabled: false (import) stores it paused without creating it in rproxy', async () => {
    const { status } = await call('add', { ...tcpRule, enabled: false });
    expect(status).toBe(200);
    const insert = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules '));
    expect(JSON.parse(insert![1][9] as string)).toMatchObject({ enabled: false });
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('shows paused rules as paused, not missing', async () => {
    pool.query.mockResolvedValue([
      { id: 1, auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8888, src_port_end: null, dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify({ ...PASS, enabled: false }) },
      { id: 2, auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8889, src_port_end: null, dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null },
    ]);
    mocks.listRules.mockResolvedValue([]);
    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body.map((r: any) => [r.srcPort, r.state, r.enabled])).toEqual([[8888, 'paused', false], [8889, 'missing', true]]);
  });

  it('users cannot pause other users\' rules (not found for them)', async () => {
    conn.query.mockImplementation(async (sql: string) => (sql.includes('FOR UPDATE') ? [] : { affectedRows: 1 }));
    const { status } = await call('pause', tcpRule);
    expect(status).toBe(404);
    const lock = sqlCalls().find(([sql]) => sql.includes('FOR UPDATE'));
    expect(lock![0]).toContain('auth_id = ?');
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });
});
