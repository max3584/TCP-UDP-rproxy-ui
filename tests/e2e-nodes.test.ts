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

// CI の nodes.yaml のグループ ha の vip
const VIP = '10.99.0.10';

// コンテナのネットワーク名前空間で ip を動かす（keepalived が VIP を付け外しする代わり）
function ipInContainer(node: string, args: string[]): void {
  const pid = execFileSync('docker', ['inspect', '-f', '{{.State.Pid}}', container(node)]).toString().trim();
  execFileSync('sudo', ['nsenter', '-t', pid, '-n', 'ip', ...args], { stdio: 'inherit' });
}

async function groupHa(): Promise<{ active: string[]; warning: string | null }> {
  const { json } = await call('dashboard', undefined, 'GET');
  const g = (json.groups ?? []).find((x: any) => x.name === 'ha');
  return { active: g.active, warning: g.warning };
}

// ビューの行（rproxy と同じ SELECT）。上書きを重ねた結果を確かめる
async function viewRows(database: string): Promise<any[]> {
  const mariadb = (await import('mariadb')).default;
  const conn = await mariadb.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: database,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  try {
    const rows = await conn.query('SELECT protocol, src_addr, CAST(src_port AS SIGNED) AS src_port, dist_addr, CAST(dist_port AS SIGNED) AS dist_port, CAST(options AS CHAR) AS options FROM forward_rules');
    return rows.map((r: any) => ({ ...r, src_port: Number(r.src_port), dist_port: Number(r.dist_port) }));
  } finally {
    await conn.end();
  }
}

