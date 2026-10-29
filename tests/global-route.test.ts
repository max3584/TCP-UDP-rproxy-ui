// /api/forward/global（rproxy-api v0.4.19 の GET / PATCH /config/global、UI #169）。rproxy と NextAuth はモック
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getCapabilities: vi.fn(), getGlobalSettings: vi.fn(), patchGlobalSettings: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getCapabilities: mocks.getCapabilities,
  getGlobalSettings: mocks.getGlobalSettings,
  patchGlobalSettings: mocks.patchGlobalSettings,
}));

import handler from '@/pages/api/forward/global';
import { RproxyError, currentNode } from '@/components/rproxy';
import { resetNodesCache } from '@/components/nodes';
import { globalFailure } from '@/components/globalapi';

let dir = '';
const as = (roles: string[]) => mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', name: 'n', email: 'e', image: '', role: '', roles: roles }, expires: '' });

function call(method: string, opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  const req = { method: method, query: opts.query ?? {}, body: opts.body, headers: opts.headers ?? { 'sec-fetch-site': 'same-origin' } } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn();
  return Promise.resolve(handler(req, res as NextApiResponse)).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

const settings = (over: Record<string, unknown> = {}) => ({
  items: {
    trusted_proxies: { value: [], source: 'file', apply: 'live', unix_only: false, settable: false },
    udp_max_sessions: { value: 1024, source: 'default', apply: 'live', unix_only: false, settable: true },
    crowdsec: { value: null, source: 'default', apply: 'live', unix_only: true, settable: true },
    performance: { value: null, source: 'default', apply: 'restart', unix_only: false, settable: false },
  },
  storage: 'database', persisted: true, updated_by: null, updated_at: null, warnings: [], ...over,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-global-'));
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:', '  - {name: a, url: "http://a:8081"}', '  - {name: b, url: "unix:/run/rproxy/b.sock"}', '  - {name: c, url: "http://c:8081"}',
    'groups:', '  - {name: g, nodes: [a, b]}',
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
  as(['rproxy-admin']);
  mocks.getCapabilities.mockImplementation(async () => ({ source_ip: [], features: { http: true, http3: true, acme: true, tls_options: true, middlewares: [], global_api: currentNode()?.name !== 'c' } }));
  mocks.getGlobalSettings.mockImplementation(async () => settings());
  mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
    const changes = 'udp_max_sessions' in body ? [{ item: 'udp_max_sessions', before: 1024, after: body.udp_max_sessions, api_before: null, api_after: body.udp_max_sessions }] : [];
    return dryRun ? { dry_run: true, changes: changes, applied: changes.map((c) => c.item) } : { ...settings(), changes: changes, applied: changes.map((c) => c.item) };
  });
});

