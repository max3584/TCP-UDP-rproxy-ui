// 1 台に聞く API（/api/forward/acme・capabilities・interfaces・certs）のノードの制限（#164）：
// 利用者は RPROXY_UI_USER_NODES の内だけ（外は 403 node_not_allowed）、見るだけのノード（Kubernetes の rproxy）は利用者には
// ないもの（400 unknown_target）。target を書かなければ既定、既定に触れなければ触れる最初のノード
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(), loadNodes: vi.fn(), asked: [] as string[],
}));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/rproxy')>();
  const answer = (body: unknown) => async () => {
    mocks.asked.push(real.currentNode()?.name ?? '-');
    return body;
  };
  return {
    ...real,
    getAcme: vi.fn(answer({ resolvers: [], accounts: [], dns_providers: [], certificates: [] })),
    getCapabilities: vi.fn(answer({ version: '0.4.13', features: {} })),
    getInterfaces: vi.fn(answer({ interfaces: [], reserved: [] })),
    listCerts: vi.fn(answer([])),
  };
});
vi.mock('@/components/nodes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/nodes')>();
  return { ...real, loadNodes: () => mocks.loadNodes() ?? real.implicitConfig() };
});

import acme from '@/pages/api/forward/acme';
import capabilities from '@/pages/api/forward/capabilities';
import interfaces from '@/pages/api/forward/interfaces';
import certs from '@/pages/api/forward/certs';
import versions from '@/pages/api/forward/versions';
import { parseNodesConfig } from '@/components/nodes';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
const user = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };
const admin = { ...user, user: { ...user.user, roles: ['rproxy-admin'] } };

const call = async (handler: Handler, query: Record<string, string> = {}) => {
  const req = { method: 'GET', query: query, headers: { 'sec-fetch-site': 'same-origin' } } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  await handler(req, res as NextApiResponse);
  return { status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] };
};

// n1・n2 は VM の rproxy、k1 は見るだけ（Kubernetes の rproxy）。既定は n2
function config() {
  const cfg = parseNodesConfig('nodes:\n  - {name: n1, url: "http://127.0.0.1:8081"}\n  - {name: n2, url: "http://127.0.0.1:8082"}\n  - {name: k1, url: "http://127.0.0.1:8083"}\ndefault_target: n2\n', () => 't');
  cfg.nodes = cfg.nodes.map((n) => (n.name === 'k1' ? { ...n, readonly: true } : n));
  return cfg;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.asked.length = 0;
  mocks.getServerSession.mockResolvedValue(user);
  mocks.loadNodes.mockReturnValue(config());
});

describe.each([['acme', acme], ['capabilities', capabilities], ['interfaces', interfaces], ['certs', certs]] as [string, Handler][])('/api/forward/%s', (_name, handler) => {
  it('users may ask only the nodes of RPROXY_UI_USER_NODES', async () => {
    vi.stubEnv('RPROXY_UI_USER_NODES', 'n1');
    expect((await call(handler, { target: 'n1' })).status).toBe(200);
    const other = await call(handler, { target: 'n2' });
    expect([other.status, other.body.code]).toEqual([403, 'node_not_allowed']);
    // 既定（n2）に触れなければ、触れる最初のノード（n1）に聞く
    expect((await call(handler)).status).toBe(200);
    expect(mocks.asked).toEqual(['n1', 'n1']);
  });

  it('read-only (Kubernetes) nodes do not exist for users; admins may ask them', async () => {
    const k = await call(handler, { target: 'k1' });
    expect([k.status, k.body.code]).toEqual([400, 'unknown_target']);
    expect(mocks.asked).toEqual([]);
    mocks.getServerSession.mockResolvedValue(admin);
    vi.stubEnv('RPROXY_UI_USER_NODES', 'n1');
    expect((await call(handler, { target: 'k1' })).status).toBe(200);
    expect((await call(handler, { target: 'n2' })).status).toBe(200);
    expect(mocks.asked).toEqual(['k1', 'n2']);
  });

  it('users without a node they may touch get 403 and nothing is asked', async () => {
    vi.stubEnv('RPROXY_UI_USER_NODES', 'n9');
    const res = await call(handler);
    expect([res.status, res.body.code]).toEqual([403, 'node_not_allowed']);
    expect(mocks.asked).toEqual([]);
  });

  it('without RPROXY_UI_NODES nothing changes (the one rproxy)', async () => {
    mocks.loadNodes.mockReturnValue(undefined);
    vi.stubEnv('RPROXY_UI_USER_NODES', 'n1');
    expect((await call(handler)).status).toBe(200);
    expect(mocks.asked).toEqual(['-']);
  });
});

describe('/api/forward/versions', () => {
  it('users of RPROXY_UI_USER_NODES get (and ask) only their nodes; admins get all but read-only ones are admin-only', async () => {
    vi.stubEnv('RPROXY_UI_USER_NODES', 'n1');
    const res = await call(versions);
    expect(res.status).toBe(200);
    expect(res.body.nodes.map((n: { name: string }) => n.name)).toEqual(['n1']);
    expect(mocks.asked).toEqual(['n1']);
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await call(versions)).body.nodes.map((n: { name: string }) => n.name)).toEqual(['n1', 'n2', 'k1']);
  });
});
