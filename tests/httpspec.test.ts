import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HttpRules,
  buildMatch,
  checkMatch,
  cleanHttp,
  emptyHttp,
  redirectHttp,
  toHttpRules,
  validateHttp,
} from '@/components/httpspec';
import HttpEditor from '@/components/HttpEditor';
import HttpSummary from '@/components/HttpSummary';
import RuleForm from '@/components/RuleForm';
import { PROFILES } from '@/components/profiles';
import type { ForwardRule } from '@/components/lib';

// rproxy-api の docs/DESIGN-v0.3.md 7. の gitlab・cdn の設定（Traefik からの書き直し）
const gitlab: HttpRules = {
  routes: [
    { name: 'gitlab-login', match: 'Host(`gitlab.example.com`) && Method(`POST`) && Path(`/users/sign_in`)', service: 'gitlab', middlewares: ['crowdsec', 'rate-limit-login'] },
    { name: 'gitlab-assets', match: 'Host(`gitlab.example.com`) && (PathPrefix(`/assets/`) || PathPrefix(`/uploads/`))', service: 'gitlab' },
    { name: 'gitlab-internal', match: 'Host(`gitlab.example.com`) && ClientIP(`10.0.0.0/8`)', service: 'gitlab' },
    { name: 'cdn-block', match: 'Host(`cdn.example.com`) && !PathPrefix(`/file/`)', middlewares: ['forbidden'] },
  ],
  services: { gitlab: { servers: [{ url: 'http://10.0.0.20:80' }] } },
  middlewares: {
    crowdsec: { crowdsec: { appsec: true } },
    'rate-limit-login': { rate_limit: { average: 5, period: '1m', burst: 10 } },
    forbidden: { respond: { status: 403 } },
  },
};

describe('match expressions', () => {
  it('accepts what rproxy accepts', () => {
    for (const r of gitlab.routes) expect([r.match, checkMatch(r.match)]).toEqual([r.match, null]);
    expect(checkMatch('Header(`X-Env`, "prod") || Query(`debug`)')).toBeNull();
    expect(checkMatch('!(Method(`GET`, `HEAD`))')).toBeNull();
  });

  it('explains mistakes in Japanese', () => {
    expect(checkMatch('')).toContain('入力して');
    expect(checkMatch('Hots(`a`)')).toContain('知らない条件 Hots');
    expect(checkMatch('Host(a)')).toContain('`...` で囲んで');
    expect(checkMatch('Host(`a`) & Path(`/`)')).toContain('&& と書いて');
    expect(checkMatch('Header(`X`)')).toContain('引数は 2 個');
    expect(checkMatch('PathPrefix(`api`)')).toContain('/ で始めて');
    expect(checkMatch('(Host(`a`)')).toContain(') が足りません');
    expect(checkMatch('Host(`a`) Path(`/`)')).toContain('余分');
    expect(checkMatch('Host(`a')).toContain('閉じていません');
  });

  it('builds an expression from the helper fields', () => {
    expect(buildMatch({ hosts: ['a.example', ' b.example '], pathPrefixes: ['/api/'], methods: [], clientIps: [''] }))
      .toBe('Host(`a.example`, `b.example`) && PathPrefix(`/api/`)');
    expect(buildMatch({ hosts: [], pathPrefixes: [], methods: [], clientIps: [] })).toBe('');
    expect(checkMatch(buildMatch({ hosts: ['x'], pathPrefixes: ['/'], methods: ['GET'], clientIps: ['10.0.0.0/8'] }))).toBeNull();
  });
});

describe('validateHttp', () => {
  it('accepts the gitlab / cdn settings and the templates', () => {
    expect(validateHttp(gitlab)).toEqual([]);
    expect(validateHttp(emptyHttp())).toEqual([]);
    expect(validateHttp(redirectHttp())).toEqual([]);
  });

  it('finds broken references, duplicates and unusable kinds', () => {
    const broken: HttpRules = {
      routes: [
        { name: 'a', match: 'PathPrefix(`/`)', service: 'missing' },
        { name: 'a', match: 'Hots(`x`)', to: 'ftp://x' },
        { name: 'b', match: 'PathPrefix(`/`)', middlewares: ['crowdsec'] },
        { name: '', match: 'PathPrefix(`/`)', service: 's', to: 'http://x' },
      ],
      services: { s: { servers: [] } },
      middlewares: { crowdsec: { crowdsec: {} }, two: { respond: { status: 403 }, ip_allow: { source_range: [] } } },
      default: { status: 999, service: 'nope' },
    };
    const errors = validateHttp(broken, ['crowdsec']).join('\n');
    for (const want of [
      'サービス「missing」がありません', '名前「a」が重複', 'match: 知らない条件', 'http:// か https://',
      'リダイレクト・固定の応答のミドルウェア', '4 番目のルートに名前','service と to のどちらか', '転送先（servers）がありません',
      '種類を 1 つだけ', '100〜599', 'サービス「nope」',
    ]) {
      expect(errors).toContain(want);
    }
    expect(validateHttp({ routes: [], middlewares: { r: { rate_limit: { average: 1 } } } }, ['crowdsec']).join()).toContain('この rproxy ではまだ使えません');
  });
});

