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

// rproxy-api v0.4.22（#345、UI #189）：geoip・acme はその場で変えられる。印（features.global_api_geoip・global_api_acme）を返すノードでだけ
describe('/api/forward/global: geoip and acme', () => {
  const liveView = (n: string) => {
    const v = view(n) as { items: Record<string, unknown> };
    const a = api[n] ?? {};
    v.items.acme = {
      value: a.acme ?? null, source: 'acme' in a ? 'api' : 'default', apply: 'live', unix_only: true, settable: true, ...('acme' in a ? { api_value: a.acme } : {}),
    };
    v.items.geoip = {
      value: a.geoip ?? null, source: 'geoip' in a ? 'api' : 'file', apply: 'live', unix_only: true, settable: true, kept: !('geoip' in a),
      ...('geoip' in a ? { api_value: a.geoip } : {}),
    };
    return v;
  };
  const flags = (on: boolean) => mocks.getCapabilities.mockImplementation(async () => ({
    source_ip: [], features: { global_api: true, global_api_geoip: on, global_api_acme: on },
  }));

  beforeEach(() => {
    mocks.getGlobalSettings.mockImplementation(async () => liveView(node()));
  });

  it('an rproxy without the flags shows geoip and acme as restart-only, with their contents hidden', async () => {
    flags(false);
    api = { a: { acme: { accounts: { le: { contact: ['mailto:a@example.com'], allowed_names: ['example.com'] } } } } };
    const { body } = await call('GET', { query: { target: 'a' } });
    const items = body.nodes[0].settings.items;
    expect(items.acme).toMatchObject({ apply: 'restart', settable: false, redacted: true, value: null });
    expect(items.geoip).toMatchObject({ apply: 'restart', settable: false });
    expect(JSON.stringify(body)).not.toContain('mailto');
  });

  it('with the flags, acme is live and its secret-shaped values are hidden again by the UI', async () => {
    flags(true);
    const acme = {
      accounts: { le: { contact: ['mailto:a@example.com'], allowed_names: ['example.com'], eab: { kid: 'kid-1', hmac_key_file: '/etc/rproxy/acme/eab' } } },
      dns_providers: { relay: { type: 'http', secret_file: '/etc/rproxy/acme/t', add: { url: 'https://u:p@relay.example/tok/123?k=v', headers: { Authorization: 'Bearer {secret}' } }, allowed_names: ['example.com'] } },
    };
    api = { a: { acme: acme } };
    const { body } = await call('GET', { query: { target: 'a' } });
    const item = body.nodes[0].settings.items.acme;
    expect(item).toMatchObject({ apply: 'live', settable: true });
    const text = JSON.stringify(item);
    for (const secret of ['kid-1', '/etc/rproxy/acme/eab', '/etc/rproxy/acme/t', 'u:p', 'tok/123', 'k=v', 'Bearer']) expect(text).not.toContain(secret);
    expect(item.api_value.dns_providers.relay.add.url).toBe('https://***@relay.example/***?***');
    // a kept geoip of the file is shown as such
    expect(body.nodes[0].settings.items.geoip).toMatchObject({ kept: true, source: 'file' });
  });

  it('hides acme in the changes of a dry run and of an apply', async () => {
    flags(true);
    const acme = { accounts: { le: { allowed_names: ['example.com'], eab: { kid: 'kid-2', hmac_key_file: '/etc/rproxy/acme/eab' } } } };
    const plan = await call('POST', { body: { target: 'a', values: { acme: acme }, dryRun: true } });
    expect(plan.status).toBe(200);
    expect(JSON.stringify(plan.body)).not.toContain('kid-2');
    const applied = await call('POST', { body: { target: 'a', values: { acme: acme } } });
    expect(applied.status).toBe(200);
    expect(JSON.stringify(applied.body)).not.toContain('kid-2');
    // rproxy got the value itself
    expect(api.a.acme).toEqual(acme);
  });

  it('rolls back geoip on the other nodes of a group when one refuses (403 protected_file)', async () => {
    flags(true);
    api = { a: { geoip: { country_db: '/var/lib/GeoIP/old.mmdb' } } };
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('geoip.country_db: /x/c.mmdb is not in /var/lib/GeoIP (RPROXY_API_GEOIP_DIR)', 'protected_file', 403);
      return fakePatch(body, dryRun);
    });
    const { status, body } = await call('POST', { body: { target: 'g', values: { geoip: { country_db: '/var/lib/GeoIP/new.mmdb' } } } });
    expect(status).toBe(403);
    expect(body.code).toBe('global_protected_file');
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'applied', undone: true });
    expect(api.a.geoip).toEqual({ country_db: '/var/lib/GeoIP/old.mmdb' });
  });

  it('removing acme that rules use is 409 global_in_use', async () => {
    flags(true);
    api = { a: { acme: { accounts: { le: { allowed_names: ['example.com'] } } } } };
    mocks.patchGlobalSettings.mockRejectedValue(new RproxyError('global.acme: resolver le-http is used by rules', 'in_use', 409));
    const { status, body } = await call('POST', { body: { target: 'a', values: { acme: null } } });
    expect(status).toBe(409);
    expect(body.code).toBe('global_in_use');
  });

  it('does not send a hidden (***) previous acme back when rolling back: that node is reported as not undone', async () => {
    flags(true);
    const masked = { accounts: { le: { allowed_names: ['example.com'], eab: { kid: '***', hmac_key_file: '***' } } } };
    api = { a: { acme: { accounts: { le: { allowed_names: ['example.com'] } } } } };
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('in use', 'in_use', 409);
      const r = fakePatch(body, dryRun) as { changes: { api_before: unknown }[] };
      // rproxy hides the secret-shaped values of acme in the changes
      for (const c of r.changes) c.api_before = masked;
      return r;
    });
    const next = { accounts: { le2: { allowed_names: ['example.com'] } } };
    const { status, body } = await call('POST', { body: { target: 'g', values: { acme: next } } });
    expect(status).toBe(409);
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'applied', undone: false });
    // no PATCH carried ***
    expect(mocks.patchGlobalSettings.mock.calls.every((c) => !JSON.stringify(c[0]).includes('***'))).toBe(true);
    expect(api.a.acme).toEqual(next);
  });

  it('refuses an acme value that still holds hidden (***) values with 400, on the server too', async () => {
    flags(true);
    const { status, body } = await call('POST', { body: { target: 'a', values: { acme: { accounts: { le: { allowed_names: ['example.com'], ca_file: '***' } } } } } });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
  });

  it('when the previous acme cannot be put back, a group is dry-run first and nothing changes if a node refuses', async () => {
    flags(true);
    // rproxy shows the API value of acme hidden: it could not be sent back
    const hidden = { accounts: { le: { allowed_names: ['example.com'], eab: { kid: '***', hmac_key_file: '***' } } } };
    mocks.getGlobalSettings.mockImplementation(async () => {
      const v = liveView(node()) as { items: Record<string, Record<string, unknown>> };
      v.items.acme = { ...v.items.acme, source: 'api', value: hidden, api_value: hidden };
      return v;
    });
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('global.acme.accounts.le2.ca_file: /x is not right in /y (RPROXY_API_ACME_DIR)', 'protected_file', 403);
      return fakePatch(body, dryRun);
    });
    const next = { accounts: { le2: { allowed_names: ['example.com'] } } };
    const { status, body } = await call('POST', { body: { target: 'g', values: { acme: next } } });
    expect(status).toBe(403);
    expect(body.code).toBe('global_protected_file');
    // only dry runs were sent
    expect(patches(false)).toEqual([]);
    expect(patches(true)).toHaveLength(2);
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ ok: false, outcome: 'refused', code: 'global_not_sent' });
    expect(body.nodes.find((n: { node: string }) => n.node === 'b')).toMatchObject({ ok: false, outcome: 'refused', code: 'global_protected_file' });
    expect(api.a).toBeUndefined();

    // every node accepts the dry run: the change is applied
    mocks.patchGlobalSettings.mockImplementation(async (b: Record<string, unknown>, dryRun: boolean) => fakePatch(b, dryRun));
    const ok = await call('POST', { body: { target: 'g', values: { acme: next } } });
    expect(ok.status).toBe(200);
    expect(api.a.acme).toEqual(next);
    expect(api.b.acme).toEqual(next);
  });
});

