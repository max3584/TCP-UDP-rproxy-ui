// 複数のノードとグループ（#98）の API route。MariaDB と rproxy はモック（ノードごとの呼び出しは currentNode で見分ける）
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    getInterfaces: vi.fn(),
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
  getInterfaces: mocks.getInterfaces,
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError, currentNode } from '@/components/rproxy';
import { resetNodesCache } from '@/components/nodes';

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

const row = (id: number, target: string, extra: Record<string, unknown> = {}) => ({
  id: id, auth_id: 'user-1', target: target, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8000 + id, src_port_end: null,
  dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null, ...extra,
});

const status = (port: number, extra: Record<string, unknown> = {}) => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: port, remote_addr: 'example.com', remote_port: 80,
  state: 'running', error: null, resolved: ['192.0.2.1:80'], connections: 2,
  stats: { total_connections: 10, rx_bytes: 100, tx_bytes: 200, tls_failures: 0 }, started_at: 1000, ...extra,
});

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body, headers: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
  }));
}

// 呼ばれたノードの名前を記録する rproxy のモック
function onNode<T>(calls: string[], fn: (node: string) => T) {
  return async () => {
    const node = currentNode()?.name ?? '(none)';
    calls.push(node);
    return fn(node);
  };
}

function sql(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((c) => String(c[0]));
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-forward-nodes-'));
  writeFileSync(join(dir, 'a.token'), 'tok-a');
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:',
    `  - {name: a, url: "http://a:8081", token_file: ${join(dir, 'a.token')}}`,
    '  - {name: b, url: "http://b:8081"}',
    '  - {name: c, url: "http://c:8081"}',
    'groups:',
    '  - {name: ha, nodes: [a, b], mode: active_standby}',
  ].join('\n'));
  process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
  resetNodesCache();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockImplementation(async (q: string) => (q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
  conn.rollback.mockResolvedValue(undefined);
  pool.query.mockResolvedValue([]);
  mocks.getInterfaces.mockResolvedValue({ interfaces: [], reserved: [] });
});

