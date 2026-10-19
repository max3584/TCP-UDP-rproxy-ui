// rproxy-api v0.4.7 の tls.routes[].upstream（名前ごとの転送先への TLS。rproxy-gateway が BackendTLSPolicy から作る、features.tls_route_upstream）。
// 形の検証（rproxy の src/tls/config.rs の validate と同じ規則）と、DB / rproxy / エクスポート / rproxy の応答 / ずれ / 履歴 / フォームで落とさないこと
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForwardRule, TlsSpec } from '@/components/lib';
import { checkTls, normalizeTls, optionsJson, parseOptions, TlsError } from '@/components/tls';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule } from '@/components/settingsdoc';
import { toRproxyPatch } from '@/components/ruledb';
import { ruleFromStatus } from '@/components/dashboard';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import { V04_FEATURES } from '@/components/system';
import type { RproxyRuleStatus } from '@/components/rproxy';
import RuleForm, {
  buildRouteSpec, routeRow, routeRowTakesUpstream, routeUpstreamChoice, withRouteUpstreamChoice,
} from '@/components/RuleForm';
import type { RouteContext } from '@/components/RuleForm';
import { upstreamSummary } from '@/components/UpstreamFields';

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (err) {
    return err instanceof TlsError ? err.code : 'other';
  }
};

const BACKEND_TLS = { tls: true, server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem' };
const MTLS = { tls: true, ca_file: '/etc/rproxy/ca.pem', cert_file: '/etc/rproxy/up.pem', chain_file: '/etc/rproxy/up-chain.pem', key_file: '/etc/rproxy/up.key' };

// rproxy-gateway が TLSRoute の終端と BackendTLSPolicy から作る形（docs/API.md「Gateway API 向けの L7・TLS」）
const terminateTls = (routes: Record<string, unknown>[]) => ({
  mode: 'terminate',
  certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }],
  routes: routes,
  upstream: { tls: true },
});
const ROUTES = [
  { server_name: 'backend.example.com', remote_addr: '10.0.0.5', remote_port: 8443, upstream: BACKEND_TLS },
  // {} はこの名前だけ平文（ルールの upstream を使わない）。省略はルールの upstream
  { server_name: 'plain.example.com', remote_addr: '10.0.0.6', remote_port: 8080, upstream: {} },
  { server_names: ['mtls.example.com', '*.mtls.example.com'], remote_addr: '10.0.0.7', remote_port: 443, upstream: MTLS },
  { server_name: 'inherit.example.com', remote_addr: '10.0.0.8', remote_port: 443 },
];

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.9', distPort: 443,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false,
  targets: [], balance: 'round_robin', healthCheck: null,
};
const tls = normalizeTls(terminateTls(ROUTES));
const rule: ForwardRule = { ...base, tls: tls };

describe('normalizeTls：tls.routes[].upstream を残す', () => {
  it('既定値を省き、{} は残し、省略なら付けない（キーは rproxy の応答の順）', () => {
    expect(tls.routes?.[0]).toEqual({ server_name: 'backend.example.com', remote_addr: '10.0.0.5', remote_port: 8443, upstream: BACKEND_TLS });
    expect(tls.routes?.[1].upstream).toEqual({});
    expect(tls.routes?.[2].upstream).toEqual(MTLS);
    expect('upstream' in tls.routes![3]).toBe(false);
    // rproxy の応答の形（null・false を書く）も同じ形になる
    const fromRproxy = normalizeTls(terminateTls([{
      server_name: 'a.example.com', remote_addr: '10.0.0.5', remote_port: 443, source_ip: null,
      upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null },
    }]));
    expect(fromRproxy.routes?.[0].upstream).toEqual({});
    // upstream は passthrough・targets・balance の後、source_ip の前
    const keys = Object.keys(normalizeTls({ mode: 'sni', routes: [{ server_name: 'a.example.com', targets: [{ addr: '10.0.0.1', port: 443 }], balance: 'failover', upstream: { tls: true }, source_ip: 'proxy_v2' }] }).routes![0]);
    expect(keys).toEqual(['server_name', 'targets', 'balance', 'upstream', 'source_ip']);
  });

  it('知らない項目と形の誤りは invalid', () => {
    expect(code(() => normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { tls: true, subject_alt_names: ['x'] } }])))).toBe('invalid');
    expect(code(() => normalizeTls(terminateTls([{ ...ROUTES[0], upstream: 'tls' }])))).toBe('invalid');
    expect(code(() => normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { tls: 'yes' } }])))).toBe('invalid');
    expect(code(() => normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { ca_file: 3 } }])))).toBe('invalid');
  });
});

