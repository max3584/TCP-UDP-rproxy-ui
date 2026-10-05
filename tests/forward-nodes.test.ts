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

  // ---- 第 3 段階：ノードごとの上書き・まとめての停止・コピー / 移動・ノードに限ったロール ----

  // conn.query：ロックしたルールの行、id、上書きの行を SQL で返し分ける
  function lockRows(overrides: any[] = []) {
    conn.query.mockImplementation(async (q: string, params: unknown[] = []) => {
      if (q.includes('FOR UPDATE') && q.includes('forward_rules WHERE')) {
        const target = String(params.find((p) => ['ha', 'a', 'b', 'c'].includes(String(p))) ?? 'ha');
        return [row(1, target)];
      }
      if (q.startsWith('SELECT id FROM forward_rules')) return [{ id: 1 }];
      if (q.includes('FROM forward_rule_overrides')) return overrides;
      return q.startsWith('SELECT') ? [] : { affectedRows: 1, insertId: 7 };
    });
  }

  it('override: stores the node\'s override, applies it to that node only (listen address changed: recreate), logs OVERRIDE', async () => {
    lockRows();
    const deleted: string[] = [];
    const added: string[] = [];
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));
    mocks.addRule.mockImplementation(onNode(added, () => ({})));
    const { status: code, body } = await call('override', {
      protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'b', override: { srcAddr: '192.0.2.50', allowFrom: ['10.0.0.0/8'] },
    });
    expect(code, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ node: 'b', result: 'set' });
    expect(deleted).toEqual(['b']);
    expect(added).toEqual(['b']);
    expect(mocks.deleteRule.mock.calls[0][0]).toEqual({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8001 });
    expect(mocks.addRule.mock.calls[0][0]).toMatchObject({ listen_addr: '192.0.2.50', allow_from: ['10.0.0.0/8'] });
    const ins = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rule_overrides'))!;
    expect(ins[1]).toEqual([1, 'b', '192.0.2.50', null, null, JSON.stringify({ allow_from: ['10.0.0.0/8'] })]);
    const log = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))!;
    expect(log[1].slice(0, 3)).toEqual(['user-1', 'ha', 'b']);
    expect(log[1].at(-1)).toBe('OVERRIDE');
  });

  it('override: only for group rules, and the node must belong to it', async () => {
    pool.query.mockImplementation(async (q: string) => (q.startsWith('SELECT target FROM forward_rules') ? [{ target: 'c' }] : []));
    expect((await call('override', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, node: 'c', override: { srcAddr: '192.0.2.1' } })).body.code).toBe('unsupported');
    expect((await call('override', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', node: 'c', override: {} })).body.code).toBe('unknown_node');
  });

  it('group changes use each node\'s effective rule (key and contents)', async () => {
    lockRows([{ rule_id: 1, node: 'b', src_addr: '192.0.2.50', dist_addr: '192.0.2.9', dist_port: 81, options: null }]);
    pool.query.mockImplementation(async (q: string) => (q.startsWith('SELECT target FROM forward_rules') ? [{ target: 'ha' }] : []));
    const patched: string[] = [];
    mocks.modifyRule.mockImplementation(onNode(patched, () => ({})));
    expect((await call('modify', { ...tcpRule, srcPort: 8001, distAddr: 'new.example.com', target: 'ha' })).status).toBe(200);
    const byNode = Object.fromEntries(patched.map((n, i) => [n, mocks.modifyRule.mock.calls[i]]));
    expect(byNode.a[0]).toEqual({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8001 });
    expect(byNode.a[1]).toMatchObject({ remote_addr: 'new.example.com' });
    // b は待ち受けアドレスと転送先を上書きしているので、そのキーとその転送先のまま
    expect(byNode.b[0]).toEqual({ protocol: 'tcp', listen_addr: '192.0.2.50', listen_port: 8001 });
    expect(byNode.b[1]).toMatchObject({ remote_addr: '192.0.2.9', remote_port: 81 });
  });

  it('pause-node: pauses the node\'s own rules and the group rules on that node only', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.includes('target IN')) return [row(1, 'ha'), row(2, 'b')];
      return [];
    });
    lockRows();
    const deleted: string[] = [];
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));
    const { status: code, body } = await call('pause-node', { node: 'b', action: 'pause' });
    expect(code, JSON.stringify(body)).toBe(200);
    expect(body.results.map((r: any) => [r.target, r.result])).toEqual([['ha', 'paused'], ['b', 'paused']]);
    expect(deleted).toEqual(['b', 'b']);
    const ov = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rule_overrides'))!;
    expect(ov[1]).toEqual([1, 'b', null, null, null, JSON.stringify({ enabled: false })]);
  });

  it('copy keeps the overrides of nodes in the destination; move adds there and deletes the original', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.startsWith('SELECT target FROM forward_rules') && !q.includes('<>')) return [{ target: 'ha' }];
      if (q.startsWith('SELECT id, auth_id, target')) return [row(1, 'ha')];
      if (q.includes('FROM forward_rule_overrides')) return [{ rule_id: 1, node: 'a', src_addr: '192.0.2.50', dist_addr: null, dist_port: null, options: null }];
      return [];
    });
    lockRows();
    const added: string[] = [];
    mocks.addRule.mockImplementation(onNode(added, () => ({})));
    const copy = await call('copy', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', to: 'c' });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    expect(copy.body).toEqual({ result: 'copied', target: 'c' });
    expect(added).toEqual(['c']);
    expect(mocks.addRule.mock.calls[0][0]).toMatchObject({ listen_addr: '0.0.0.0' });

    // ノード a に置くと、a の上書きをルールの内容にする（ha と a は重なるので、先に元を消す）
    added.length = 0;
    const deleted: string[] = [];
    mocks.deleteRule.mockImplementation(onNode(deleted, () => undefined));
    const move = await call('copy', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8001, target: 'ha', to: 'a', move: true });
    expect(move.body).toEqual({ result: 'moved', target: 'a' });
    expect(deleted.sort()).toEqual(['a', 'b']);
    expect(added).toEqual(['a']);
    expect(mocks.addRule.mock.calls.at(-1)![0]).toMatchObject({ listen_addr: '192.0.2.50' });
  });

  it('RPROXY_UI_USER_NODES limits users to those nodes', async () => {
    process.env.RPROXY_UI_USER_NODES = 'c';
    try {
      const denied = await call('add', { ...tcpRule, target: 'ha' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('node_not_allowed');
      mocks.addRule.mockResolvedValue({});
      expect((await call('add', { ...tcpRule, target: 'c' })).status).toBe(200);
      const info = await call('nodes', undefined, 'GET');
      expect(info.body.allowedTargets).toEqual(['c']);
    } finally {
      delete process.env.RPROXY_UI_USER_NODES;
    }
  });

  it('export writes the overrides; the dashboard shows when each node was last applied', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.startsWith('SELECT id, protocol')) return [row(1, 'ha')];
      if (q.includes('FROM forward_rule_overrides')) return [{ rule_id: 1, node: 'b', src_addr: '192.0.2.50', dist_addr: null, dist_port: null, options: null }];
      if (q.includes('MAX(updated_at)')) return [{ target: 'ha', node: null, at: '2026-01-01T00:00:00Z' }, { target: 'ha', node: 'b', at: '2026-02-01T00:00:00Z' }];
      if (q.includes('FROM forward_rules')) return [];
      return [];
    });
    const req = { method: 'GET', query: { forward: 'export' }, headers: {} } as unknown as NextApiRequest;
    const res: any = { setHeader: vi.fn() };
    res.status = vi.fn(() => res);
    res.send = vi.fn(() => res);
    res.json = vi.fn(() => res);
    await handler(req, res as NextApiResponse);
    const doc = JSON.parse(res.send.mock.calls[0][0]);
    expect(doc.rules[0].overrides).toEqual({ b: { listen_addr: '192.0.2.50' } });

    mocks.listRules.mockResolvedValue([]);
    const { body } = await call('dashboard', undefined, 'GET');
    expect(body.nodes.map((n: any) => [n.name, n.lastSync ?? null])).toEqual([['a', '2026-01-01T00:00:00.000Z'], ['b', '2026-02-01T00:00:00.000Z'], ['c', null]]);
  });

  it('import reads the overrides of a UI export into a group (round trip of export)', async () => {
    pool.query.mockResolvedValue([]);
    mocks.listRules.mockResolvedValue([]);
    lockRows();
    const added: string[] = [];
    mocks.addRule.mockImplementation(onNode(added, () => ({})));
    const text = JSON.stringify({
      format: 'rproxy-ui-export', version: 1,
      rules: [{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8500, remote_addr: 'example.com', remote_port: 80, overrides: { b: { listen_addr: '192.0.2.50', remote_addr: '192.0.2.9', remote_port: 81 } } }],
    });
    const { status: code, body } = await call('import', { text: text, target: 'ha' });
    expect(code, JSON.stringify(body)).toBe(200);
    expect(body.results).toEqual([{ index: 0, key: 'tcp|0.0.0.0|8500', result: 'added' }]);
    const sent = Object.fromEntries(added.map((n, i) => [n, mocks.addRule.mock.calls[i][0]]));
    expect(sent.a).toMatchObject({ listen_addr: '0.0.0.0', remote_addr: 'example.com' });
    expect(sent.b).toMatchObject({ listen_addr: '192.0.2.50', remote_addr: '192.0.2.9', remote_port: 81 });
    const ins = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rule_overrides'))!;
    expect(ins[1].slice(0, 5)).toEqual([7, 'b', '192.0.2.50', '192.0.2.9', 81]);

    // ノードに読み込むときの overrides は使えない
    const bad = await call('import', { text: text, target: 'c', dryRun: true });
    expect(bad.body.items[0].status).toBe('error');
  });
});
