// 複数のノード（#98）の E2E：UI の API route を、本物の MariaDB と 2 台の rproxy-api（それぞれ別のコンテナ）につないで動かす。
// RUN_E2E_NODES=1 のときだけ実行する（CI の e2e-nodes ジョブが用意する）。
// 必要な環境変数: DB_*、RPROXY_UI_NODES（ノード n1・n2 とグループ ha = [n1, n2] の設定ファイル）、
// E2E_NODE_CONTAINERS（n1=コンテナ名,n2=コンテナ名。再起動の確認に使う）。
// 各 rproxy の RPROXY_DATABASE_URL は db/node-view.mjs で作ったノードごとのデータベース（ビュー）を、読み取り専用のユーザーで読む
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { execFileSync } from 'node:child_process';

const run = process.env.RUN_E2E_NODES === '1';

vi.mock('next-auth', () => ({
  getServerSession: async () => ({ user: { id: 'e2e-user', name: 'e2e', email: 'e2e@example.com', image: '', role: '' }, expires: '' }),
}));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));

async function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const { default: handler } = await import('@/pages/api/forward/[forward]');
  let status = 0;
  let json: any;
  const res = {
    status(s: number) { status = s; return res; },
    json(j: unknown) { json = j; return res; },
  } as unknown as NextApiResponse;
  await handler({ method, query: { ...query, forward: action }, body } as unknown as NextApiRequest, res);
  return { status, json };
}

// rproxy の GET /rules を、設定ファイルのノードに直接聞く（UI を通さない）
async function rulesOn(node: string): Promise<number[]> {
  const { loadNodes, targetNodes, toRproxyNode } = await import('@/components/nodes');
  const { listRules, withNode } = await import('@/components/rproxy');
  const n = targetNodes(loadNodes(), node)![0];
  const rules = await withNode(toRproxyNode(n), () => listRules());
  return rules.filter((r) => r.origin !== 'static').map((r) => r.listen_port).sort();
}

async function viewPorts(database: string): Promise<number[]> {
  const mariadb = (await import('mariadb')).default;
  const conn = await mariadb.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: database,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  try {
    // rproxy-api（src/config/db.rs）と同じ SELECT がビューで通ること
    const rows = await conn.query('SELECT protocol, src_addr, CAST(src_port AS SIGNED) AS src_port, dist_addr, CAST(dist_port AS SIGNED) AS dist_port, source_ip, CAST(udp_idle_secs AS SIGNED) AS udp_idle_secs, CAST(src_port_end AS SIGNED) AS src_port_end, CAST(options AS CHAR) AS options FROM forward_rules');
    return rows.map((r: any) => Number(r.src_port)).sort();
  } finally {
    await conn.end();
  }
}

function container(node: string): string {
  const pairs = (process.env.E2E_NODE_CONTAINERS ?? '').split(',').map((p) => p.split('='));
  const hit = pairs.find(([n]) => n === node);
  if (!hit) throw new Error(`E2E_NODE_CONTAINERS に ${node} がありません`);
  return hit[1];
}

