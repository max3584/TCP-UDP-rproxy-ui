import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => {
  const conn = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    query: vi.fn(),
  };
  const pool = {
    getConnection: vi.fn(),
    query: vi.fn(),
  };
  return {
    conn,
    pool,
    getServerSession: vi.fn(),
    addRule: vi.fn(),
    modifyRule: vi.fn(),
    deleteRule: vi.fn(),
    listRules: vi.fn(),
    getRule: vi.fn(),
    planAdd: vi.fn(),
    planModify: vi.fn(),
    planDelete: vi.fn(),
  };
});

vi.mock('mariadb', () => ({ default: { createPool: () => mocks.pool } }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  addRule: mocks.addRule,
  modifyRule: mocks.modifyRule,
  deleteRule: mocks.deleteRule,
  listRules: mocks.listRules,
  getRule: mocks.getRule,
  planAdd: mocks.planAdd,
  planModify: mocks.planModify,
  planDelete: mocks.planDelete,
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';

const { conn, pool } = mocks;

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };

const tcpRule = {
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8888,
  distAddr: 'example.com',
  distPort: 80,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
};

function call(action: string, body?: unknown, method = 'POST', query: Record<string, string> = {}) {
  const req = { method, query: { ...query, forward: action }, body } as unknown as NextApiRequest;
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return handler(req, res as NextApiResponse).then(() => ({
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0],
  }));
}

function sqlCalls(): [string, unknown[]][] {
  return conn.query.mock.calls as [string, unknown[]][];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerSession.mockResolvedValue(session);
  pool.getConnection.mockResolvedValue(conn);
  conn.query.mockResolvedValue({ affectedRows: 1 });
  conn.rollback.mockResolvedValue(undefined);
});


const v04 = {
  labels: { tenant: 'act' },
  limits: { per_source: { max_connections: 8 } },
  bandwidth: { download: '10Mbps' },
  geoip: { deny_countries: ['XX'] },
};

const plan = { dry_run: true, action: 'update', change: 'in_place', rule: 'tcp/0.0.0.0:8888', diff: [{ path: 'labels', before: null, after: { tenant: 'act' } }], warnings: [] };

describe('v0.4 のルールの項目（/api/forward）', () => {
  it('add は v0.4 の項目を rproxy に送り、DB の options に書く', async () => {
    mocks.addRule.mockResolvedValue({});
    const { status } = await call('add', { ...tcpRule, ...v04, outlierDetection: { consecutive_failures: 3 } });
    expect(status).toBe(200);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ ...v04, outlier_detection: { consecutive_failures: 3 } }));
    const options = JSON.parse(String(sqlCalls()[0][1][9]));
    expect(options).toMatchObject({ ...v04, outlier_detection: { consecutive_failures: 3 } });
  });

  it('add は形の誤りを 400 invalid で断る（rproxy に送らない）', async () => {
    const { status, body } = await call('add', { ...tcpRule, limits: { per_source: { packets: { average: 1 } } } });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('modify は送られた項目だけ置き換え、null で外し、送られない項目は DB の値を保つ', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, ...v04 }) }]);
    mocks.modifyRule.mockResolvedValue({});
    const { status } = await call('modify', { ...tcpRule, labels: { tenant: 'b' }, limits: null });
    expect(status).toBe(200);
    const patch = mocks.modifyRule.mock.calls[0][1];
    expect(patch.labels).toEqual({ tenant: 'b' });
    expect(patch.limits).toEqual({});
    expect(patch.bandwidth).toEqual(v04.bandwidth);
    expect(patch.geoip).toEqual(v04.geoip);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    const options = JSON.parse(String(update?.[1][3]));
    expect(options.labels).toEqual({ tenant: 'b' });
    expect(options.limits).toBeUndefined();
    expect(options.bandwidth).toEqual(v04.bandwidth);
  });

  it('plan（add）は rproxy の dry_run を聞くだけで DB に書かない', async () => {
    mocks.planAdd.mockResolvedValue({ ...plan, action: 'create', change: 'recreate' });
    const { status, body } = await call('plan', { ...tcpRule, ...v04, action: 'add' });
    expect(status).toBe(200);
    expect(body.results).toEqual([{ node: 'default', plan: { ...plan, action: 'create', change: 'recreate' } }]);
    expect(mocks.planAdd).toHaveBeenCalledWith(expect.objectContaining(v04));
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('plan（modify）は DB の今の内容に本文を重ねた PATCH を dry_run で聞き、rproxy にないときは作るときの差分', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null }]);
    mocks.planModify.mockResolvedValue(plan);
    const { body } = await call('plan', { ...tcpRule, labels: { tenant: 'act' }, action: 'modify' });
    expect(body.results[0].plan).toEqual(plan);
    expect(mocks.planModify.mock.calls[0][1].labels).toEqual({ tenant: 'act' });
    expect(conn.commit).not.toHaveBeenCalled();
    expect(mocks.modifyRule).not.toHaveBeenCalled();

    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null }]);
    mocks.planModify.mockRejectedValueOnce(new RproxyError('rule not found', 'not_found', 404));
    mocks.planAdd.mockResolvedValue({ ...plan, action: 'create' });
    const again = await call('plan', { ...tcpRule, action: 'modify' });
    expect(again.body.results[0].plan.action).toBe('create');
  });

  it('plan は rproxy の断り（dry_run に対応していないなど）をノードごとの誤りにする', async () => {
    mocks.planAdd.mockRejectedValue(new RproxyError('dry_run is not available in this version', 'unsupported', 400));
    const { status, body } = await call('plan', { ...tcpRule, action: 'add' });
    expect(status).toBe(200);
    expect(body.results).toEqual([{ node: 'default', error: 'dry_run is not available in this version', code: 'unsupported' }]);
  });

  it('plan（delete）', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: null }]);
    mocks.planDelete.mockResolvedValue({ ...plan, action: 'delete', change: 'recreate', diff: [] });
    const { body } = await call('plan', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8888, action: 'delete' });
    expect(body.results[0].plan.action).toBe('delete');
    expect(mocks.planDelete).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
  });
});

