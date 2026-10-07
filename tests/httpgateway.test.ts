// Gateway API 向けの L7・TLS の項目（rproxy-api の docs/API.md「Gateway API 向けの L7・TLS」、rproxy-api #237）：
// 検証（rproxy と同じ規則）、rproxy へ送る形、features での出し分け、詳細画面の表示、tls.routes の targets
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpRules, HTTP_OPTIONS, cleanHttp, httpOptionsUsed, isStatusRange, toHttpRules, validateHttp } from '@/components/httpspec';
import HttpEditor from '@/components/HttpEditor';
import HttpSummary from '@/components/HttpSummary';
import { RouteTargetsEditor } from '@/components/TargetsEditor';
import { checkTls, normalizeTls } from '@/components/tls';
import { routeTargets } from '@/components/lib';
import { matchesText } from '@/components/dashboard';
import type { ForwardRule } from '@/components/lib';

// rproxy-api の docs/API.md の例（HTTPRoute 1 つの規則を写したもの）
const example = (): HttpRules => toHttpRules({
  routes: [{
    name: 'r0', match: 'Host(`app.example`) && PathPrefix(`/api/`)', service: 'r0',
    middlewares: ['r0-hdr', 'r0-cors', 'r0-mirror', 'r0-retry'], timeouts: { request: '10s', backend_request: '2s' },
  }],
  services: {
    r0: {
      protocol: 'h2c',
      servers: [
        { url: 'http://10.1.0.5:8080', weight: 5, middlewares: ['r0-b0'] },
        { url: 'http://10.1.0.6:8080', weight: 5, middlewares: ['r0-b0'] },
        { status: 500, weight: 10 },
      ],
    },
    'r0-shadow': { servers: [{ url: 'http://10.1.0.9:8080' }] },
    'tls-svc': {
      servers: [{ url: 'https://10.1.0.7:8443' }],
      tls: { server_name: 'abc.example.com', ca_file: '/var/run/rproxy-gateway/certs/0123456789abcdef.crt', subject_alt_names: ['abc.example.com', 'spiffe://abc.example.com/test-identity'] },
    },
  },
  middlewares: {
    'r0-hdr': { headers: { request: { set: { 'X-Header-Set': 'v' }, add: { 'X-Header-Add': 'v' }, remove: ['X-Header-Remove'] } } },
    'r0-b0': { headers: { request: { set: { Backend: 'v1' } } } },
    'r0-cors': { cors: { allow_origins: ['https://www.foo.com', 'https://*.bar.com'], allow_methods: ['GET', 'OPTIONS'], allow_headers: ['x-header-1'], expose_headers: ['x-header-3'], allow_credentials: true, max_age: 3600 } },
    'r0-mirror': { mirror: { service: 'r0-shadow', percent: 20 } },
    'r0-retry': { retry: { attempts: 4, status: ['500', '502-504'], initial_interval: '100ms' } },
    'r0-host': { replace_host: { host: 'one.example.org' } },
    'r0-redirect': { redirect_regex: { regex: '^http://([^/:]+)(:\\d+)?/(.*)$', replacement: 'https://$1/$3', status: 303 } },
  },
});

type Svc = NonNullable<HttpRules['services']>[string];
const withService = (name: string, svc: Partial<Svc>): HttpRules => {
  const v = example();
  return { ...v, services: { ...v.services, [name]: { ...(v.services?.[name] ?? { servers: [] }), ...svc } as Svc } };
};
const withMiddleware = (name: string, m: Record<string, Record<string, unknown>>): HttpRules => {
  const v = example();
  return { ...v, middlewares: { ...v.middlewares, [name]: m } };
};
const errorsOf = (v: HttpRules) => validateHttp(v).join(' ');

