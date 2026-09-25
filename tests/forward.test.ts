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
}));

import handler from '@/pages/api/forward/[forward]';
import { RproxyError } from '@/components/rproxy';

const { conn, pool } = mocks;

const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: '' }, expires: '' };

const tcpRule = {
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8888,
  distAddr: 'example.com',
  distPort: 80,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
};

function call(action: string, body?: unknown, method = 'POST') {
  const req = { method, query: { forward: action }, body } as unknown as NextApiRequest;
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

describe('/api/forward/[forward]', () => {
  it('returns 401 without a session', async () => {
    mocks.getServerSession.mockResolvedValue(null);

    const { status } = await call('add', tcpRule);
    expect(status).toBe(401);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('add commits when rproxy succeeds', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', tcpRule);
    expect(status).toBe(200);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(sqlCalls()[0][0]).toMatch(/^INSERT INTO forward_rules /);
    // 単一ポート・既定の TLS なので src_port_end と options は NULL
    expect(sqlCalls()[0][1]).toEqual(['user-1', 'tcp', '0.0.0.0', 8888, null, 'example.com', 80, 'proxy', 30, null]);
    expect(sqlCalls()[1][0]).toMatch(/^INSERT INTO forward_rules_log /);
    expect(sqlCalls()[1][1][0]).toBe('user-1');
    expect(mocks.addRule).toHaveBeenCalledWith({
      protocol: 'tcp',
      listen_addr: '0.0.0.0',
      listen_port: 8888,
      remote_addr: 'example.com',
      remote_port: 80,
      source_ip: 'proxy',
      udp_idle_secs: 30,
      tls: { mode: 'passthrough' },
    });
  });

  it('add rolls back and returns the rproxy error code', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('address already in use (os error 98)', 'bind_failed', 409));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'address already in use (os error 98)', code: 'bind_failed' });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('add returns 502 when rproxy is unreachable', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('rproxy に接続できません', 'unreachable', 0));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('unreachable');
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('add returns 409 on a duplicate key without calling rproxy', async () => {
    conn.query.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' }));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(409);
    expect(body.code).toBe('already_exists');
    expect(mocks.addRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('normalizes the protocol to lowercase', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', { ...tcpRule, protocol: 'UDP' });
    expect(status).toBe(200);
    expect(sqlCalls()[0][1][1]).toBe('udp');
    expect(sqlCalls()[1][1][1]).toBe('udp');
    expect(mocks.addRule.mock.calls[0][0].protocol).toBe('udp');
  });

  it.each([
    ['srcPort 0', { srcPort: 0 }],
    ['srcPort 65536', { srcPort: 65536 }],
    ['distPort 0', { distPort: 0 }],
    ['port as string', { srcPort: '8888' }],
    ['non-integer port', { distPort: 80.5 }],
    ['unknown protocol', { protocol: 'sctp' }],
    ['hostname as listen address', { srcAddr: 'example.com' }],
    ['proxy_v2 with udp', { protocol: 'udp', sourceIp: 'proxy_v2' }],
    ['udp_idle_secs out of range', { protocol: 'udp', udpIdleSecs: 86401 }],
  ])('rejects invalid input: %s', async (_name, override) => {
    const { status, body } = await call('add', { ...tcpRule, ...override });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('accepts ports 1 and 65535', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', { ...tcpRule, srcPort: 1, distPort: 65535 });
    expect(status).toBe(200);
  });

  it('modify sends PATCH with udp_idle_secs and keeps source_ip from the DB', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old.example.com', dist_port: 53, source_ip: 'transparent', udp_idle_secs: 30 }]);
    mocks.modifyRule.mockResolvedValue({});

    const { status } = await call('modify', { ...tcpRule, protocol: 'udp', udpIdleSecs: 120, sourceIp: 'proxy' });
    expect(status).toBe(200);
    expect(mocks.modifyRule).toHaveBeenCalledWith(
      { protocol: 'udp', listen_addr: '0.0.0.0', listen_port: 8888 },
      { remote_addr: 'example.com', remote_port: 80, udp_idle_secs: 120, tls: { mode: 'passthrough' } },
    );
    const log = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules_log'));
    expect(log?.[1]).toEqual(['user-1', 'udp', '0.0.0.0', 8888, null, 'example.com', 80, 'transparent', 120, null, 'UPDATE']);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('modify returns 404 when the rule is not owned by the user', async () => {
    conn.query.mockResolvedValueOnce([]);

    const { status } = await call('modify', tcpRule);
    expect(status).toBe(404);
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('delete treats rproxy not_found as success', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockRejectedValue(new RproxyError('rule not found', 'not_found', 404));

    const { status } = await call('delete', { protocol: 'TCP', srcAddr: '0.0.0.0', srcPort: 8888 });
    expect(status).toBe(200);
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
  });

  it('delete rolls back on other rproxy errors', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockRejectedValue(new RproxyError('boom', 'internal', 500));

    const { status, body } = await call('delete', tcpRule);
    expect(status).toBe(502);
    expect(body.code).toBe('internal');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('add undoes the rproxy change when COMMIT fails', async () => {
    mocks.addRule.mockResolvedValue({});
    mocks.deleteRule.mockResolvedValue(undefined);
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status, body } = await call('add', tcpRule);
    expect(status).toBe(500);
    expect(body.code).toBe('internal');
    expect(mocks.deleteRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 });
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('modify re-creates a rule that rproxy does not have', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old.example.com', dist_port: 81, source_ip: 'proxy_v2', udp_idle_secs: 30 }]);
    mocks.modifyRule.mockRejectedValue(new RproxyError('rule not found', 'not_found', 404));
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('modify', tcpRule);
    expect(status).toBe(200);
    expect(mocks.addRule).toHaveBeenCalledWith({
      protocol: 'tcp',
      listen_addr: '0.0.0.0',
      listen_port: 8888,
      remote_addr: 'example.com',
      remote_port: 80,
      source_ip: 'proxy_v2',
      udp_idle_secs: 30,
      tls: { mode: 'passthrough' },
    });
    expect(conn.commit).toHaveBeenCalled();
  });

  it('modify restores the previous target when COMMIT fails', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'old.example.com', dist_port: 81, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.modifyRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status } = await call('modify', tcpRule);
    expect(status).toBe(500);
    expect(mocks.modifyRule).toHaveBeenCalledTimes(2);
    expect(mocks.modifyRule.mock.calls[1]).toEqual([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888 },
      { remote_addr: 'old.example.com', remote_port: 81, tls: { mode: 'passthrough' } },
    ]);
  });

  it('delete re-adds the rule to rproxy when COMMIT fails', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockResolvedValue(undefined);
    mocks.addRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status } = await call('delete', tcpRule);
    expect(status).toBe(500);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ listen_port: 8888, remote_addr: 'example.com' }));
  });

  it('reports but survives a failed undo', async () => {
    mocks.addRule.mockResolvedValue({});
    mocks.deleteRule.mockRejectedValue(new RproxyError('down', 'unreachable', 0));
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status } = await call('add', tcpRule);
    expect(status).toBe(500);
    expect(conn.release).toHaveBeenCalled();
  });

  it('list merges live state from rproxy', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 80, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30 },
      { id: 2, protocol: 'udp', src_addr: '::', src_port: 53, dist_addr: 'b', dist_port: 53, source_ip: 'proxy', udp_idle_secs: 60 },
      { id: 3, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 81, dist_addr: 'c', dist_port: 8081, source_ip: 'proxy', udp_idle_secs: 30 },
    ]);
    mocks.listRules.mockResolvedValue([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, remote_addr: 'a', remote_port: 8080, state: 'running', error: null, resolved: [], connections: 3 },
      { protocol: 'udp', listen_addr: '::', listen_port: 53, remote_addr: 'b', remote_port: 53, state: 'failed', error: 'bind failed', resolved: [], connections: 0 },
    ]);

    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body.map((r: any) => [r.id, r.state, r.error, r.connections])).toEqual([
      [1, 'running', null, 3],
      [2, 'failed', 'bind failed', 0],
      [3, 'missing', null, null],
    ]);
  });

  it('list returns DB rules with state unknown when rproxy is down', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'TCP', src_addr: '0.0.0.0', src_port: 80, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30 },
    ]);
    mocks.listRules.mockRejectedValue(new RproxyError('down', 'unreachable', 0));

    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].protocol).toBe('tcp');
    expect(body[0].state).toBe('unknown');
  });
});