describe('nodes and groups (#98)', () => {
  it('writes forward_rule_targets from the config file once (the per-node views read it)', async () => {
    const { status } = await call('nodes', undefined, 'GET');
    expect(status).toBe(200);
    expect(sql(conn.query)).toContain('DELETE FROM forward_rule_targets');
    const insert = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rule_targets'))!;
    expect(insert[1]).toEqual(['a', 'a', 'a', 'ha', 'b', 'b', 'b', 'ha', 'c', 'c']);
    expect(conn.commit).toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue(session);
    await call('nodes', undefined, 'GET');
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('GET nodes returns names and groups without URLs or tokens', async () => {
    const { body } = await call('nodes', undefined, 'GET');
    expect(body).toEqual({
      configured: true,
      nodes: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      groups: [{ name: 'ha', mode: 'active_standby', nodes: ['a', 'b'] }],
      defaultTarget: null,
    });
  });

  it('add to a group sends the rule to every member and stores the target', async () => {
    const calls: string[] = [];
    mocks.addRule.mockImplementation(onNode(calls, () => ({})));

    const { status, body } = await call('add', { ...tcpRule, target: 'ha' });
    expect(status).toBe(200);
    expect(calls.sort()).toEqual(['a', 'b']);
    const insert = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rules '))!;
    expect(insert[0]).toContain('(auth_id, target, protocol,');
    expect(insert[1].slice(0, 3)).toEqual(['user-1', 'ha', 'tcp']);
    const log = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))!;
    expect(log[1].slice(0, 2)).toEqual(['user-1', 'ha']);
    expect(conn.commit).toHaveBeenCalled();
    expect(body).toEqual({ message: 'Forwarding rule added successfully', nodes: [{ node: 'a', ok: true }, { node: 'b', ok: true }] });
  });

  it('when one member fails, the others are undone, the DB rolls back and each node is reported', async () => {
    const added: string[] = [];
    const deleted: string[] = [];
    mocks.addRule.mockImplementation(onNode(added, (node) => {
      if (node === 'b') throw new RproxyError('address already in use (os error 98)', 'bind_failed', 409);
      return {};
    }));
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));

    const { status, body } = await call('add', { ...tcpRule, target: 'ha' });
    expect(status).toBe(409);
    expect(body.code).toBe('bind_failed');
    expect(body.error).toBe('ノード b: address already in use (os error 98)');
    expect(body.nodes).toEqual([
      { node: 'a', ok: true, undone: true },
      { node: 'b', ok: false, error: 'address already in use (os error 98)', code: 'bind_failed' },
    ]);
    expect(deleted).toEqual(['a']);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('a COMMIT failure undoes the change on every member', async () => {
    mocks.addRule.mockResolvedValue({});
    const deleted: string[] = [];
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));
    conn.commit.mockRejectedValueOnce(new Error('lost connection'));

    const { status } = await call('add', { ...tcpRule, target: 'ha' });
    expect(status).toBe(500);
    expect(deleted.sort()).toEqual(['a', 'b']);
  });

  it('add to a node only touches that node', async () => {
    const calls: string[] = [];
    mocks.addRule.mockImplementation(onNode(calls, () => ({})));
    const { status } = await call('add', { ...tcpRule, target: 'c' });
    expect(status).toBe(200);
    expect(calls).toEqual(['c']);
  });

  it('add needs a target when there is no default, and the target must exist', async () => {
    expect((await call('add', tcpRule)).body.code).toBe('target_required');
    const unknown = await call('add', { ...tcpRule, target: 'zzz' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('unknown_target');
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('refuses the same key on a node / group sharing a node (409 target_conflict)', async () => {
    pool.query.mockImplementation(async (q: string) => (q.includes('target <> ?') ? [{ target: 'a' }] : []));
    const { status, body } = await call('add', { ...tcpRule, target: 'ha' });
    expect(status).toBe(409);
    expect(body.code).toBe('target_conflict');
    expect(mocks.addRule).not.toHaveBeenCalled();

    // 重ならないノード（c）なら置ける
    mocks.addRule.mockResolvedValue({});
    pool.query.mockImplementation(async (q: string) => (q.includes('target <> ?') ? [{ target: 'ha' }] : []));
    expect((await call('add', { ...tcpRule, target: 'c' })).status).toBe(200);
  });

  it('delete finds the target in the DB when the body has none, and deletes on every member', async () => {
    pool.query.mockImplementation(async (q: string) => (q.startsWith('SELECT target FROM forward_rules') ? [{ target: 'ha' }] : []));
    conn.query.mockImplementation(async (q: string) => (q.includes('FOR UPDATE') && q.includes('forward_rules WHERE') ? [row(1, 'ha')] : q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
    const deleted: string[] = [];
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));

    const { status, body } = await call('delete', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001 });
    expect(status).toBe(200);
    expect(deleted.sort()).toEqual(['a', 'b']);
    const del = conn.query.mock.calls.find((c) => String(c[0]).startsWith('DELETE FROM forward_rules'))!;
    expect(del[0]).toBe('DELETE FROM forward_rules WHERE auth_id = ? AND target = ? AND protocol = ? AND src_addr = ? AND src_port = ?');
    expect(del[1]).toEqual(['user-1', 'ha', 'tcp', '0.0.0.0', 8001]);
    expect(body.nodes).toHaveLength(2);
  });

  it('the same key on two targets needs an explicit target', async () => {
    pool.query.mockImplementation(async (q: string) => (q.startsWith('SELECT target FROM forward_rules') ? [{ target: 'a' }, { target: 'c' }] : []));
    const { status, body } = await call('pause', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001 });
    expect(status).toBe(400);
    expect(body.code).toBe('target_required');
  });

  it('dashboard: state per node, aggregated per rule, and a summary per node', async () => {
    pool.query.mockImplementation(async (q: string) => (q.includes('FROM forward_rules') ? [row(1, 'ha'), row(2, 'c')] : []));
    mocks.listRules.mockImplementation(async () => {
      const node = currentNode()?.name;
      if (node === 'a') return [status(8001), status(9443, { origin: 'static', listen_port: 9443 })];
      if (node === 'b') return [status(8001, { state: 'failed', error: 'bind failed', connections: 3, started_at: 900 })];
      throw new RproxyError('rproxy に接続できません: ECONNREFUSED', 'unreachable', 0);
    });

    const { status: code, body } = await call('dashboard', undefined, 'GET');
    expect(code).toBe(200);
    expect(body.reachable).toBe(true);
    expect(body.rproxyError).toBe('ノード c: rproxy に接続できません: ECONNREFUSED');
    expect(body.nodes).toEqual([
      { name: 'a', reachable: true, error: null, rules: 1, failed: 0, drifted: 0 },
      { name: 'b', reachable: true, error: null, rules: 1, failed: 1, drifted: 0 },
      { name: 'c', reachable: false, error: 'rproxy に接続できません: ECONNREFUSED', rules: 1, failed: 0, drifted: 0 },
    ]);

    const group = body.rules.find((r: any) => r.id === 1);
    expect(group.target).toBe('ha');
    expect(group.state).toBe('failed');
    expect(group.error).toBe('b: bind failed');
    expect(group.connections).toBe(5);
    expect(group.stats).toEqual({ total_connections: 20, rx_bytes: 200, tx_bytes: 400, tls_failures: 0 });
    expect(group.startedAt).toBe(900);
    expect(group.nodes.map((n: any) => [n.node, n.state])).toEqual([['a', 'running'], ['b', 'failed']]);

    const single = body.rules.find((r: any) => r.id === 2);
    expect(single.state).toBe('unknown');
    expect(single.nodes).toEqual([expect.objectContaining({ node: 'c', state: 'unknown' })]);

    // 固定ルールはそのノードのもの
    const fixed = body.rules.find((r: any) => r.origin === 'static');
    expect(fixed).toMatchObject({ target: 'a', srcPort: 9443 });
  });

  it('rule: one entry with the state of each member', async () => {
    pool.query.mockImplementation(async (q: string) => (q.includes('FROM forward_rules WHERE') && q.startsWith('SELECT id') ? [row(1, 'ha')] : []));
    mocks.getRule.mockImplementation(async () => {
      if (currentNode()?.name === 'a') return status(8001);
      throw new RproxyError('no such rule', 'not_found', 404);
    });
    const { status: code, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8001', target: 'ha' });
    expect(code).toBe(200);
    expect(body.state).toBe('missing');
    expect(body.nodes.map((n: any) => [n.node, n.state])).toEqual([['a', 'running'], ['b', 'missing']]);
  });

  it('history carries the target and filters by it', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.startsWith('SELECT COUNT(*)')) return [{ n: 1 }];
      if (q.includes('FROM forward_rules_log')) {
        return [{ ...row(1, 'ha'), id: 5, update_action: 'ADD', updated_at: '2026-01-01T00:00:00Z' }];
      }
      return [];
    });
    const { body } = await call('history', undefined, 'GET', { target: 'ha' });
    expect(body.entries[0].target).toBe('ha');
    const count = pool.query.mock.calls.find((c) => String(c[0]).startsWith('SELECT COUNT(*)'))!;
    expect(count[0]).toContain('l.target = ?');
    expect(count[1]).toContain('ha');
  });

  it('dashboard: drift per node and the act of an active_standby group (VIP = specific listen address)', async () => {
    pool.query.mockImplementation(async (q: string) => (q.includes('FROM forward_rules') ? [row(1, 'ha', { src_addr: '192.0.2.10', src_port: 8001 })] : []));
    mocks.listRules.mockImplementation(async () => {
      const node = currentNode()?.name;
      if (node === 'a') return [status(8001, { listen_addr: '192.0.2.10' })];
      if (node === 'b') return [status(8001, { listen_addr: '192.0.2.10', remote_port: 81 })];
      return [];
    });
    mocks.getInterfaces.mockImplementation(async () => ({
      interfaces: currentNode()?.name === 'b' ? [{ addr: '192.0.2.10' }, { addr: '10.0.0.2' }] : [{ addr: '10.0.0.1' }],
      reserved: [],
    }));
    const { body } = await call('dashboard', undefined, 'GET');
    const r = body.rules[0];
    expect(r.nodes.map((n: any) => [n.node, n.role, n.drift])).toEqual([['a', 'standby', []], ['b', 'active', ['remote']]]);
    expect(r.ha).toEqual({ addrs: ['192.0.2.10'], active: ['b'], warning: null });
    expect(body.nodes.find((n: any) => n.name === 'b').drifted).toBe(1);
  });

  it('resend: recreates the rule on the one node where it is missing, and records RESEND with the node', async () => {
    conn.query.mockImplementation(async (q: string) => (q.includes('FOR UPDATE') && q.includes('forward_rules WHERE') ? [row(1, 'ha')] : q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
    const got: string[] = [];
    mocks.getRule.mockImplementation(onNode(got, () => { throw new RproxyError('no such rule', 'not_found', 404); }));
    const added: string[] = [];
    mocks.addRule.mockImplementation(onNode(added, () => ({})));

    const { status: code, body } = await call('resend', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'b' });
    expect(code).toBe(200);
    expect(body).toEqual({ node: 'b', result: 'added' });
    expect(got).toEqual(['b']);
    expect(added).toEqual(['b']);
    const log = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))!;
    expect(log[0]).toContain('(auth_id, target, node,');
    expect(log[1].slice(0, 3)).toEqual(['user-1', 'ha', 'b']);
    expect(log[1].at(-1)).toBe('RESEND');
    expect(conn.commit).toHaveBeenCalled();
  });

  it('resend: PATCHes a drifted rule, and does nothing when the node already matches', async () => {
    conn.query.mockImplementation(async (q: string) => (q.includes('FOR UPDATE') && q.includes('forward_rules WHERE') ? [row(1, 'ha')] : q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
    mocks.getRule.mockResolvedValue(status(8001, { remote_port: 81 }));
    const patched: string[] = [];
    mocks.modifyRule.mockImplementation(onNode(patched, () => ({})));
    expect((await call('resend', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'a' })).body.result).toBe('modified');
    expect(patched).toEqual(['a']);
    expect(mocks.modifyRule.mock.calls[0][1]).toMatchObject({ remote_addr: 'example.com', remote_port: 80 });

    mocks.getRule.mockResolvedValue(status(8001));
    expect((await call('resend', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'a' })).body.result).toBe('unchanged');
    expect(mocks.modifyRule).toHaveBeenCalledTimes(1);
  });

  it('resend: the node must belong to the rule', async () => {
    const { status: code, body } = await call('resend', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'c' });
    expect(code).toBe(400);
    expect(body.code).toBe('unknown_node');
  });
});
