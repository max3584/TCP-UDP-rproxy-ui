// 利用者のルールの制限（#155）：ファイルのパス・転送先の取り出し、前からある値の扱い、転送先の確かめ方、ほかの人のルールのパスを伏せる
import { describe, expect, it } from 'vitest';
import type { ForwardRule } from '@/components/lib';
import { DEFAULT_TLS, NO_BALANCING } from '@/components/tls';
import { HIDDEN_FILE, addedRefs, certAllowed, certNames, destKey, destRefs, fileKey, fileRefs, redactFiles, urlHostPort } from '@/components/userlimits';
import { checkDestinations, nameAllowed, protectedAddrs, toIp } from '@/components/usertargets';
import type { TargetDeps } from '@/components/usertargets';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8443, srcPortEnd: null, distAddr: '192.0.2.5', distPort: 8080,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { ...DEFAULT_TLS }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false,
  ...NO_BALANCING, extraListenAddrs: [],
};

const tlsWithFiles = {
  mode: 'terminate' as const,
  certificates: [{ cert_file: '/etc/rproxy/tls/a.pem', chain_file: '/etc/rproxy/tls/chain.pem', key_file: '/etc/rproxy/tls/a.key' }, { cert: 'tenant-a' }],
  client_auth: { mode: 'required' as const, ca_file: '/etc/rproxy/ca.pem', chain_file: '/etc/rproxy/ca-chain.pem' },
  upstream: { tls: true, ca_file: '/up/ca.pem', cert_file: '/up/c.pem', key_file: '/up/c.key', chain_file: '/up/chain.pem' },
  routes: [{ server_name: 'a.example.com', remote_addr: '198.51.100.1', remote_port: 443, upstream: { ca_file: '/r/ca.pem', cert_file: '/r/c.pem', key_file: '/r/c.key' } }],
};

const http = {
  routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 'web' }, { name: 'direct', match: 'Host(`x`)', to: 'https://direct.example.com/path' }],
  services: { web: { servers: [{ url: 'http://198.51.100.7:9000' }, { status: 503 }], tls: { ca_file: '/svc/ca.pem', cert_file: '/svc/c.pem', key_file: '/svc/c.key', chain_file: '/svc/chain.pem' } } },
  middlewares: {
    auth: { basic_auth: { users_file: '/etc/rproxy/htpasswd' } },
    sso: { oidc: { issuer: 'https://idp.example.com/realms/x', client_id: 'c', client_secret_file: '/s/client', cookie_secret_file: '/s/cookie', ca_file: '/s/ca.pem' } },
    fa: { forward_auth: { address: 'http://127.0.0.1:4181/auth' } },
    mirror: { mirror: { service: 'web' } },
    redirect: { redirect_regex: { regex: '^http://(.*)', replacement: 'https://$1' } },
  },
};