describe('/api/forward/global', () => {
  it('is for administrators only', async () => {
    as(['rproxy-user']);
    const { status, body } = await call('GET');
    expect(status).toBe(403);
    expect(body.code).toBe('forbidden_admin');
    expect(mocks.getGlobalSettings).not.toHaveBeenCalled();
  });

  it('refuses a cross-site change (CSRF)', async () => {
    const { status, body } = await call('POST', { body: { target: 'a', values: { udp_max_sessions: 1 } }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(status).toBe(403);
    expect(body.code).toBe('csrf');
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
  });

  it('shows every node, its transport, and whether the rproxy has the API', async () => {
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(body.nodes.map((n: { node: string }) => n.node)).toEqual(['a', 'b', 'c']);
    expect(body.nodes[0]).toMatchObject({ transport: 'tcp', supported: true, settings: { storage: 'database' } });
    expect(body.nodes[1].transport).toBe('unix');
    expect(body.nodes[2]).toMatchObject({ supported: false, settings: null });
    expect(body.groups).toEqual([{ name: 'g', nodes: ['a', 'b'] }]);
    // an old rproxy is not asked
    expect(mocks.getGlobalSettings).toHaveBeenCalledTimes(2);
  });

  it('a dry run asks every node of the group and changes nothing', async () => {
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 }, dryRun: true } });
    expect(status).toBe(200);
    expect(body.nodes.map((n: { node: string; ok: boolean }) => [n.node, n.ok])).toEqual([['a', true], ['b', true]]);
    expect(body.nodes[0].changes[0]).toMatchObject({ item: 'udp_max_sessions', after: 4096 });
    expect(mocks.patchGlobalSettings.mock.calls.every((c) => c[1] === true)).toBe(true);
  });

  it('sends http.timeouts in the shape of global', async () => {
    await call('POST', { body: { target: 'a', values: { 'http.timeouts': { idle: '5m' } }, dryRun: true } });
    expect(mocks.patchGlobalSettings).toHaveBeenCalledWith({ http: { timeouts: { idle: '5m' } } }, true);
  });

  it('applies to every node of the group, and puts the others back when one refuses', async () => {
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (currentNode()?.name === 'b' && body.udp_max_sessions === 4096) {
        throw new RproxyError('the settings file (or the environment) sets udp_max_sessions; change it there', 'static', 409);
      }
      const changes = body.udp_max_sessions !== undefined ? [{ item: 'udp_max_sessions', before: 1024, after: body.udp_max_sessions, api_before: 77, api_after: body.udp_max_sessions }] : [];
      return dryRun ? { dry_run: true, changes: changes, applied: [] } : { ...settings(), changes: changes, applied: [] };
    });
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(409);
    expect(body.code).toBe('global_static');
    expect(body.error).toContain('ノード b');
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ ok: true, undone: true });
    // a got its API value before back
    const undo = mocks.patchGlobalSettings.mock.calls.find((c) => c[0].udp_max_sessions === 77);
    expect(undo).toEqual([{ udp_max_sessions: 77 }, false]);
  });

  it('applies and answers with the changes', async () => {
    const { status, body } = await call('POST', { body: { target: 'a', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(200);
    expect(body.nodes).toEqual([expect.objectContaining({ node: 'a', ok: true, persisted: true, storage: 'database' })]);
    expect(mocks.patchGlobalSettings).toHaveBeenCalledWith({ udp_max_sessions: 4096 }, false);
  });

  it('needs a target with several nodes, and refuses unknown targets and bad values', async () => {
    expect((await call('POST', { body: { values: { udp_max_sessions: 1 } } })).body.code).toBe('target_required');
    expect((await call('POST', { body: { target: 'zz', values: { udp_max_sessions: 1 } } })).body.code).toBe('unknown_target');
    const bad = await call('POST', { body: { target: 'a', values: {} } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid');
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
  });

  it('explains a secret item refused over TCP (Unix socket only)', async () => {
    mocks.patchGlobalSettings.mockRejectedValue(new RproxyError('PATCH /config/global of crowdsec is accepted only over the Unix socket (RPROXY_API_SOCKET); set RPROXY_API_RELOAD_UNIX_ONLY=false to allow it over TCP', 'forbidden', 403));
    const { status, body } = await call('POST', { body: { target: 'a', values: { crowdsec: null }, dryRun: true } });
    expect(status).toBe(200);
    expect(body.nodes[0]).toMatchObject({ ok: false, code: 'global_unix_only' });
    const applied = await call('POST', { body: { target: 'a', values: { crowdsec: null } } });
    expect(applied.status).toBe(403);
    expect(applied.body.code).toBe('global_unix_only');
  });
});

describe('globalFailure', () => {
  it('renames the codes that clash with the rules, and keeps unknown ones with rproxy\'s text', () => {
    expect(globalFailure(new RproxyError('x', 'restart_only', 409))).toMatchObject({ status: 409, code: 'global_restart_only' });
    expect(globalFailure(new RproxyError('x', 'in_use', 409))).toMatchObject({ status: 409, code: 'global_in_use' });
    expect(globalFailure(new RproxyError('outside', 'protected_file', 403))).toMatchObject({ status: 403, code: 'protected_file' });
    expect(globalFailure(new RproxyError('not loaded yet', 'not_ready', 503))).toMatchObject({ status: 503, code: 'not_ready', error: 'not loaded yet' });
    expect(globalFailure(new RproxyError('new refusal', 'some_new_code', 422))).toMatchObject({ status: 422, code: 'some_new_code', error: 'new refusal' });
    expect(globalFailure(new RproxyError('lacks admin', 'forbidden', 403))).toMatchObject({ status: 502, code: 'global_forbidden' });
    expect(globalFailure(new RproxyError('nope', 'not_found', 404))).toMatchObject({ status: 409, code: 'global_unsupported' });
    expect(globalFailure(new RproxyError('bad token', 'unauthorized', 401))).toMatchObject({ status: 502, code: 'rproxy_unauthorized' });
    expect(globalFailure(new RproxyError('down', 'unreachable', 0))).toMatchObject({ status: 502, code: 'unreachable' });
  });
});