describe('checkTls：rproxy の validate と同じ規則（どれも tls_config）', () => {
  it('tcp の terminate の、終端する route だけ', () => {
    expect(code(() => checkTls('tcp', tls, null, 1))).toBeNull();
    // passthrough の route
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], passthrough: true }])), null, 1))).toBe('tls_config');
    // sni のルール
    expect(code(() => checkTls('tcp', normalizeTls({ mode: 'sni', routes: [ROUTES[0]] }), null, 1))).toBe('tls_config');
    // udp（DTLS の終端・sni）
    expect(code(() => checkTls('udp', normalizeTls({ ...terminateTls([ROUTES[1]]), upstream: undefined }), null, 1))).toBe('tls_config');
    expect(code(() => checkTls('udp', normalizeTls({ mode: 'sni', routes: [ROUTES[1]] }), null, 1))).toBe('tls_config');
    // L7 のルールの route は passthrough だけで、そこには書けない
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], passthrough: true }])), null, 1, true))).toBe('tls_config');
  });

  it('cert_file と key_file は組で、chain_file は cert_file と一緒に（tls: false でも）', () => {
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { tls: true, cert_file: '/u.pem' } }])), null, 1))).toBe('tls_config');
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { key_file: '/u.key' } }])), null, 1))).toBe('tls_config');
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { tls: true, chain_file: '/c.pem' } }])), null, 1))).toBe('tls_config');
    // insecure_skip_verify・server_name だけ、平文に server_name が残っているのはよい（rproxy も断らない）
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { tls: true, insecure_skip_verify: true } }])), null, 1))).toBeNull();
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([{ ...ROUTES[0], upstream: { server_name: 'x.internal' } }])), null, 1))).toBeNull();
  });
});

describe('保存・送信・エクスポートで落とさない', () => {
  it('DB の options に書いて読み直すと同じ', () => {
    const json = optionsJson(rule.tls, null, true);
    expect(parseOptions(json).tls).toEqual(rule.tls);
    // mariadb ドライバがオブジェクトで返しても同じ
    expect(parseOptions(JSON.parse(json!)).tls).toEqual(rule.tls);
  });

  it('rproxy への POST と PATCH に付ける', () => {
    expect(toRproxyRule(rule).tls).toEqual(tls);
    expect((toRproxyPatch(rule).tls as TlsSpec).routes).toEqual(tls.routes);
  });

  it('エクスポートして読み込むと同じ値が本文に戻る（rproxy の設定ファイルの形も読む）', () => {
    const body = settingsRuleToBody(parseDoc(JSON.stringify(exportDoc([rule]))).rules[0]);
    expect(normalizeTls(body.tls)).toEqual(tls);
    const yaml = [
      'version: 1',
      'rules:',
      '  - protocol: tcp',
      '    listen_addr: 0.0.0.0',
      '    listen_port: 443',
      '    remote_addr: 10.0.0.9',
      '    remote_port: 443',
      '    tls:',
      '      mode: terminate',
      '      certificates: [{cert_file: /c.pem, key_file: /k.pem}]',
      '      routes:',
      '        - {server_name: backend.example.com, remote_addr: 10.0.0.5, remote_port: 8443, upstream: {tls: true, server_name: backend.internal}}',
      '        - {server_name: plain.example.com, remote_addr: 10.0.0.6, remote_port: 8080, upstream: {}}',
    ].join('\n');
    const fromFile = normalizeTls(settingsRuleToBody(parseDoc(yaml).rules[0]).tls);
    expect(fromFile.routes?.map((r) => r.upstream)).toEqual([{ tls: true, server_name: 'backend.internal' }, {}]);
  });

  it('rproxy の応答から画面の形にしても残り（生の値に落ちない）、比べてもずれにならない', () => {
    const live = {
      ...toRproxyRule(rule), state: 'running', error: null, connections: 0, resolved: [],
      // rproxy は Upstream の項目を null / false でも書く
      tls: {
        ...tls, unmatched: 'default', alpn: [], client_auth: { mode: 'none', ca_file: null },
        upstream: { tls: true, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null },
        routes: tls.routes!.map((r) => (r.upstream === undefined ? r : {
          ...r, upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null, ...r.upstream },
        })),
      },
    } as unknown as RproxyRuleStatus;
    expect(ruleFromStatus(live, 0).tls).toEqual(tls);
    expect(ruleDrift(rule, live)).toEqual([]);
  });

  it('{} と省略の違い、項目の違いはずれになる', () => {
    const withoutPlain: ForwardRule = { ...rule, tls: { ...tls, routes: tls.routes!.map((r, i) => (i === 1 ? { ...r, upstream: undefined } : r)) } };
    const live = { ...toRproxyRule(rule), state: 'running', error: null, connections: 0, resolved: [] } as unknown as RproxyRuleStatus;
    expect(ruleDrift(withoutPlain, live)).toEqual(['tls']);
    const otherCa: ForwardRule = { ...rule, tls: { ...tls, routes: tls.routes!.map((r, i) => (i === 0 ? { ...r, upstream: { ...BACKEND_TLS, ca_file: '/other.pem' } } : r)) } };
    expect(ruleDrift(otherCa, live)).toEqual(['tls']);
  });

  it('履歴の差分に出す', () => {
    const before: ForwardRule = { ...rule, tls: { ...tls, routes: tls.routes!.map((r) => ({ ...r, upstream: undefined })) } };
    expect(ruleChanges(before, rule)).toContain('TLS の設定を変更');
  });

  it('/system の機能の一覧に features.tls_route_upstream', () => {
    expect(V04_FEATURES.map((f) => f.key)).toContain('tls_route_upstream');
  });
});