async function waitFor(fn: () => Promise<unknown>, secs = 30): Promise<void> {
  let last: unknown;
  for (let i = 0; i < secs * 2; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

describe.runIf(run)('e2e: two rproxy nodes, a group and per-node views', () => {
  const rule = (port: number) => ({
    protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, distAddr: '127.0.0.1', distPort: 9, sourceIp: 'proxy', udpIdleSecs: 30,
  });
  const GROUP_PORT = 19400;
  const N1_PORT = 19401;
  const N2_PORT = 19402;

  it('lists the nodes and the group', async () => {
    const { status, json } = await call('nodes', undefined, 'GET');
    expect(status).toBe(200);
    expect(json.nodes.map((n: any) => n.name)).toEqual(['n1', 'n2']);
    expect(json.groups).toEqual([{ name: 'ha', mode: 'active_standby', nodes: ['n1', 'n2'] }]);
  });

  it('a group rule is created on both nodes', async () => {
    const add = await call('add', { ...rule(GROUP_PORT), target: 'ha' });
    expect(add.status, JSON.stringify(add.json)).toBe(200);
    expect(add.json.nodes).toEqual([{ node: 'n1', ok: true }, { node: 'n2', ok: true }]);
    expect(await rulesOn('n1')).toContain(GROUP_PORT);
    expect(await rulesOn('n2')).toContain(GROUP_PORT);
  });

  it('a node rule is created on that node only', async () => {
    expect((await call('add', { ...rule(N1_PORT), target: 'n1' })).status).toBe(200);
    expect((await call('add', { ...rule(N2_PORT), target: 'n2' })).status).toBe(200);
    expect(await rulesOn('n1')).toEqual([GROUP_PORT, N1_PORT]);
    expect(await rulesOn('n2')).toEqual([GROUP_PORT, N2_PORT]);
  });

  it('the same key on a node of the group is refused', async () => {
    const { status, json } = await call('add', { ...rule(GROUP_PORT), target: 'n1' });
    expect(status).toBe(409);
    expect(json.code).toBe('target_conflict');
  });

  it('the dashboard shows the state per node', async () => {
    const { status, json } = await call('dashboard', undefined, 'GET');
    expect(status).toBe(200);
    expect(json.reachable).toBe(true);
    expect(json.rproxyError).toBeNull();
    expect(json.nodes).toEqual([
      { name: 'n1', reachable: true, error: null, rules: 2, failed: 0 },
      { name: 'n2', reachable: true, error: null, rules: 2, failed: 0 },
    ]);
    const group = json.rules.find((r: any) => r.srcPort === GROUP_PORT);
    expect(group.target).toBe('ha');
    expect(group.state).toBe('running');
    expect(group.nodes.map((n: any) => [n.node, n.state])).toEqual([['n1', 'running'], ['n2', 'running']]);
  });

  it('each node\'s view has its own rules and the group\'s', async () => {
    expect(await viewPorts('rproxy_node_n1')).toEqual([GROUP_PORT, N1_PORT]);
    expect(await viewPorts('rproxy_node_n2')).toEqual([GROUP_PORT, N2_PORT]);
  });

  it('a restarted rproxy restores only its own rules through its view', async () => {
    execFileSync('docker', ['restart', container('n2')], { stdio: 'inherit' });
    await waitFor(async () => {
      expect(await rulesOn('n2')).toEqual([GROUP_PORT, N2_PORT]);
    });
    expect(await rulesOn('n1')).toEqual([GROUP_PORT, N1_PORT]);
  });

  it('pausing and deleting a group rule applies to both nodes', async () => {
    expect((await call('pause', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: GROUP_PORT, target: 'ha' })).status).toBe(200);
    expect(await rulesOn('n1')).toEqual([N1_PORT]);
    expect(await rulesOn('n2')).toEqual([N2_PORT]);
    // 停止中のルールはビューにあっても rproxy は作らない（options.enabled: false）
    execFileSync('docker', ['restart', container('n1')], { stdio: 'inherit' });
    await waitFor(async () => {
      expect(await rulesOn('n1')).toEqual([N1_PORT]);
    });

    expect((await call('resume', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: GROUP_PORT, target: 'ha' })).status).toBe(200);
    expect(await rulesOn('n2')).toEqual([GROUP_PORT, N2_PORT]);

    for (const [port, target] of [[GROUP_PORT, 'ha'], [N1_PORT, 'n1'], [N2_PORT, 'n2']] as const) {
      expect((await call('delete', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, target: target })).status).toBe(200);
    }
    expect(await rulesOn('n1')).toEqual([]);
    expect(await rulesOn('n2')).toEqual([]);
  });

  it('a group change that fails on one node is undone on the other', async () => {
    // n2 にだけ同じ待ち受けのルールを UI を通さずに作り、グループのルールを n2 で失敗させる
    const { loadNodes, targetNodes, toRproxyNode } = await import('@/components/nodes');
    const { addRule, deleteRule, withNode } = await import('@/components/rproxy');
    const n2 = toRproxyNode(targetNodes(loadNodes(), 'n2')![0]);
    const key = { protocol: 'tcp' as const, listen_addr: '127.0.0.1', listen_port: GROUP_PORT };
    await withNode(n2, () => addRule({ ...key, remote_addr: '127.0.0.1', remote_port: 9 }));
    try {
      const { status, json } = await call('add', { ...rule(GROUP_PORT), target: 'ha' });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(json.nodes.find((n: any) => n.node === 'n1')).toEqual({ node: 'n1', ok: true, undone: true });
      expect(json.nodes.find((n: any) => n.node === 'n2').ok).toBe(false);
      expect(await rulesOn('n1')).toEqual([]);
      expect(await viewPorts('rproxy_node_n1')).toEqual([]);
    } finally {
      await withNode(n2, () => deleteRule(key));
    }
  });
});
