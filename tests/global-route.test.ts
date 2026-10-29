// /api/forward/global（rproxy-api v0.4.19 の GET / PATCH /config/global、UI #169）。rproxy と NextAuth はモック。
// rproxy はノードごとの API の値を覚える偽物（GET は今の値、PATCH は値を入れて changes を返す）
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

// ノードごとの API の値（http.timeouts は本文の http.timeouts）
let api: Record<string, Record<string, unknown>> = {};
const node = () => currentNode()?.name ?? 'default';

function view(n: string) {
  const a = api[n] ?? {};
  const live = (name: string, def: unknown, extra: Record<string, unknown> = {}) => ({
    value: name in a ? a[name] : def, source: name in a ? 'api' : 'default', apply: 'live', unix_only: false, settable: true,
    ...(name in a ? { api_value: a[name] } : {}), ...extra,
  });
  return {
    items: {
      trusted_proxies: { value: [], source: 'file', apply: 'live', unix_only: true, settable: false },
      udp_max_sessions: live('udp_max_sessions', 16384),
      'http.timeouts': live('http.timeouts', null),
      crowdsec: live('crowdsec', null, { unix_only: true }),
      acme: { value: { contact: ['mailto:a@example.com'], directory: 'https://ca.example/dir', eab: { kid: 'secret-kid' } }, source: 'file', apply: 'restart', unix_only: true, settable: false },
      performance: { value: 4, source: 'env', apply: 'restart', unix_only: false, settable: false },
    },
    storage: 'database', persisted: true, loaded: true, updated_by: null, updated_at: null, warnings: [],
  };
}

function itemsOf(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'http') out['http.timeouts'] = v === null ? null : (v as { timeouts: unknown }).timeouts;
    else out[k] = v;
  }
  return out;
}

function fakePatch(body: Record<string, unknown>, dryRun: boolean) {
  const n = node();
  const before = { ...(api[n] ?? {}) };
  const after = { ...before };
  for (const [k, v] of Object.entries(itemsOf(body))) {
    if (v === null) delete after[k];
    else after[k] = v;
  }
  const changes = Object.keys(itemsOf(body)).map((k) => ({ item: k, before: before[k] ?? null, after: after[k] ?? null, api_before: before[k] ?? null, api_after: after[k] ?? null }));
  if (dryRun) return { dry_run: true, changes: changes, applied: changes.map((c) => c.item) };
  api[n] = after;
  return { ...view(n), changes: changes, applied: changes.map((c) => c.item) };
}

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
  delete process.env.RPROXY_UI_USER_NODES;
  resetNodesCache();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RPROXY_UI_USER_NODES;
  api = {};
  as(['rproxy-admin']);
  mocks.getCapabilities.mockImplementation(async () => ({ source_ip: [], features: { http: true, http3: true, acme: true, tls_options: true, middlewares: [], global_api: node() !== 'c' } }));
  mocks.getGlobalSettings.mockImplementation(async () => view(node()));
  mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => fakePatch(body, dryRun));
});

const patches = (dryRun = false) => mocks.patchGlobalSettings.mock.calls.filter((c) => c[1] === dryRun).map((c) => c[0]);