describe('cleanHttp / toHttpRules', () => {
  it('drops empty and default fields and round-trips', () => {
    const cleaned = cleanHttp({
      routes: [{ name: ' a ', match: ' PathPrefix(`/`) ', service: 's', priority: undefined, middlewares: [] }],
      services: { s: { servers: [{ url: 'http://x', weight: 1 }, { url: 'http://y', weight: 3 }], pass_host_header: true, timeouts: { connect: '', response: '30s' }, health_check: { path: '' } } },
      middlewares: {},
      default: { status: 404 },
    });
    expect(cleaned).toEqual({
      routes: [{ name: 'a', match: 'PathPrefix(`/`)', service: 's' }],
      services: { s: { servers: [{ url: 'http://x' }, { url: 'http://y', weight: 3 }], timeouts: { response: '30s' } } },
    });
    expect(cleanHttp(toHttpRules(gitlab as never))).toEqual(gitlab);
    expect(toHttpRules(null).routes).toEqual([]);
  });
});

describe('HttpEditor and the L7 parts of RuleForm', () => {
  const httpRule: ForwardRule = {
    protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '', distPort: 0, sourceIp: 'proxy', udpIdleSecs: 30,
    tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }] },
    starttls: null, starttlsRequired: true, allowFrom: [], http: cleanHttp(gitlab), crowdsec: true,
  };

  it('shows routes in order with their middlewares, services and typed middleware forms', () => {
    const html = renderToStaticMarkup(createElement(HttpEditor, {
      value: gitlab, onChange: () => undefined, middlewares: ['crowdsec', 'rate_limit', 'respond'], serviceOptions: [], http3: false,
    }));
    expect(html.match(/data-testid="http-route"/g)).toHaveLength(4);
    expect(html.match(/data-testid="http-service"/g)).toHaveLength(1);
    expect(html.match(/data-testid="http-middleware"/g)).toHaveLength(3);
    expect(html.indexOf('gitlab-login')).toBeLessThan(html.indexOf('cdn-block'));
    expect(html).toContain('1. crowdsec');
    expect(html).toContain('2. rate-limit-login');
    // rate_limit は種類ごとの欄、サービスの項目は features.services にないので出さない
    expect(html).toMatch(/id="http-mw-1-average"[^>]*value="5"/);
    expect(html).not.toContain('ヘルスチェックのパス');
    expect(html).not.toContain('HTTP/3');
    // 選べる種類は features.middlewares だけ
    expect(html).not.toContain('（headers）');
  });

  it('labels every input of the L7 tab and keeps the settings of an http rule', () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: httpRule }));
    const ids = Array.from(html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)).map((m) => m[1]);
    expect(ids).toContain('http-route-0-match');
    for (const id of ids) expect(html).toContain(`for="${id}"`);
    // 編集では L4 / L7 を切り替えられない。CrowdSec（L4）は保存された値
    expect(html).toMatch(/<input[^>]*id="rule-crowdsec"[^>]*checked=""/);
    expect(html).not.toContain('id="rule-dist-addr"');
  });

  it('summarizes the L7 settings read-only in the order rproxy tries the routes', () => {
    const html = renderToStaticMarkup(createElement(HttpSummary, { http: cleanHttp({
      ...gitlab,
      routes: [...gitlab.routes, { name: 'forced', match: 'Path(`/x`)', priority: 1000, to: 'http://10.0.0.9:80' }],
    }) }));
    expect(html).toContain('data-testid="http-summary"');
    // 優先度の指定がなければ match の長さ（Traefik と同じ）
    const order = ['forced', 'gitlab-assets', 'gitlab-login', 'gitlab-internal', 'cdn-block'].map((n) => html.indexOf(`>${n}<`));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(html).toContain('crowdsec → rate-limit-login');
    expect(html).toContain('ミドルウェアが応答');
    expect(html).toContain('404 を返す');
    expect(html).toContain('レート制限');
  });

  it('offers L7 profiles for HTTPS and the port 80 redirect', () => {
    const l7 = PROFILES.filter((p) => p.l7 !== undefined).map((p) => [p.id, p.srcPort, p.tlsMode, p.l7]);
    expect(l7).toEqual([['https-l7', 443, 'terminate', 'proxy'], ['http-redirect', 80, 'passthrough', 'redirect']]);
  });
});
