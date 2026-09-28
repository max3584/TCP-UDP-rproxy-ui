// UI の API route を、本物の MariaDB と rproxy-api につないで動かす。
// RUN_E2E=1 のときだけ実行する（CI の e2e ジョブが DB と rproxy を用意する）。
// 必要な環境変数: DB_* と RPROXY_API_URL / RPROXY_API_TOKEN、E2E_BACKEND_PORT（エコーサーバを立てるポート。
// 範囲ルールの確認用に、その次の 2 ポートにもエコーサーバを立てる）
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const run = process.env.RUN_E2E === '1';

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

function echoThrough(port: number, msg: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, host, () => c.write(msg));
    c.setTimeout(3000, () => reject(new Error('timeout')));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
    // 拒否された接続は RST ではなく FIN で閉じることもある（データより先に閉じたら失敗。resolve の後なら何もしない）
    c.on('close', () => reject(new Error('closed without a reply')));
  });
}

// TLS で 1 往復する（servername は SNI。証明書は検証しない）
function tlsThrough(port: number, servername: string, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = tls.connect({ port: port, host: '127.0.0.1', servername: servername, rejectUnauthorized: false }, () => c.write(msg));
    c.setTimeout(3000, () => reject(new Error('timeout')));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
    c.on('close', () => reject(new Error('closed without a reply')));
  });
}

function canBind(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, host, () => s.close(() => resolve(true)));
  });
}

// 自己署名の証明書（openssl がなければ null）
function selfSigned(names: string[]): { cert: string; key: string; dir: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rproxy-ui-e2e-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', `/CN=${names[0]}`, '-addext', `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
      '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
  } catch {
    return null;
  }
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(key, 0o644);
  return { cert: cert, key: key, dir: dir };
}

