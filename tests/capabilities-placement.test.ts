// GET /api/forward/capabilities?target=<グループ>：connect_timeout を UI の DB から戻せるかを置き場所のすべてのノードで確かめる（UI #184）。
// フォームは 1 台（グループなら先頭）の features で欄を出すので、グループのほかのノードが戻せなければ placement で知らせる
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getCapabilities: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getCapabilities: mocks.getCapabilities,
}));

import handler from '@/pages/api/forward/capabilities';
import { RproxyError, currentNode } from '@/components/rproxy';
import { resetNodesCache } from '@/components/nodes';

let dir = '';
let answers: Record<string, 'ok' | 'old' | 'down'> = {};

function call(target: string) {
  const req = { method: 'GET', query: { target: target }, headers: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-caps-'));
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:', '  - {name: a, url: "http://a:8081"}', '  - {name: b, url: "http://b:8081"}', '  - {name: c, url: "http://c:8081"}',
    'groups:', '  - {name: abc, nodes: [a, b, c]}',
  ].join('\n'));
  process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
  resetNodesCache();
});

afterAll(() => {
  delete process.env.RPROXY_UI_NODES;
  resetNodesCache();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', name: 'n', email: 'e', image: '', role: '', roles: ['rproxy-admin'] }, expires: '' });
  answers = {};
  mocks.getCapabilities.mockImplementation(async () => {
    const a = answers[currentNode()?.name ?? ''] ?? 'ok';
    if (a === 'down') throw new RproxyError('rproxy に接続できません', 'unreachable', 0);
    return { version: '0.4.21', features: a === 'ok' ? { connect_timeout: true, db_connect_timeout: true } : { connect_timeout: true } };
  });
});

describe('/api/forward/capabilities placement (UI #184)', () => {
  it('all nodes of the group can restore it: placement.db_connect_timeout is true', async () => {
    const { status, body } = await call('abc');
    expect(status).toBe(200);
    expect(body.placement).toEqual({ nodes: ['a', 'b', 'c'], db_connect_timeout: true, lacking: [], unreachable: [] });
  });

  it('another node without the flag or that cannot be asked makes it false and is named', async () => {
    answers = { b: 'old', c: 'down' };
    const { body } = await call('abc');
    expect(body.features.db_connect_timeout).toBe(true);
    expect(body.placement).toEqual({ nodes: ['a', 'b', 'c'], db_connect_timeout: false, lacking: ['b'], unreachable: ['c'] });
  });

  it('a single node has no placement, and the first node without the flag needs no further question', async () => {
    expect((await call('b')).body.placement).toBeUndefined();
    answers = { a: 'old' };
    mocks.getCapabilities.mockClear();
    const { body } = await call('abc');
    expect(body.placement).toBeUndefined();
    expect(mocks.getCapabilities).toHaveBeenCalledTimes(1);
  });
});