describe('validateHttp: the Gateway API fields', () => {
  it('accepts the example of rproxy-api docs/API.md and keeps every field when cleaned', () => {
    expect(validateHttp(example())).toEqual([]);
    const cleaned = cleanHttp(example()) as Record<string, any>;
    expect(cleaned.routes[0].timeouts).toEqual({ request: '10s', backend_request: '2s' });
    expect(cleaned.services.r0).toEqual({
      servers: [
        { url: 'http://10.1.0.5:8080', weight: 5, middlewares: ['r0-b0'] },
        { url: 'http://10.1.0.6:8080', weight: 5, middlewares: ['r0-b0'] },
        { status: 500, weight: 10 },
      ],
      protocol: 'h2c',
    });
    expect(cleaned.services['tls-svc'].tls.subject_alt_names).toHaveLength(2);
    // 書き出した形を読み直しても同じ
    expect(cleanHttp(toHttpRules(cleaned))).toEqual(cleaned);
  });

  it('lists the http_options a spec uses (as rproxy options_used)', () => {
    expect(httpOptionsUsed(example())).toEqual(['headers_add', 'redirect_status', 'route_timeouts', 'server_middlewares', 'server_status', 'retry_status']);
    expect(httpOptionsUsed(toHttpRules({ routes: [{ name: 'a', match: 'PathPrefix(`/`)', to: 'http://x' }] }))).toEqual([]);
    expect([...HTTP_OPTIONS].sort()).toEqual(['headers_add', 'redirect_status', 'retry_status', 'route_timeouts', 'server_middlewares', 'server_status']);
  });

  it('checks servers: url or status, weight, per-server middlewares, h2 / h2c schemes', () => {
    expect(errorsOf(withService('r0', { servers: [{ url: 'http://a', status: 500 }] }))).toContain('URL と状態コードのどちらか一方');
    expect(errorsOf(withService('r0', { servers: [{ status: 600 }, { url: 'http://a' }] }))).toContain('状態コードは 100〜599');
    expect(errorsOf(withService('r0', { servers: [{ status: 503, middlewares: ['r0-b0'] }, { url: 'http://a' }] }))).toContain('ミドルウェアを付けられません');
    expect(errorsOf(withService('r0', { servers: [{ url: 'http://a', weight: 0 }] }))).toContain('重みは 1 以上');
    expect(errorsOf(withService('r0', { servers: [{ url: 'http://a', middlewares: ['nope'] }] }))).toContain('ミドルウェア「nope」がありません');
    expect(errorsOf(withService('r0', { servers: [{ url: 'http://a', middlewares: ['r0-cors'] }] }))).toContain('転送先ごとには使えない種類');
    expect(errorsOf(withService('r0', { protocol: 'h2', servers: [{ url: 'http://a' }] }))).toContain('HTTP/2（h2）には https://');
    expect(errorsOf(withService('r0', { protocol: 'h2c', servers: [{ url: 'https://a' }] }))).toContain('h2c）には http://');
    expect(errorsOf(withService('r0', { protocol: 'h3' as never, servers: [{ url: 'http://a' }] }))).toContain('http1 / h2 / h2c / auto');
    expect(errorsOf(withService('r0', { servers: [{ status: 500 }], health_check: { path: '/h' } }))).toContain('URL の転送先が 1 つ以上');
    // status だけでも h2 のサービスは作れる（url のない転送先は scheme を問わない）
    expect(errorsOf(withService('r0', { protocol: 'h2', servers: [{ status: 500 }] }))).toBe('');
  });

  it('checks the service tls as rproxy ServiceTlsSpec::validate', () => {
    expect(errorsOf(withService('tls-svc', { tls: { cert_file: '/c' } }))).toContain('クライアント証明書と秘密鍵は両方とも');
    expect(errorsOf(withService('tls-svc', { tls: { chain_file: '/x' } }))).toContain('中間 CA はクライアント証明書と一緒に');
    expect(errorsOf(withService('tls-svc', { tls: { server_name: 'bad name' } }))).toContain('ホスト名か IP アドレス');
    expect(errorsOf(withService('tls-svc', { tls: { subject_alt_names: ['a b'] } }))).toContain('DNS 名か URI');
    expect(errorsOf(withService('tls-svc', { tls: { insecure_skip_verify: true, ca_file: '/ca' } }))).toContain('証明書を確かめないときは');
    expect(errorsOf(withService('tls-svc', { tls: { server_name: '10.0.0.1', cert_file: '/c', key_file: '/k', chain_file: '/ch' } }))).toBe('');
  });

  it('checks route timeouts, redirect status, retry status ranges', () => {
    const v = example();
    v.routes[0].timeouts = { request: '10 seconds' };
    expect(errorsOf(v)).toContain('時間の上限「10 seconds」');
    v.routes[0].timeouts = { request: '0s', backend_request: '500ms' };
    expect(errorsOf(v)).toBe('');
    expect(errorsOf(withMiddleware('r0-redirect', { redirect_scheme: { scheme: 'https', status: 304 } }))).toContain('301・302・303・307・308');
    expect(errorsOf(withMiddleware('r0-retry', { retry: { attempts: 2, status: ['5xx'] } }))).toContain('送り直す状態コード「5xx」');
    expect(['500', '502-504', '100-599'].every(isStatusRange)).toBe(true);
    expect(['99', '600', '504-502', '5xx', '500-', ''].some(isStatusRange)).toBe(false);
  });

  it('checks mirror, replace_host and cors as rproxy does', () => {
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: 'nope' } }))).toContain('サービス「nope」がありません');
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: '' } }))).toContain('送り先のサービスを指定');
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: 'r0-shadow', percent: 10, fraction: { numerator: 1 } } }))).toContain('どちらか一方');
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: 'r0-shadow', percent: 101 } }))).toContain('0〜100');
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: 'r0-shadow', fraction: { numerator: 4, denominator: 3 } } }))).toContain('分母以下');
    // denominator の既定は 100
    expect(errorsOf(withMiddleware('r0-mirror', { mirror: { service: 'r0-shadow', fraction: { numerator: 7 } } }))).toBe('');
    expect(errorsOf(withMiddleware('r0-host', { replace_host: { host: 'user@evil' } }))).toContain('host か host:port');
    expect(errorsOf(withMiddleware('r0-host', { replace_host: { host: 'one.example.org:8443' } }))).toBe('');
    expect(errorsOf(withMiddleware('r0-host', { replace_host: { host: '[2001:db8::1]:80' } }))).toBe('');
    expect(errorsOf(withMiddleware('r0-cors', { cors: { allow_origins: [] } }))).toContain('1 つ以上');
    expect(errorsOf(withMiddleware('r0-cors', { cors: { allow_origins: ['www.foo.com'] } }))).toContain('* か http://');
    expect(errorsOf(withMiddleware('r0-cors', { cors: { allow_origins: ['*'], allow_methods: ['GET, POST'] } }))).toContain('ヘッダの値に使えません');
    // 件数の上限（セキュリティレビュー L7）
    expect(errorsOf(withMiddleware('r0-cors', { cors: { allow_origins: ['*'], allow_headers: Array.from({ length: 257 }, (_, i) => `x-h${i}`) } }))).toContain('256 件まで');
    expect(errorsOf(withMiddleware('r0-cors', { cors: { allow_origins: ['*'], allow_headers: Array.from({ length: 256 }, (_, i) => `x-h${i}`) } }))).toBe('');
    expect(errorsOf(withMiddleware('r0-geo', { geoip: { deny_asns: Array.from({ length: 257 }, (_, i) => i + 1) } }))).toContain('256 件まで');
    expect(errorsOf(withMiddleware('r0-hdr', { headers: { response: { add: { 'X-A': 1 } } } }))).toContain('response.add');
  });

  it('refuses the new middleware kinds when rproxy does not list them', () => {
    expect(validateHttp(example(), ['headers', 'retry', 'redirect_regex']).join(' ')).toContain('種類「cors」は、この rproxy ではまだ使えません');
  });
});

