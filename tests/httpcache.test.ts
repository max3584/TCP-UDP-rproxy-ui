// L7 の応答のキャッシュ（rproxy-api #340、docs/API.md「応答のキャッシュ」）：
// 設定とルートの置き場所の検証（rproxy の cache.rs・check_cache_route と同じ規則）、features での出し分け、詳細画面の数
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpRules, MIDDLEWARE_KINDS, MIDDLEWARE_TEMPLATES, cleanHttp, toHttpRules, validateHttp } from '@/components/httpspec';
import HttpEditor from '@/components/HttpEditor';
import HttpSummary from '@/components/HttpSummary';
import { cacheCountsLabel, cacheHitPercent, httpRouteRows, sumStats } from '@/components/dashboard';
import type { HttpStats, RuleStats } from '@/components/lib';

// docs/API.md の例
const example = (cache: Record<string, unknown> = { ttl: '1s' }, routeMws: string[] = ['gzip', 'micro'], extra: Record<string, Record<string, Record<string, unknown>>> = {}): HttpRules => toHttpRules({
  routes: [{ name: 'state', match: 'Host(`api.example.com`) && Path(`/state.json`)', service: 'app', middlewares: routeMws }],
  services: { app: { servers: [{ url: 'http://10.0.0.20:80' }] } },
  middlewares: { gzip: { compress: {} }, micro: { cache }, ...extra },
});

const errorsOf = (spec: HttpRules) => validateHttp(spec).join(' ');

describe('cache settings are checked as rproxy does', () => {
  it('accepts the documented example and the template', () => {
    const full = { ttl: '1s', stale_on_error: '30s', max_body: 1048576, max_entries: 1024, max_memory: 67108864, vary: ['Accept-Language'], status: [200], header: 'X-Cache' };
    expect(validateHttp(example(full))).toEqual([]);
    expect(validateHttp(example(MIDDLEWARE_TEMPLATES.cache))).toEqual([]);
    expect(validateHttp(example({ ttl: '100ms', header: '', status: [200, 404, 410] }))).toEqual([]);
    expect(validateHttp(example({ ttl: '24h', stale_on_error: '24h', max_body: 67108864 }))).toEqual([]);
    expect(MIDDLEWARE_KINDS.cache).toBe('応答のキャッシュ');
  });

  it('needs ttl from 100ms to 24h and stale_on_error up to 24h', () => {
    expect(errorsOf(example({}))).toContain('持つ時間（ttl）を書いてください');
    expect(errorsOf(example({ ttl: '99ms' }))).toContain('100ms〜24h にしてください');
    expect(errorsOf(example({ ttl: '25h' }))).toContain('100ms〜24h にしてください');
    expect(errorsOf(example({ ttl: '1 s' }))).toContain('数と単位');
    expect(errorsOf(example({ ttl: '1s', stale_on_error: '2d' }))).toContain('stale_on_error');
    expect(errorsOf(example({ ttl: '1s', stale_on_error: '25h' }))).toContain('24h までに');
  });

  it('checks the limits, vary, status and header', () => {
    expect(errorsOf(example({ ttl: '1s', max_body: 0 }))).toContain('max_body');
    expect(errorsOf(example({ ttl: '1s', max_body: 67108865 }))).toContain('64 MiB');
    expect(errorsOf(example({ ttl: '1s', max_entries: 0 }))).toContain('max_entries');
    expect(errorsOf(example({ ttl: '1s', max_entries: 1.5 }))).toContain('max_entries');
    expect(errorsOf(example({ ttl: '1s', max_body: 2048, max_memory: 1024 }))).toContain('max_body）以上');
    expect(errorsOf(example({ ttl: '1s', max_memory: 17179869185 }))).toContain('16 GiB');
    expect(errorsOf(example({ ttl: '1s', vary: ['Accept Language'] }))).toContain('ヘッダの名前');
    expect(errorsOf(example({ ttl: '1s', status: [200, 302] }))).toContain('状態コード「302」は持てません');
    expect(errorsOf(example({ ttl: '1s', header: 'X Cache' }))).toContain('header');
    for (const h of ['Connection', 'content-length', 'Transfer-Encoding', 'Age', 'VARY', 'Set-Cookie', 'ETag', 'Cache-Control', 'Date', 'Host', 'TE']) {
      expect(errorsOf(example({ ttl: '1s', header: h }))).toContain(`ヘッダ「${h}」は、HTTP の接続・本文の形やキャッシュに使うヘッダなので使えません`);
    }
    expect(validateHttp(example({ ttl: '1s', header: 'X-Edge-Cache' }))).toEqual([]);
    expect(errorsOf(example({ ttl: '1s', share_after_auth: 'yes' }))).toContain('true か false');
    expect(errorsOf(example({ ttl: '1s', max_age: 5 }))).toContain('「max_age」は cache の項目ではありません');
  });
});