describe('fileRefs / certNames', () => {
  it('finds every *_file in tls and http (certificates, client_auth, upstream, route upstream, service tls, basic_auth, oidc)', () => {
    const refs = fileRefs({ tls: tlsWithFiles, http: http });
    expect(refs.map((r) => r.where).sort()).toEqual([
      'http.middlewares.*.basic_auth.users_file',
      'http.middlewares.*.oidc.ca_file',
      'http.middlewares.*.oidc.client_secret_file',
      'http.middlewares.*.oidc.cookie_secret_file',
      'http.services.*.tls.ca_file',
      'http.services.*.tls.cert_file',
      'http.services.*.tls.chain_file',
      'http.services.*.tls.key_file',
      'tls.certificates[].cert_file',
      'tls.certificates[].chain_file',
      'tls.certificates[].key_file',
      'tls.client_auth.ca_file',
      'tls.client_auth.chain_file',
      'tls.routes[].upstream.ca_file',
      'tls.routes[].upstream.cert_file',
      'tls.routes[].upstream.key_file',
      'tls.upstream.ca_file',
      'tls.upstream.cert_file',
      'tls.upstream.chain_file',
      'tls.upstream.key_file',
    ].sort());
    expect(certNames({ tls: tlsWithFiles })).toEqual(['tenant-a']);
    expect(fileRefs(null)).toEqual([]);
  });

  it('keeps values that were already there (also after reordering or renaming a service), and reports new or changed ones', () => {
    const before = fileRefs({ tls: tlsWithFiles, http: http });
    const reordered = { ...tlsWithFiles, certificates: [...tlsWithFiles.certificates].reverse() };
    const renamed = { ...http, services: { backend: http.services.web } };
    expect(addedRefs(fileRefs({ tls: reordered, http: renamed }), before, fileKey)).toEqual([]);
    const changed = { ...tlsWithFiles, certificates: [{ cert_file: '/etc/rproxy/tls/a.pem', key_file: '/etc/rproxy/tls/dashboard.key' }] };
    expect(addedRefs(fileRefs({ tls: changed, http: null }), before, fileKey)).toEqual([{ where: 'tls.certificates[].key_file', value: '/etc/rproxy/tls/dashboard.key' }]);
    // the same path in another field is new there
    const moved = { mode: 'terminate' as const, certificates: [{ cert_file: '/etc/rproxy/tls/a.key', key_file: '/etc/rproxy/tls/a.key' }] };
    expect(addedRefs(fileRefs({ tls: moved, http: null }), before, fileKey).map((r) => r.where)).toEqual(['tls.certificates[].cert_file']);
  });

  it('certAllowed follows the name prefixes (null: any)', () => {
    expect(certAllowed('dashboard', null)).toBe(true);
    expect(certAllowed('tenant-a', ['tenant-'])).toBe(true);
    expect(certAllowed('dashboard', ['tenant-'])).toBe(false);
  });
});

describe('destRefs', () => {
  it('lists every outbound destination: remote, targets, tls routes, service URLs, route to, forward_auth, oidc issuer', () => {
    const rule: ForwardRule = {
      ...base, srcPort: 5000, srcPortEnd: 5009, distAddr: 'Backend.Example.com', distPort: 6000,
      tls: { mode: 'sni', routes: [{ server_name: 'a.example.com', remote_addr: '198.51.100.1', remote_port: 443 }, { server_name: 'b.example.com', targets: [{ addr: '[2001:db8::1]', port: 8443 }] }] },
    };
    expect(destRefs(rule)).toEqual([
      { where: 'remote', host: 'backend.example.com', ports: [6000, 6009] },
      { where: 'tls.routes[].remote', host: '198.51.100.1', ports: [443, 443] },
      { where: 'tls.routes[].targets[]', host: '2001:db8::1', ports: [8443, 8443] },
    ]);
    const multi: ForwardRule = { ...base, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 81 }] };
    expect(destRefs(multi).map((d) => `${d.where} ${d.host}:${d.ports[0]}`)).toEqual(['targets[] 192.0.2.1:80', 'targets[] 192.0.2.2:81']);
    const l7: ForwardRule = { ...base, distAddr: '', distPort: 0, http: http };
    expect(destRefs(l7).map((d) => `${d.where} ${d.host}:${d.ports[0]}`)).toEqual([
      'http.routes[].to direct.example.com:443',
      'http.services.*.servers[].url 198.51.100.7:9000',
      'http.middlewares.*.oidc.issuer idp.example.com:443',
      'http.middlewares.*.forward_auth.address 127.0.0.1:4181',
    ]);
    expect(urlHostPort('http://[::1]/x')).toEqual({ host: '::1', port: 80 });
    expect(urlHostPort('ftp://x')).toBeNull();
  });

  it('a changed port of a kept host is new', () => {
    const before = destRefs({ ...base, distAddr: '127.0.0.1', distPort: 8080 });
    expect(addedRefs(destRefs({ ...base, distAddr: '127.0.0.1', distPort: 8080 }), before, destKey)).toEqual([]);
    expect(addedRefs(destRefs({ ...base, distAddr: '127.0.0.1', distPort: 3306 }), before, destKey)).toHaveLength(1);
  });
});

