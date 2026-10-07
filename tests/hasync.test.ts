// act/stb の昇格の前に揃える（#109）：自動の送り直し・昇格してよいか・keepalived の口。MariaDB と rproxy はモック
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(), query: vi.fn() };
  const pool = { getConnection: vi.fn(), query: vi.fn() };
  return { conn, pool, addRule: vi.fn(), modifyRule: vi.fn(), deleteRule: vi.fn(), listRules: vi.fn(), getRule: vi.fn(), getInterfaces: vi.fn() };
});

vi.mock('mariadb', () => ({ default: { createPool: () => mocks.pool } }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  addRule: mocks.addRule, modifyRule: mocks.modifyRule, deleteRule: mocks.deleteRule,
  listRules: mocks.listRules, getRule: mocks.getRule, getInterfaces: mocks.getInterfaces,
}));

import { RproxyError, currentNode } from '@/components/rproxy';
import { loadNodes, resetNodesCache } from '@/components/nodes';
import { haSyncIntervalSecs, haSyncStatus, nodeReadiness, runHaSyncOnce, startHaSync, stopHaSync, syncNode } from '@/components/hasync';
import { fromRow, resendOne } from '@/components/ruledb';
import { checkHaToken } from '@/components/hatoken';
import readyHandler from '@/pages/api/forward/ha/ready';
import notifyHandler from '@/pages/api/forward/ha/notify';

const { conn, pool } = mocks;
let dir = '';

const row = (id: number, target: string, extra: Record<string, unknown> = {}) => ({
  id: id, auth_id: 'user-1', target: target, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8000 + id, src_port_end: null,
  dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null, ...extra,
});
const status = (port: number, extra: Record<string, unknown> = {}) => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: port, remote_addr: 'example.com', remote_port: 80, source_ip: 'proxy',
  udp_idle_secs: 30, tls: { mode: 'passthrough' }, allow_from: [], state: 'running', error: null, resolved: [], connections: 0, ...extra,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-hasync-'));
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:',
    '  - {name: a, url: "http://a:8081"}',
    '  - {name: b, url: "http://b:8081"}',
    '  - {name: c, url: "http://c:8081"}',
    'groups:',
    '  - {name: ha, nodes: [a, b], mode: active_standby}',
    '  - {name: manual, nodes: [b, c], mode: active_standby, auto_resend: false}',
  ].join('\n'));
  writeFileSync(join(dir, 'ha.tokens'), '# keepalived\nsecret-1\n\nsecret-2\n');
  process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
  resetNodesCache();
});

// pool.query：グループのルール（ha は 1・2、manual は 3）と上書き（なし）
function rulesFor(q: string, params: unknown[] = []): unknown[] {
  if (q.includes('FROM forward_rule_overrides')) return [];
  if (q.includes('FROM forward_rules WHERE target IN')) {
    const out = [];
    if (params.includes('ha')) out.push(row(1, 'ha'), row(2, 'ha'));
    if (params.includes('manual')) out.push(row(3, 'manual'));
    return out;
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  stopHaSync();
  pool.getConnection.mockResolvedValue(conn);
  pool.query.mockImplementation(async (q: string, params?: unknown[]) => rulesFor(q, params));
  conn.query.mockImplementation(async (q: string, params: unknown[] = []) => {
    if (q.startsWith('SELECT GET_LOCK')) return [{ got: 1 }];
    if (q.includes('WHERE id = ? FOR UPDATE')) {
      const id = Number(params[0]);
      return [row(id, id === 3 ? 'manual' : 'ha')];
    }
    if (q.includes('FROM forward_rule_overrides')) return [];
    return q.startsWith('SELECT') ? [] : { affectedRows: 1 };
  });
  conn.rollback.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RPROXY_UI_HA_SYNC_SECS;
});

