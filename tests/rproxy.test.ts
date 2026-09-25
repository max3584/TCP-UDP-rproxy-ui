import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RproxyError, addRule, deleteRule, getCapabilities, listRules, modifyRule } from '@/components/rproxy';

const fetchMock = vi.fn();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit & { headers: Record<string, string> } };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('RPROXY_API_URL', 'http://127.0.0.1:8080/');
  vi.stubEnv('RPROXY_API_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('rproxy client', () => {
  it('returns parsed rules on success', async () => {
    const rules = [{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, remote_addr: 'example.com', remote_port: 8080, state: 'running', error: null, resolved: [], connections: 2 }];
    fetchMock.mockResolvedValueOnce(json(rules));

    await expect(listRules()).resolves.toEqual(rules);
    const { url, init } = lastCall();
    expect(url).toBe('http://127.0.0.1:8080/rules');
    expect(init.method).toBe('GET');
  });

  it('posts a rule as JSON', async () => {
    const rule = { protocol: 'udp' as const, listen_addr: '0.0.0.0', listen_port: 53, remote_addr: '1.1.1.1', remote_port: 53, source_ip: 'proxy' as const, udp_idle_secs: 60 };
    fetchMock.mockResolvedValueOnce(json({ ...rule, state: 'running', error: null, resolved: ['1.1.1.1:53'], connections: 0 }, 201));

    await addRule(rule);
    const { url, init } = lastCall();
    expect(url).toBe('http://127.0.0.1:8080/rules');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(rule);
  });

  it('posts a range rule with TLS and STARTTLS as JSON', async () => {
    const rule = {
      protocol: 'tcp' as const, listen_addr: '0.0.0.0', listen_port: 587, listen_port_end: 588, remote_addr: '10.0.0.20', remote_port: 587,
      tls: { mode: 'terminate' as const, certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }] }, starttls: 'smtp' as const, starttls_required: false,
    };
    fetchMock.mockResolvedValueOnce(json({ error: '/c.pem: No such file or directory (os error 2)', code: 'tls_config' }, 400));

    const err = await addRule(rule).catch((e) => e);
    expect(JSON.parse(lastCall().init.body as string)).toEqual(rule);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.code).toBe('tls_config');
    expect(err.status).toBe(400);
  });

  it('maps the error body to RproxyError', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'address already in use (os error 98)', code: 'bind_failed' }, 409));

    const err = await getCapabilities().catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.code).toBe('bind_failed');
    expect(err.status).toBe(409);
    expect(err.message).toBe('address already in use (os error 98)');
  });

  it('uses code internal for a non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    const err = await listRules().catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.code).toBe('internal');
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
  });

  it('reports network failures as unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const err = await listRules().catch((e) => e);
    expect(err).toBeInstanceOf(RproxyError);
    expect(err.code).toBe('unreachable');
    expect(err.status).toBe(0);
  });

  it('sends the bearer token when RPROXY_API_TOKEN is set', async () => {
    vi.stubEnv('RPROXY_API_TOKEN', 'secret-token');
    fetchMock.mockResolvedValueOnce(json([]));

    await listRules();
    expect(lastCall().init.headers['Authorization']).toBe('Bearer secret-token');
  });

  it('omits the Authorization header when RPROXY_API_TOKEN is unset', async () => {
    fetchMock.mockResolvedValueOnce(json([]));

    await listRules();
    expect(lastCall().init.headers).not.toHaveProperty('Authorization');
  });

  it('URL-encodes an IPv6 listen address', async () => {
    fetchMock.mockResolvedValueOnce(json({}));

    await modifyRule({ protocol: 'tcp', listen_addr: '2001:db8::1', listen_port: 443 }, { remote_addr: 'example.com', remote_port: 8443 });
    const { url, init } = lastCall();
    expect(url).toBe('http://127.0.0.1:8080/rules/tcp/2001%3Adb8%3A%3A1/443');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ remote_addr: 'example.com', remote_port: 8443 });
  });

  it('deletes a rule and accepts 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(deleteRule({ protocol: 'udp', listen_addr: '::', listen_port: 53 }, 5)).resolves.toBeUndefined();
    const { url, init } = lastCall();
    expect(url).toBe('http://127.0.0.1:8080/rules/udp/%3A%3A/53?drain_secs=5');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});
