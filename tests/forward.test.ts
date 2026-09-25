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
      { remote_addr: 'example.com', remote_port: 80, udp_idle_secs: 120, tls: { mode: 'passthrough' }, allow_from: [] },
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

  it('delete removes a DB rule shadowed by a static rule of the same key', async () => {
    conn.query.mockResolvedValueOnce([{ dist_addr: 'example.com', dist_port: 80, source_ip: 'proxy', udp_idle_secs: 30 }]);
    mocks.deleteRule.mockRejectedValue(new RproxyError('tcp/0.0.0.0:8888 is a static rule', 'static', 409));

    const { status } = await call('delete', tcpRule);
    expect(status).toBe(200);
    expect(conn.commit).toHaveBeenCalled();
    expect(sqlCalls().some(([sql]) => sql.startsWith('DELETE FROM forward_rules'))).toBe(true);
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
      { remote_addr: 'old.example.com', remote_port: 81, tls: { mode: 'passthrough' }, allow_from: [] },
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
    ['upstream chain_file without cert_file', { tls: { mode: 'terminate', certificates: [cert], upstream: { tls: true, chain_file: '/chain.pem' } } }, 'tls_config'],
    ['client_auth chain_file with mode none', { tls: { mode: 'terminate', certificates: [cert], client_auth: { mode: 'none', chain_file: '/chain.pem' } } }, 'tls_config'],
    ['client_auth chain_file with passthrough', { tls: { mode: 'passthrough', client_auth: { chain_file: '/chain.pem' } } }, 'tls_config'],
    ['unknown key in a certificate', { tls: { mode: 'terminate', certificates: [{ ...cert, chains: '/c.pem' }] } }, 'invalid'],
    ['chain_file that is not a string', { tls: { mode: 'terminate', certificates: [{ ...cert, chain_file: 1 }] } }, 'invalid'],
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
      { remote_addr: '10.0.0.20', remote_port: 587, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: true, allow_from: [] },
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
      { remote_addr: 'old.example.com', remote_port: 81, tls: previous.tls, allow_from: [] },
    ]);
  });

  it('modify restores STARTTLS too when COMMIT fails (options returned as an object)', async () => {
    // ドライバが JSON 列をオブジェクトで返す場合も読める
    conn.query.mockResolvedValueOnce([row({ options: { tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: false } })]);
    mocks.modifyRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    await call('modify', tcpRule);
    expect(mocks.modifyRule.mock.calls[0][1]).toEqual({ remote_addr: 'example.com', remote_port: 80, tls: { mode: 'passthrough' }, allow_from: [] });
    expect(mocks.modifyRule.mock.calls[1][1]).toEqual({
      remote_addr: 'old.example.com', remote_port: 81, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', starttls_required: false, allow_from: [],
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

  it('stores certificate, client_auth and upstream chain files in the exact rproxy shape', async () => {
    mocks.addRule.mockResolvedValue({});
    const chained = {
      mode: 'terminate',
      certificates: [
        { cert_file: '/etc/rproxy/certs/leaf.pem', chain_file: ' /etc/rproxy/certs/intermediates.pem ', key_file: '/etc/rproxy/certs/leaf.key' },
        { cert_file: '/etc/rproxy/certs/other.pem', chain_file: '', key_file: '/etc/rproxy/certs/other.key' },
      ],
      client_auth: { mode: 'required', ca_file: '/etc/rproxy/clients-root.pem', chain_file: '/etc/rproxy/clients-intermediates.pem' },
      upstream: { tls: true, cert_file: '/etc/rproxy/up.pem', chain_file: '/etc/rproxy/up-chain.pem', key_file: '/etc/rproxy/up.key' },
    };

    const { status } = await call('add', { ...tcpRule, srcPort: 443, tls: chained });
    expect(status).toBe(200);
    // 空の chain_file は省く。キーは rproxy と同じ名前・順番
    const expected = {
      mode: 'terminate',
      certificates: [
        { cert_file: '/etc/rproxy/certs/leaf.pem', chain_file: '/etc/rproxy/certs/intermediates.pem', key_file: '/etc/rproxy/certs/leaf.key' },
        { cert_file: '/etc/rproxy/certs/other.pem', key_file: '/etc/rproxy/certs/other.key' },
      ],
      client_auth: { mode: 'required', ca_file: '/etc/rproxy/clients-root.pem', chain_file: '/etc/rproxy/clients-intermediates.pem' },
      upstream: { tls: true, cert_file: '/etc/rproxy/up.pem', chain_file: '/etc/rproxy/up-chain.pem', key_file: '/etc/rproxy/up.key' },
    };
    const options = sqlCalls()[0][1][9] as string;
    expect(JSON.parse(options)).toEqual({ tls: expected, starttls: null, starttls_required: true });
    expect(options).toContain('{"cert_file":"/etc/rproxy/certs/leaf.pem","chain_file":"/etc/rproxy/certs/intermediates.pem","key_file":"/etc/rproxy/certs/leaf.key"}');
    expect(mocks.addRule.mock.calls[0][0].tls).toEqual(expected);
  });

  it('reads chain files back from the options column', async () => {
    const tls = {
      mode: 'terminate',
      certificates: [{ ...cert, chain_file: '/etc/rproxy/certs/intermediates.pem' }],
      client_auth: { mode: 'optional', ca_file: '/root.pem', chain_file: '/int.pem' },
    };
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 993, src_port_end: null, dist_addr: 'b', dist_port: 143, source_ip: 'proxy', udp_idle_secs: 30,
        options: JSON.stringify({ tls: tls, starttls: null, starttls_required: true }) },
    ]);
    mocks.listRules.mockResolvedValue([]);

    const { body } = await call('list', undefined, 'GET');
    expect(body[0].tls).toEqual(tls);
  });
});