describe('制御 API の一時停止（429 locked_out）', () => {
  it('rproxy の 429 は UI サーバの問題として 502 rproxy_locked_out と説明を返す', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('too many failed attempts', 'locked_out', 429, 120));
    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('rproxy_locked_out');
    expect(body.error).toContain('一時的に止めています');
    expect(body.error).toContain('120 秒');
  });

  it('ダッシュボードの rproxyError にも説明を出す', async () => {
    pool.query.mockResolvedValue([]);
    mocks.listRules.mockRejectedValue(new RproxyError('locked out', 'locked_out', 429));
    const { body } = await call('dashboard', undefined, 'GET');
    expect(body.reachable).toBe(false);
    expect(body.rproxyError).toContain('認証の失敗が続いた');
  });
});

// rproxy-api v0.4.13：ルールの proxy_protocol（#296）と tls.routes[].source_ip（#297）。変更・保存で落とさないこと
describe('proxy_protocol と route ごとの source_ip（/api/forward）', () => {
  const pp = { from: ['10.2.0.0/16', '172.16.10.19/32'], required: true };
  const sniTls = {
    mode: 'sni',
    routes: [{ server_name: 'k8s.example.com', remote_addr: '10.2.255.131', remote_port: 443, source_ip: 'proxy_v2' }],
  };
  const row = (options: unknown) => [{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify(options) }];

  it('add は proxy_protocol（正規化した from と required）と route の source_ip を rproxy と DB に渡す', async () => {
    mocks.addRule.mockResolvedValue({});
    const { status } = await call('add', { ...tcpRule, tls: sniTls, proxyProtocol: { from: ['10.2.9.9/16', '172.16.10.19'] } });
    expect(status).toBe(200);
    const sent = mocks.addRule.mock.calls[0][0];
    expect(sent.proxy_protocol).toEqual(pp);
    expect(sent.tls.routes[0].source_ip).toBe('proxy_v2');
    const options = JSON.parse(String(sqlCalls()[0][1][9]));
    expect(options.proxy_protocol).toEqual(pp);
    expect(options.tls.routes[0].source_ip).toBe('proxy_v2');
  });

  it('add は rproxy と同じ規則で断る（from が空・/0・udp・終端する route の source_ip・transparent・udp の proxy_v1）', async () => {
    const cases: [unknown, string][] = [
      [{ ...tcpRule, proxyProtocol: { from: [] } }, 'invalid'],
      [{ ...tcpRule, proxyProtocol: { from: ['0.0.0.0/0'] } }, 'invalid'],
      [{ ...tcpRule, proxyProtocol: { from: ['::/0'] } }, 'invalid'],
      [{ ...tcpRule, proxyProtocol: { from: ['10.0.0.1'], extra: 1 } }, 'invalid'],
      [{ ...tcpRule, protocol: 'udp', proxyProtocol: { from: ['10.0.0.1'] } }, 'unsupported'],
      [{ ...tcpRule, tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }], routes: [{ server_name: 'a.example.com', remote_addr: '10.0.0.1', remote_port: 443, source_ip: 'proxy_v2' }] } }, 'unsupported'],
      [{ ...tcpRule, tls: { ...sniTls, routes: [{ ...sniTls.routes[0], source_ip: 'transparent' }] } }, 'unsupported'],
      [{ ...tcpRule, protocol: 'udp', tls: { ...sniTls, routes: [{ ...sniTls.routes[0], source_ip: 'proxy_v1' }] } }, 'unsupported'],
    ];
    for (const [body, code] of cases) {
      const { status, body: res } = await call('add', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(res.code, JSON.stringify(body)).toBe(code);
    }
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('modify は本文にない proxy_protocol を DB の値のまま保ち、tls の route の source_ip を PATCH で送る', async () => {
    conn.query.mockResolvedValueOnce(row({ tls: sniTls, starttls: null, starttls_required: true, proxy_protocol: pp }));
    mocks.modifyRule.mockResolvedValue({});
    const { status } = await call('modify', { ...tcpRule, distAddr: 'example.org', tls: sniTls });
    expect(status).toBe(200);
    const patch = mocks.modifyRule.mock.calls[0][1];
    // 変わらない v0.4 の項目は丸ごと送り直す（rproxy は置き換え）
    expect(patch.proxy_protocol).toEqual(pp);
    expect(patch.tls.routes[0].source_ip).toBe('proxy_v2');
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    const options = JSON.parse(String(update?.[1][3]));
    expect(options.proxy_protocol).toEqual(pp);
    expect(options.tls.routes[0].source_ip).toBe('proxy_v2');
  });

  it('modify の proxyProtocol: null は外す（rproxy へは {}、DB からは消す）', async () => {
    conn.query.mockResolvedValueOnce(row({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, proxy_protocol: pp }));
    mocks.modifyRule.mockResolvedValue({});
    const { status } = await call('modify', { ...tcpRule, proxyProtocol: null });
    expect(status).toBe(200);
    expect(mocks.modifyRule.mock.calls[0][1].proxy_protocol).toEqual({});
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    expect(update?.[1][3]).toBeNull();
  });
});

