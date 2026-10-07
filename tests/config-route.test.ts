// GET /api/forward/config：rproxy の設定ファイルの状態（GET /config）をダッシュボード向けに返す
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getConfigStatus: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getConfigStatus: mocks.getConfigStatus,
}));

import handler from '@/pages/api/forward/config';
import { RproxyError } from '@/components/rproxy';

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };

function call(method = 'GET') {
  const req = { method, query: {} } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
});

describe('/api/forward/config', () => {
  it('passes the error and the restart-needed items on (admins)', async () => {
    mocks.getServerSession.mockResolvedValue({ ...session, user: { ...session.user, roles: ['rproxy-admin'] } });
    mocks.getConfigStatus.mockResolvedValue({ configured: true, path: '/etc/rproxy/rproxy.yaml', error: 'line 3: bad', restart_needed: ['global.crowdsec'] });
    expect(await call()).toEqual({ status: 200, body: { show: true, path: '/etc/rproxy/rproxy.yaml', error: 'line 3: bad', restartNeeded: ['global.crowdsec'] } });
  });

  // セキュリティレビュー M3：設定ファイルのパスと誤りの中身（設定の一部を含むことがある）は管理者だけ
  it('users see that there is an error, not the path or the text', async () => {
    mocks.getConfigStatus.mockResolvedValue({ configured: true, path: '/etc/rproxy/rproxy.yaml', error: 'line 3: token: s3cret', restart_needed: ['global.crowdsec'] });
    const { body } = await call();
    expect(body).toMatchObject({ show: true, path: null, restartNeeded: ['global.crowdsec'] });
    expect(body.error).toContain('管理者だけ');
    expect(JSON.stringify(body)).not.toContain('s3cret');
  });

  it('shows nothing when the token may not read it, rproxy is old or unreachable, or there is no settings file', async () => {
    for (const err of [new RproxyError('forbidden', 'forbidden', 403), new RproxyError('no such endpoint', 'not_found', 404), new RproxyError('down', 'unreachable', 0)]) {
      mocks.getConfigStatus.mockRejectedValueOnce(err);
      expect((await call()).body).toEqual({ show: false, path: null, error: null, restartNeeded: [] });
    }
    mocks.getConfigStatus.mockResolvedValue({ configured: false });
    expect((await call()).body.show).toBe(false);
  });

  it('needs a signed-in user and GET', async () => {
    mocks.getServerSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    mocks.getServerSession.mockResolvedValue(session);
    expect((await call('POST')).status).toBe(405);
    expect(mocks.getConfigStatus).not.toHaveBeenCalled();
  });
});