describe('/api/forward/[forward]: live stats, dashboard and a single rule', () => {
  const dbRow = { id: 7, protocol: 'tcp', src_addr: '::1', src_port: 443, src_port_end: null, dist_addr: 'a', dist_port: 8443, source_ip: 'proxy', udp_idle_secs: 30, options: null };
  const liveRule = {
    protocol: 'tcp', listen_addr: '::1', listen_port: 443, remote_addr: 'a', remote_port: 8443, state: 'running', error: null,
    resolved: ['10.0.0.1:8443'], connections: 2,
    stats: { total_connections: 10, rx_bytes: 1234, tx_bytes: 5678, tls_failures: 1 }, started_at: 1790000000,
  };

  it('list passes stats, started_at and resolved through from rproxy', async () => {
    pool.query.mockResolvedValue([dbRow, { ...dbRow, id: 8, src_port: 444 }]);
    mocks.listRules.mockResolvedValue([liveRule]);

    const { status, body } = await call('list', undefined, 'GET');
    expect(status).toBe(200);
    expect(body[0]).toMatchObject({
      id: 7, state: 'running', connections: 2, resolved: ['10.0.0.1:8443'],
      stats: { total_connections: 10, rx_bytes: 1234, tx_bytes: 5678, tls_failures: 1 }, startedAt: 1790000000,
    });
    // rproxy にないルールは稼働情報なし
    expect(body[1]).toMatchObject({ id: 8, state: 'missing', connections: null, stats: null, startedAt: null, resolved: [] });
  });

  it('list leaves stats empty when rproxy is unreachable or an old rproxy omits them', async () => {
    pool.query.mockResolvedValue([dbRow]);
    mocks.listRules.mockRejectedValueOnce(new RproxyError('down', 'unreachable', 0));
    expect((await call('list', undefined, 'GET')).body[0]).toMatchObject({ state: 'unknown', stats: null, startedAt: null, resolved: [] });

    const { stats: _s, started_at: _t, ...old } = liveRule;
    mocks.listRules.mockResolvedValueOnce([old]);
    expect((await call('list', undefined, 'GET')).body[0]).toMatchObject({ state: 'running', stats: null, startedAt: null, resolved: ['10.0.0.1:8443'] });
  });

  it('dashboard reports whether rproxy was reachable', async () => {
    pool.query.mockResolvedValue([]);
    mocks.listRules.mockResolvedValueOnce([]);
    expect((await call('dashboard', undefined, 'GET')).body).toEqual({ reachable: true, rproxyError: null, rules: [] });

    mocks.listRules.mockRejectedValueOnce(new RproxyError('rproxy に接続できません: ECONNREFUSED', 'unreachable', 0));
    const { status, body } = await call('dashboard', undefined, 'GET');
    expect(status).toBe(200);
    expect(body).toEqual({ reachable: false, rproxyError: 'rproxy に接続できません: ECONNREFUSED', rules: [] });
  });

  it('rule returns one own rule with its live state (IPv6 address normalized)', async () => {
    pool.query.mockResolvedValue([dbRow]);
    mocks.getRule.mockResolvedValue(liveRule);

    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'TCP', addr: '0:0:0:0:0:0:0:1', port: '443' });
    expect(status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual(['user-1', 'tcp', '::1', 443]);
    expect(pool.query.mock.calls[0][0]).toMatch(/WHERE auth_id = \? AND protocol = \? AND src_addr = \? AND src_port = \?/);
    expect(mocks.getRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '::1', listen_port: 443 });
    expect(body).toMatchObject({ id: 7, srcAddr: '::1', srcPort: 443, state: 'running', stats: liveRule.stats, startedAt: 1790000000 });
  });

  it('rule returns 404 for a rule of another user (a dynamic rule in rproxy is not shown)', async () => {
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValueOnce({ ...liveRule, listen_addr: '0.0.0.0', origin: 'dynamic' });

    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'ルールが見つかりません。', code: 'not_found' });

    // rproxy にもなければ 404。古い rproxy（origin なし）の rule も見せない
    mocks.getRule.mockRejectedValueOnce(new RproxyError('rule not found', 'not_found', 404));
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' })).status).toBe(404);
    mocks.getRule.mockResolvedValueOnce({ ...liveRule, listen_addr: '0.0.0.0' });
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' })).status).toBe(404);
  });

  it('rule reports missing and unknown like list', async () => {
    pool.query.mockResolvedValue([dbRow]);
    mocks.getRule.mockRejectedValueOnce(new RproxyError('rule not found', 'not_found', 404));
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '::1', port: '443' })).body).toMatchObject({ state: 'missing', stats: null });

    mocks.getRule.mockRejectedValueOnce(new RproxyError('down', 'unreachable', 0));
    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '::1', port: '443' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'unknown', stats: null, connections: null });
  });

  it.each([
    ['no protocol', { addr: '0.0.0.0', port: '443' }],
    ['unknown protocol', { protocol: 'sctp', addr: '0.0.0.0', port: '443' }],
    ['hostname as addr', { protocol: 'tcp', addr: 'example.com', port: '443' }],
    ['port 0', { protocol: 'tcp', addr: '0.0.0.0', port: '0' }],
    ['port not a number', { protocol: 'tcp', addr: '0.0.0.0', port: '44x' }],
  ])('rule rejects an invalid key: %s', async (_name, query) => {
    const { status, body } = await call('rule', undefined, 'GET', query as Record<string, string>);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rule returns 401 without a session', async () => {
    mocks.getServerSession.mockResolvedValue(null);
    expect((await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' })).status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('/api/forward/[forward]: allow_from, unmatched and static rules', () => {
  const route = { server_name: 'dashboard.proxy.home', remote_addr: '127.0.0.1', remote_port: 3001 };
  const row = (over: Record<string, unknown> = {}) => ({
    src_port_end: null, dist_addr: 'old.example.com', dist_port: 81, source_ip: 'proxy', udp_idle_secs: 30, options: null, ...over,
  });
  // rproxy-api の docs/API.md の「固定ルール」の例（応答の形）
  const staticRule = {
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, listen_port_end: null, remote_addr: '127.0.0.1', remote_port: 3001,
    source_ip: 'proxy', udp_idle_secs: 30, allow_from: ['172.16.0.0/16'], starttls: null, starttls_required: true,
    tls: {
      mode: 'terminate', routes: [route], certificates: [{ cert_file: '/etc/rproxy/certs/dashboard.pem', chain_file: '/etc/rproxy/certs/intermediates.pem', key_file: '/etc/rproxy/certs/dashboard.key' }],
      client_auth: { mode: 'none', ca_file: null }, alpn: [],
      upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null },
      unmatched: 'reject',
    },
    state: 'running', error: null, resolved: ['127.0.0.1:3001'], connections: 1,
    stats: { total_connections: 9, rx_bytes: 100, tx_bytes: 200, tls_failures: 0, denied: 4 }, started_at: 1790000000, origin: 'static',
  };
  const staticKey = { protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443 };

  it('add normalizes allow_from, stores it in options and sends it to rproxy', async () => {
    mocks.addRule.mockResolvedValue({});

    const { status } = await call('add', { ...tcpRule, allowFrom: ['10.0.0.5', '172.16.9.9/16', 'fd00::1/8'] });
    expect(status).toBe(200);
    const allow = ['10.0.0.5/32', '172.16.0.0/16', 'fd00::/8'];
    // TLS が既定でも allow_from があれば options を保存する（キーは rproxy が読む 4 つ）
    expect(JSON.parse(sqlCalls()[0][1][9] as string)).toEqual({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: allow });
    expect(JSON.parse(sqlCalls()[1][1][9] as string).allow_from).toEqual(allow);
    expect(mocks.addRule.mock.calls[0][0].allow_from).toEqual(allow);
  });

  it('add leaves allow_from out of the POST and options when empty', async () => {
    mocks.addRule.mockResolvedValue({});

    await call('add', { ...tcpRule, allowFrom: [] });
    expect(sqlCalls()[0][1][9]).toBeNull();
    expect(mocks.addRule.mock.calls[0][0]).not.toHaveProperty('allow_from');
  });

  it.each([
    ['not an array', { allowFrom: '10.0.0.0/8' }],
    ['a hostname', { allowFrom: ['example.com'] }],
    ['a too long prefix', { allowFrom: ['10.0.0.0/33'] }],
    ['a too long IPv6 prefix', { allowFrom: ['fd00::/129'] }],
    ['65 entries', { allowFrom: Array.from({ length: 65 }, (_, i) => `10.0.0.${i}`) }],
    ['unmatched with an unknown value', { tls: { mode: 'sni', routes: [route], unmatched: 'drop' } }],
  ])('rejects invalid allow_from / unmatched: %s', async (_name, override) => {
    const { status, body } = await call('add', { ...tcpRule, ...override });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid');
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['sni without routes', { tls: { mode: 'sni', unmatched: 'reject' } }],
    ['passthrough', { tls: { mode: 'passthrough', unmatched: 'reject' } }],
    ['udp terminate (DTLS)', { protocol: 'udp', tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }], routes: [route], unmatched: 'reject' } }],
  ])('rejects unmatched: reject for %s as tls_config', async (_name, override) => {
    const { status, body } = await call('add', { ...tcpRule, ...override });
    expect(status).toBe(400);
    expect(body.code).toBe('tls_config');
    expect(body.error).toContain('unmatched: reject');
  });

  it('passes unmatched: reject through and drops the default', async () => {
    mocks.addRule.mockResolvedValue({});

    await call('add', { ...tcpRule, srcPort: 443, tls: { mode: 'sni', routes: [route], unmatched: 'reject' } });
    expect(mocks.addRule.mock.calls[0][0].tls).toEqual({ mode: 'sni', routes: [route], unmatched: 'reject' });
    expect(JSON.parse(sqlCalls()[0][1][9] as string).tls.unmatched).toBe('reject');

    await call('add', { ...tcpRule, srcPort: 444, tls: { mode: 'sni', routes: [route], unmatched: 'default' } });
    expect(mocks.addRule.mock.calls[1][0].tls).toEqual({ mode: 'sni', routes: [route] });
  });

  it('modify replaces allow_from when given and keeps the stored value when omitted', async () => {
    const stored = { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: ['10.0.0.0/8'] };
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(stored) })]);
    mocks.modifyRule.mockResolvedValue({});

    await call('modify', { ...tcpRule, allowFrom: ['192.168.1.7'] });
    expect(mocks.modifyRule.mock.calls[0][1].allow_from).toEqual(['192.168.1.7/32']);
    const update = sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'));
    expect(JSON.parse(update?.[1][3] as string).allow_from).toEqual(['192.168.1.7/32']);

    vi.clearAllMocks();
    pool.getConnection.mockResolvedValue(conn);
    conn.query.mockResolvedValue({ affectedRows: 1 });
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(stored) })]);
    mocks.modifyRule.mockResolvedValue({});
    await call('modify', tcpRule);
    expect(mocks.modifyRule.mock.calls[0][1].allow_from).toEqual(['10.0.0.0/8']);

    // [] ですべて許可に戻す（PATCH にも [] を付ける。options は NULL に戻る）
    vi.clearAllMocks();
    pool.getConnection.mockResolvedValue(conn);
    conn.query.mockResolvedValue({ affectedRows: 1 });
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(stored) })]);
    mocks.modifyRule.mockResolvedValue({});
    await call('modify', { ...tcpRule, allowFrom: [] });
    expect(mocks.modifyRule.mock.calls[0][1].allow_from).toEqual([]);
    expect(sqlCalls().find(([sql]) => sql.startsWith('UPDATE forward_rules'))?.[1][3]).toBeNull();
  });

  it('modify restores the previous allow_from and tls (with unmatched) when COMMIT fails', async () => {
    const previous = { tls: { mode: 'sni', routes: [route], unmatched: 'reject' }, starttls: null, starttls_required: true, allow_from: ['172.16.0.0/16'] };
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(previous) })]);
    mocks.modifyRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    const { status } = await call('modify', { ...tcpRule, allowFrom: [] });
    expect(status).toBe(500);
    expect(mocks.modifyRule.mock.calls[0][1]).toEqual({ remote_addr: 'example.com', remote_port: 80, tls: { mode: 'passthrough' }, allow_from: [] });
    expect(mocks.modifyRule.mock.calls[1][1]).toEqual({
      remote_addr: 'old.example.com', remote_port: 81, tls: previous.tls, allow_from: ['172.16.0.0/16'],
    });
  });

  it('delete re-adds the rule with its allow_from when COMMIT fails', async () => {
    const opts = { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: ['10.0.0.0/8'] };
    conn.query.mockResolvedValueOnce([row({ options: JSON.stringify(opts) })]);
    mocks.deleteRule.mockResolvedValue(undefined);
    mocks.addRule.mockResolvedValue({});
    conn.commit.mockRejectedValueOnce(new Error('connection lost'));

    await call('delete', tcpRule);
    expect(mocks.addRule).toHaveBeenCalledWith(expect.objectContaining({ allow_from: ['10.0.0.0/8'] }));
  });

  it('list returns allowFrom, origin dynamic and stats.denied for DB rules, but no static rules', async () => {
    pool.query.mockResolvedValue([
      { id: 1, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 80, src_port_end: null, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30,
        options: JSON.stringify({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: ['10.0.0.0/8'] }) },
    ]);
    mocks.listRules.mockResolvedValue([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, remote_addr: 'a', remote_port: 8080, state: 'running', error: null, resolved: [], connections: 0,
        stats: { total_connections: 3, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, denied: 2 }, origin: 'dynamic' },
      staticRule,
    ]);

    const { body } = await call('list', undefined, 'GET');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: 1, origin: 'dynamic', allowFrom: ['10.0.0.0/8'], stats: { denied: 2 } });
  });

  it('dashboard merges static rules from rproxy as read-only rows after the own rules', async () => {
    pool.query.mockResolvedValue([
      { id: 5, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 80, src_port_end: null, dist_addr: 'a', dist_port: 8080, source_ip: 'proxy', udp_idle_secs: 30, options: null },
    ]);
    mocks.listRules.mockResolvedValue([
      { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, remote_addr: 'a', remote_port: 8080, state: 'running', error: null, resolved: [], connections: 0, origin: 'dynamic' },
      // ほかの利用者の dynamic なルールは出さない
      { protocol: 'udp', listen_addr: '0.0.0.0', listen_port: 53, remote_addr: 'b', remote_port: 53, state: 'running', error: null, resolved: [], connections: 0, origin: 'dynamic' },
      staticRule,
    ]);

    const { status, body } = await call('dashboard', undefined, 'GET');
    expect(status).toBe(200);
    expect(body.reachable).toBe(true);
    expect(body.rules.map((r: any) => [r.id, r.origin, r.srcPort])).toEqual([[5, 'dynamic', 80], [-1, 'static', 443]]);
    expect(body.rules[1]).toMatchObject({
      protocol: 'tcp', srcAddr: '0.0.0.0', srcPortEnd: null, distAddr: '127.0.0.1', distPort: 3001, allowFrom: ['172.16.0.0/16'],
      tls: { mode: 'terminate', routes: [route], unmatched: 'reject' }, starttls: null, starttlsRequired: true,
      state: 'running', connections: 1, stats: { denied: 4 }, startedAt: 1790000000, resolved: ['127.0.0.1:3001'],
    });
    // 既定値の項目は省いた形（client_auth / alpn / upstream なし）
    expect(Object.keys(body.rules[1].tls).sort()).toEqual(['certificates', 'mode', 'routes', 'unmatched']);
  });

  it('dashboard has no static rows when rproxy is unreachable', async () => {
    pool.query.mockResolvedValue([]);
    mocks.listRules.mockRejectedValueOnce(new RproxyError('down', 'unreachable', 0));

    expect((await call('dashboard', undefined, 'GET')).body).toEqual({ reachable: false, rproxyError: 'down', rules: [] });
  });

  it('rule returns a static rule that is not in the DB', async () => {
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockResolvedValue(staticRule);

    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    expect(status).toBe(200);
    expect(mocks.getRule).toHaveBeenCalledWith({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443 });
    expect(body).toMatchObject({ id: -1, origin: 'static', srcPort: 443, allowFrom: ['172.16.0.0/16'], state: 'running', stats: { denied: 4 } });
  });

  it('rule reports an unreachable rproxy instead of 404 for a rule that is not in the DB', async () => {
    pool.query.mockResolvedValue([]);
    mocks.getRule.mockRejectedValue(new RproxyError('rproxy に接続できません', 'unreachable', 0));

    const { status, body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    expect(status).toBe(502);
    expect(body.code).toBe('unreachable');
  });

  it('rule returns an own DB rule with origin dynamic', async () => {
    pool.query.mockResolvedValue([{ id: 3, protocol: 'tcp', src_addr: '0.0.0.0', src_port: 443, src_port_end: null, dist_addr: 'a', dist_port: 1, source_ip: 'proxy', udp_idle_secs: 30, options: null }]);
    mocks.getRule.mockResolvedValue({ ...staticRule, origin: 'dynamic' });

    const { body } = await call('rule', undefined, 'GET', { protocol: 'tcp', addr: '0.0.0.0', port: '443' });
    // DB の設定を返す（稼働情報だけ rproxy から）
    expect(body).toMatchObject({ id: 3, origin: 'dynamic', distAddr: 'a', allowFrom: [], tls: { mode: 'passthrough' } });
  });

  it.each(['modify', 'delete'])('%s refuses a static rule with 409 static without touching rproxy', async (action) => {
    conn.query.mockResolvedValueOnce([]);
    mocks.getRule.mockResolvedValue(staticRule);

    const { status, body } = await call(action, action === 'delete' ? staticKey : { ...tcpRule, ...staticKey });
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'このルールは rproxy の固定ルールです。', code: 'static' });
    expect(mocks.modifyRule).not.toHaveBeenCalled();
    expect(mocks.deleteRule).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it.each(['modify', 'delete'])('%s still returns 404 for a rule that is neither own nor static', async (action) => {
    conn.query.mockResolvedValueOnce([]);
    mocks.getRule.mockResolvedValue({ ...staticRule, origin: 'dynamic' });
    expect((await call(action, action === 'delete' ? staticKey : { ...tcpRule, ...staticKey })).status).toBe(404);

    conn.query.mockResolvedValueOnce([]);
    mocks.getRule.mockRejectedValue(new RproxyError('down', 'unreachable', 0));
    expect((await call(action, action === 'delete' ? staticKey : { ...tcpRule, ...staticKey })).status).toBe(404);
  });

  it('passes a 409 static from rproxy through and rolls back', async () => {
    conn.query.mockResolvedValueOnce([row()]);
    mocks.modifyRule.mockRejectedValue(new RproxyError('rule is static', 'static', 409));

    const { status, body } = await call('modify', tcpRule);
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'rule is static', code: 'static' });
    expect(conn.rollback).toHaveBeenCalled();
  });
});
