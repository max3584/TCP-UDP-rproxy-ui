// Kubernetes の rproxy（rproxy-gateway が UI の namespace に書く Secret rproxy-ui-discovery。RPROXY_UI_K8S_DISCOVERY）：
// 読み方、見るだけ（409 readonly_node）、管理者だけ、利用量の行の node。MariaDB と rproxy はモック
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  addRule: mocks.addRule, modifyRule: mocks.modifyRule, deleteRule: mocks.deleteRule,
  listRules: mocks.listRules, getRule: mocks.getRule, getInterfaces: mocks.getInterfaces,
}));

import handler from '@/pages/api/forward/[forward]';
import { currentNode } from '@/components/rproxy';
import {
  K8S_PREFIX, NodesConfigError, isReadonlyTarget, loadNodes, membership, nodesInfo, parseDiscovery, resetNodesCache,
  usageRowNode, visibleNodes, withDiscovery,
} from '@/components/nodes';
import type { NodesConfig } from '@/components/nodes';
import { targetChoices } from '@/components/dashboard';
import { collectNode } from '@/components/usagecollect';

const { conn, pool } = mocks;

const admin = { user: { id: 'admin-1', name: 'a', email: 'e', image: '', roles: ['rproxy-admin'] }, expires: '' };
const user = { user: { id: 'user-1', name: 'u', email: 'e', image: '', roles: ['rproxy-user'] }, expires: '' };

const POD_A = 'k8s:team-a/web/rproxy-team-a-web-abc-1';
const POD_B = 'k8s:team-a/web/rproxy-team-a-web-abc-2';
const GW = 'k8s:team-a/web';

// コントローラが書く形（rproxy-gateway の docs/DESIGN-v0.4.x.md 4.1）
function discoveryYaml(pods: string[]): string {
  return [
    '# written by rproxy-gateway',
    'nodes:',
    ...pods.map((p, i) => [
      `  - name: ${p}`,
      `    url: https://10.244.0.${i + 5}:9443`,
      '    tls_server_name: team-a-web-0123abcd.rproxy-api.rproxy-gateway.internal',
      '    tls_ca: ca.crt',
      '    token_file: token-team-a-web-0123abcd',
      '    readonly: true',
    ].join('\n')),
    'groups:',
    `  - name: ${GW}`,
    `    nodes: [${pods.join(', ')}]`,
    '    readonly: true',
  ].join('\n');
}

let dir = '';
let tick = 1_700_000_000;
function writeDiscovery(pods: string[]): void {
  writeFileSync(join(dir, 'nodes.yaml'), discoveryYaml(pods));
  // 同じ秒に書いても更新時刻が変わるように（kubelet はファイルをまとめて入れ替える）
  tick += 10;
  utimesSync(join(dir, 'nodes.yaml'), tick, tick);
}

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body, headers: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

const status = (port: number, extra: Record<string, unknown> = {}) => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: port, remote_addr: '', remote_port: 0,
  state: 'running', error: null, resolved: [], connections: 1,
  stats: { total_connections: 10, rx_bytes: 100, tx_bytes: 200, tls_failures: 0, counters_since: 1000 }, started_at: 1000,
  origin: 'dynamic', ruleset: 'k8s/team-a/web', labels: { 'gateway.networking.k8s.io/gateway-name': 'web' }, ...extra,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-k8s-'));
  writeFileSync(join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  writeFileSync(join(dir, 'token-team-a-web-0123abcd'), 'ui-token-a\n');
  writeDiscovery([POD_A, POD_B]);
  delete process.env.RPROXY_UI_NODES;
  process.env.RPROXY_API_URL = 'http://vm:8081';
  process.env.RPROXY_UI_K8S_DISCOVERY = dir;
  resetNodesCache();
});

