// UI の API route を、本物の MariaDB と rproxy-api につないで動かす。
// RUN_E2E=1 のときだけ実行する（CI の e2e ジョブが DB と rproxy を用意する）。
// 必要な環境変数: DB_* と RPROXY_API_URL / RPROXY_API_TOKEN、E2E_BACKEND_PORT（エコーサーバを立てるポート）
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import net from 'node:net';

const run = process.env.RUN_E2E === '1';

vi.mock('next-auth', () => ({
  getServerSession: async () => ({ user: { id: 'e2e-user', name: 'e2e', email: 'e2e@example.com', image: '', role: '' }, expires: '' }),
}));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));

async function call(action: string, body?: unknown, method = 'POST') {
  const { default: handler } = await import('@/pages/api/forward/[forward]');
  let status = 0;
  let json: any;
  const res = {
    status(s: number) { status = s; return res; },
    json(j: unknown) { json = j; return res; },
  } as unknown as NextApiResponse;
  await handler({ method, query: { forward: action }, body } as unknown as NextApiRequest, res);
  return { status, json };
}

function echoThrough(port: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(msg));
    c.setTimeout(3000, () => reject(new Error('timeout')));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
  });
}

describe.runIf(run)('e2e: UI API route + MariaDB + rproxy', () => {
  const backendPort = Number(process.env.E2E_BACKEND_PORT || 19001);
  const listenPort = 19300;
  let backend: net.Server;

  beforeAll(async () => {
    backend = net.createServer((s) => s.on('data', (d) => s.end(`echo:${d}`)));
    await new Promise<void>((r) => backend.listen(backendPort, '127.0.0.1', r));
  });
  afterAll(() => backend?.close());

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
  });

  it('modifies and deletes the rule', async () => {
    expect((await call('modify', { ...rule, distAddr: 'localhost' })).status).toBe(200);
    expect(await echoThrough(listenPort, 'again')).toBe('echo:again');
    expect((await call('delete', rule)).status).toBe(200);
    expect((await call('list', undefined, 'GET')).json).toEqual([]);
    await expect(echoThrough(listenPort, 'gone')).rejects.toThrow();
  });

  it('records who changed what in forward_rules_log', async () => {
    const mariadb = (await import('mariadb')).default;
    const conn = await mariadb.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_DATABASE,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    });
    try {
      const rows = await conn.query('SELECT auth_id, update_action FROM forward_rules_log WHERE src_port = ? ORDER BY id', [listenPort]);
      expect(rows.map((r: any) => [r.auth_id, r.update_action])).toEqual([
        ['e2e-user', 'ADD'], ['e2e-user', 'UPDATE'], ['e2e-user', 'DELETE'],
      ]);
    } finally {
      await conn.end();
    }
  });
});
