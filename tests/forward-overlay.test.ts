// 固定ルールに重ねる分（rproxy-api v0.4.23 の #397、UI #193）の API route。MariaDB と rproxy はモック
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query: vi.fn() };
  const pool = { getConnection: vi.fn(), query: vi.fn() };
  return {
    conn,
    pool,
    getServerSession: vi.fn(),
    getRule: vi.fn(),
    getCapabilities: vi.fn(),
    getInterfaces: vi.fn(),
    getOverlay: vi.fn(),
    putOverlay: vi.fn(),
    deleteOverlay: vi.fn(),
    listRules: vi.fn(),
    nodes: [] as string[],
  };
});

vi.mock('mariadb', () => ({ default: { createPool: () => mocks.pool } }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/rproxy')>();
  // どのノードに聞いたか（withNode の中なら名前）
  const seen = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    mocks.nodes.push(real.currentNode()?.name ?? '(none)');
    return fn(...a);
  };
  return {
    ...real,
    getRule: seen(mocks.getRule),
    getCapabilities: seen(mocks.getCapabilities),
    getInterfaces: mocks.getInterfaces,
    getOverlay: seen(mocks.getOverlay),
    putOverlay: seen(mocks.putOverlay),
    deleteOverlay: seen(mocks.deleteOverlay),
    listRules: seen(mocks.listRules),
  };
});

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';
import { resetNodesCache } from '@/components/nodes';

const { pool } = mocks;

const admin = { user: { id: 'admin-1', name: 'n', email: 'e', image: '', roles: ['rproxy-admin'] }, expires: '' };
const user = { user: { id: 'user-1', name: 'n', email: 'e', image: '', roles: ['rproxy-user'] }, expires: '' };

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body, headers: { 'sec-fetch-site': 'same-origin' } } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn();
  return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] }));
}

const fileHttp = {
  routes: [{ name: 'site', match: 'Host(`a.example.com`)', service: 'web' }],
  services: {
    web: { servers: [{ url: 'http://10.0.0.5:80' }] },
    secure: { servers: [{ url: 'https://10.0.0.6' }], tls: { cert_file: '/etc/rproxy/c.pem', key_file: '/etc/rproxy/c.key' } },
  },
  middlewares: { auth: { basic_auth: { users_file: '/etc/rproxy/users' } }, hdr: { headers: { request: { set: { 'X-A': '1' } } } } },
};

const staticRule = (over: Record<string, unknown> = {}) => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8443, remote_addr: '', remote_port: 0, source_ip: 'proxy', udp_idle_secs: 30,
  tls: { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/site.pem', key_file: '/etc/rproxy/site.key' }] },
  http: fileHttp, origin: 'static', state: 'running', error: null, resolved: [], connections: 0, ...over,
});

const wiki = {
  http: {
    routes: [{ name: 'wiki', match: 'Host(`wiki.example.com`)', service: 'wiki' }],
    services: { wiki: { servers: [{ url: 'http://10.0.0.7:8080' }] } },
  },
};

const view = (spec: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  rule: 'tcp/0.0.0.0/8443', ...spec, state: 'applied', etag: '"o-1"', created_by: 'ui', created_at: 1790000000, updated_by: 'ui', updated_at: 1790000000, ...over,
});

const key = { protocol: 'tcp', addr: '0.0.0.0', port: '8443' };
const notFound = () => new RproxyError('tcp/0.0.0.0/8443 has no overlay', 'not_found', 404);

// 履歴の OVERLAY の行（作った人を探す overlayCreator が読む）。deleted は外した行（overlay: null）
function overlayRows(rows: { auth_id: string; created_at?: number; deleted?: boolean }[]) {
  const withId = rows.map((r, i) => ({ ...r, id: i + 1 }));
  pool.query.mockImplementation(async (q: string, params: unknown[] = []) => {
    if (q.includes('SELECT MAX(l.id) AS id') && q.includes("update_action = 'OVERLAY'")) {
      const ids = withId.filter((r) => r.deleted).map((r) => r.id);
      return [{ id: ids.length > 0 ? Math.max(...ids) : null }];
    }
    if (q.includes('SELECT l.auth_id, l.options') && q.includes('LIMIT 1')) {
      const createdAt = String(params[params.length - 1]);
      const after = Number(params[params.length - 2]);
      return withId.filter((r) => !r.deleted && r.id > after && String(r.created_at) === createdAt).slice(0, 1)
        .map((r) => ({ auth_id: r.auth_id, options: JSON.stringify({ overlay: {}, created_at: r.created_at }) }));
    }
    return [];
  });
}