async function withDb(fn: (conn: any) => Promise<any>): Promise<any> {
  const mariadb = (await import('mariadb')).default;
  const conn = await mariadb.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_DATABASE,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

function echoServer(port: number, prefix: string): Promise<net.Server> {
  const server = net.createServer((s) => s.on('data', (d) => s.end(`${prefix}:${d}`)));
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

describe.runIf(run)('e2e: UI API route + MariaDB + rproxy', () => {
  const backendPort = Number(process.env.E2E_BACKEND_PORT || 19001);
  const listenPort = 19300;
  // 範囲ルール: 19310-19311 → backendPort+1, backendPort+2
  const rangePort = 19310;
  const backends: net.Server[] = [];

  beforeAll(async () => {
    backends.push(await echoServer(backendPort, 'echo'));
    backends.push(await echoServer(backendPort + 1, 'echo0'));
    backends.push(await echoServer(backendPort + 2, 'echo1'));
  });
  afterAll(() => backends.forEach((b) => b.close()));

  const rule = {
    protocol: 'TCP', srcAddr: '127.0.0.1', srcPort: listenPort,
    distAddr: '127.0.0.1', distPort: backendPort, sourceIp: 'proxy', udpIdleSecs: 30,
  };

  it('adds a rule that forwards traffic', async () => {
    const add = await call('add', rule);
    expect(add.status).toBe(200);
    expect(await echoThrough(listenPort, 'hi')).toBe('echo:hi');
  });

  it('rejects a duplicate and an unresolvable target without leaving rows', async () => {
    expect((await call('add', rule)).status).toBe(409);
    const bad = await call('add', { ...rule, srcPort: listenPort + 1, distAddr: 'nowhere.invalid' });
    expect(bad.status).toBe(502);
    expect(bad.json.code).toBe('resolve_failed');
    const list = await call('list', undefined, 'GET');
    expect(list.json.map((r: any) => r.srcPort)).toEqual([listenPort]);
    expect(list.json[0].state).toBe('running');
    // rproxy の累計（前のテストで 1 回接続した）と開始時刻
    expect(list.json[0].stats).toMatchObject({
      total_connections: expect.any(Number), rx_bytes: expect.any(Number), tx_bytes: expect.any(Number), tls_failures: 0,
    });
    expect(list.json[0].stats.total_connections).toBeGreaterThanOrEqual(1);
    expect(list.json[0].stats.rx_bytes).toBeGreaterThanOrEqual(2);
    expect(list.json[0].startedAt).toBeGreaterThan(1_600_000_000);
    expect(list.json[0].resolved).toEqual([`127.0.0.1:${backendPort}`]);
  });

  it('returns one rule and the dashboard with live state', async () => {
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(listenPort) });
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ srcPort: listenPort, state: 'running', stats: { tls_failures: 0 } });
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(listenPort + 50) })).status).toBe(404);
    const dash = await call('dashboard', undefined, 'GET');
    expect(dash.json.reachable).toBe(true);
    expect(dash.json.rules.map((r: any) => r.srcPort)).toEqual([listenPort]);
  });

  it('modifies and deletes the rule', async () => {
    expect((await call('modify', { ...rule, distAddr: 'localhost' })).status).toBe(200);
    expect(await echoThrough(listenPort, 'again')).toBe('echo:again');
    expect((await call('delete', rule)).status).toBe(200);
    expect((await call('list', undefined, 'GET')).json).toEqual([]);
    await expect(echoThrough(listenPort, 'gone')).rejects.toThrow();
  });

  it('records who changed what in forward_rules_log', async () => {
    const rows = await withDb((conn) => conn.query('SELECT auth_id, update_action FROM forward_rules_log WHERE src_port = ? ORDER BY id', [listenPort]));
    expect(rows.map((r: any) => [r.auth_id, r.update_action])).toEqual([
      ['e2e-user', 'ADD'], ['e2e-user', 'UPDATE'], ['e2e-user', 'DELETE'],
    ]);
  });

  it('round-trips allow_from through the DB and rproxy and drops connections outside it', async () => {
    const allowRule = { ...rule, srcPort: listenPort + 3 };
    const key = { protocol: 'tcp' as const, listen_addr: '127.0.0.1', listen_port: listenPort + 3 };
    const { getRule } = await import('@/components/rproxy');
    const storedAllowFrom = async () => {
      const rows = await withDb((conn) => conn.query('SELECT options FROM forward_rules WHERE src_port = ?', [listenPort + 3]));
      const opts = rows[0].options;
      return opts === null ? null : (typeof opts === 'string' ? JSON.parse(opts) : opts).allow_from;
    };

    expect((await call('add', { ...allowRule, allowFrom: ['127.0.0.1', '10.9.8.7/8'] })).status).toBe(200);
    const normalized = ['127.0.0.1/32', '10.0.0.0/8'];
    expect(await storedAllowFrom()).toEqual(normalized);
    const live = await getRule(key);
    expect(live.allow_from).toEqual(normalized);
    expect(live.origin).toBe('dynamic');
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(listenPort + 3) });
    expect(one.json).toMatchObject({ origin: 'dynamic', allowFrom: normalized });
    expect(await echoThrough(listenPort + 3, 'in')).toBe('echo:in');

    // 127.0.0.1 を外すと切断される（拒否した接続として数える）
    expect((await call('modify', { ...allowRule, allowFrom: ['10.0.0.0/8'] })).status).toBe(200);
    expect((await getRule(key)).allow_from).toEqual(['10.0.0.0/8']);
    await expect(echoThrough(listenPort + 3, 'out')).rejects.toThrow();
    expect((await getRule(key)).stats?.denied).toBeGreaterThanOrEqual(1);

    // allowFrom を省いた変更では元の値を保ち、[] ですべて許可に戻す（options は NULL）
    expect((await call('modify', { ...allowRule })).status).toBe(200);
    expect((await getRule(key)).allow_from).toEqual(['10.0.0.0/8']);
    expect((await call('modify', { ...allowRule, allowFrom: [] })).status).toBe(200);
    expect((await getRule(key)).allow_from).toEqual([]);
    expect(await storedAllowFrom()).toBeNull();
    expect(await echoThrough(listenPort + 3, 'again')).toBe('echo:again');

    expect((await call('delete', allowRule)).status).toBe(200);
    expect((await call('list', undefined, 'GET')).json).toEqual([]);
  });

  const rangeRule = {
    protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: rangePort, srcPortEnd: rangePort + 1,
    distAddr: '127.0.0.1', distPort: backendPort + 1, sourceIp: 'proxy', udpIdleSecs: 30,
  };

  it('forwards a two-port range one to one', async () => {
    const add = await call('add', rangeRule);
    expect(add.status).toBe(200);
    expect(await echoThrough(rangePort, 'a')).toBe('echo0:a');
    expect(await echoThrough(rangePort + 1, 'b')).toBe('echo1:b');
    const list = await call('list', undefined, 'GET');
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ srcPort: rangePort, srcPortEnd: rangePort + 1, tls: { mode: 'passthrough' }, state: 'running' });
    const rows = await withDb((conn) => conn.query('SELECT src_port_end, options FROM forward_rules WHERE src_port = ?', [rangePort]));
    expect(rows.map((r: any) => [Number(r.src_port_end), r.options])).toEqual([[rangePort + 1, null]]);
  });

  it('rejects a terminate rule whose certificate cannot be read without leaving rows', async () => {
    const bad = await call('add', {
      ...rule, srcPort: listenPort + 2,
      tls: { mode: 'terminate', certificates: [{ cert_file: '/nonexistent/rproxy-e2e.pem', key_file: '/nonexistent/rproxy-e2e.key' }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('tls_config');
    const rows = await withDb((conn) => conn.query('SELECT COUNT(*) AS n FROM forward_rules WHERE src_port = ?', [listenPort + 2]));
    expect(Number(rows[0].n)).toBe(0);
    expect((await call('list', undefined, 'GET')).json.map((r: any) => r.srcPort)).toEqual([rangePort]);
  });

  // 宛先を複数にしたルール（rproxy v0.3.3）。rproxy が targets を知らなければ（古い master）飛ばす
  it('balances across several targets and fails over to a live one', async (ctx) => {
    const port = listenPort + 5;
    const multi = {
      protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, distAddr: '', distPort: 0, sourceIp: 'proxy', udpIdleSecs: 30,
      targets: [{ addr: '127.0.0.1', port: backendPort + 1 }, { addr: '127.0.0.1', port: backendPort + 2 }],
      balance: 'round_robin',
    };
    const add = await call('add', multi);
    if (add.status === 400 && /unknown field `targets`|targets/.test(String(add.json?.error)) && !/宛先/.test(String(add.json?.error))) {
      ctx.skip();
      return;
    }
    expect(add.status).toBe(200);
    const replies = new Set<string>();
    for (let i = 0; i < 6; i++) replies.add((await echoThrough(port, 'x')).split(':')[0]);
    expect([...replies].sort()).toEqual(['echo0', 'echo1']);

    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
    expect(one.json).toMatchObject({ balance: 'round_robin', targets: multi.targets });

    // 1 件目は誰も待ち受けていないポート。フェイルオーバーで生きている 2 件目に送る
    const failover = { ...multi, balance: 'failover', targets: [{ addr: '127.0.0.1', port: backendPort + 50 }, { addr: '127.0.0.1', port: backendPort + 2 }] };
    expect((await call('modify', failover)).status).toBe(200);
    expect(await echoThrough(port, 'f')).toBe('echo1:f');
    expect(await echoThrough(port, 'g')).toBe('echo1:g');

    expect((await call('delete', multi)).status).toBe(200);
    await expect(echoThrough(port, 'gone')).rejects.toThrow();
  });

  // 1 つのルールで 127.0.0.1 と ::1 を待ち受ける（rproxy v0.3.3 の extra_listen_addrs）。::1 がない環境・古い rproxy では飛ばす
  it('listens on 127.0.0.1 and ::1 with one rule and drops the extra address again', async (ctx) => {
    if (!(await canBind('::1'))) {
      ctx.skip();
      return;
    }
    const port = listenPort + 7;
    const dual = { ...rule, srcPort: port, extraListenAddrs: ['::1'] };
    const add = await call('add', dual);
    if (add.status === 400 && /extra_listen_addrs/.test(String(add.json?.error))) {
      ctx.skip();
      return;
    }
    expect(add.status).toBe(200);
    expect(await echoThrough(port, 'a')).toBe('echo:a');
    expect(await echoThrough(port, 'b', '::1')).toBe('echo:b');
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
    expect(one.json.extraListenAddrs).toEqual(['::1']);

    expect((await call('modify', { ...dual, extraListenAddrs: [] })).status).toBe(200);
    await expect(echoThrough(port, 'c', '::1')).rejects.toThrow();
    expect(await echoThrough(port, 'd')).toBe('echo:d');
    expect((await call('delete', dual)).status).toBe(200);
  });

  // TLS を終端するルールで、一部のサーバ名だけ終端せずに流す（rproxy v0.3.3 の tls.routes[].passthrough）
  it('passes chosen server names through untouched and terminates the others', async (ctx) => {
    const pki = selfSigned(['front.test', 'registry.test', '*.b.tenant.test']);
    if (!pki) {
      ctx.skip();
      return;
    }
    const tlsBackendPort = backendPort + 10;
    const backend = tls.createServer({ cert: fs.readFileSync(pki.cert), key: fs.readFileSync(pki.key) }, (s) => s.on('data', (d) => s.end(`k8s:${d}`)));
    await new Promise<void>((r) => backend.listen(tlsBackendPort, '127.0.0.1', () => r()));
    const port = listenPort + 8;
    const mixed = {
      ...rule, srcPort: port,
      tls: {
        mode: 'terminate',
        certificates: [{ cert_file: pki.cert, key_file: pki.key }],
        routes: [{ server_names: ['registry.test', '**.tenant.test'], remote_addr: '127.0.0.1', remote_port: tlsBackendPort, passthrough: true }],
      },
    };
    try {
      const add = await call('add', mixed);
      if (add.status === 400 && /passthrough|server_names/.test(String(add.json?.error))) {
        ctx.skip();
        return;
      }
      expect(add.status).toBe(200);
      // passthrough：TLS は転送先（k8s 役）が終端する
      expect(await tlsThrough(port, 'registry.test', 'p')).toBe('k8s:p');
      expect(await tlsThrough(port, 'a.b.tenant.test', 'q')).toBe('k8s:q');
      // それ以外は rproxy が終端して、平文のエコーサーバへ
      expect(await tlsThrough(port, 'front.test', 'r')).toBe('echo:r');
      const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
      expect(one.json.tls.routes[0]).toMatchObject({ server_names: ['registry.test', '**.tenant.test'], passthrough: true });
      expect((await call('delete', mixed)).status).toBe(200);
    } finally {
      backend.close();
      fs.rmSync(pki.dir, { recursive: true, force: true });
    }
  });

  // エクスポート → 削除 → インポートで元に戻る。変更したあと、履歴から前の版に巻き戻せる（#60、#61）
  it('restores a rule from its export and reverts a change from the history', async () => {
    const port = listenPort + 9;
    const r = { ...rule, srcPort: port };
    expect((await call('add', r)).status).toBe(200);
    expect(await echoThrough(port, 'a')).toBe('echo:a');

    // エクスポート（自分のルール。範囲ルールも入っている）
    const { default: handler } = await import('@/pages/api/forward/[forward]');
    let exported = '';
    const res = {
      status() { return res; },
      json() { return res; },
      setHeader() { return res; },
      send(body: string) { exported = body; return res; },
    } as unknown as NextApiResponse;
    await handler({ method: 'GET', query: { forward: 'export', format: 'yaml' } } as unknown as NextApiRequest, res);
    expect(exported).toContain(`listen_port: ${port}`);

    expect((await call('delete', r)).status).toBe(200);
    await expect(echoThrough(port, 'b')).rejects.toThrow();

    // 確かめる：消したルールは追加、残っている範囲ルールは「同じキーがある」
    const preview = await call('import', { text: exported, dryRun: true });
    expect(preview.status).toBe(200);
    const statuses = Object.fromEntries(preview.json.items.map((i: { key: string; status: string }) => [i.key, i.status]));
    expect(statuses[`tcp|127.0.0.1|${port}`]).toBe('new');
    expect(statuses[`tcp|127.0.0.1|${rangePort}`]).toBe('exists');

    const imported = await call('import', { text: exported });
    const results = Object.fromEntries(imported.json.results.map((i: { key: string; result: string }) => [i.key, i.result]));
    expect(results[`tcp|127.0.0.1|${port}`]).toBe('added');
    expect(results[`tcp|127.0.0.1|${rangePort}`]).toBe('skipped');
    expect(await echoThrough(port, 'c')).toBe('echo:c');

    // 変更して、履歴から変更の前の版（インポートで追加した版）に戻す
    expect((await call('modify', { ...r, distPort: backendPort + 1 })).status).toBe(200);
    expect(await echoThrough(port, 'd')).toBe('echo0:d');
    const history = await call('history', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
    expect(history.status).toBe(200);
    const [latest, added] = history.json.entries as { id: number; action: string; changes: string[] }[];
    expect(latest.action).toBe('UPDATE');
    expect(latest.changes.join(' ')).toContain(`127.0.0.1:${backendPort} → 127.0.0.1:${backendPort + 1}`);
    expect(added.action).toBe('ADD');
    const reverted = await call('revert', { id: added.id });
    expect(reverted.status).toBe(200);
    expect(reverted.json.result).toBe('modified');
    expect(await echoThrough(port, 'e')).toBe('echo:e');
    const after = await call('history', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
    expect(after.json.entries[0].action).toBe('UPDATE');
    expect(after.json.total).toBe(history.json.total + 1);

    expect((await call('delete', r)).status).toBe(200);
  });

  // 一時停止すると rproxy から外れて待ち受けが閉じ、再開すると同じ内容で戻る（#63）
  it('pauses and resumes a rule', async () => {
    const port = listenPort + 12;
    const r = { ...rule, srcPort: port };
    expect((await call('add', r)).status).toBe(200);
    expect(await echoThrough(port, 'a')).toBe('echo:a');

    expect((await call('pause', r)).status).toBe(200);
    await expect(echoThrough(port, 'b')).rejects.toThrow();
    const paused = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) });
    expect(paused.json).toMatchObject({ state: 'paused', enabled: false });
    const stored = await withDb((c) => c.query('SELECT options FROM forward_rules WHERE src_port = ?', [port]));
    const opts = typeof stored[0].options === 'string' ? JSON.parse(stored[0].options) : stored[0].options;
    expect(opts).toMatchObject({ enabled: false });

    // 停止中の変更は DB だけ（rproxy には作らない）
    expect((await call('modify', { ...r, distPort: backendPort + 1 })).status).toBe(200);
    await expect(echoThrough(port, 'c')).rejects.toThrow();

    expect((await call('resume', r)).status).toBe(200);
    expect(await echoThrough(port, 'd')).toBe('echo0:d');
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '127.0.0.1', port: String(port) })).json.state).toBe('running');

    expect((await call('delete', r)).status).toBe(200);
  });

  it('deletes the range rule', async () => {
    expect((await call('delete', rangeRule)).status).toBe(200);
    expect((await call('list', undefined, 'GET')).json).toEqual([]);
    await expect(echoThrough(rangePort + 1, 'gone')).rejects.toThrow();
  });
});