describe('checkDestinations', () => {
  const names: Record<string, string[]> = {
    'backend.example.com': ['192.0.2.20'],
    'evil.example.com': ['192.0.2.21', '127.0.0.1'],
    'meta.example.com': ['169.254.169.254'],
    'db.internal': ['10.0.0.9'],
  };
  const deps = (protectedAddrs: TargetDeps['protectedAddrs'] = []): TargetDeps => ({
    resolve: async (h) => {
      if (names[h]) return names[h];
      throw new Error('ENOTFOUND');
    },
    protectedAddrs: protectedAddrs,
  });
  const ref = (host: string, port = 80, end = port) => ({ where: 'remote', host: host, ports: [port, end] as [number, number] });
  const reasons = async (hosts: ReturnType<typeof ref>[], allow: Parameters<typeof checkDestinations>[1], d = deps()) =>
    (await checkDestinations(hosts, allow, d)).map((r) => r.ref.host);

  it('without an allow-list, refuses loopback, link-local (metadata), unspecified, multicast and broadcast, also behind a name or IPv4-mapped', async () => {
    const bad = ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'fe80::1', '0.0.0.0', '::', '224.0.0.1', 'ff02::1', '255.255.255.255', 'fd00:ec2::254', 'evil.example.com', 'meta.example.com', 'nowhere.invalid'];
    expect(await reasons(bad.map((h) => ref(h)), null)).toEqual(bad);
    expect(await reasons([ref('192.0.2.1'), ref('10.1.2.3'), ref('2001:db8::5'), ref('backend.example.com')], null)).toEqual([]);
  });

  it('with an allow-list, only addresses in its CIDRs or names in its list (names are still resolved and checked)', async () => {
    const allow = { cidrs: ['10.0.0.0/8', '2001:db8::/32'], names: ['backend.example.com', '*.svc.example.com'] };
    expect(await reasons([ref('10.1.2.3'), ref('2001:db8::5'), ref('backend.example.com'), ref('db.internal')], allow)).toEqual([]);
    expect(await reasons([ref('192.0.2.1'), ref('evil.example.com')], allow)).toEqual(['192.0.2.1', 'evil.example.com']);
    expect(nameAllowed('a.svc.example.com', allow.names)).toBe(true);
    expect(nameAllowed('svc.example.com', allow.names)).toBe(false);
    expect(nameAllowed('Backend.Example.com.', allow.names)).toBe(true);
  });

  it('a special range is usable only through an entry inside it (127.0.0.1/32), not through a broad one (0.0.0.0/0)', async () => {
    expect(await reasons([ref('127.0.0.1')], { cidrs: ['0.0.0.0/0'], names: [] })).toEqual(['127.0.0.1']);
    expect(await reasons([ref('127.0.0.1')], { cidrs: ['127.0.0.1/32'], names: [] })).toEqual([]);
    expect(await reasons([ref('127.0.0.2')], { cidrs: ['127.0.0.1/32'], names: [] })).toEqual(['127.0.0.2']);
  });

  it('the control API, the UI and the DB are refused even when allowed, by address and port (also inside a port range)', async () => {
    const d = deps([{ addr: '127.0.0.1', port: 8080, what: 'rproxy の制御 API' }, { addr: '10.0.0.9', port: 3306, what: 'データベース' }]);
    const allow = { cidrs: ['127.0.0.1/32', '10.0.0.0/8'], names: [] };
    expect(await reasons([ref('127.0.0.1', 8080), ref('127.0.0.1', 8000, 8100), ref('db.internal', 3306)], allow, d)).toEqual(['127.0.0.1', '127.0.0.1', 'db.internal']);
    expect(await reasons([ref('127.0.0.1', 9000), ref('10.0.0.9', 5432)], allow, d)).toEqual([]);
  });

  it('collects the protected addresses from the API URLs, GET /interfaces, the UI and the DB settings', async () => {
    const resolve = async (h: string) => (h === 'localhost' ? ['127.0.0.1'] : h === 'ui.example.com' ? ['192.0.2.80'] : h === 'db.example.com' ? ['192.0.2.33'] : [toIp(h) ?? '']);
    const list = await protectedAddrs({
      env: { PORT: '3001', NEXTAUTH_URL: 'https://ui.example.com', DB_HOST: 'db.example.com', DB_PORT: '3307' },
      apiUrls: ['http://127.0.0.1:8081'],
      interfaces: [{ interfaces: [{ name: 'eth0', addr: '192.0.2.50', family: 'ipv4', loopback: false, link_local: false }], reserved: [{ protocol: 'tcp', addr: '0.0.0.0', port: 8443, purpose: 'control api' }] }],
      resolve: resolve,
      local: () => ['127.0.0.1', '192.0.2.60'],
    });
    const has = (addr: string, port: number) => list.some((p) => p.addr === addr && p.port === port);
    expect(has('127.0.0.1', 8081)).toBe(true);
    expect(has('192.0.2.60', 8081)).toBe(true); // loopback control API: also this host's addresses
    expect(has('192.0.2.50', 8443)).toBe(true); // reserved on 0.0.0.0: every interface of that node
    expect(has('127.0.0.1', 8443)).toBe(true);
    expect(has('192.0.2.60', 3001)).toBe(true); // the UI listens on every address of its host
    expect(has('192.0.2.80', 443)).toBe(true); // NEXTAUTH_URL
    expect(has('192.0.2.33', 3307)).toBe(true); // DB
  });
});

