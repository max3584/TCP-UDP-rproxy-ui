// GET /api/forward/system：利用者に見せる範囲（セキュリティレビュー M3）。rproxy と NextAuth はモック
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getCapabilities: vi.fn(), getConfigStatus: vi.fn() }));
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
  writeFileSync(join(dir, 'nodes.yaml'), ['nodes:', '  - {name: a, url: "http://a:8081"}', '  - {name: b, url: "http://b:8081"}'].join('\n'));
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
});
