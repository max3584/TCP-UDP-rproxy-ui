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
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';

const { conn, pool } = mocks;

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: '' }, expires: '' };

const tcpRule = {
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8888,
  distAddr: 'example.com',
  distPort: 80,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
};

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
});

describe('/api/forward/[forward]', () => {
  it('returns 401 without a session', async () => {
    mocks.getServerSession.mockResolvedValue(null);

    const { status } = await call('add', tcpRule);
    expect(status).toBe(401);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('add commits when rproxy succeeds', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', tcpRule);
    expect(status).toBe(200);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(sqlCalls()[0][0]).toMatch(/^INSERT INTO forward_rules /);
    expect(sqlCalls()[0][1]).toEqual(['user-1', 'tcp', '0.0.0.0', 8888, 'example.com', 80, 'proxy', 30]);
    expect(sqlCalls()[1][0]).toMatch(/^INSERT INTO forward_rules_log /);
    expect(mocks.addRule).toHaveBeenCalledWith({
      protocol: 'tcp',
      listen_addr: '0.0.0.0',
      listen_port: 8888,
      remote_addr: 'example.com',
      remote_port: 80,
      source_ip: 'proxy',
      udp_idle_secs: 30,
    });
  });

  it('add rolls back and returns the rproxy error code', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('address already in use (os error 98)', 'bind_failed', 409));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'address already in use (os error 98)', code: 'bind_failed' });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('add returns 502 when rproxy is unreachable', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('rproxy に接続できません', 'unreachable', 0));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('unreachable');
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('add returns 409 on a duplicate key without calling rproxy', async () => {
    conn.query.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' }));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(409);
    expect(body.code).toBe('already_exists');
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('normalizes the protocol to lowercase', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', { ...tcpRule, protocol: 'UDP' });
    expect(status).toBe(200);
    expect(sqlCalls()[0][1][1]).toBe('udp');
    expect(sqlCalls()[1][1][0]).toBe('udp');
    expect(mocks.addRule.mock.calls[0][0].protocol).toBe('udp');
  });

  it.each([
    ['srcPort 0', { srcPort: 0 }],
    ['srcPort 65536', { srcPort: 65536 }],
    ['distPort 0', { distPort: 0 }],
    ['port as string', { srcPort: '8888' }],
    ['non-integer port', { distPort: 80.5 }],
    ['unknown protocol', { protocol: 'sctp' }],
    ['hostname as listen address', { srcAddr: 'example.com' }],
    ['proxy_v2 with udp', { protocol: 'udp', sourceIp: 'proxy_v2' }],
    ['udp_idle_secs out of range', { protocol: 'udp', udpIdleSecs: 86401 }],
  ])('rejects invalid input: %s', async (_name, override) => {
    const { status, body } = await call('add', { ...tcpRule, ...override });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('accepts ports 1 and 65535', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', { ...tcpRule, srcPort: 1, distPort: 65535 });
    expect(status).toBe(200);
  });

  it('modify sends PATCH with udp_idle_secs and keeps source_ip from the DB', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old.example.com', dist_port: 53, source_ip: 'transparent', udp_idle_secs: 30 }]);
    mocks.modifyRule.mockResolvedValue({});

    const { status } = await call('modify', { ...tcpRule, protocol: 'udp', udpIdleSecs: 120, sourceIp: 'proxy' });
    expect(status).toBe(200);
    expect(mocks.modifyRule).toHaveBeenCalledWith(
      { protocol: 'udp', listen_addr: '0.0.0.0', listen_port: 8888 },
      { remote_addr: 'example.com', remote_port: 80, udp_idle_secs: 120 },
    );
    const log = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules_log'));
    expect(log?.[1]).toEqual(['udp', '0.0.0.0', 8888, 'example.com', 80, 'transparent', 120, 'UPDATE']);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('modify returns 404 when the rule is not owned by the user', async () => {
    conn.query.mockResolvedValueOnce([]);

    const { status } = await call('modify', tcpRule);
    expect(status).toBe(404);
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('delete treats rproxy not_found as success', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockRejectedValue(new RproxyError('rule not found', 'not_found', 404));

    const { status } = await call('delete', { protocol: 'TCP', srcAddr: '0.0.0.0', srcPort: 8888 });
    expect(status).toBe(200);
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('delete rolls back on other rproxy errors', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockRejectedValue(new RproxyError('boom', 'internal', 500));

    const { status, body } = await call('delete', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('internal');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('list merges live state from rproxy', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 80, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30 },
      { id: 2, protocol: 'udp', src_addr: '::', src_port: 53, dist_addr: 'b', dist_port: 53, source_ip: 'proxy', udp_idle_secs: 60 },
      { id: 3, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 81, dist_addr: 'c', dist_port: 8081, source_ip: 'proxy', udp_idle_secs: 30 },
    ]);
    mocks.listRules.mockResolvedValue([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, remote_addr: 'a', remote_port: 8080, state: 'running', error: null, resolved: [], connections: 3 },
      { protocol: 'udp', listen_addr: '::', listen_port: 53, remote_addr: 'b', remote_port: 53, state: 'failed', error: 'bind failed', resolved: [], connections: 0 },
    ]);

    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body.map((r: any) => [r.id, r.state, r.error, r.connections])).toEqual([
      [1, 'running', null, 3],
      [2, 'failed', 'bind failed', 0],
      [3, 'missing', null, null],
    ]);
  });

  it('list returns DB rules with state unknown when rproxy is down', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'TCP', src_addr: '0.0.0.0', src_port: 80, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30 },
    ]);
    mocks.listRules.mockRejectedValue(new RproxyError('down', 'unreachable', 0));

    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].protocol).toBe('tcp');
    expect(body[0].state).toBe('unknown');
  });
});