describe('/api/forward/[forward]: port ranges and TLS', () => {
  const cert = { cert_file: '/etc/rproxy/certs/mail.pem', key_file: '/etc/rproxy/certs/mail.key' };
  const submission = {
    ...tcpRule,
    srcPort: 587,
    distAddr: '10.0.0.20',
    distPort: 587,
    sourceIp: 'proxy_v2',
    tls: { mode: 'terminate', certificates: [cert] },
    starttls: 'smtp',
    starttlsRequired: true,
  };
  // DB の行（lockOwnRule が読む列）
  const row = (over: Record<string, unknown> = {}) => ({
    src_port_end: null, dist_addr: 'old.example.com', dist_port: 81, source_ip: 'proxy', udp_idle_secs: 30, options: null, ...over,
  });

  it.each([
    ['range end below start', { srcPortEnd: 8000 }, 'invalid'],
    ['range end as string', { srcPortEnd: '9000' }, 'invalid'],
    ['range pushes remote_port past 65535', { srcPortEnd: 8890, distPort: 65534 }, 'invalid'],
    ['unknown tls mode', { tls: { mode: 'mitm' } }, 'invalid'],
    ['unknown key in tls', { tls: { mode: 'passthrough', extra: 1 } }, 'invalid'],
    ['unknown starttls', { tls: { mode: 'terminate', certificates: [cert] }, starttls: 'ftp' }, 'invalid'],
    ['certificate without key', { tls: { mode: 'terminate', certificates: [{ cert_file: '/a.pem', key_file: '' }] } }, 'invalid'],
    ['sni with udp', { protocol: 'udp', tls: { mode: 'sni' } }, 'unsupported'],
    ['terminate without certificates', { tls: { mode: 'terminate' } }, 'tls_config'],
    ['certificates with passthrough', { tls: { mode: 'passthrough', certificates: [cert] } }, 'tls_config'],
    ['routes with passthrough', { tls: { mode: 'passthrough', routes: [{ server_name: 'a.example.com', remote_addr: '10.0.0.1', remote_port: 443 }] } }, 'tls_config'],
    ['alpn with sni', { tls: { mode: 'sni', alpn: ['h2'] } }, 'tls_config'],
    ['client_auth without ca_file', { tls: { mode: 'terminate', certificates: [cert], client_auth: { mode: 'required' } } }, 'tls_config'],
    ['upstream cert without key', { tls: { mode: 'terminate', certificates: [cert], upstream: { tls: true, cert_file: '/c.pem' } } }, 'tls_config'],
    ['invalid server_name', { tls: { mode: 'sni', routes: [{ server_name: 'a..b', remote_addr: '10.0.0.1', remote_port: 443 }] } }, 'tls_config'],
    ['starttls without terminate', { starttls: 'smtp' }, 'tls_config'],
    ['starttls with udp', { protocol: 'udp', tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp' }, 'tls_config'],
    ['alpn with udp (DTLS)', { protocol: 'udp', tls: { mode: 'terminate', certificates: [cert], alpn: ['coap'] } }, 'tls_config'],
  ])('rejects invalid range / TLS input: %s', async (_name, override, code) => {
    const { status, body } = await call('add', { ...tcpRule, ...override });
    expect(status).toBe(400);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(mocks.addRule).not.toHaveBeenCalled();
  });

  it('add stores the range and options JSON and passes them to rproxy', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', {
      ...submission,
      srcPortEnd: 588,
      tls: {
        mode: 'terminate',
        certificates: [cert],
        routes: [{ server_name: 'Mail.Example.com', remote_addr: '10.0.0.21', remote_port: 587 }],
        client_auth: { mode: 'none', ca_file: '' },
        alpn: [],
        upstream: { tls: false, server_name: '', insecure_skip_verify: false },
      },
      starttlsRequired: false,
    });
    expect(status).toBe(200);
    // 既定値の項目は省いた形で保存する（rproxy は未知のキーを拒否するので、キーは tls / starttls / starttls_required だけ）
    const tls = { mode: 'terminate', routes: [{ server_name: 'mail.example.com', remote_addr: '10.0.0.21', remote_port: 587 }], certificates: [cert] };
    const [sql, params] = sqlCalls()[0];
    expect(sql).toMatch(/src_port_end.*options/);
    expect(params[4]).toBe(588);
    expect(JSON.parse(params[9] as string)).toEqual({ tls: tls, starttls: 'smtp', starttls_required: false });
    const log = sqlCalls()[1][1];
    expect(log[4]).toBe(588);
    expect(JSON.parse(log[9] as string)).toEqual({ tls: tls, starttls: 'smtp', starttls_required: false });
    expect(mocks.addRule).toHaveBeenCalledWith({
      protocol: 'tcp',
      listen_addr: '0.0.0.0',
      listen_port: 587,
      listen_port_end: 588,
      remote_addr: '10.0.0.20',
      remote_port: 587,
      source_ip: 'proxy_v2',
      udp_idle_secs: 30,
      tls: tls,
      starttls: 'smtp',
      starttls_required: false,
    });
  });

  it('forces starttls_required for imap and pop3', async () => {
    mocks.addRule.mockResolvedValue({});

    await call('add', { ...submission, srcPort: 143, distPort: 143, starttls: 'imap', starttlsRequired: false });
    expect(mocks.addRule.mock.calls[0][0].starttls_required).toBe(true);
    expect(JSON.parse(sqlCalls()[0][1][9] as string).starttls_required).toBe(true);
  });

  it('treats a range that ends at its start as a single port', async () => {
    mocks.addRule.mockResolvedValue({});

    await call('add', { ...tcpRule, srcPortEnd: tcpRule.srcPort });
    expect(sqlCalls()[0][1][4]).toBeNull();
    expect(mocks.addRule.mock.calls[0][0]).not.toHaveProperty('listen_port_end');
  });

  it('passes the rproxy tls_config error through as 400', async () => {
    mocks.addRule.mockRejectedValue(new RproxyError('/etc/rproxy/certs/mail.pem: No such file or directory (os error 2)', 'tls_config', 400));

    const { status, body } = await call('add', submission);
    expect(status).toBe(400);
    expect(body).toEqual({ error: '/etc/rproxy/certs/mail.pem: No such file or directory (os error 2)', code: 'tls_config' });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it('modify replaces the TLS settings with PATCH and stores options', async () => {
    conn.query.mockResolvedValueOnce([row()]);
    mocks.modifyRule.mockResolvedValue({});

    const { status } = await call('modify', submission);
    expect(status).toBe(200);
    expect(mocks.modifyRule).toHaveBeenCalledWith(
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 587 },
      { remote_addr: '10.0.0.20', remote_port: 587, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: true },
    );
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    expect(update?.[0]).toMatch(/options = \?/);
    expect(JSON.parse(update?.[1][3] as string)).toEqual({ tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: true });
  });

  it('modify restores the previous TLS settings when COMMIT fails', async () => {
    const previous = { tls: { mode: 'sni', routes: [{ server_name: 'a.example.com', remote_addr: '10.0.0.1', remote_port: 443 }] }, starttls: null, starttls_required: true };
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(previous) })]);
    mocks.modifyRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status } = await call('modify', submission);
    expect(status).toBe(500);
    expect(mocks.modifyRule).toHaveBeenCalledTimes(2);
    expect(mocks.modifyRule.mock.calls[1]).toEqual([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 587 },
      { remote_addr: 'old.example.com', remote_port: 81, tls: previous.tls },
    ]);
  });

  it('modify restores STARTTLS too when COMMIT fails (options returned as an object)', async () => {
    // ドライバが JSON 列をオブジェクトで返す場合も読める
    conn.query.mockResolvedValueOnce([row({ options: { tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: false } })]);
    mocks.modifyRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    await call('modify', tcpRule);
    expect(mocks.modifyRule.mock.calls[0][1]).toEqual({ remote_addr: 'example.com', remote_port: 80, tls: { mode: 'passthrough' } });
    expect(mocks.modifyRule.mock.calls[1][1]).toEqual({
      remote_addr: 'old.example.com', remote_port: 81, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: false,
    });
  });

  it('modify keeps the range from the DB and rejects a changed range', async () => {
    conn.query.mockResolvedValueOnce([row({ src_port_end: 8890 })]);

    const { status, body } = await call('modify', { ...tcpRule, srcPortEnd: 8900 });
    expect(status).toBe(400);
    expect(body.code).toBe('unsupported');
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('modify checks the new target port against the stored range', async () => {
    conn.query.mockResolvedValueOnce([row({ src_port_end: 8890 })]);

    const { status, body } = await call('modify', { ...tcpRule, distPort: 65534 });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(mocks.modifyRule).not.toHaveBeenCalled();
  });

  it('modify re-creates a missing range rule with its range and new TLS settings', async () => {
    conn.query.mockResolvedValueOnce([row({ src_port_end: 8890 })]);
    mocks.modifyRule.mockRejectedValue(new RproxyError('rule not found', 'not_found', 404));
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('modify', { ...tcpRule, tls: { mode: 'sni' } });
    expect(status).toBe(200);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ listen_port: 8888, listen_port_end: 8890, tls: { mode: 'sni' } }));
  });

  it('delete re-adds the range rule with its TLS settings when COMMIT fails', async () => {
    const opts = { tls: { mode: 'terminate', certificates: [cert] }, starttls: null, starttls_required: true };
    conn.query.mockResolvedValueOnce([row({ src_port_end: 8890, options: JSON.stringify(opts) })]);
    mocks.deleteRule.mockResolvedValue(undefined);
    mocks.addRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    await call('delete', tcpRule);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ listen_port: 8888, listen_port_end: 8890, tls: opts.tls }));
    expect(mocks.addRule.mock.calls[0][0]).not.toHaveProperty('starttls');
    const log = sqlCalls().find(([sql]) => sql.startsWith('INSERT INTO forward_rules_log'));
    expect(log?.[1][4]).toBe(8890);
    expect(JSON.parse(log?.[1][9] as string)).toEqual(opts);
  });

  it('list returns the range and TLS settings from the DB', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'udp', src_addr: '0.0.0.0', src_port: 8000, src_port_end: 8001, dist_addr: 'a', dist_port: 8000, source_ip: 'proxy', udp_idle_secs: 30, options: null },
      { id: 2, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 587, src_port_end: null, dist_addr: 'b', dist_port: 587, source_ip: 'proxy_v2', udp_idle_secs: 30,
        options: JSON.stringify({ tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: true }) },
    ]);
    mocks.listRules.mockResolvedValue([
      { protocol: 'udp', listen_addr: '0.0.0.0', listen_port: 8000, listen_port_end: 8001, remote_addr: 'a', remote_port: 8000, state: 'running', error: null, resolved: [], connections: 1 },
    ]);

    const { body } = await call('list', undefined, 'GET');
    expect(body[0]).toMatchObject({ srcPort: 8000, srcPortEnd: 8001, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, state: 'running' });
    expect(body[1]).toMatchObject({ srcPortEnd: null, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttlsRequired: true, state: 'missing' });
  });
});