describe('RuleForm：route ごとの転送先への TLS', () => {
  const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
    protocol: 'tcp', tlsMode: 'terminate', l7: false, routeSourceIpEditable: true, routeUpstreamEditable: true, ...over,
  });
  const rebuild = (c: RouteContext) => normalizeTls({ ...terminateTls(tls.routes!.map((r) => buildRouteSpec(routeRow(r), c))), upstream: tls.upstream });

  it('行に直して組み立て直すと upstream が残る（編集できるときも、読み取り専用のときも）', () => {
    expect(rebuild(ctx())).toEqual(tls);
    expect(rebuild(ctx({ routeUpstreamEditable: false }))).toEqual(tls);
  });

  it('選び方：ルールと同じ（外す）・平文（欄は残す）・TLS', () => {
    const row = routeRow(tls.routes![0]);
    expect(routeUpstreamChoice(row.upstream)).toBe('tls');
    expect(routeUpstreamChoice(routeRow(tls.routes![1]).upstream)).toBe('plain');
    expect(routeUpstreamChoice(routeRow(tls.routes![3]).upstream)).toBe('inherit');
    expect(withRouteUpstreamChoice(row.upstream, 'inherit')).toBeNull();
    const plain = withRouteUpstreamChoice(row.upstream, 'plain');
    expect(plain).toMatchObject({ tls: false, server_name: 'backend.internal' });
    expect(normalizeTls(terminateTls([buildRouteSpec({ ...row, upstream: plain }, ctx())])).routes?.[0].upstream)
      .toEqual({ server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem' });
    expect(withRouteUpstreamChoice(null, 'tls')).toEqual({
      tls: true, server_name: '', ca_file: '', insecure_skip_verify: false, cert_file: '', chain_file: '', key_file: '',
    });
    // 空の欄は省く（{ tls: true } だけ）
    expect(normalizeTls(terminateTls([buildRouteSpec({ ...row, upstream: withRouteUpstreamChoice(null, 'tls') }, ctx())])).routes?.[0].upstream).toEqual({ tls: true });
  });

  it('書けない route（passthrough・sni・udp・L7）では、編集できるときだけ外す', () => {
    const row = routeRow(tls.routes![0]);
    expect(routeRowTakesUpstream(row, ctx())).toBe(true);
    for (const c of [ctx({ tlsMode: 'sni' }), ctx({ protocol: 'udp' }), ctx({ l7: true })]) {
      expect(routeRowTakesUpstream(row, c)).toBe(false);
      expect(buildRouteSpec(row, c).upstream).toBeUndefined();
    }
    expect(buildRouteSpec({ ...row, passthrough: true }, ctx()).upstream).toBeUndefined();
    // rproxy が features.tls_route_upstream を返さない：読んだ値は消さずに送る（書けない route なら checkTls が断る）
    const kept = buildRouteSpec({ ...row, passthrough: true }, ctx({ routeUpstreamEditable: false }));
    expect(kept.upstream).toEqual({ tls: true, server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem', insecure_skip_verify: false, cert_file: '', chain_file: '', key_file: '' });
    expect(code(() => checkTls('tcp', normalizeTls(terminateTls([kept])), null, 1))).toBe('tls_config');
  });

  it('rproxy が機能を返さないときは、route の upstream を読み取り専用で出す', () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: rule }));
    expect(html.match(/data-testid="route-upstream-preserved"/g)).toHaveLength(3);
    expect(html).toContain(upstreamSummary(BACKEND_TLS));
    expect(html).toContain('tls: false');
    // 編集の欄は出さない（ルールの upstream の欄は出す）
    expect(html).not.toContain('data-testid="route-upstream"');
    expect(html).not.toContain('rule-route-1-upstream');
    expect(html).toContain('id="rule-upstream-name"');
  });
});
