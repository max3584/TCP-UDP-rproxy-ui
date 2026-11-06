// GET /api/forward/system：利用者に見せる範囲（セキュリティレビュー M3）。rproxy と NextAuth はモック
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getCapabilities: vi.fn(), getConfigStatus: vi.fn(), query: vi.fn() }));
vi.mock('mariadb', () => ({ default: { createPool: () => ({ query: mocks.query }) } }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getCapabilities: mocks.getCapabilities,
  getConfigStatus: mocks.getConfigStatus,
}));

import handler from '@/pages/api/forward/system';
import { RproxyError, currentNode } from '@/components/rproxy';
import { resetNodesCache } from '@/components/nodes';

let dir = '';
const as = (roles: string[]) => mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', name: 'n', email: 'e', image: '', role: '', roles: roles }, expires: '' });

function call() {
  const req = { method: 'GET', query: {}, headers: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-system-'));
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:', '  - {name: a, url: "http://a:8081"}', '  - {name: b, url: "http://b:8081"}', '  - {name: c, url: "http://c:8081"}',
    'groups:', '  - {name: ab, nodes: [a, b]}',
  ].join('\n'));
  process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
  resetNodesCache();
});

afterAll(() => {
  delete process.env.RPROXY_UI_NODES;
  delete process.env.RPROXY_UI_USER_NODES;
  resetNodesCache();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RPROXY_UI_USER_NODES;
  mocks.getCapabilities.mockImplementation(async () => {
    if (currentNode()?.name === 'b') throw new RproxyError('rproxy に接続できません: connect ECONNREFUSED 10.0.0.5:8443', 'unreachable', 0);
    return { version: '0.4.0', source_ip: ['proxy'], build: { version: '0.4.0', sha256: 'deadbeef' }, features: { http: true, http3: true, acme: true, tls_options: true, middlewares: [], limits: true } };
  });
  mocks.query.mockResolvedValue([]);
  mocks.getConfigStatus.mockResolvedValue({ configured: true, path: '/etc/rproxy/secret-path.yaml', rules: 2, error: 'line 3: token: s3cret', restart_needed: [] });
});

describe('/api/forward/system', () => {
  it('管理者には設定ファイルのパス・誤り・ハッシュ・通信の失敗の文を返す', async () => {
    as(['rproxy-admin']);
    const { body } = await call();
    expect(body.admin).toBe(true);
    expect(body.nodes[0]).toMatchObject({ node: 'a', build: { sha256: 'deadbeef' }, config: { path: '/etc/rproxy/secret-path.yaml', error: 'line 3: token: s3cret' } });
    expect(body.nodes[1].error).toContain('10.0.0.5');
  });

  it('利用者には版と機能だけ（パス・誤りの中身・ハッシュ・内部のアドレスは返さない）', async () => {
    as(['rproxy-user']);
    const { body } = await call();
    expect(body.admin).toBeUndefined();
    expect(body.nodes[0]).toMatchObject({ node: 'a', version: '0.4.0', build: { version: '0.4.0' }, config: { path: null, rules: 2 } });
    expect(body.nodes[0].features.limits).toBe(true);
    expect(body.nodes[0].config.error).toContain('管理者だけ');
    expect(body.nodes[1].reachable).toBe(false);
    const text = JSON.stringify(body);
    for (const secret of ['deadbeef', 'secret-path', 's3cret', '10.0.0.5']) expect(text).not.toContain(secret);
  });

  it('RPROXY_UI_USER_NODES の利用者には触れるノードだけ', async () => {
    process.env.RPROXY_UI_USER_NODES = 'a';
    as(['rproxy-user']);
    const { body } = await call();
    expect(body.nodes.map((n: { node: string }) => n.node)).toEqual(['a']);
    expect(mocks.getCapabilities).toHaveBeenCalledTimes(1);
  });

  // UI #184：UI の DB から connect_timeout を戻せないノードに、connect_timeout のある UI のルールが置かれていれば数を出す（管理者だけ）
  it('connect_timeout のルールを置いた、戻せないノードに数を付ける', async () => {
    as(['rproxy-admin']);
    mocks.getCapabilities.mockImplementation(async () => ({
      version: '0.4.20', features: { labels: true, connect_timeout: true, db_connect_timeout: currentNode()?.name === 'c' },
    }));
    const ct = JSON.stringify({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, connect_timeout: '3s' });
    mocks.query.mockResolvedValue([
      { target: 'ab', options: ct },
      { target: 'a', options: ct },
      { target: 'c', options: ct },
      { target: 'b', options: JSON.stringify({ allow_from: ['10.0.0.0/8'], note: 'connect_timeout' }) },
    ]);
    const { body } = await call();
    const byNode = Object.fromEntries(body.nodes.map((n: any) => [n.node, n.connectTimeoutAtRisk]));
    expect(byNode).toEqual({ a: 2, b: 1, c: undefined });
    expect(String(mocks.query.mock.calls[0][0])).toContain('connect\\_timeout');
    // 利用者には数えない
    mocks.query.mockClear();
    as(['rproxy-user']);
    const user = await call();
    expect(user.body.nodes.every((n: any) => n.connectTimeoutAtRisk === undefined)).toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