function logInserts(): unknown[][] {
  return pool.query.mock.calls.filter((c) => String(c[0]).startsWith('INSERT INTO forward_rules_log')).map((c) => c[1] as unknown[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.nodes.length = 0;
  mocks.getServerSession.mockResolvedValue(admin);
  pool.query.mockResolvedValue([]);
  mocks.getRule.mockResolvedValue(staticRule());
  mocks.getCapabilities.mockResolvedValue({ source_ip: ['proxy'], features: { http: true, static_overlay: true, middlewares: ['headers', 'basic_auth', 'mirror'] } });
  mocks.getInterfaces.mockResolvedValue({ interfaces: [], reserved: [] });
  mocks.getOverlay.mockRejectedValue(notFound());
  mocks.putOverlay.mockImplementation(async (_k: unknown, spec: Record<string, unknown>) => ({ view: view(spec, { etag: '"o-2"' }), etag: '"o-2"' }));
  mocks.deleteOverlay.mockResolvedValue(undefined);
  mocks.listRules.mockResolvedValue([]);
});

describe('GET overlay', () => {
  it('answers whether rproxy can overlay, the overlay with its ETag, the shape and the secret file items', async () => {
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    const { status, body } = await call('overlay', undefined, 'GET', key);
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, etag: '"o-1"', canEdit: true, shape: { http: true, tlsRoutes: false } });
    expect(body.overlay.http.routes[0].name).toBe('wiki');
    expect(body.secretItems).toEqual({ services: ['secure'], middlewares: ['auth'] });
  });

  it('is not available on an rproxy without features.static_overlay (the editor is not shown)', async () => {
    mocks.getCapabilities.mockResolvedValue({ source_ip: ['proxy'], features: { http: true } });
    const { status, body } = await call('overlay', undefined, 'GET', key);
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.overlay).toBeNull();
    expect(mocks.getOverlay).not.toHaveBeenCalled();
  });

  it('refuses rules that are not static (409 not_static) and unknown keys (404)', async () => {
    mocks.getRule.mockResolvedValue(staticRule({ origin: 'api' }));
    expect((await call('overlay', undefined, 'GET', key)).body.code).toBe('not_static');
    mocks.getRule.mockRejectedValue(new RproxyError('no rule', 'not_found', 404));
    expect((await call('overlay', undefined, 'GET', key)).status).toBe(404);
  });

  it('hides file paths from users and says why they cannot edit (RPROXY_UI_USER_PORTS)', async () => {
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_PORTS', '10000-20000');
    mocks.getOverlay.mockResolvedValue({ view: view({ http: { routes: [], middlewares: { ba: { basic_auth: { users_file: '/etc/rproxy/team-users' } } } } }), etag: '"o-1"' });
    const { body } = await call('overlay', undefined, 'GET', key);
    expect(body.overlay.http.middlewares.ba.basic_auth.users_file).toBe('<hidden>');
    expect(body.canEdit).toBe(false);
    expect(body.editCode).toBe('port_not_allowed');
  });
});