describe('HttpEditor: features decide what can be edited, and old values are kept read-only', () => {
  const ALL_OPTIONS = [...HTTP_OPTIONS];
  const render = (value: HttpRules, httpOptions: readonly string[] | null, serviceOptions: readonly string[] | null) => renderToStaticMarkup(createElement(HttpEditor, {
    value, onChange: () => undefined, http3: false, httpOptions, serviceOptions,
    middlewares: ['headers', 'retry', 'redirect_regex', 'cors', 'mirror', 'replace_host'],
  }));

  it('shows every field when rproxy lists the features', () => {
    const html = render(example(), ALL_OPTIONS, ['protocol', 'tls']);
    expect(html).toMatch(/id="http-route-0-timeout-request"[^>]*value="10s"/);
    expect(html).toMatch(/id="http-route-0-timeout-backend"[^>]*value="2s"/);
    expect(html).toMatch(/<option value="h2c" selected="">/);
    expect(html).toContain('data-testid="service-tls"');
    expect(html).toMatch(/aria-label="サービス tls-svc: 確かめる名前（SAN）"[^>]*value="abc.example.com, spiffe:\/\/abc.example.com\/test-identity"/);
    expect(html).toContain('aria-label="サービス r0 の転送先 3 の状態コード"');
    expect(html).toContain('aria-label="サービス r0 の転送先 1 から r0-b0 を外す"');
    // 種類ごとの欄：cors・replace_host・mirror・retry の status・redirect の status
    expect(html).toMatch(/value="https:\/\/www.foo.com, https:\/\/\*.bar.com"/);
    expect(html).toMatch(/value="one.example.org"/);
    expect(html).toMatch(/<option value="r0-shadow" selected="">/);
    expect(html).toMatch(/value="500, 502-504"/);
    expect(html).toMatch(/<option value="303" selected="">/);
    expect(html).not.toContain('data-testid="http-preserved"');
  });

  it('keeps values read-only when this rproxy does not list them, and hides the empty ones', () => {
    const html = render(example(), [], ['health_check']);
    expect(html).not.toContain('timeout-request');
    expect(html).not.toContain('data-testid="service-tls"');
    expect(html).not.toContain('-protocol"');
    const preserved = html.match(/data-testid="http-preserved"/g) ?? [];
    // timeouts・per-server middlewares (2)・protocol・tls・retry status・redirect status
    expect(preserved.length).toBe(7);
    expect(html).toContain('この rproxy では使えないので編集できません');
    expect(html).toContain('add（ヘッダを足す）は、この rproxy ではまだ使えません');
    const plain = render(toHttpRules({ routes: [{ name: 'a', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'http://a' }] } } }), [], []);
    expect(plain).not.toContain('data-testid="http-preserved"');
    expect(plain).not.toContain('状態コードで答える');
  });
});