afterAll(() => {
  delete process.env.RPROXY_UI_K8S_DISCOVERY;
  delete process.env.RPROXY_API_URL;
  resetNodesCache();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(admin);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockImplementation(async (q: string) => (q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
  conn.rollback.mockResolvedValue(undefined);
  pool.query.mockResolvedValue([]);
  mocks.getInterfaces.mockResolvedValue({ interfaces: [], reserved: [] });
  mocks.listRules.mockImplementation(async () => (currentNode()?.name.startsWith(K8S_PREFIX) ? [status(443)] : []));
});

describe('parseDiscovery', () => {
  const read = (files: Record<string, string>) => (p: string) => {
    const f = files[p];
    if (f === undefined) throw new Error('ENOENT');
    return f;
  };
  const files = { '/d/ca.crt': 'CA', '/d/token-x': 'tok\n' };

  it('reads nodes and groups as read-only, with the CA, the server name and the token in the directory', () => {
    const d = parseDiscovery(discoveryYaml([POD_A]).replaceAll('team-a-web-0123abcd', 'x'), '/d', read(files));
    expect(d.nodes).toEqual([{
      name: POD_A, url: 'https://10.244.0.5:9443', tokenFile: '/d/token-x', token: 'tok',
      tls: { ca: '/d/ca.crt', servername: 'x.rproxy-api.rproxy-gateway.internal' }, readonly: true,
    }]);
    expect(d.groups).toEqual([{ name: GW, nodes: [POD_A], mode: 'single', vips: [], autoResend: false, readonly: true }]);
  });

  it('an empty file or a group without pods gives nothing', () => {
    expect(parseDiscovery('', '/d', read(files))).toEqual({ nodes: [], groups: [] });
    expect(parseDiscovery(`nodes: []\ngroups: [{name: "${GW}", nodes: []}]`, '/d', read(files)).groups).toEqual([]);
  });

  it('refuses files outside the directory, other names and plain http', () => {
    const node = (extra: string) => `nodes:\n  - {name: "${POD_A}", url: "https://10.0.0.1:9443", tls_server_name: a.b, tls_ca: ca.crt, token_file: token-x${extra}}`;
    expect(() => parseDiscovery(node('').replace('token-x', '../token-x'), '/d', read(files))).toThrow(NodesConfigError);
    expect(() => parseDiscovery(node('').replace('token-x', '/etc/passwd'), '/d', read(files))).toThrow(NodesConfigError);
    expect(() => parseDiscovery(node('').replace(POD_A, 'node1'), '/d', read(files))).toThrow(/k8s:/);
    expect(() => parseDiscovery(node('').replace('https://', 'http://'), '/d', read(files))).toThrow(/https/);
    expect(() => parseDiscovery(node('').replace('token-x', 'token-missing'), '/d', read(files))).toThrow(/token_file/);
    // a newer controller's keys are ignored
    expect(parseDiscovery(node(', zone: a'), '/d', read(files)).nodes).toHaveLength(1);
  });
});

describe('the merged config', () => {
  const k8s = parseDiscovery(discoveryYaml([POD_A, POD_B]), dir, (p) => (p.endsWith('.crt') ? 'CA' : 'tok'));
  const implicit: NodesConfig = { configured: false, nodes: [{ name: 'default', url: '' }], groups: [], defaultTarget: 'default' };

  it('without Kubernetes rproxy nothing changes', () => {
    expect(withDiscovery(implicit, { nodes: [], groups: [] }, false)).toBe(implicit);
  });

  it('RPROXY_API_URL\'s rproxy stays the default target; without it only the Kubernetes rproxy (no default)', () => {
    const both = withDiscovery(implicit, k8s, true);
    expect(both.configured).toBe(true);
    expect(both.nodes.map((n) => n.name)).toEqual(['default', POD_A, POD_B]);
    expect(both.defaultTarget).toBe('default');
    const only = withDiscovery(implicit, k8s, false);
    expect(only.nodes.map((n) => n.name)).toEqual([POD_A, POD_B]);
    expect(only.defaultTarget).toBeNull();
  });

  it('users do not see the Kubernetes rproxy; membership, choices and usage rows', () => {
    const cfg = withDiscovery(implicit, k8s, true);
    expect(visibleNodes(cfg, true)).toBe(cfg);
    const shown = visibleNodes(cfg, false);
    expect(shown.nodes.map((n) => n.name)).toEqual(['default']);
    expect(shown.groups).toEqual([]);
    expect(membership(cfg)).toEqual([{ node: 'default', target: 'default' }]);
    expect(isReadonlyTarget(cfg, GW)).toBe(true);
    expect(isReadonlyTarget(cfg, 'default')).toBe(false);
    const info = nodesInfo(cfg);
    expect(info.nodes.find((n) => n.name === POD_A)?.readonly).toBe(true);
    expect(targetChoices(info).map((c) => c.value)).toEqual(['default']);
    expect(usageRowNode(cfg, POD_A)).toBe(GW);
    expect(usageRowNode(cfg, 'default')).toBe('default');
  });

  it('reads nodes.yaml again when the controller rewrites it; a broken file gives no Kubernetes rproxy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(loadNodes().nodes.map((n) => n.name)).toEqual(['default', POD_A, POD_B]);
      writeDiscovery([POD_B]);
      expect(loadNodes().nodes.map((n) => n.name)).toEqual(['default', POD_B]);
      writeFileSync(join(dir, 'nodes.yaml'), 'nodes: [{name: x}]');
      tick += 10;
      utimesSync(join(dir, 'nodes.yaml'), tick, tick);
      expect(loadNodes().nodes.map((n) => n.name)).toEqual(['default']);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      writeDiscovery([POD_A, POD_B]);
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe('the API: read-only, admins only', () => {
  it('admins see the pods and their rule set rules marked read-only', async () => {
    const info = await call('nodes', undefined, 'GET');
    expect(info.body.nodes).toEqual([{ name: 'default' }, { name: POD_A, readonly: true }, { name: POD_B, readonly: true }]);
    const { status: code, body } = await call('dashboard', undefined, 'GET');
    expect(code).toBe(200);
    expect(body.nodes.filter((n: { readonly?: boolean }) => n.readonly).map((n: { name: string }) => n.name)).toEqual([POD_A, POD_B]);
    const k8sRules = body.rules.filter((r: { target?: string }) => r.target?.startsWith(K8S_PREFIX));
    expect(k8sRules).toHaveLength(2);
    expect(k8sRules.every((r: { readonlyNode?: boolean; ruleset?: string }) => r.readonlyNode === true && r.ruleset === 'k8s/team-a/web')).toBe(true);
    // forward_rule_targets never gets the Kubernetes pods
    const inserts = conn.query.mock.calls.filter((c) => String(c[0]).includes('forward_rule_targets') && String(c[0]).startsWith('INSERT'));
    expect(JSON.stringify(inserts)).not.toContain(K8S_PREFIX);
  });

  it('users see neither the pods nor their rules', async () => {
    mocks.getServerSession.mockResolvedValue(user);
    const info = await call('nodes', undefined, 'GET');
    expect(info.body.nodes).toEqual([{ name: 'default' }]);
    const { body } = await call('dashboard', undefined, 'GET');
    expect(JSON.stringify(body)).not.toContain(K8S_PREFIX);
    expect(mocks.listRules).toHaveBeenCalledTimes(1);
    const add = await call('add', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8443, distAddr: '192.0.2.1', distPort: 80, target: GW });
    expect(add.status).toBe(400);
    expect(add.body.code).toBe('unknown_target');
  });

  it('every change naming a Kubernetes node or group is 409 readonly_node, even for admins, and nothing reaches rproxy', async () => {
    const key = { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443 };
    const cases: [string, Record<string, unknown>][] = [
      ['add', { ...key, distAddr: '192.0.2.1', distPort: 80, target: GW }],
      ['modify', { ...key, distAddr: '192.0.2.1', distPort: 80, target: POD_A }],
      ['delete', { ...key, target: GW }],
      ['pause', { ...key, target: GW }],
      ['api-modify', { ...key, distAddr: '192.0.2.1', distPort: 80, target: POD_A }],
      ['api-delete', { ...key, target: POD_A }],
      ['resend', { ...key, target: 'default', node: POD_A }],
      ['pause-node', { node: POD_A, action: 'pause' }],
      ['copy', { ...key, target: 'default', to: GW }],
      ['ha-sync', { node: POD_B }],
      ['plan', { action: 'add', ...key, distAddr: '192.0.2.1', distPort: 80, target: GW }],
    ];
    for (const [action, body] of cases) {
      const res = await call(action, body);
      expect([action, res.status, res.body?.code]).toEqual([action, 409, 'readonly_node']);
    }
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(mocks.deleteRule).not.toHaveBeenCalled();
  });

  it('a rule of a pod (the rule page) is marked read-only', async () => {
    mocks.getRule.mockImplementation(async () => status(443));
    const { status: code, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443', target: POD_A });
    expect(code).toBe(200);
    expect(body.readonlyNode).toBe(true);
    expect(body.target).toBe(POD_A);
  });
});

describe('usage of the Kubernetes rproxy', () => {
  it('counters per pod, rows per Gateway with origin ruleset', async () => {
    const q = vi.fn(async (sql: string): Promise<unknown> => (sql.startsWith('SELECT') ? [] : { affectedRows: 1 }));
    const prev = [{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, counters_since: 1000, started_at: 1000, rx_bytes: 40, tx_bytes: 50, connections: 4, sampled_at: '2026-10-08 00:00:00.000' }];
    q.mockImplementationOnce(async () => prev);
    await collectNode({ query: q } as never, POD_A, [status(443) as never], new Map(), new Date('2026-10-08T00:01:00Z'), { rowNode: GW, k8s: true });
    const counters = q.mock.calls.find((c) => String(c[0]).startsWith('REPLACE INTO usage_counters'))!;
    expect((counters as unknown[])[1]).toEqual(expect.arrayContaining([POD_A]));
    const hourly = q.mock.calls.find((c) => String(c[0]).includes('INSERT INTO usage_hourly'))! as unknown[];
    const params = hourly[1] as unknown[];
    expect(params[1]).toBe(GW);
    // owner null, origin ruleset, the delta 60 / 150 / 6
    expect(params.slice(7, 13)).toEqual([null, 'ruleset', JSON.stringify({ 'gateway.networking.k8s.io/gateway-name': 'web' }), 60, 150, 6]);
  });
});