describe('PUT overlay (overlay-put)', () => {
  it('lets users change or remove only overlays they created (the UI history), others are read-only', async () => {
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    // 管理者が作った（同じ created_at の最初の行が管理者）
    overlayRows([{ auth_id: 'admin-1', created_at: 1790000000 }, { auth_id: 'user-1', created_at: 1790000000 }]);
    const info = await call('overlay', undefined, 'GET', key);
    expect(info.body).toMatchObject({ canEdit: false, editCode: 'overlay_not_owner' });
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: '"o-1"' })).body.code).toBe('overlay_not_owner');
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).body.code).toBe('overlay_not_owner');
    // 履歴にない（rproxy の API で直接作った）・前の重ねる分の行（created_at が違う）だけでも読むだけ
    overlayRows([{ auth_id: 'user-1', created_at: 1780000000 }]);
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).body.code).toBe('overlay_not_owner');
    overlayRows([]);
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).body.code).toBe('overlay_not_owner');
    // 管理者のものを外して同じ秒に作り直した：外した行より前の行は数えない
    overlayRows([{ auth_id: 'user-1', created_at: 1790000000 }, { auth_id: 'admin-1', deleted: true }, { auth_id: 'admin-1', created_at: 1790000000 }]);
    expect((await call('overlay', undefined, 'GET', key)).body.editCode).toBe('overlay_not_owner');
    overlayRows([{ auth_id: 'admin-1', created_at: 1790000000 }, { auth_id: 'admin-1', deleted: true }]);
    expect((await call('overlay', undefined, 'GET', key)).body.editCode).toBe('overlay_not_owner');
    // 自分で作ったもの（前に外した行があっても、その後の自分の行）
    overlayRows([{ auth_id: 'admin-1', created_at: 1790000000 }, { auth_id: 'admin-1', deleted: true }, { auth_id: 'user-1', created_at: 1790000000 }]);
    expect((await call('overlay', undefined, 'GET', key)).body.canEdit).toBe(true);
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).status).toBe(200);
    expect(mocks.deleteOverlay).toHaveBeenCalledTimes(1);
    // 管理者はだれのものでも
    mocks.getServerSession.mockResolvedValue(admin);
    overlayRows([]);
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).status).toBe(200);
  });

  it('records the rproxy created_at with the overlay (to find who created it)', async () => {
    await call('overlay-put', { ...key, overlay: wiki, etag: null });
    const opts = logInserts()[0].find((v) => typeof v === 'string' && v.startsWith('{"overlay"')) as string;
    expect(JSON.parse(opts)).toEqual({ overlay: wiki, created_at: 1790000000 });
  });

  it('creates it without If-Match and records OVERLAY in the history', async () => {
    const { status, body } = await call('overlay-put', { ...key, overlay: wiki, etag: null });
    expect(status).toBe(200);
    expect(body).toMatchObject({ created: true, etag: '"o-2"' });
    expect(mocks.putOverlay).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8443 }, wiki, null);
    const [log] = logInserts();
    expect(log).toContain('OVERLAY');
    expect(log).toContain('admin-1');
    expect(JSON.parse(String(log.find((v) => typeof v === 'string' && v.startsWith('{"overlay"')))).overlay).toEqual(wiki);
  });

  it('replaces it with the ETag of GET as If-Match', async () => {
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    const next = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], middlewares: ['hdr'] }] } };
    const { status, body } = await call('overlay-put', { ...key, overlay: next, etag: '"o-1"' });
    expect(status).toBe(200);
    expect(body.created).toBe(false);
    expect(mocks.putOverlay.mock.calls[0][2]).toBe('"o-1"');
  });

  it('passes rproxy\'s 412 through when someone created one between the check and the PUT (If-None-Match: *)', async () => {
    mocks.putOverlay.mockRejectedValue(new RproxyError('tcp/0.0.0.0/8443: an overlay exists (If-None-Match)', 'precondition_failed', 412));
    const { status, body } = await call('overlay-put', { ...key, overlay: wiki, etag: null });
    expect(status).toBe(412);
    expect(body.code).toBe('precondition_failed');
    // 作るときは If-Match を付けない（rproxy の putOverlay が If-None-Match: * にする）
    expect(mocks.putOverlay.mock.calls[0][2]).toBeNull();
    expect(logInserts()).toEqual([]);
  });

  it('is 412 when the overlay changed since GET (or was created by someone else)', async () => {
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-9"' });
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: '"o-1"' })).status).toBe(412);
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).body.code).toBe('precondition_failed');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
    // rproxy の 412 もそのまま
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    mocks.putOverlay.mockRejectedValue(new RproxyError('the overlay changed', 'precondition_failed', 412));
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: '"o-1"' })).status).toBe(412);
  });

  it('refuses names of the settings file (409 overlay_conflict) before rproxy', async () => {
    const { status, body } = await call('overlay-put', { ...key, overlay: { http: { routes: [{ name: 'site', match: 'Path(`/`)', service: 'web' }] } }, etag: null });
    expect(status).toBe(409);
    expect(body.code).toBe('overlay_conflict');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
  });

  it('refuses forwarding headers as identity headers (400) and tls.routes on an http rule', async () => {
    const bad = { http: { routes: [{ name: 'w', match: 'Path(`/w`)', service: 'web', middlewares: ['ba'] }], middlewares: { ba: { basic_auth: { users_file: '/etc/rproxy/u', user_header: 'X-Forwarded-For' } } } } };
    const r1 = await call('overlay-put', { ...key, overlay: bad, etag: null });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toContain('X-Forwarded-For');
    const r2 = await call('overlay-put', { ...key, overlay: { tls: { routes: [{ server_name: 'git.example.com', remote_addr: '10.0.0.9', remote_port: 22 }] } }, etag: null });
    expect(r2.status).toBe(400);
  });

  it('takes tls.routes on an sni rule and refuses an upstream on them', async () => {
    mocks.getRule.mockResolvedValue(staticRule({ http: undefined, tls: { mode: 'sni', routes: [{ server_name: '*.example.com', remote_addr: '10.0.0.1', remote_port: 443 }] } }));
    const ok = await call('overlay-put', { ...key, overlay: { tls: { routes: [{ server_name: 'git.example.org', remote_addr: '10.0.0.9', remote_port: 443 }] } }, etag: null });
    expect(ok.status).toBe(200);
    expect(mocks.putOverlay.mock.calls[0][1]).toEqual({ tls: { routes: [{ server_name: 'git.example.org', remote_addr: '10.0.0.9', remote_port: 443 }] } });
    const covered = await call('overlay-put', { ...key, overlay: { tls: { routes: [{ server_name: 'a.example.com', remote_addr: '10.0.0.9', remote_port: 443 }] } }, etag: null });
    expect(covered.body.code).toBe('overlay_conflict');
    const up = await call('overlay-put', { ...key, overlay: { tls: { routes: [{ server_name: 'b.example.org', remote_addr: '10.0.0.9', remote_port: 443, upstream: {} }] } }, etag: null });
    expect(up.status).toBe(400);
  });

  it('lets admins use file items that hold secrets, but not users (409 file_in_use)', async () => {
    const usesAuth = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], middlewares: ['auth'] }] } };
    expect((await call('overlay-put', { ...key, overlay: usesAuth, etag: null })).status).toBe(200);
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    const { status, body } = await call('overlay-put', { ...key, overlay: usesAuth, etag: null });
    expect(status).toBe(409);
    expect(body.code).toBe('file_in_use');
    expect(body.error).toContain('auth');
    // 秘密のないファイルのミドルウェアは、自分のサービスと一緒なら使える
    const plain = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], middlewares: ['hdr'] }] } };
    expect((await call('overlay-put', { ...key, overlay: plain, etag: null })).status).toBe(200);
  });

  it('refuses file services reached through file middlewares, but allows a file forward_auth', async () => {
    mocks.getRule.mockResolvedValue(staticRule({ http: {
      ...fileHttp,
      services: { ...fileHttp.services, authsvc: { servers: [{ url: 'http://10.0.0.20' }] } },
      middlewares: { ...fileHttp.middlewares, shadow: { mirror: { service: 'web' } }, oops: { errors: { status: ['500-599'], service: 'web', query: '/' } }, sso: { forward_auth: { address: 'http://10.0.0.20/verify', service: 'authsvc' } } },
    } }));
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    const withMw = (mws: string[], services?: Record<string, unknown>) => ({ http: { ...wiki.http, ...(services ? { services: { ...wiki.http.services, ...services } } : {}), routes: [{ ...wiki.http.routes[0], middlewares: mws }] } });
    for (const overlay of [withMw(['shadow']), withMw(['oops'])]) {
      const { status, body } = await call('overlay-put', { ...key, overlay, etag: null });
      expect(status, JSON.stringify(body)).toBe(403);
      expect(body.code).toBe('file_service_not_allowed');
    }
    // 自分のサービスの servers[].middlewares がファイルの mirror
    const viaServers = { http: { ...wiki.http, services: { wiki: { servers: [{ url: 'http://10.0.0.7:8080', middlewares: ['shadow'] }] } } } };
    const vs = await call('overlay-put', { ...key, overlay: viaServers, etag: null });
    expect(vs.body.code, JSON.stringify(vs.body)).toBe('file_service_not_allowed');
    // ファイルの forward_auth（管理者の SSO）は付けてよい
    expect((await call('overlay-put', { ...key, overlay: withMw(['sso']), etag: null })).status).toBe(200);
  });

  it('never lets users reference a file service, even one without secrets (403 file_service_not_allowed); admins may', async () => {
    const fileService = { http: { routes: [{ name: 'w', match: 'Host(`w.example.com`)', service: 'web' }] } };
    const viaMirror = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], middlewares: ['m'] }], middlewares: { m: { mirror: { service: 'web' } } } } };
    expect((await call('overlay-put', { ...key, overlay: fileService, etag: null })).status).toBe(200);
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    for (const overlay of [fileService, viaMirror]) {
      const { status, body } = await call('overlay-put', { ...key, overlay, etag: null });
      expect(status).toBe(403);
      expect(body.code).toBe('file_service_not_allowed');
      expect(body.error).toContain('web');
    }
  });

  it('passes rproxy 409 file_in_use through', async () => {
    mocks.putOverlay.mockRejectedValue(new RproxyError('the key file is used by another owner', 'file_in_use', 409));
    const { status, body } = await call('overlay-put', { ...key, overlay: wiki, etag: null });
    expect(status).toBe(409);
    expect(body.code).toBe('file_in_use');
  });

  it('holds users to their ports, file paths and targets', async () => {
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_PORTS', '10000-20000');
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).body.code).toBe('port_not_allowed');
    vi.stubEnv('RPROXY_UI_USER_PORTS', '');
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    // 許可リストの外の転送先（ループバック）
    const loop = { http: { ...wiki.http, services: { wiki: { servers: [{ url: 'http://127.0.0.1:8080' }] } } } };
    expect((await call('overlay-put', { ...key, overlay: loop, etag: null })).body.code).toBe('target_not_allowed');
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).status).toBe(200);
    const withFile = { http: { ...wiki.http, services: { wiki: { servers: [{ url: 'https://10.0.0.7' }], tls: { ca_file: '/etc/ca.pem' } } } } };
    expect((await call('overlay-put', { ...key, overlay: withFile, etag: null })).body.code).toBe('file_not_allowed');
  });

  it('puts back the file paths hidden from a user where they were', async () => {
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    const current = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], middlewares: ['ba'] }], middlewares: { ba: { basic_auth: { users_file: '/etc/rproxy/team-users' } } } } };
    mocks.getOverlay.mockResolvedValue({ view: view(current), etag: '"o-1"' });
    overlayRows([{ auth_id: 'user-1', created_at: 1790000000 }]);
    const sent = { http: { ...current.http, middlewares: { ba: { basic_auth: { users_file: '<hidden>', realm: 'team' } } } } };
    const { status } = await call('overlay-put', { ...key, overlay: sent, etag: '"o-1"' });
    expect(status).toBe(200);
    expect(mocks.putOverlay.mock.calls[0][1].http.middlewares.ba.basic_auth).toEqual({ users_file: '/etc/rproxy/team-users', realm: 'team' });
    // 名前を変えると戻せない
    const renamed = { http: { ...current.http, routes: [{ ...wiki.http.routes[0], middlewares: ['ba2'] }], middlewares: { ba2: { basic_auth: { users_file: '<hidden>' } } } } };
    expect((await call('overlay-put', { ...key, overlay: renamed, etag: '"o-1"' })).body.code).toBe('file_not_allowed');
  });

  it('is 400 unsupported on an rproxy without features.static_overlay, and refuses an empty overlay', async () => {
    mocks.getCapabilities.mockResolvedValue({ source_ip: ['proxy'], features: { http: true } });
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).body.code).toBe('unsupported');
    mocks.getCapabilities.mockResolvedValue({ source_ip: ['proxy'], features: { static_overlay: true } });
    expect((await call('overlay-put', { ...key, overlay: { http: { routes: [] } }, etag: null })).status).toBe(400);
  });

  it('warns when rproxy could not store it (persisted: false)', async () => {
    mocks.putOverlay.mockResolvedValue({ view: view(wiki, { persisted: false }), etag: '"o-2"' });
    const { body } = await call('overlay-put', { ...key, overlay: wiki, etag: null });
    expect(body.warning).toContain('rproxy_rule_overlays');
  });
});