// rproxy-api v0.4.7 の tls.routes[].upstream（BackendTLSPolicy、features.tls_route_upstream）。
// 以前は normalizeTls が知らない項目として断り、API のルールの表示が生の値に落ち、変更で消えるおそれがあった
describe('route ごとの upstream（/api/forward）', () => {
  const upstream = { tls: true, server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem' };
  const terminateTls = {
    mode: 'terminate',
    certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }],
    routes: [
      { server_name: 'backend.example.com', remote_addr: '10.0.0.5', remote_port: 8443, upstream: upstream },
      { server_name: 'plain.example.com', remote_addr: '10.0.0.6', remote_port: 8080, upstream: {} },
    ],
    upstream: { tls: true },
  };
  const row = (options: unknown) => [{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify(options) }];
  const admin = { user: { ...session.user, id: 'admin-1', roles: ['rproxy-admin'] }, expires: '' };
  // rproxy の応答（Upstream の項目を null / false でも書く）
  const liveTls = {
    ...terminateTls,
    unmatched: 'default', alpn: [], client_auth: { mode: 'none', ca_file: null },
    upstream: { tls: true, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null },
    routes: [
      { ...terminateTls.routes[0], upstream: { ...upstream, insecure_skip_verify: false, cert_file: null, key_file: null } },
      { ...terminateTls.routes[1], upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null } },
    ],
  };
  const live = (over: Record<string, unknown> = {}) => ({
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888, remote_addr: 'example.com', remote_port: 80, source_ip: 'proxy', udp_idle_secs: 30,
    tls: liveTls, state: 'running', error: null, resolved: [], connections: 0, ...over,
  });

  it('add は route の upstream（{} を含む）を rproxy と DB に渡す', async () => {
    mocks.addRule.mockResolvedValue({});
    const { status } = await call('add', { ...tcpRule, tls: terminateTls });
    expect(status).toBe(200);
    expect(mocks.addRule.mock.calls[0][0].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
    const options = JSON.parse(String(sqlCalls()[0][1][9]));
    expect(options.tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
  });

  it('add は rproxy と同じ規則で断る（passthrough・sni・udp の route、cert_file だけ、知らない項目）', async () => {
    const route = terminateTls.routes[0];
    const cases: [unknown, string][] = [
      [{ ...tcpRule, tls: { ...terminateTls, routes: [{ ...route, passthrough: true }] } }, 'tls_config'],
      [{ ...tcpRule, tls: { mode: 'sni', routes: [route] } }, 'tls_config'],
      [{ ...tcpRule, protocol: 'udp', tls: { mode: 'sni', routes: [route] } }, 'tls_config'],
      [{ ...tcpRule, tls: { ...terminateTls, routes: [{ ...route, upstream: { tls: true, cert_file: '/u.pem' } }] } }, 'tls_config'],
      [{ ...tcpRule, tls: { ...terminateTls, routes: [{ ...route, upstream: { tls: true, chain_file: '/u-chain.pem' } }] } }, 'tls_config'],
      [{ ...tcpRule, tls: { ...terminateTls, routes: [{ ...route, upstream: { tls: true, alpn: ['h2'] } }] } }, 'invalid'],
    ];
    for (const [body, c] of cases) {
      const { status, body: res } = await call('add', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(res.code, JSON.stringify(body)).toBe(c);
    }
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('modify は DB に upstream のある行を読み、本文の tls の route の upstream を PATCH と DB に書く', async () => {
    conn.query.mockResolvedValueOnce(row({ tls: terminateTls, starttls: null, starttls_required: true }));
    mocks.modifyRule.mockResolvedValue({});
    const { status } = await call('modify', { ...tcpRule, distAddr: 'example.org', tls: terminateTls });
    expect(status).toBe(200);
    expect(mocks.modifyRule.mock.calls[0][1].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    expect(JSON.parse(String(update?.[1][3])).tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
  });

  it('list と rule は DB の upstream をそのまま返す', async () => {
    const dbRow = { id: 1, auth_id: 'user-1', protocol: 'tcp', src_addr: '0.0.0.0', src_port: 8888, src_port_end: null, dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30, options: JSON.stringify({ tls: terminateTls, starttls: null, starttls_required: true }) };
    pool.query.mockResolvedValue([dbRow]);
    mocks.listRules.mockResolvedValue([live()]);
    mocks.getRule.mockResolvedValue(live({ origin: 'dynamic' }));
    const list = await call('list', undefined, 'GET');
    expect(list.status).toBe(200);
    expect(list.body[0].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8888' });
    expect(one.status).toBe(200);
    expect(one.body.tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
  });

  it('API のルール：画面の形にしても upstream が残り、api-modify の PATCH と plan に付く', async () => {
    mocks.getServerSession.mockResolvedValue(admin);
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(live({ origin: 'api' }));
    const one = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '8888' });
    expect(one.body.origin).toBe('api');
    // 生の値（null・false の項目つき）ではなく、正規化した形
    expect(one.body.tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);

    mocks.modifyRule.mockResolvedValue({ ...live({ origin: 'api' }), persisted: true });
    const modified = await call('api-modify', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8888, distAddr: '10.0.0.20', distPort: 8080, tls: one.body.tls });
    expect(modified.status, JSON.stringify(modified.body)).toBe(200);
    expect(mocks.modifyRule.mock.calls[0][1].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);

    mocks.planModify.mockResolvedValue(plan);
    const planned = await call('plan', { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8888, distAddr: '10.0.0.20', distPort: 8080, tls: one.body.tls, action: 'api-modify' });
    expect(planned.status).toBe(200);
    expect(mocks.planModify.mock.calls[0][1].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
  });

  it('plan（modify）にも付く', async () => {
    conn.query.mockResolvedValueOnce(row({ tls: terminateTls, starttls: null, starttls_required: true }));
    mocks.getRule.mockRejectedValue(new RproxyError('rule not found', 'not_found', 404));
    mocks.planModify.mockResolvedValue(plan);
    const { body } = await call('plan', { ...tcpRule, tls: terminateTls, action: 'modify' });
    expect(body.results[0].plan).toEqual(plan);
    expect(mocks.planModify.mock.calls[0][1].tls.routes.map((r: any) => r.upstream)).toEqual([upstream, {}]);
  });
});
