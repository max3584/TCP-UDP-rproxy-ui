// 登録済みの証明書の一覧（/api/forward/certs、#155）：名前・名前の一覧・期限だけ、利用者には RPROXY_UI_USER_CERTS の名前だけ、
// rproxy が読ませない（403・404）なら available: false
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), listCerts: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  listCerts: mocks.listCerts,
}));

import handler from '@/pages/api/forward/certs';
import { RproxyError } from '@/components/rproxy';

const user = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };
const admin = { ...user, user: { ...user.user, roles: ['rproxy-admin'] } };
const RAW = [
  { name: 'tenant-a', sans: ['a.example.com'], not_before: 'x', not_after: '2027-01-01T00:00:00Z', fingerprint_sha256: 'ab', issuer: 'CN=ca', used_by: ['tcp/0.0.0.0:443'], updated_by: 'ui' },
  { name: 'dashboard', sans: ['dash.example.com'], not_after: '2027-01-01T00:00:00Z', used_by: [] },
];

const call = (method = 'GET') => {
  const req = { method, query: {}, headers: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getServerSession.mockResolvedValue(user);
});

describe('/api/forward/certs', () => {
  it('returns the names, SANs and expiry only (not who uses them or the fingerprint)', async () => {
    mocks.listCerts.mockResolvedValue(RAW);
    const res = await call();
    expect(res).toEqual({ status: 200, body: { available: true, certs: [
      { name: 'tenant-a', sans: ['a.example.com'], not_after: '2027-01-01T00:00:00Z' },
      { name: 'dashboard', sans: ['dash.example.com'], not_after: '2027-01-01T00:00:00Z' },
    ] } });
  });

  it('users see only the names in RPROXY_UI_USER_CERTS; admins see all', async () => {
    vi.stubEnv('RPROXY_UI_USER_CERTS', 'tenant-');
    mocks.listCerts.mockResolvedValue(RAW);
    expect((await call()).body.certs.map((c: { name: string }) => c.name)).toEqual(['tenant-a']);
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await call()).body.certs.map((c: { name: string }) => c.name)).toEqual(['tenant-a', 'dashboard']);
  });

  it('is available: false when rproxy refuses (no certs:read) or is old, 502 when unreachable, and needs a role and GET', async () => {
    mocks.listCerts.mockRejectedValue(new RproxyError('forbidden', 'forbidden', 403));
    expect(await call()).toEqual({ status: 200, body: { available: false, certs: [] } });
    mocks.listCerts.mockRejectedValue(new RproxyError('not found', 'not_found', 404));
    expect((await call()).body.available).toBe(false);
    mocks.listCerts.mockRejectedValue(new RproxyError('down', 'unreachable', 0));
    expect((await call()).status).toBe(502);
    expect((await call('POST')).status).toBe(405);
    mocks.getServerSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
});