// crowdsec の URL の利用者・クエリも rproxy は *** で返す（#347）。伏せた値を送り返さない（UI #189 のレビュー）
describe('/api/forward/global: values rproxy returned hidden', () => {
  const hidden = { lapi_url: 'http://***@lapi.example:8080/?***', api_key_file: '/etc/crowdsec/key' };

  it('refuses any item that still holds *** with 400 (crowdsec too)', async () => {
    const { status, body } = await call('POST', { body: { target: 'a', values: { crowdsec: hidden } } });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(mocks.patchGlobalSettings).not.toHaveBeenCalled();
  });

  it('a group whose previous crowdsec was returned hidden is dry-run first, also when a node cannot be read', async () => {
    api = { a: { crowdsec: hidden } };
    let reads = 0;
    mocks.getGlobalSettings.mockImplementation(async () => {
      // b cannot be read the first time: treated as not undoable
      if (node() === 'b' && reads++ === 0) throw new RproxyError('down', 'unreachable', 0);
      return view(node());
    });
    mocks.patchGlobalSettings.mockImplementation(async (body: Record<string, unknown>, dryRun: boolean) => {
      if (node() === 'b') throw new RproxyError('crowdsec: LAPI did not answer', 'crowdsec_unavailable', 502);
      return fakePatch(body, dryRun);
    });
    const next = { lapi_url: 'http://lapi2.example:8080', api_key_file: '/etc/crowdsec/key' };
    const { status, body } = await call('POST', { body: { target: 'g', values: { crowdsec: next } } });
    expect(status).toBe(502);
    expect(body.code).toBe('crowdsec_unavailable');
    expect(patches(false)).toEqual([]);
    expect(body.nodes.find((n: { node: string }) => n.node === 'a')).toMatchObject({ outcome: 'refused', code: 'global_not_sent' });
    expect(api.a.crowdsec).toEqual(hidden);
  });

  it('without hidden previous values, a group is applied directly (no dry run)', async () => {
    const { status } = await call('POST', { body: { target: 'g', values: { udp_max_sessions: 2048 } } });
    expect(status).toBe(200);
    expect(patches(true)).toEqual([]);
  });
});