describe('where cache sits in a route', () => {
  const auth = {
    allow: { ip_allow: { source_range: ['10.0.0.0/8'] } },
    basic: { basic_auth: { users_file: '/etc/rproxy/htpasswd' } },
    sso: { oidc: { issuer: 'https://id.example.com/realms/a', client_id: 'a', client_secret_file: '/s', scopes: ['openid'], cookie_secret_file: '/c' } },
    other: { cache: { ttl: '5s' } },
  };

  it('refuses gates after the cache', () => {
    const e = errorsOf(example({ ttl: '1s' }, ['micro', 'allow'], auth));
    expect(e).toContain('「allow」（ip_allow）が cache「micro」より後ろにあります');
    expect(e).toContain('cache より前に置いてください');
    expect(validateHttp(example({ ttl: '1s' }, ['allow', 'micro'], auth))).toEqual([]);
  });

  it('needs share_after_auth after sign-in, and share_credentials after oidc', () => {
    expect(errorsOf(example({ ttl: '1s' }, ['basic', 'micro'], auth))).toContain('share_after_auth');
    expect(validateHttp(example({ ttl: '1s', share_after_auth: true }, ['basic', 'micro'], auth))).toEqual([]);
    const oidc = errorsOf(example({ ttl: '1s', share_after_auth: true }, ['sso', 'micro'], auth));
    expect(oidc).toContain('share_credentials');
    expect(oidc).toContain('必ず有効にしてください');
    expect(oidc).not.toContain('share_after_auth）を有効');
    expect(validateHttp(example({ ttl: '1s', share_after_auth: true, share_credentials: true }, ['sso', 'micro'], auth))).toEqual([]);
  });

  it('takes one cache per route and none per server', () => {
    expect(errorsOf(example({ ttl: '1s' }, ['micro', 'other'], auth))).toContain('2 つ以上');
    const perServer = example();
    perServer.services!.app.servers[0].middlewares = ['micro'];
    expect(errorsOf(perServer)).toContain('転送先ごとには使えない種類');
  });

  it('refuses forward_auth on the servers of the route\'s service (rproxy check_cache_route)', () => {
    const spec = example({ ttl: '1s' }, ['micro'], { fa: { forward_auth: { address: 'http://10.0.0.30/auth' } } });
    spec.services!.app.servers[0].middlewares = ['fa'];
    const e = errorsOf(spec);
    expect(e).toContain('サービスの転送先が forward_auth の「fa」を使っています');
    expect(e).toContain('cache「micro」と一緒には使えません');
    // a route without cache is not refused for it
    const noCache = example({ ttl: '1s' }, ['gzip'], { fa: { forward_auth: { address: 'http://10.0.0.30/auth' } } });
    noCache.services!.app.servers[0].middlewares = ['fa'];
    expect(errorsOf(noCache)).not.toContain('サービスの転送先が forward_auth');
  });

  it('refuses the kind when rproxy does not list it', () => {
    expect(validateHttp(example(), ['compress']).join(' ')).toContain('種類「cache」は、この rproxy ではまだ使えません');
    expect(validateHttp(example(), ['compress', 'cache'])).toEqual([]);
  });
});