describe('HttpSummary: the rule detail shows the Gateway API fields', () => {
  it('shows timeouts, status backends, per-server middlewares, protocol and TLS', () => {
    const html = renderToStaticMarkup(createElement(HttpSummary, { http: cleanHttp(example()) }));
    expect(html).toContain('data-testid="http-route-timeouts"');
    expect(html).toContain('全体 10s、転送先へ 1 回 2s');
    expect(html).toContain('状態コード 500 で答える（重み 10）');
    expect(html).toContain('（ミドルウェア r0-b0）');
    expect(html).toContain('HTTP/2（平文。http:// の転送先）');
    expect(html).toContain('サーバ名 abc.example.com');
    expect(html).toContain('CORS（オリジンの許可）');
    expect(html).toContain('ミラー（リクエストの写しを送る）');
    expect(html).toContain('Host の書き換え');
  });
});

describe('tls.routes[] targets and balance (#234)', () => {
  const route = { server_name: 'A.example.com', targets: [{ addr: '10.0.0.1', port: 443, weight: 1 }, { addr: 'b.internal', port: 443, backup: true }], balance: 'least_conn' };

  it('normalizes targets instead of remote_addr / remote_port and keeps the default balance out', () => {
    const tls = normalizeTls({ mode: 'sni', routes: [route, { ...route, balance: 'round_robin' }] });
    expect(tls.routes?.[0]).toEqual({ server_name: 'a.example.com', targets: [{ addr: '10.0.0.1', port: 443 }, { addr: 'b.internal', port: 443, backup: true }], balance: 'least_conn' });
    expect(tls.routes?.[1]).not.toHaveProperty('balance');
    expect(() => checkTls('tcp', tls, null, 1)).not.toThrow();
    expect(routeTargets(tls.routes![0])).toHaveLength(2);
    expect(routeTargets({ server_name: 'x', remote_addr: '10.0.0.9', remote_port: 8443 })).toEqual([{ addr: '10.0.0.9', port: 8443 }]);
  });

  it('refuses both or neither, balance without targets, and ports over 65535 in a range', () => {
    expect(() => normalizeTls({ mode: 'sni', routes: [{ ...route, remote_addr: '10.0.0.1', remote_port: 443 }] })).toThrow(/どちらか一方/);
    expect(() => normalizeTls({ mode: 'sni', routes: [{ server_name: 'a', remote_addr: '10.0.0.1', remote_port: 443, balance: 'failover' }] })).toThrow(/targets）を指定したときだけ/);
    expect(() => normalizeTls({ mode: 'sni', routes: [{ server_name: 'a' }] })).toThrow(/ポート番号/);
    const tls = normalizeTls({ mode: 'sni', routes: [{ server_name: 'a.example.com', targets: [{ addr: '10.0.0.1', port: 65530 }] }] });
    expect(() => checkTls('tcp', tls, null, 10)).toThrow(/65535/);
  });

  it('can be found by a destination address or port on the dashboard', () => {
    const rule = { srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '', distPort: 0, http: null, targets: [], extraListenAddrs: [],
      tls: normalizeTls({ mode: 'sni', routes: [route] }) } as unknown as ForwardRule;
    expect(matchesText(rule, 'b.internal')).toBe(true);
    expect(matchesText(rule, '10.0.0.1')).toBe(true);
  });

  it('edits the destinations when rproxy lists tls_route_targets and keeps them read-only otherwise', () => {
    const rows = [{ addr: '10.0.0.1', port: 443 as const, weight: '' as const, backup: false }];
    const props = { index: 0, rows, balance: 'failover' as const, onChange: () => undefined, onSingle: () => undefined };
    const editable = renderToStaticMarkup(createElement(RouteTargetsEditor, { ...props, editable: true }));
    expect(editable).toContain('aria-label="転送先 1 の宛先 1 のアドレス"');
    expect(editable).toMatch(/<option value="failover" selected="">/);
    const locked = renderToStaticMarkup(createElement(RouteTargetsEditor, { ...props, editable: false }));
    expect(locked).toContain('data-testid="tls-route-targets-preserved"');
    expect(locked).toContain('10.0.0.1:443');
    expect(locked).not.toContain('<input');
  });
});