describe('globalFailure', () => {
  it('renames the codes that clash with the rules, and keeps unknown ones with rproxy\'s text', () => {
    expect(globalFailure(new RproxyError('x', 'restart_only', 409))).toMatchObject({ status: 409, code: 'global_restart_only' });
    expect(globalFailure(new RproxyError('x', 'in_use', 409))).toMatchObject({ status: 409, code: 'global_in_use' });
    expect(globalFailure(new RproxyError('outside', 'protected_file', 403))).toMatchObject({ status: 403, code: 'global_protected_file' });
    expect(globalFailure(new RproxyError('too many listeners', 'limit', 409))).toMatchObject({ status: 409, code: 'global_limit' });
    expect(globalFailure(new RproxyError('not loaded yet', 'not_ready', 503))).toMatchObject({ status: 503, code: 'not_ready', error: 'not loaded yet' });
    expect(globalFailure(new RproxyError('new refusal', 'some_new_code', 422))).toMatchObject({ status: 422, code: 'some_new_code', error: 'new refusal' });
    expect(globalFailure(new RproxyError('lacks admin', 'forbidden', 403))).toMatchObject({ status: 502, code: 'global_forbidden' });
    expect(globalFailure(new RproxyError('nope', 'not_found', 404))).toMatchObject({ status: 409, code: 'global_unsupported' });
    expect(globalFailure(new RproxyError('bad token', 'unauthorized', 401))).toMatchObject({ status: 502, code: 'rproxy_unauthorized' });
    expect(globalFailure(new RproxyError('down', 'unreachable', 0))).toMatchObject({ status: 502, code: 'unreachable' });
  });
});