describe('DELETE overlay (overlay-delete)', () => {
  it('removes it with If-Match and records OVERLAY with null', async () => {
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    const { status } = await call('overlay-delete', { ...key, etag: '"o-1"' });
    expect(status).toBe(200);
    expect(mocks.deleteOverlay).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8443 }, '"o-1"');
    expect(logInserts()[0]).toContain('{"overlay":null}');
  });

  it('is 404 without an overlay', async () => {
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).status).toBe(404);
  });
});

describe('history of overlays', () => {
  it('lists OVERLAY rows with the change from the previous one and never reverts them', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.startsWith('SELECT COUNT(*)')) return [{ n: 1 }];
      if (q.includes("update_action = 'OVERLAY'")) return [{ options: JSON.stringify({ overlay: wiki }) }];
      if (q.includes('ORDER BY l.id DESC LIMIT ? OFFSET ?')) {
        return [{ id: 7, auth_id: 'admin-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8443, src_port_end: null, dist_addr: '', dist_port: 0, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify({ overlay: null }), update_action: 'OVERLAY', updated_at: new Date('2026-11-11T00:00:00Z') }];
      }
      if (q.includes('l.id = ?')) return [{ id: 7, update_action: 'OVERLAY', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8443, options: '{"overlay":null}' }];
      return [];
    });
    const { status, body } = await call('history', undefined, 'GET', {});
    expect(status).toBe(200);
    expect(body.entries[0]).toMatchObject({ action: 'OVERLAY', overlay: null, changes: ['重ねる分を外しました'], revertible: false, rule: null });
    const r = await call('revert', { id: 7 });
    expect(r.status).toBe(400);
  });

  it('hides file paths in OVERLAY rows from users (they may see their own rows)', async () => {
    const withFile = { http: { ...wiki.http, middlewares: { ba: { basic_auth: { users_file: '/etc/rproxy/team-users' } } } } };
    pool.query.mockImplementation(async (q: string) => {
      if (q.startsWith('SELECT COUNT(*)')) return [{ n: 1 }];
      if (q.includes('ORDER BY l.id DESC LIMIT ? OFFSET ?')) {
        return [{ id: 8, auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8443, src_port_end: null, dist_addr: '', dist_port: 0, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify({ overlay: withFile, created_at: 1 }), update_action: 'OVERLAY', updated_at: new Date('2026-11-11T00:00:00Z') }];
      }
      return [];
    });
    mocks.getServerSession.mockResolvedValue(user);
    const { status, body } = await call('history', undefined, 'GET', {});
    expect(status).toBe(200);
    expect(body.entries[0].overlay.http.middlewares.ba.basic_auth.users_file).toBe('<hidden>');
    expect(JSON.stringify(body)).not.toContain('team-users');
    mocks.getServerSession.mockResolvedValue(admin);
    expect((await call('history', undefined, 'GET', {})).body.entries[0].overlay.http.middlewares.ba.basic_auth.users_file).toBe('/etc/rproxy/team-users');
  });
});