describe('/api/forward/global', () => {
  it('is for administrators only, also for a user limited to some nodes', async () => {
    as(['rproxy-user']);
    process.env.RPROXY_UI_USER_NODES = 'a';
    const { status, body } = await call('GET');
    expect(status).toBe(403);
    expect(body.code).toBe('forbidden_admin');
    const post = await call('POST', { body: { target: 'a', values: { udp_max_sessions: 1 } } });
    expect(post.status).toBe(403);
    expect(mocks.getGlobalSettings).not.toHaveBeenCalled();
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
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
    expect(body.nodes[0]).toMatchObject({ transport: 'tcp', supported: true, settings: { storage: 'database', loaded: true } });
    expect(body.nodes[1].transport).toBe('unix');
    expect(body.nodes[2]).toMatchObject({ supported: false, settings: null });
    expect(body.groups).toEqual([{ name: 'g', nodes: ['a', 'b'] }]);
    expect(mocks.getGlobalSettings).toHaveBeenCalledTimes(2);
  });

  it('does not pass on the contents of restart-only items (acme), only their keys', async () => {
    const { body } = await call('GET', { query: { target: 'a' } });
    const acme = body.nodes[0].settings.items.acme;
    expect(acme).toMatchObject({ value: null, redacted: true, keys: ['contact', 'directory', 'eab'] });
    const text = JSON.stringify(body);
    for (const secret of ['mailto:a@example.com', 'ca.example', 'secret-kid']) expect(text).not.toContain(secret);
    // scalars of restart items stay
    expect(body.nodes[0].settings.items.performance.value).toBe(4);
  });

  it('a dry run asks every node of the group and changes nothing', async () => {
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 }, dryRun: true } });
    expect(status).toBe(200);
    expect(body.nodes.map((n: { node: string; ok: boolean }) => [n.node, n.ok])).toEqual([['a', true], ['b', true]]);
    expect(body.nodes[0].changes[0]).toMatchObject({ item: 'udp_max_sessions', after: 4096 });
    expect(patches(false)).toEqual([]);
    expect(api).toEqual({});
  });

  it('sends http.timeouts in the shape of global', async () => {
    await call('POST', { body: { target: 'a', values: { 'http.timeouts': { idle: '5m' } }, dryRun: true } });
    expect(patches(true)).toEqual([{ http: { timeouts: { idle: '5m' } } }]);
  });

  it('applies to every node of the group and answers with the changes', async () => {
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(200);
    expect(body.nodes).toEqual([
      expect.objectContaining({ node: 'a', ok: true, outcome: 'applied', persisted: true, storage: 'database' }),
      expect.objectContaining({ node: 'b', ok: true, outcome: 'applied' }),
    ]);
    expect(api).toEqual({ a: { udp_max_sessions: 4096 }, b: { udp_max_sessions: 4096 } });
  });

  it('puts the other nodes back to their API value before when one refuses, with that node\'s code', async () => {
    api = { a: { udp_max_sessions: 77 } };
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('udp_max_sessions can be changed only over the Unix socket (RPROXY_API_SOCKET)', 'forbidden', 403);
      return fakePatch(body, dryRun);
    });
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(403);
    expect(body.code).toBe('global_unix_only');
    expect(body.error).toContain('ノード b');
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ ok: true, outcome: 'applied', undone: true });
    // the per-node code is mapped too
    expect(body.nodes.find((n: { node: string }) => n.node === 'b')).toMatchObject({ ok: false, outcome: 'refused', code: 'global_unix_only' });
    expect(api.a).toEqual({ udp_max_sessions: 77 });
  });

  it('maps each node\'s refusal (unsupported, unauthorized, static)', async () => {
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'a') throw new RproxyError('not found', 'not_found', 404);
      if (node() === 'b') throw new RproxyError('bad token', 'unauthorized', 401);
      return fakePatch(body, dryRun);
    });
    const { body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 1 }, dryRun: true } });
    expect(body.nodes.map((n: { code?: string }) => n.code)).toEqual(['global_unsupported', 'rproxy_unauthorized']);
  });

  it('reports a failed undo (undone: false)', async () => {
    let failUndo = true;
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('the settings file (or the environment) sets udp_max_sessions', 'static', 409);
      if (node() === 'a' && body.udp_max_sessions === null && failUndo) throw new RproxyError('boom', 'internal', 500);
      return fakePatch(body, dryRun);
    });
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(409);
    expect(body.code).toBe('global_static');
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'applied', undone: false });
    failUndo = false;
  });

  it('does not undo a value another administrator changed in the meantime', async () => {
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') {
        // meanwhile someone else sets a different value on a
        api.a = { udp_max_sessions: 999 };
        throw new RproxyError('x', 'in_use', 409);
      }
      return fakePatch(body, dryRun);
    });
    await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(api.a).toEqual({ udp_max_sessions: 999 });
  });

  it('a timeout is an unknown outcome: reads the node again and treats a changed value as applied', async () => {
    // a applies but its answer never comes; b refuses
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'a' && body.udp_max_sessions === 4096) {
        fakePatch(body, dryRun);
        throw new RproxyError('rproxy に接続できません: The operation was aborted due to timeout', 'unreachable', 0);
      }
      if (node() === 'b') throw new RproxyError('x', 'in_use', 409);
      return fakePatch(body, dryRun);
    });
    const { body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'applied', undone: true });
    // rolled back after the re-read
    expect(api.a).toEqual({});
  });

  it('a timeout with no visible change is unknown and is not rolled back', async () => {
    mocks.patchGlobalSettings.mockImplementation(async () => {
      throw new RproxyError('rproxy に接続できません: timeout', 'unreachable', 0);
    });
    const one = await call('POST', { body: { target: 'a', values: { udp_max_sessions: 4096 } } });
    expect(one.status).toBe(502);
    expect(one.body.code).toBe('global_unknown');
    expect(one.body.nodes[0]).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('a timeout on one node and a success on the other: the other is put back, the unknown one is reported', async () => {
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b' && body.udp_max_sessions === 4096) throw new RproxyError('timeout', 'unreachable', 0);
      return fakePatch(body, dryRun);
    });
    const { status, body } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 4096 } } });
    expect(status).toBe(502);
    expect(body.code).toBe('global_unknown');
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'applied', undone: true });
    expect(body.nodes.find((n: { node: string }) => n.node === 'b')).toMatchObject({ outcome: 'unknown', undone: false });
    expect(api.a).toEqual({});
  });

  it('refuses a read-only (Kubernetes) node with 409 readonly_node', async () => {
    const k8s = mkdtempSync(join(tmpdir(), 'rproxy-ui-k8s-'));
    writeFileSync(join(k8s, 'nodes.yaml'), [
      'nodes:', '  - {name: "k8s:ns/gw/pod-0", url: "https://10.0.0.9:8443", token_file: token, tls_ca: ca.crt, tls_server_name: rproxy.ns.svc}',
      'groups:', '  - {name: "k8s:ns/gw", nodes: ["k8s:ns/gw/pod-0"]}',
    ].join('\n'));
    writeFileSync(join(k8s, 'token'), 'tok\n');
    writeFileSync(join(k8s, 'ca.crt'), '');
    process.env.RPROXY_UI_K8S_DISCOVERY = k8s;
    resetNodesCache();
    try {
      const { status, body } = await call('POST', { body: { target: 'k8s:ns/gw', values: { udp_max_sessions: 1 } } });
      expect(status).toBe(409);
      expect(body.code).toBe('readonly_node');
      expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
    } finally {
      delete process.env.RPROXY_UI_K8S_DISCOVERY;
      resetNodesCache();
      rmSync(k8s, { recursive: true, force: true });
    }
  });

  it('needs a target with several nodes, and refuses unknown targets, overlapping names and bad values', async () => {
    expect((await call('POST', { body: { values: { udp_max_sessions: 1 } } })).body.code).toBe('target_required');
    expect((await call('POST', { body: { target: 'zz', values: { udp_max_sessions: 1 } } })).body.code).toBe('unknown_target');
    const bad = await call('POST', { body: { target: 'a', values: {} } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid');
    const overlap = await call('POST', { body: { target: 'a', values: { http: null, 'http.timeouts': { idle: '1s' } } } });
    expect(overlap.body.code).toBe('invalid');
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
  });

  it('explains a Unix-socket-only item refused over TCP without advising to accept it over TCP', async () => {
    mocks.patchGlobalSettings.mockRejectedValue(new RproxyError('crowdsec can be changed only over the Unix socket (RPROXY_API_SOCKET)', 'forbidden', 403));
    const { status, body } = await call('POST', { body: { target: 'a', values: { crowdsec: null }, dryRun: true } });
    expect(status).toBe(200);
    expect(body.nodes[0]).toMatchObject({ ok: false, code: 'global_unix_only' });
    const applied = await call('POST', { body: { target: 'a', values: { crowdsec: null } } });
    expect(applied.status).toBe(403);
    expect(applied.body.code).toBe('global_unix_only');
    expect(applied.body.error).not.toContain('RELOAD_UNIX_ONLY');
    expect(applied.body.error).toContain('RPROXY_API_SOCKET');
  });

  it('passes on 502 crowdsec_unavailable and 503 not_loaded', async () => {
    mocks.patchGlobalSettings.mockRejectedValueOnce(new RproxyError('the new LAPI did not answer in 10s', 'crowdsec_unavailable', 502));
    const a = await call('POST', { body: { target: 'b', values: { crowdsec: { lapi_url: 'http://127.0.0.1:8080', api_key_file: '/etc/k' } } } });
    expect(a).toMatchObject({ status: 502, body: { code: 'crowdsec_unavailable' } });
    mocks.patchGlobalSettings.mockRejectedValueOnce(new RproxyError('the stored values are not loaded', 'not_loaded', 503));
    const b = await call('POST', { body: { target: 'a', values: { udp_max_sessions: 1 } } });
    expect(b).toMatchObject({ status: 503, body: { code: 'not_loaded' } });
  });
});