// ノードの GET /rules の 1 件（待ち受けアドレスも見る）
async function liveOn(node: string, port: number): Promise<any | undefined> {
  const { loadNodes, targetNodes, toRproxyNode } = await import('@/components/nodes');
  const { listRules, withNode } = await import('@/components/rproxy');
  const n = targetNodes(loadNodes(), node)![0];
  return (await withNode(toRproxyNode(n), () => listRules())).find((r) => r.listen_port === port);
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
    expect(json.groups).toEqual([{ name: 'ha', mode: 'active_standby', nodes: ['n1', 'n2'], vips: [VIP] }]);
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
      { name: 'n1', reachable: true, error: null, rules: 2, failed: 0, drifted: 0, lastSync: expect.any(String) },
      { name: 'n2', reachable: true, error: null, rules: 2, failed: 0, drifted: 0, lastSync: expect.any(String) },
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

  it('shows the node holding the VIP as act, and warns when none or both hold it', async () => {
    expect(await groupHa()).toEqual({ active: [], warning: 'none' });
    ipInContainer('n1', ['addr', 'add', `${VIP}/32`, 'dev', 'eth0']);
    try {
      expect(await groupHa()).toEqual({ active: ['n1'], warning: null });
      ipInContainer('n2', ['addr', 'add', `${VIP}/32`, 'dev', 'eth0']);
      try {
        expect(await groupHa()).toEqual({ active: ['n1', 'n2'], warning: 'split' });
      } finally {
        ipInContainer('n1', ['addr', 'del', `${VIP}/32`, 'dev', 'eth0']);
      }
      expect(await groupHa()).toEqual({ active: ['n2'], warning: null });
      // ルールの詳細でも、ノードごとの役割が付く
      expect((await call('add', { ...rule(GROUP_PORT), target: 'ha' })).status).toBe(200);
      const { json } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(GROUP_PORT), target: 'ha' });
      expect(json.nodes.map((n: any) => [n.node, n.role])).toEqual([['n1', 'standby'], ['n2', 'active']]);
      expect(json.ha).toEqual({ addrs: [VIP], active: ['n2'], warning: null });
    } finally {
      ipInContainer('n2', ['addr', 'flush', 'dev', 'eth0', 'to', `${VIP}/32`]);
    }
  });

  it('detects a rule changed directly on one node (drift) and resending fixes that node only', async () => {
    const { loadNodes, targetNodes, toRproxyNode } = await import('@/components/nodes');
    const { modifyRule, withNode } = await import('@/components/rproxy');
    const n2 = toRproxyNode(targetNodes(loadNodes(), 'n2')![0]);
    const key = { protocol: 'tcp' as const, listen_addr: '127.0.0.1', listen_port: GROUP_PORT };
    // UI を通さずに n2 の転送先を変える
    await withNode(n2, () => modifyRule(key, { remote_addr: '127.0.0.1', remote_port: 10, tls: { mode: 'passthrough' }, allow_from: [] }));

    const q = { protocol: 'tcp', addr: '127.0.0.1', port: String(GROUP_PORT), target: 'ha' };
    let { json } = await call('rule', undefined, 'GET', q);
    expect(json.nodes.map((n: any) => [n.node, n.drift])).toEqual([['n1', []], ['n2', ['remote']]]);
    const dash = await call('dashboard', undefined, 'GET');
    expect(dash.json.nodes.map((n: any) => [n.name, n.drifted])).toEqual([['n1', 0], ['n2', 1]]);

    const resend = await call('resend', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: GROUP_PORT, target: 'ha', node: 'n2' });
    expect(resend.status, JSON.stringify(resend.json)).toBe(200);
    expect(resend.json).toEqual({ node: 'n2', result: 'modified' });
    ({ json } = await call('rule', undefined, 'GET', q));
    expect(json.nodes.map((n: any) => n.drift)).toEqual([[], []]);

    // 履歴に送り直し（RESEND）とノードが残る
    const history = await call('history', undefined, 'GET', { ...q, action: 'RESEND' });
    expect(history.json.entries[0]).toMatchObject({ action: 'RESEND', node: 'n2', target: 'ha' });
  });

  it('shows a rule removed from one node as missing, and resending recreates it there', async () => {
    const { loadNodes, targetNodes, toRproxyNode } = await import('@/components/nodes');
    const { deleteRule, withNode } = await import('@/components/rproxy');
    const n1 = toRproxyNode(targetNodes(loadNodes(), 'n1')![0]);
    await withNode(n1, () => deleteRule({ protocol: 'tcp', listen_addr: '127.0.0.1', listen_port: GROUP_PORT }));
    const q = { protocol: 'tcp', addr: '127.0.0.1', port: String(GROUP_PORT), target: 'ha' };
    let { json } = await call('rule', undefined, 'GET', q);
    expect(json.nodes.map((n: any) => [n.node, n.state])).toEqual([['n1', 'missing'], ['n2', 'running']]);

    const resend = await call('resend', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: GROUP_PORT, target: 'ha', node: 'n1' });
    expect(resend.json).toEqual({ node: 'n1', result: 'added' });
    ({ json } = await call('rule', undefined, 'GET', q));
    expect(json.nodes.map((n: any) => n.state)).toEqual(['running', 'running']);
    expect(await rulesOn('n1')).toEqual([GROUP_PORT]);

    expect((await call('delete', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: GROUP_PORT, target: 'ha' })).status).toBe(200);
  });

  const OV_PORT = 19410;

  it('a per-node override changes that node only, is not drift, and survives a restart through the view', async () => {
    expect((await call('add', { ...rule(OV_PORT), target: 'ha' })).status).toBe(200);
    const set = await call('override', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: OV_PORT, target: 'ha', node: 'n2', override: { srcAddr: '127.0.0.2', distAddr: '127.0.0.1', distPort: 10 } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(await liveOn('n1', OV_PORT)).toMatchObject({ listen_addr: '127.0.0.1', remote_port: 9 });
    expect(await liveOn('n2', OV_PORT)).toMatchObject({ listen_addr: '127.0.0.2', remote_port: 10 });

    const { json } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(OV_PORT), target: 'ha' });
    expect(json.overrides).toEqual({ n2: { srcAddr: '127.0.0.2', distAddr: '127.0.0.1', distPort: 10 } });
    expect(json.nodes.map((n: any) => [n.node, n.state, n.drift])).toEqual([['n1', 'running', []], ['n2', 'running', []]]);

    // ビューが上書きを重ねる（rproxy と同じ SELECT）
    const v2 = (await viewRows('rproxy_node_n2')).find((r) => Number(r.src_port) === OV_PORT);
    expect(v2).toMatchObject({ src_addr: '127.0.0.2', dist_port: 10 });
    const v1 = (await viewRows('rproxy_node_n1')).find((r) => Number(r.src_port) === OV_PORT);
    expect(v1).toMatchObject({ src_addr: '127.0.0.1', dist_port: 9 });

    execFileSync('docker', ['restart', container('n2')], { stdio: 'inherit' });
    await waitFor(async () => {
      expect(await liveOn('n2', OV_PORT)).toMatchObject({ listen_addr: '127.0.0.2', remote_port: 10 });
    });

    // エクスポートに上書きが入る
    const { default: handler } = await import('@/pages/api/forward/[forward]');
    let sent = '';
    const res: any = { setHeader: () => undefined, status: () => res, send: (b: string) => { sent = b; return res; }, json: () => res };
    await handler({ method: 'GET', query: { forward: 'export', target: 'ha' } } as unknown as NextApiRequest, res);
    const doc = JSON.parse(sent);
    expect(doc.rules.find((r: any) => r.listen_port === OV_PORT).overrides).toEqual({ n2: { listen_addr: '127.0.0.2', remote_addr: '127.0.0.1', remote_port: 10 } });
  });

  it('pausing a node pauses group rules on that node only, also across a restart', async () => {
    const paused = await call('pause-node', { node: 'n1', action: 'pause' });
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    expect(paused.json.results.find((r: any) => r.key === `tcp|127.0.0.1|${OV_PORT}`).result).toBe('paused');
    expect(await liveOn('n1', OV_PORT)).toBeUndefined();
    expect(await liveOn('n2', OV_PORT)).toBeDefined();
    execFileSync('docker', ['restart', container('n1')], { stdio: 'inherit' });
    await waitFor(async () => { await rulesOn('n1'); });
    expect(await liveOn('n1', OV_PORT)).toBeUndefined();

    expect((await call('pause-node', { node: 'n1', action: 'resume' })).status).toBe(200);
    expect(await liveOn('n1', OV_PORT)).toMatchObject({ listen_addr: '127.0.0.1' });
  });

  it('copying to an overlapping node is refused; moving to a node keeps that node\'s override', async () => {
    const copy = await call('copy', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: OV_PORT, target: 'ha', to: 'n1' });
    expect(copy.status).toBe(409);
    expect(copy.json.code).toBe('target_conflict');

    const move = await call('copy', { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: OV_PORT, target: 'ha', to: 'n2', move: true });
    expect(move.status, JSON.stringify(move.json)).toBe(200);
    expect(await liveOn('n1', OV_PORT)).toBeUndefined();
    expect(await liveOn('n2', OV_PORT)).toMatchObject({ listen_addr: '127.0.0.2', remote_port: 10 });
    const history = await call('history', undefined, 'GET', { protocol: 'tcp', port: String(OV_PORT) });
    expect(history.json.entries.slice(0, 2).map((e: any) => [e.action, e.target])).toEqual([['ADD', 'n2'], ['DELETE', 'ha']]);

    expect((await call('delete', { protocol: 'tcp', srcAddr: '127.0.0.2', srcPort: OV_PORT, target: 'n2' })).status).toBe(200);
    expect(await liveOn('n2', OV_PORT)).toBeUndefined();
  });
});
