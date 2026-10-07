// 制御 API のクライアント証明書（rproxy v0.4 の mTLS、#167）と 429 locked_out の Retry-After
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RproxyError, envClientTls, getCapabilities, listRules, withNode } from '@/components/rproxy';
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