describe('nodeReadiness', () => {
  it('a node in line with the DB is ready', async () => {
    mocks.listRules.mockResolvedValue([status(8001), status(8002)]);
    const r = await nodeReadiness(loadNodes(), 'a');
    expect(r).toEqual({ node: 'a', ready: true, checked: 2, issues: [] });
  });

  it('lists missing and drifted rules of every active_standby group of the node', async () => {
    mocks.listRules.mockResolvedValue([status(8001, { remote_port: 81 })]);
    const r = await nodeReadiness(loadNodes(), 'b');
    expect(r.ready).toBe(false);
    expect(r.checked).toBe(3);
    expect(r.issues).toEqual([
      { target: 'ha', key: 'tcp|0.0.0.0|8001', state: 'drift', fields: ['remote'] },
      { target: 'ha', key: 'tcp|0.0.0.0|8002', state: 'missing' },
      { target: 'manual', key: 'tcp|0.0.0.0|8003', state: 'missing' },
    ]);
  });

  it('a node that cannot be reached is not ready (unknown)', async () => {
    mocks.listRules.mockRejectedValue(new RproxyError('rproxy に接続できません: ECONNREFUSED', 'unreachable', 0));
    const r = await nodeReadiness(loadNodes(), 'a');
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.state)).toEqual(['unknown', 'unknown']);
  });
});

