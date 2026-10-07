import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), query: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('mariadb', () => ({ default: { createPool: () => ({ query: mocks.query, getConnection: vi.fn() }) } }));

import handler from '@/pages/api/forward/usage';

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
});
