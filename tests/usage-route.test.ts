import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), query: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('mariadb', () => ({ default: { createPool: () => ({ query: mocks.query, getConnection: vi.fn() }) } }));

import handler from '@/pages/api/forward/usage';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetNodesCache } from '@/components/nodes';

const as = (roles: string[]) => mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', name: 'n', email: 'e', image: '', role: '', roles: roles }, expires: '' });

function call(query: Record<string, string>) {
  const req = { method: 'GET', query: query, headers: {} } as unknown as NextApiRequest;
  const res: any = { headers: {} as Record<string, string> };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.setHeader = vi.fn((k: string, v: string) => { res.headers[k] = v; });
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0], text: res.send.mock.calls[0]?.[0] as string, headers: res.headers,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { rproxyPool?: unknown }).rproxyPool;
});

describe('/api/forward/usage', () => {
  it('利用者は自分のルールだけ、ルールを指定すればそのルール', async () => {
    as(['rproxy-user']);
    mocks.query.mockResolvedValue([]);
    const { status, body } = await call({ range: '30d', protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    expect(status).toBe(200);
    expect(body.points).toHaveLength(30);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('FROM usage_daily');
    expect(sql).toContain('owner = ?');
    expect(params.slice(1)).toEqual(['tcp', '0.0.0.0', 443, 'u1']);
  });

  // セキュリティレビュー M3：集計の失敗の文（内部のアドレスを含む）は管理者だけ
  it('集計の失敗の文は管理者だけ。利用者には失敗したことだけ', async () => {
    (globalThis as { rproxyUiUsage?: unknown }).rproxyUiUsage = { timer: null, running: false, lastRun: null, error: 'n1: rproxy に接続できません: connect ECONNREFUSED 10.0.0.5:8443', missingTable: false };
    try {
      mocks.query.mockResolvedValue([]);
      as(['rproxy-user']);
      const user = await call({ range: '24h' });
      expect(user.body.status.error).toContain('管理者だけ');
      expect(JSON.stringify(user.body)).not.toContain('10.0.0.5');
      as(['rproxy-admin']);
      const admin = await call({ range: '24h' });
      expect(admin.body.status.error).toContain('10.0.0.5');
    } finally {
      delete (globalThis as { rproxyUiUsage?: unknown }).rproxyUiUsage;
    }
  });

  it('管理者は全体。表がなければ available: false', async () => {
    as(['rproxy-admin']);
    mocks.query.mockRejectedValue(Object.assign(new Error('no table'), { errno: 1146 }));
    const { status, body } = await call({ range: '24h' });
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(mocks.query.mock.calls[0][0]).not.toContain('owner = ?');
  });

  it('集計表と CSV', async () => {
    as(['rproxy-admin']);
    mocks.query.mockResolvedValue([{ node: 'n1', protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, target: null, owner: 'u1', origin: 'dynamic', labels: '{"tenant":"act"}', rx: '10', tx: '5', connections: '1' }]);
    const json = await call({ report: '1', period: '2026-10', group: 'label:tenant' });
    expect(json.body).toMatchObject({ available: true, period: '2026-10', group: 'label:tenant', labelKeys: ['tenant'], lines: [{ key: 'act', rx: 10, tx: 5, connections: 1, rules: 1 }] });
    expect(mocks.query.mock.calls[0][1]).toEqual(['2026-10-01', '2026-11-01']);
    const csv = await call({ report: '1', period: '2026-10', group: 'owner', format: 'csv' });
    expect(csv.headers['Content-Type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[1]).toBe('2026-10,u1,10,5,15,1,1');
    expect((await call({ report: '1', period: 'oct' })).status).toBe(400);
  });

  it('グループのルールは、ノードごとの上書きの待ち受けアドレスで引く（ノードのタブはそのノードだけ）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-nodes-'));
    const file = join(dir, 'nodes.yaml');
    writeFileSync(file, 'nodes:\n  - {name: n1, url: http://127.0.0.1:1}\n  - {name: n2, url: http://127.0.0.1:2}\ngroups:\n  - {name: g, nodes: [n1, n2]}\n');
    vi.stubEnv('RPROXY_UI_NODES', file);
    resetNodesCache();
    try {
      as(['rproxy-admin']);
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT id FROM forward_rules')) return [{ id: 7 }];
        if (sql.includes('forward_rule_overrides')) return [{ rule_id: 7, node: 'n2', src_addr: '192.0.2.2', dist_addr: null, dist_port: null, options: null }];
        return [];
      });
      await call({ range: '24h', protocol: 'tcp', addr: '0.0.0.0', port: '443', target: 'g' });
      const usage = mocks.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('FROM usage_hourly'))!;
      expect(usage[0]).toContain('((node = ? AND listen_addr = ?) OR (node = ? AND listen_addr = ?))');
      expect(usage[1].slice(1)).toEqual(['tcp', 443, 'n1', '0.0.0.0', 'n2', '192.0.2.2']);

      mocks.query.mockClear();
      await call({ range: '24h', protocol: 'tcp', addr: '0.0.0.0', port: '443', target: 'g', node: 'n2' });
      const one = mocks.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('FROM usage_hourly'))!;
      expect(one[1].slice(1)).toEqual(['tcp', 443, 'n2', '192.0.2.2']);
      expect((await call({ range: '24h', protocol: 'tcp', addr: '0.0.0.0', port: '443', target: 'g', node: 'n9' })).status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
      resetNodesCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