describe('syncNode / runHaSyncOnce', () => {
  it('resends missing rules to the node and records RESEND by system with the node', async () => {
    mocks.listRules.mockResolvedValue([status(8001)]);
    mocks.getRule.mockRejectedValue(new RproxyError('no such rule', 'not_found', 404));
    const added: string[] = [];
    mocks.addRule.mockImplementation(async () => { added.push(currentNode()!.name); return {}; });
    const out = await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(out.results).toEqual([{ target: 'ha', key: 'tcp|0.0.0.0|8002', result: 'added' }]);
    expect(added).toEqual(['a']);
    const log = conn.query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))!;
    expect(log[1].slice(0, 3)).toEqual(['system', 'ha', 'a']);
    expect(log[1].at(-1)).toBe('RESEND');
    expect(conn.commit).toHaveBeenCalled();
  });

  it('onlyAuto skips groups with auto_resend: false; an explicit sync (notify) does not', async () => {
    mocks.listRules.mockResolvedValue([status(8001), status(8002)]);
    mocks.getRule.mockRejectedValue(new RproxyError('no such rule', 'not_found', 404));
    mocks.addRule.mockResolvedValue({});
    expect((await syncNode(loadNodes(), 'c', { onlyAuto: true })).results).toEqual([]);
    expect((await syncNode(loadNodes(), 'c', { onlyAuto: false })).results.map((r) => r.key)).toEqual(['tcp|0.0.0.0|8003']);
  });

  it('nothing changed on the node: no history row', async () => {
    mocks.listRules.mockResolvedValue([status(8001)]);
    // 見たときは無かったが、送り直す前に別のだれかが揃えた
    mocks.getRule.mockResolvedValue(status(8002));
    const out = await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(out.results).toEqual([{ target: 'ha', key: 'tcp|0.0.0.0|8002', result: 'unchanged' }]);
    expect(conn.query.mock.calls.some((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))).toBe(false);
    expect(conn.rollback).toHaveBeenCalled();
  });

  // セキュリティレビュー H1：同じキーを API のルール・ルールの組が使っていれば、送り直しでそれを消したり書き換えたりしない
  it('a key used by an API rule or a ruleset on the node is reported (shadowed) but never resent', async () => {
    mocks.listRules.mockResolvedValue([status(8001), status(8002, { origin: 'api', remote_port: 99, created_by: 'admin-token' })]);
    const r = await nodeReadiness(loadNodes(), 'a');
    expect(r.issues).toEqual([{ target: 'ha', key: 'tcp|0.0.0.0|8002', state: 'shadowed' }]);
    // UI からは直せないので昇格は止めない
    expect(r.ready).toBe(true);
    const out = await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(out.results).toEqual([]);
    mocks.listRules.mockResolvedValue([status(8001), status(8002, { ruleset: 'k8s/default/web' })]);
    expect((await syncNode(loadNodes(), 'a', { onlyAuto: true })).results).toEqual([]);
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(mocks.deleteRule).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('an API rule created between the check and the resend is left alone (shadowed, no history)', async () => {
    mocks.listRules.mockResolvedValue([status(8001)]);
    mocks.getRule.mockResolvedValue(status(8002, { origin: 'api', remote_port: 99 }));
    const out = await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(out.results).toEqual([{ target: 'ha', key: 'tcp|0.0.0.0|8002', result: 'shadowed' }]);
    expect(conn.query.mock.calls.some((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log'))).toBe(false);
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('resendOne does not delete an API rule for a paused UI rule, nor patch one that drifts', async () => {
    const paused = fromRow(row(2, 'ha', { options: JSON.stringify({ enabled: false }) }));
    mocks.getRule.mockResolvedValue(status(8002, { origin: 'api' }));
    expect(await resendOne(paused)).toBe('shadowed');
    expect(await resendOne(fromRow(row(2, 'ha')))).toBe('shadowed');
    mocks.getRule.mockResolvedValue(status(8002, { origin: 'dynamic', ruleset: 'k8s/default/web', remote_port: 99 }));
    expect(await resendOne(fromRow(row(2, 'ha')))).toBe('shadowed');
    expect(mocks.deleteRule).not.toHaveBeenCalled();
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    // origin を返さない古い rproxy のルールは UI のもの
    mocks.getRule.mockResolvedValue(status(8002, { remote_port: 99 }));
    mocks.modifyRule.mockResolvedValue({});
    expect(await resendOne(fromRow(row(2, 'ha')))).toBe('modified');
  });

  it('counts repeated failures and clears them after a success', async () => {
    mocks.listRules.mockResolvedValue([status(8001)]);
    mocks.getRule.mockRejectedValue(new RproxyError('no such rule', 'not_found', 404));
    mocks.addRule.mockRejectedValue(new RproxyError('address already in use', 'bind_failed', 409));
    for (let i = 0; i < 3; i++) await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(haSyncStatus().failures).toEqual([expect.objectContaining({ node: 'a', target: 'ha', key: 'tcp|0.0.0.0|8002', count: 3, error: 'address already in use' })]);
    mocks.addRule.mockResolvedValue({});
    await syncNode(loadNodes(), 'a', { onlyAuto: true });
    expect(haSyncStatus().failures).toEqual([]);
  });

  it('runs once per round under a DB lock; another instance holding it means skip', async () => {
    mocks.listRules.mockResolvedValue([status(8001), status(8002)]);
    expect(await runHaSyncOnce()).toBe('done');
    expect(haSyncStatus().lastRun).not.toBeNull();
    // manual（auto_resend: false）のノード c には聞かない
    expect(conn.query.mock.calls.some((c) => String(c[0]).startsWith('SELECT RELEASE_LOCK'))).toBe(true);
    conn.query.mockImplementation(async (q: string) => (q.startsWith('SELECT GET_LOCK') ? [{ got: 0 }] : []));
    mocks.listRules.mockClear();
    expect(await runHaSyncOnce()).toBe('skipped');
    expect(mocks.listRules).not.toHaveBeenCalled();
  });

  // セキュリティレビュー L6：ロックを解放できなかった接続は pool に返さない
  it('destroys the lock connection when RELEASE_LOCK fails', async () => {
    mocks.listRules.mockResolvedValue([status(8001), status(8002)]);
    const base = conn.query.getMockImplementation()!;
    conn.query.mockImplementation(async (q: string, params?: unknown[]) => {
      if (q.startsWith('SELECT RELEASE_LOCK')) throw new Error('connection lost');
      return base(q, params);
    });
    expect(await runHaSyncOnce()).toBe('done');
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    const released = conn.release.mock.calls.length;
    conn.query.mockImplementation(base);
    expect(await runHaSyncOnce()).toBe('done');
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release.mock.calls.length).toBeGreaterThan(released);
  });

  it('starts one loop per process; RPROXY_UI_HA_SYNC_SECS=0 disables it', () => {
    vi.useFakeTimers();
    expect(haSyncIntervalSecs({})).toBe(30);
    expect(haSyncIntervalSecs({ RPROXY_UI_HA_SYNC_SECS: '5' })).toBe(5);
    expect(haSyncIntervalSecs({ RPROXY_UI_HA_SYNC_SECS: 'x' })).toBe(30);
    process.env.RPROXY_UI_HA_SYNC_SECS = '0';
    expect(startHaSync()).toBe(false);
    process.env.RPROXY_UI_HA_SYNC_SECS = '5';
    expect(startHaSync()).toBe(true);
    expect(startHaSync()).toBe(false);
    stopHaSync();
  });
});

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, query: Record<string, string>, token?: string) {
  const req = { method, query, headers: token ? { authorization: `Bearer ${token}` } : {}, body: undefined } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

describe('keepalived endpoints', () => {
  afterEach(() => { delete process.env.RPROXY_UI_HA_TOKEN_FILE; });

  it('checkHaToken: disabled without the file, then the bearer token must match a line', () => {
    expect(checkHaToken('Bearer x', {})).toMatchObject({ ok: false, status: 404, code: 'ha_disabled' });
    const env = { RPROXY_UI_HA_TOKEN_FILE: join(dir, 'ha.tokens') };
    expect(checkHaToken('Bearer secret-2', env)).toEqual({ ok: true });
    expect(checkHaToken('Bearer secret-3', env)).toMatchObject({ ok: false, status: 401 });
    expect(checkHaToken(undefined, env)).toMatchObject({ ok: false, status: 401 });
    expect(checkHaToken('Bearer x', { RPROXY_UI_HA_TOKEN_FILE: join(dir, 'none') })).toMatchObject({ ok: false, status: 500 });
  });

  it('GET ha/ready: 200 in sync, 503 with the issues otherwise; 404 without the token file', async () => {
    expect((await call(readyHandler, 'GET', { node: 'a' }, 'secret-1')).status).toBe(404);
    process.env.RPROXY_UI_HA_TOKEN_FILE = join(dir, 'ha.tokens');
    expect((await call(readyHandler, 'GET', { node: 'a' }, 'nope')).status).toBe(401);
    expect((await call(readyHandler, 'GET', { node: 'zzz' }, 'secret-1')).status).toBe(400);
    mocks.listRules.mockResolvedValue([status(8001), status(8002)]);
    expect((await call(readyHandler, 'GET', { node: 'a' }, 'secret-1')).status).toBe(200);
    mocks.listRules.mockResolvedValue([status(8001)]);
    const bad = await call(readyHandler, 'GET', { node: 'a' }, 'secret-1');
    expect(bad.status).toBe(503);
    expect(bad.body.issues).toEqual([{ target: 'ha', key: 'tcp|0.0.0.0|8002', state: 'missing' }]);
  });

  it('POST ha/notify (MASTER): resends to the promoted node at once, also for auto_resend: false groups', async () => {
    process.env.RPROXY_UI_HA_TOKEN_FILE = join(dir, 'ha.tokens');
    mocks.listRules.mockResolvedValue([]);
    mocks.getRule.mockRejectedValue(new RproxyError('no such rule', 'not_found', 404));
    const added: string[] = [];
    mocks.addRule.mockImplementation(async () => { added.push(currentNode()!.name); return {}; });
    const out = await call(notifyHandler, 'POST', { node: 'c', state: 'MASTER' }, 'secret-1');
    expect(out.status).toBe(200);
    expect(out.body.results.map((r: any) => [r.key, r.result])).toEqual([['tcp|0.0.0.0|8003', 'added']]);
    expect(added).toEqual(['c']);
    // BACKUP などは何もしない
    added.length = 0;
    expect((await call(notifyHandler, 'POST', { node: 'c', state: 'BACKUP' }, 'secret-1')).body.results).toEqual([]);
    expect(added).toEqual([]);
    expect((await call(notifyHandler, 'GET', { node: 'c' }, 'secret-1')).status).toBe(405);
  });
});
