// 制御 API のクライアント証明書（rproxy v0.4 の mTLS、#167）と 429 locked_out の Retry-After
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RproxyError, envClientTls, envClientTlsProblem, getCapabilities, listRules, tlsAgent, tlsAgentCount, withNode } from '@/components/rproxy';
import { NodesConfigError, checkClientTls, implicitConfig, parseNodesConfig } from '@/components/nodes';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('クライアント証明書の設定', () => {
  it('RPROXY_API_TLS_* を読む（RPROXY_UI_NODES がないとき）', () => {
    vi.stubEnv('RPROXY_API_TLS_CERT', '/etc/rproxy-ui/client.pem');
    vi.stubEnv('RPROXY_API_TLS_KEY', '/etc/rproxy-ui/client.key');
    vi.stubEnv('RPROXY_API_TLS_CA', '');
    expect(envClientTls()).toEqual({ cert: '/etc/rproxy-ui/client.pem', key: '/etc/rproxy-ui/client.key' });
    expect(implicitConfig().nodes[0].tls).toEqual({ cert: '/etc/rproxy-ui/client.pem', key: '/etc/rproxy-ui/client.key' });
  });

  it('RPROXY_UI_NODES の tls_cert・tls_key・tls_ca', () => {
    const read = (p: string) => (p.startsWith('/missing') ? (() => { throw new Error('ENOENT'); })() : 'x');
    const cfg = parseNodesConfig(`nodes:
  - name: a
    url: https://10.0.0.1:8443
    tls_cert: /etc/c.pem
    tls_key: /etc/c.key
    tls_ca: /etc/ca.pem
`, read);
    expect(cfg.nodes[0].tls).toEqual({ cert: '/etc/c.pem', key: '/etc/c.key', ca: '/etc/ca.pem' });
    expect(() => checkClientTls({ tls_cert: '/etc/c.pem' }, 'nodes[0]', 'https://x', read)).toThrow(/両方/);
    expect(() => checkClientTls({ tls_ca: '/etc/ca.pem' }, 'nodes[0]', 'http://x', read)).toThrow(/https/);
    expect(() => checkClientTls({ tls_ca: '/missing/ca.pem' }, 'nodes[0]', 'https://x', read)).toThrow(NodesConfigError);
    expect(checkClientTls({}, 'nodes[0]', 'https://x', read)).toBeUndefined();
  });

  // セキュリティレビュー L3：mTLS のつもりで http:// の URL を書くと、証明書を使わずにトークンが平文で流れていた
  it('RPROXY_API_TLS_* と http:// の RPROXY_API_URL の組は起動時に止め、問い合わせもしない', async () => {
    expect(envClientTlsProblem({ RPROXY_API_URL: 'http://10.0.0.1:8081' })).toBeNull();
    expect(envClientTlsProblem({ RPROXY_API_URL: 'https://10.0.0.1:8443', RPROXY_API_TLS_CERT: '/c', RPROXY_API_TLS_KEY: '/k' })).toBeNull();
    expect(envClientTlsProblem({ RPROXY_API_URL: 'http://10.0.0.1:8081', RPROXY_API_TLS_CA: '/ca' })).toContain('https://');
    expect(envClientTlsProblem({ RPROXY_API_URL: 'unix:/run/rproxy.sock', RPROXY_API_TLS_CERT: '/c' })).toContain('RPROXY_API_TLS_CERT');

    vi.stubEnv('RPROXY_API_URL', 'http://127.0.0.1:1');
    vi.stubEnv('RPROXY_API_TLS_CA', '/etc/rproxy-ui/ca.pem');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await listRules().catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.message).toContain('https://');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checkNodesAtStartup は RPROXY_API_TLS_* と http:// の組で終了する', async () => {
    const { checkNodesAtStartup } = await import('@/components/nodes');
    vi.stubEnv('RPROXY_UI_NODES', '');
    vi.stubEnv('RPROXY_API_URL', 'http://127.0.0.1:8081');
    vi.stubEnv('RPROXY_API_TLS_CERT', '/c');
    vi.stubEnv('RPROXY_API_TLS_KEY', '/k');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      checkNodesAtStartup();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(error.mock.calls[0][0])).toContain('https://');
      exit.mockClear();
      vi.stubEnv('RPROXY_API_URL', 'https://127.0.0.1:8443');
      checkNodesAtStartup();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  // セキュリティレビュー L4：証明書の入れ替えのたびに Agent が増えていた
  it('証明書のファイルが更新されたら Agent を作り直し、古いものを閉じる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-agent-'));
    try {
      const ca = join(dir, 'ca.pem');
      writeFileSync(ca, 'not a real certificate');
      const before = tlsAgentCount();
      const a1 = tlsAgent({ ca: ca });
      expect(tlsAgent({ ca: ca })).toBe(a1);
      const close = vi.spyOn(a1, 'close');
      for (let i = 1; i <= 3; i++) {
        utimesSync(ca, new Date(), new Date(Date.now() + i * 10_000));
        expect(tlsAgent({ ca: ca })).not.toBe(a1);
      }
      // undici の close() は中で close(callback) を呼ぶので、呼ばれたことだけを見る
      expect(close).toHaveBeenCalled();
      expect(tlsAgentCount()).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('429 locked_out の Retry-After を RproxyError に持つ', async () => {
    vi.stubEnv('RPROXY_API_URL', 'http://127.0.0.1:1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'locked out', code: 'locked_out' }), { status: 429, headers: { 'Retry-After': '300' } })));
    const err = await listRules().catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(300);
  });
});

describe.skipIf(!hasOpenssl())('https の制御 API にクライアント証明書で接続する', () => {
  let dir = '';
  let server: Server;
  let url = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rproxy-mtls-'));
    const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem']);
    writeFileSync(join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1\n');
    writeFileSync(join(dir, 'client.ext'), 'subjectAltName=DNS:ui.rproxy.internal\n');
    for (const name of ['server', 'client']) {
      o(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
      o(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', `${name}.ext`, '-out', `${name}.pem`]);
    }
    server = createServer({
      key: readFileSync(join(dir, 'server.key')),
      cert: readFileSync(join(dir, 'server.pem')),
      ca: readFileSync(join(dir, 'ca.pem')),
      requestCert: true,
      rejectUnauthorized: true,
    }, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: '0.4.0', source_ip: ['proxy'], client: (req.socket as import('node:tls').TLSSocket).getPeerCertificate().subject?.CN }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('証明書と CA を渡せば通る', async () => {
    const caps = await withNode({ name: 'a', url: url, tls: { cert: join(dir, 'client.pem'), key: join(dir, 'client.key'), ca: join(dir, 'ca.pem') } }, () => getCapabilities()) as unknown as Record<string, unknown>;
    expect(caps.version).toBe('0.4.0');
    expect(caps.client).toBe('client');
  });

  it('証明書がなければ TLS で断られる（unreachable）', async () => {
    const err = await withNode({ name: 'a', url: url, tls: { ca: join(dir, 'ca.pem') } }, () => getCapabilities()).catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.code).toBe('unreachable');
  });
});

// RPROXY_API_TOKEN_FILE（rproxy のトークンファイルをグループ rproxy の読み取りで使う。.deb の postinst が入れる）
describe('RPROXY_API_TOKEN_FILE', () => {
  it('最初のトークンを読み、RPROXY_API_TOKEN があればそちら。YAML の書き方は断る', async () => {
    const { envApiToken, readTokenFile } = await import('@/components/rproxy');
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-token-'));
    try {
      const file = join(dir, 'tokens');
      writeFileSync(file, '# rproxy-api\n\n  abc123  \nsecond\n');
      expect(envApiToken({ RPROXY_API_TOKEN_FILE: file })).toBe('abc123');
      expect(envApiToken({ RPROXY_API_TOKEN: 'direct', RPROXY_API_TOKEN_FILE: file })).toBe('direct');
      expect(envApiToken({})).toBeUndefined();
      // 入れ替えたら読み直す
      writeFileSync(file, 'rotated\n');
      utimesSync(file, new Date(), new Date(Date.now() + 60_000));
      expect(envApiToken({ RPROXY_API_TOKEN_FILE: file })).toBe('rotated');
      expect(() => readTokenFile('tokens:\n  - name: ui\n', file)).toThrow(/YAML/);
      expect(() => readTokenFile('# only a comment\n', file)).toThrow(/トークンがありません/);
      expect(() => envApiToken({ RPROXY_API_TOKEN_FILE: join(dir, 'missing') })).toThrow(/読めません/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('問い合わせに RPROXY_API_TOKEN_FILE のトークンを付ける', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-token-'));
    try {
      writeFileSync(join(dir, 'tokens'), 'from-file\n');
      vi.stubEnv('RPROXY_API_URL', 'http://127.0.0.1:1');
      vi.stubEnv('RPROXY_API_TOKEN', '');
      vi.stubEnv('RPROXY_API_TOKEN_FILE', join(dir, 'tokens'));
      const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await listRules();
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer from-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