describe('HttpEditor: cache is edited only when features.middlewares lists it', () => {
  const render = (value: HttpRules, middlewares: readonly string[] | null) => renderToStaticMarkup(createElement(HttpEditor, {
    value, onChange: () => undefined, http3: false, httpOptions: null, serviceOptions: null, middlewares,
  }));
  const spec = example({ ttl: '1s', stale_on_error: '30s', vary: ['Accept-Language'], status: [200, 404], header: '', share_after_auth: true });

  it('shows the fields', () => {
    const html = render(spec, ['compress', 'cache']);
    expect(html).toContain('data-testid="cache-config"');
    expect(html).toMatch(/id="http-mw-1-ttl"[^>]*value="1s"/);
    expect(html).toMatch(/id="http-mw-1-stale_on_error"[^>]*value="30s"/);
    expect(html).toMatch(/id="http-mw-1-vary"[^>]*value="Accept-Language"/);
    expect(html).toMatch(/id="http-mw-1-share_after_auth"[^>]*checked=""/);
    expect(html).toMatch(/id="http-mw-1-status-404"[^>]*checked=""/);
    expect(html).not.toMatch(/id="http-mw-1-status-410"[^>]*checked=""/);
    expect(html).toMatch(/id="http-mw-1-no-header"[^>]*checked=""/);
    expect(html).toContain('<option value="cache">');
    expect(html).not.toContain('data-testid="http-preserved"');
  });

  it('keeps the values read-only without cache in features, and does not offer it', () => {
    for (const mws of [['compress'], null]) {
      const html = render(spec, mws);
      expect(html).not.toContain('data-testid="cache-config"');
      expect(html).toContain('data-testid="http-preserved"');
      expect(html).toContain('&quot;ttl&quot;:&quot;1s&quot;');
      expect(html).not.toContain('<option value="cache">');
    }
  });

  it('says the default 200 applies when every status is cleared, and keeps values outside the list', () => {
    const cleared = render(example({ ttl: '1s', status: [] }), ['compress', 'cache']);
    expect(cleared).toContain('data-testid="cache-status-default"');
    expect(cleared).not.toMatch(/id="http-mw-1-status-200"[^>]*checked=""/);
    const omitted = render(example({ ttl: '1s' }), ['compress', 'cache']);
    expect(omitted).toMatch(/id="http-mw-1-status-200"[^>]*checked=""/);
    expect(omitted).not.toContain('data-testid="cache-status-default"');
    const extra = render(example({ ttl: '1s', status: [404, 500] }), ['compress', 'cache']);
    expect(extra).toContain('data-testid="cache-status-extra"');
    expect(extra).toContain('一覧にない状態コード 500');
    expect(extra).toMatch(/id="http-mw-1-status-404"[^>]*checked=""/);
    expect(validateHttp(example({ ttl: '1s', status: [] }))).toEqual([]);
  });

  it('says saving is blocked while an unavailable cache stays', () => {
    expect(render(spec, ['compress'])).toContain('このミドルウェアがある間は保存できません');
  });

  it('shows the user limits to users', () => {
    const user = renderToStaticMarkup(createElement(HttpEditor, { value: spec, onChange: () => undefined, http3: false, httpOptions: null, serviceOptions: null, middlewares: ['compress', 'cache'], filesLocked: true }));
    expect(user).toContain('data-testid="cache-user-note"');
    expect(user).toContain('RPROXY_UI_USER_CACHE_MAX_MEMORY');
    expect(render(spec, ['compress', 'cache'])).not.toContain('data-testid="cache-user-note"');
  });

  it('sends the settings as they are', () => {
    expect(cleanHttp(spec).middlewares).toEqual(spec.middlewares);
  });

  it('shows the settings in the rule detail', () => {
    const html = renderToStaticMarkup(createElement(HttpSummary, { http: cleanHttp(spec) }));
    expect(html).toContain('応答のキャッシュ');
    expect(html).toContain('ttl: 1s');
  });
});

describe('stats.http.cache', () => {
  const http: HttpStats = {
    requests: 10,
    by_status: { '2xx': 10 },
    cache: { hit: 6, miss: 2, stale: 1, bypass: 1 },
    routes: {
      state: { requests: 10, by_status: { '2xx': 10 }, cache: { micro: { hit: 6, miss: 2, stale: 1, bypass: 1 } } },
      other: { requests: 0, by_status: {} },
    },
  };

  it('labels the counts and the share answered from memory', () => {
    expect(cacheCountsLabel(http.cache!)).toBe('ヒット 6 / ミス 2 / 古い値 1 / 対象外 1');
    expect(cacheHitPercent(http.cache!)).toBe(77.8);
    expect(cacheHitPercent({ hit: 0, miss: 0, stale: 0, bypass: 3 })).toBeNull();
  });

  it('keeps the counts per route and middleware', () => {
    const rows = httpRouteRows(http);
    expect(rows[0].cacheBy).toEqual({ micro: { hit: 6, miss: 2, stale: 1, bypass: 1 } });
    expect(rows[1].cacheBy).toEqual({});
  });

  it('sums the counts of the nodes of a group', () => {
    const stats = (h: HttpStats): RuleStats => ({ total_connections: 1, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, http: h } as RuleStats);
    const sum = sumStats([stats(http), stats(http)]);
    expect(sum?.http?.cache).toEqual({ hit: 12, miss: 4, stale: 2, bypass: 2 });
    expect(sum?.http?.routes.state.cache).toEqual({ micro: { hit: 12, miss: 4, stale: 2, bypass: 2 } });
  });
});