describe('redactFiles', () => {
  it('hides *_file in tls and http, cert_status files and the paths in error texts', () => {
    const rule = {
      origin: 'static', tls: tlsWithFiles, http: http, error: 'open /etc/rproxy/tls/a.key: permission denied',
      certStatus: [{ role: 'server', file: '/etc/rproxy/tls/a.pem', not_after: 1, days_left: 1, state: 'ok' }],
      nodes: [{ node: 'n1', error: 'bad /etc/rproxy/tls/a.key', certStatus: [{ file: '/etc/rproxy/tls/a.pem' }] }],
    };
    const out = redactFiles(rule);
    expect(JSON.stringify(out)).not.toMatch(/\/etc\/|\/up\/|\/r\/|\/svc\/|\/s\//);
    expect(out.tls.certificates[0]).toEqual({ cert_file: HIDDEN_FILE, chain_file: HIDDEN_FILE, key_file: HIDDEN_FILE });
    expect(out.tls.certificates[1]).toEqual({ cert: 'tenant-a' });
    expect(out.error).toBe(`open ${HIDDEN_FILE}: permission denied`);
    expect(out.nodes[0].error).toBe(`bad ${HIDDEN_FILE}`);
    // the original is not changed
    expect(rule.tls.certificates[0].key_file).toBe('/etc/rproxy/tls/a.key');
  });
});

// レビューの指摘（#155）：読めない URL・死活確認のポート・上書きの置き場所・oidc・守る宛先の環境変数
describe('review fixes (#155)', () => {
  it('parseHttpUrl reads only well-formed http(s) URLs (port 1-65535 digits, no zone ID, no userinfo)', async () => {
    const { parseHttpUrl, validateHttp } = await import('@/components/httpspec');
    expect(parseHttpUrl('http://192.0.2.1:8080/x')).toEqual({ scheme: 'http', host: '192.0.2.1', port: 8080 });
    expect(parseHttpUrl('https://[2001:db8::1]/')).toEqual({ scheme: 'https', host: '2001:db8::1', port: 443 });
    expect(parseHttpUrl('HTTP://Example.COM')).toEqual({ scheme: 'http', host: 'example.com', port: 80 });
    for (const bad of ['http://169.254.169.254:65536/', 'http://127.0.0.1:8a/', 'http://[fe80::1%25eth0]/', 'http://[fe80::1%eth0]/', 'http://u:p@127.0.0.1/', 'http://127.0.0.1:0/', 'http://127.0.0.1:/', 'http://a b/', 'ftp://x/']) {
      expect(parseHttpUrl(bad), bad).toBeNull();
    }
    // サーバ側の検証（管理者も）で断る
    const errors = validateHttp({ routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's' }, { name: 't', match: 'Host(`t`)', to: 'http://127.0.0.1:8a/' }], services: { s: { servers: [{ url: 'http://169.254.169.254:65536/' }] } },
      middlewares: { fa: { forward_auth: { address: 'http://[fe80::1%25eth0]/' } }, o: { oidc: { issuer: 'https://idp:99999', client_id: 'c', client_secret_file: '/a', cookie_secret_file: '/b' } } } });
    expect(errors.join('\n')).toMatch(/サービス「s」の転送先/);
    expect(errors.join('\n')).toMatch(/ルート「t」の転送先（to）/);
    expect(errors.join('\n')).toMatch(/ミドルウェア「fa」の address/);
    expect(errors.join('\n')).toMatch(/ミドルウェア「o」の issuer/);
  });

  it('an unreadable URL becomes an invalid destination that is always refused', async () => {
    const rule: ForwardRule = { ...base, distAddr: '', distPort: 0, http: { routes: [{ name: 'r', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'http://169.254.169.254:65536/' }] } } } };
    const refs = destRefs(rule);
    expect(refs).toEqual([{ where: 'http.services.*.servers[].url', host: 'http://169.254.169.254:65536/', ports: [0, 0], invalid: true }]);
    const out = await checkDestinations(refs, null, { resolve: async () => ['192.0.2.1'], protectedAddrs: [] });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toContain('読めません');
  });

  it('health_check.port is a destination on every target', () => {
    const rule: ForwardRule = { ...base, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80 }], healthCheck: { port: 3306 } };
    expect(destRefs(rule).filter((d) => d.where === 'health_check').map((d) => `${d.host}:${d.ports[0]}`)).toEqual(['192.0.2.1:3306', '192.0.2.2:3306']);
  });

  it('locatedDests keeps a node override destination apart from the rule destination', async () => {
    const { locatedDests } = await import('@/components/userlimits');
    const rule: ForwardRule = { ...base, distAddr: '192.0.2.5', distPort: 80 };
    const withOverride = locatedDests(rule, { n1: { distAddr: '127.0.0.1', distPort: 9000 } });
    expect(withOverride.map((d) => `${d.where} ${d.host}:${d.ports[0]}`)).toEqual(['rule:remote 192.0.2.5:80', 'node:n1:remote 127.0.0.1:9000']);
    // moving the override's value to the rule is new there
    const moved = locatedDests({ ...rule, distAddr: '127.0.0.1', distPort: 9000 }, {});
    expect(addedRefs(moved, withOverride, destKey).map((d) => d.where)).toEqual(['rule:remote']);
  });

  it('oidcConfigs compares the whole oidc setting regardless of key order', async () => {
    const { oidcConfigs } = await import('@/components/userlimits');
    const a = oidcConfigs({ http: { middlewares: { o: { oidc: { issuer: 'https://i', client_id: 'c' } }, h: { headers: {} } } } });
    const b = oidcConfigs({ http: { middlewares: { renamed: { oidc: { client_id: 'c', issuer: 'https://i' } } } } });
    expect(a).toEqual(b);
    expect(oidcConfigs({ http: { middlewares: { o: { oidc: { issuer: 'https://i', client_id: 'd' } } } } })).not.toEqual(a);
  });

  it('RPROXY_UI_PROTECTED_TARGETS is refused even inside the allow-list', async () => {
    const { roleConfig, RoleConfigError } = await import('@/components/roles');
    const cfg = roleConfig({ RPROXY_UI_PROTECTED_TARGETS: '10.0.0.5:3306, 10.96.0.0/12, [fd00::/8]:5432, [2001:db8::1]' });
    expect(cfg.protectedTargets).toEqual([
      { cidr: '10.0.0.5/32', port: 3306 }, { cidr: '10.96.0.0/12', port: null }, { cidr: 'fd00::/8', port: 5432 }, { cidr: '2001:db8::1/128', port: null },
    ]);
    for (const bad of ['10.0.0.5:0', '10.0.0.5:x', 'db.example.com:3306', '[fd00::/8]:99999']) expect(() => roleConfig({ RPROXY_UI_PROTECTED_TARGETS: bad }), bad).toThrow(RoleConfigError);
    const deps = { resolve: async () => [], protectedAddrs: [], protectedCidrs: cfg.protectedTargets };
    const allow = { cidrs: ['10.0.0.0/8'], names: [] };
    const ref = (host: string, port: number) => ({ where: 'remote', host: host, ports: [port, port] as [number, number] });
    const out = await checkDestinations([ref('10.0.0.5', 3306), ref('10.0.0.5', 80), ref('10.100.0.1', 443)], allow, deps);
    expect(out.map((r) => `${r.ref.host}:${r.ref.ports[0]}`)).toEqual(['10.0.0.5:3306', '10.100.0.1:443']);
  });
});