describe('/api/forward/global without node configuration', () => {
  beforeAll(() => {
    delete process.env.RPROXY_UI_NODES;
    resetNodesCache();
  });
  afterAll(() => {
    process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
    resetNodesCache();
  });

  it('refuses an unknown target even with a single rproxy', async () => {
    const { status, body } = await call('GET', { query: { target: 'nope' } });
    expect(status).toBe(400);
    expect(body.code).toBe('unknown_target');
    expect((await call('GET', { query: { target: 'default' } })).status).toBe(200);
  });
});

describe('globalFailure', () => {
  it('renames the codes that clash with the rules, and keeps unknown ones with rproxy\'s text', () => {
    expect(globalFailure(new RproxyError('x', 'restart_only', 409))).toMatchObject({ status: 409, code: 'global_restart_only' });
    expect(globalFailure(new RproxyError('x', 'in_use', 409))).toMatchObject({ status: 409, code: 'global_in_use' });
    expect(globalFailure(new RproxyError('outside', 'protected_file', 403))).toMatchObject({ status: 403, code: 'global_protected_file' });
    expect(globalFailure(new RproxyError('not loaded yet', 'not_ready', 503))).toMatchObject({ status: 503, code: 'not_ready', error: 'not loaded yet' });
    expect(globalFailure(new RproxyError('new refusal', 'some_new_code', 422))).toMatchObject({ status: 422, code: 'some_new_code', error: 'new refusal' });
    expect(globalFailure(new RproxyError('lacks admin', 'forbidden', 403))).toMatchObject({ status: 502, code: 'global_forbidden' });
    expect(globalFailure(new RproxyError('nope', 'not_found', 404))).toMatchObject({ status: 409, code: 'global_unsupported' });
    expect(globalFailure(new RproxyError('bad token', 'unauthorized', 401))).toMatchObject({ status: 502, code: 'rproxy_unauthorized' });
    expect(globalFailure(new RproxyError('down', 'unreachable', 0))).toMatchObject({ status: 502, code: 'unreachable' });
  });
});