describe('nodes: overlays are per node (static rules come from each node\'s file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-overlay-nodes-'));
  writeFileSync(join(dir, 'nodes.yaml'), [
    'nodes:',
    '  - {name: a, url: "http://a:8081"}',
    '  - {name: b, url: "http://b:8081"}',
    'groups:',
    '  - {name: ab, nodes: [a, b]}',
    '  - {name: solo, nodes: [a]}',
  ].join('\n'));

  const withNodes = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
    resetNodesCache();
    try {
      return await fn();
    } finally {
      delete process.env.RPROXY_UI_NODES;
      resetNodesCache();
    }
  };
  afterAll(() => resetNodesCache());

  it('asks only the named node and records the node in the history; a group is 400 target_required', async () => {
    await withNodes(async () => {
      pool.getConnection.mockResolvedValue(mocks.conn);
      mocks.conn.query.mockImplementation(async (q: string) => (q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
      const { status } = await call('overlay-put', { ...key, target: 'b', overlay: wiki, etag: null });
      expect(status).toBe(200);
      expect(new Set(mocks.nodes)).toEqual(new Set(['b']));
      const [log] = logInserts();
      expect(log.slice(0, 3)).toEqual(['admin-1', 'b', 'b']);
      const group = await call('overlay', undefined, 'GET', { ...key, target: 'ab' });
      expect(group.status).toBe(400);
      expect(group.body.code).toBe('target_required');
      // ノードが 1 つのグループも断る
      expect((await call('overlay-put', { ...key, target: 'solo', overlay: wiki, etag: null })).body.code).toBe('target_required');
    });
  });

  it('keeps users to RPROXY_UI_USER_NODES', async () => {
    await withNodes(async () => {
      pool.getConnection.mockResolvedValue(mocks.conn);
      mocks.conn.query.mockImplementation(async (q: string) => (q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
      mocks.getServerSession.mockResolvedValue(user);
      vi.stubEnv('RPROXY_UI_USER_NODES', 'a');
      vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
      expect((await call('overlay-put', { ...key, target: 'b', overlay: wiki, etag: null })).body.code).toBe('node_not_allowed');
      expect((await call('overlay', undefined, 'GET', { ...key, target: 'b' })).body.code).toBe('node_not_allowed');
      expect((await call('overlay-put', { ...key, target: 'a', overlay: wiki, etag: null })).status).toBe(200);
    });
  });
});

// UI の DB の正しい形（forward_rule_overlays。migration 015、#197）
describe('desired state of overlays in the UI database (#197)', () => {
  type Row = { node: string; protocol: string; listen_addr: string; listen_port: number; spec: string; created_by: string | null };
  const desired = (spec: Record<string, unknown>, createdBy: string | null = 'admin-1', node = 'default'): Row =>
    ({ node, protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8443, spec: JSON.stringify(spec), created_by: createdBy });

  // forward_rule_overlays の行を持つ DB（missing なら表がない：errno 1146）
  function overlayTable(rows: Row[], opts: { missing?: boolean } = {}) {
    pool.query.mockImplementation(async (q: string, params: unknown[] = []) => {
      if (q.includes('forward_rule_overlays')) {
        if (opts.missing) throw Object.assign(new Error("Table 'rproxy.forward_rule_overlays' doesn't exist"), { errno: 1146 });
        if (q.startsWith('SELECT')) {
          return q.includes('WHERE node = ?') ? rows.filter((r) => r.node === params[0] && r.listen_port === params[3]) : rows;
        }
        if (q.startsWith('INSERT')) {
          const [node, protocol, addr, port, spec, createdBy] = params as [string, string, string, number, string, string | null];
          const i = rows.findIndex((r) => r.node === node && r.listen_port === port);
          if (i >= 0) rows[i] = { ...rows[i], spec };
          else rows.push({ node, protocol, listen_addr: addr, listen_port: port, spec, created_by: createdBy });
        }
        if (q.startsWith('DELETE')) {
          const i = rows.findIndex((r) => r.node === params[0] && r.listen_port === params[3]);
          if (i >= 0) rows.splice(i, 1);
        }
        return { affectedRows: 1 };
      }
      return [];
    });
    return rows;
  }

  it('saves the form rproxy answered with the creator, and keeps the creator when an admin changes it', async () => {
    const rows = overlayTable([]);
    mocks.putOverlay.mockImplementation(async (_k: unknown, spec: Record<string, unknown>) => ({ view: view({ ...spec, http: { ...(spec.http as object), middlewares: {} } }), etag: '"o-2"' }));
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node: 'default', created_by: 'admin-1' });
    expect(JSON.parse(rows[0].spec)).toEqual(wiki);
    // 利用者が作ったものを管理者が直しても、作った人は利用者のまま
    rows[0].created_by = 'user-1';
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    const next = { http: { ...wiki.http, routes: [{ ...wiki.http.routes[0], match: 'Host(`w.example.com`)' }] } };
    expect((await call('overlay-put', { ...key, overlay: next, etag: '"o-1"' })).status).toBe(200);
    expect(rows[0].created_by).toBe('user-1');
    expect(JSON.parse(rows[0].spec).http.routes[0].match).toBe('Host(`w.example.com`)');
  });

  it('refuses to change an overlay without the table (500 overlay_db) before rproxy', async () => {
    overlayTable([], { missing: true });
    const put = await call('overlay-put', { ...key, overlay: wiki, etag: null });
    expect(put.status).toBe(500);
    expect(put.body.code).toBe('overlay_db');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
    // 読むだけ（GET）は止めない（ずれは出さない）
    const info = await call('overlay', undefined, 'GET', key);
    expect(info.status).toBe(200);
    expect(info.body.drift).toBeUndefined();
  });

  it('removing deletes the row first, puts it back when rproxy refuses, and works when rproxy already lost it', async () => {
    const rows = overlayTable([desired(wiki)]);
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    mocks.deleteOverlay.mockRejectedValueOnce(new RproxyError('changed', 'precondition_failed', 412));
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).status).toBe(412);
    expect(rows).toHaveLength(1);
    expect((await call('overlay-delete', { ...key, etag: '"o-1"' })).status).toBe(200);
    expect(rows).toHaveLength(0);
    // rproxy から消えていて UI の DB にだけある：行を消すだけ（rproxy には送らない）
    overlayTable([desired(wiki)]);
    mocks.getOverlay.mockRejectedValue(notFound());
    mocks.deleteOverlay.mockClear();
    expect((await call('overlay-delete', { ...key, etag: null })).status).toBe(200);
    expect(mocks.deleteOverlay).not.toHaveBeenCalled();
    expect(logInserts().at(-1)).toContain('{"overlay":null}');
  });

  it('GET reports an overlay missing or different on rproxy to admins and the creator', async () => {
    overlayTable([desired(wiki, 'user-1')]);
    const missing = await call('overlay', undefined, 'GET', key);
    expect(missing.body).toMatchObject({ overlay: null, drift: 'missing', canResend: true });
    mocks.getOverlay.mockResolvedValue({ view: view({ http: { ...wiki.http, services: { wiki: { servers: [{ url: 'http://10.0.0.9:8080' }] } } } }), etag: '"o-1"' });
    expect((await call('overlay', undefined, 'GET', key)).body.drift).toBe('different');
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    expect((await call('overlay', undefined, 'GET', key)).body.drift).toBeUndefined();
    // 作った利用者には出し、送り直せる（送り直しで rproxy の created_at が変わっても作った人は UI の DB の行）
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    mocks.getOverlay.mockRejectedValue(notFound());
    expect((await call('overlay', undefined, 'GET', key)).body).toMatchObject({ drift: 'missing', canResend: true, canEdit: true });
  });

  it('keeps an overlay lost on rproxy to its creator: other users see no drift and cannot add over it', async () => {
    overlayTable([desired(wiki, 'admin-1')]);
    mocks.getServerSession.mockResolvedValue(user);
    vi.stubEnv('RPROXY_UI_USER_TARGETS', '10.0.0.0/8');
    const info = await call('overlay', undefined, 'GET', key);
    expect(info.body.drift).toBeUndefined();
    expect(info.body).toMatchObject({ canEdit: false, editCode: 'overlay_not_owner' });
    expect((await call('overlay-put', { ...key, overlay: wiki, etag: null })).body.code).toBe('overlay_not_owner');
    expect((await call('overlay-resend', key)).body.code).toBe('overlay_not_owner');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
  });

  it('overlay-resend creates a lost overlay (If-None-Match) and records a resend; nothing to do when it is the same', async () => {
    overlayTable([desired(wiki)]);
    const { status, body } = await call('overlay-resend', key);
    expect(status).toBe(200);
    expect(body).toMatchObject({ rule: 'tcp/0.0.0.0/8443', result: 'added' });
    expect(mocks.putOverlay).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8443 }, wiki, null);
    const log = logInserts().at(-1)!;
    expect(log).toContain('OVERLAY');
    expect(JSON.parse(String(log.find((v) => typeof v === 'string' && v.includes('"resend"'))))).toMatchObject({ overlay: wiki, resend: true });
    // 違えば If-Match で置き換える
    mocks.putOverlay.mockClear();
    mocks.getOverlay.mockResolvedValue({ view: view({ http: { routes: [] } }), etag: '"o-7"' });
    expect((await call('overlay-resend', key)).body.result).toBe('modified');
    expect(mocks.putOverlay).toHaveBeenCalledWith(expect.anything(), wiki, '"o-7"');
    // 同じなら送らない
    mocks.putOverlay.mockClear();
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-8"' });
    expect((await call('overlay-resend', key)).body.result).toBe('unchanged');
    expect(mocks.putOverlay).not.toHaveBeenCalled();
    // UI の DB になければ 404
    overlayTable([]);
    expect((await call('overlay-resend', key)).status).toBe(404);
  });

  it('overlay-resend-all resends drifted overlays for admins only, and the dashboard marks them', async () => {
    overlayTable([desired(wiki)]);
    // GET /rules の固定ルール（重ねる分がない＝消えた）
    mocks.listRules.mockResolvedValue([staticRule()]);
    const dash = await call('dashboard', undefined, 'GET');
    expect(dash.status).toBe(200);
    const row = dash.body.rules.find((r: { origin: string; srcPort: number }) => r.origin === 'static' && r.srcPort === 8443);
    expect(row.overlayDrift).toBe('missing');
    mocks.getServerSession.mockResolvedValue(user);
    expect((await call('overlay-resend-all', {})).body.code).toBe('forbidden_admin');
    // 作っていない利用者のダッシュボードには出さない
    const userDash = await call('dashboard', undefined, 'GET');
    expect(userDash.body.rules.find((r: { origin: string }) => r.origin === 'static')?.overlayDrift).toBeUndefined();
    mocks.getServerSession.mockResolvedValue(admin);
    const out = await call('overlay-resend-all', {});
    expect(out.status).toBe(200);
    expect(out.body.results).toEqual([{ rule: 'tcp/0.0.0.0/8443', result: 'added' }]);
    // 効いていて同じなら何もしない
    mocks.listRules.mockResolvedValue([staticRule({ overlay: { state: 'applied', routes: 2, tls_routes: 0 } })]);
    mocks.getOverlay.mockResolvedValue({ view: view(wiki), etag: '"o-1"' });
    expect((await call('overlay-resend-all', {})).body.results).toEqual([]);
    expect((await call('dashboard', undefined, 'GET')).body.rules.find((r: { origin: string }) => r.origin === 'static').overlayDrift).toBeUndefined();
  });

  it('history shows a resend as a resend, not a change', async () => {
    pool.query.mockImplementation(async (q: string) => {
      if (q.includes('COUNT(*)')) return [{ total: 1 }];
      if (q.includes('FROM forward_rules_log l') && q.includes('ORDER BY l.id DESC LIMIT')) {
        if (q.includes("update_action = 'OVERLAY' ORDER BY l.id DESC LIMIT 1")) return [{ options: JSON.stringify({ overlay: wiki }) }];
        return [{ id: 2, updated_at: new Date(), auth_id: 'system', update_action: 'OVERLAY', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8443, src_port_end: null, options: JSON.stringify({ overlay: wiki, resend: true }) }];
      }
      return [];
    });
    const { body } = await call('history', undefined, 'GET');
    expect(body.entries[0].changes).toEqual(['UI の DB の重ねる分を送り直しました']);
  });
});
