// #187：L7（http）のルールの tls.upstream（https:// の転送先への検証とクライアント証明書。tls: true なし）。
// rproxy-api の docs/API.md「http のルール」：tls.upstream.tls は使わず（指定すると tls_config）、ca_file・server_name・insecure_skip_verify・
// cert_file・chain_file・key_file は https:// の転送先に使う。サービスに tls（#236）があれば、そのサービスではその代わりに使う。
// 以前の UI は tls.upstream.tls が true のときだけ upstream を扱い、詳細は「平文」、変更の画面でそのまま保存すると消えた
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForwardRule, ForwardRules, TlsSpec } from '@/components/lib';
import { checkTls, normalizeTls, optionsJson, parseOptions, TlsError } from '@/components/tls';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule } from '@/components/settingsdoc';
import { toRproxyPatch } from '@/components/ruledb';
import { ruleFromStatus } from '@/components/dashboard';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import type { RproxyRuleStatus } from '@/components/rproxy';
import RuleForm from '@/components/RuleForm';
import {
  EMPTY_UPSTREAM_FORM, ruleUpstreamSpec, servicesWithOwnTls, toUpstreamForm, upstreamHasSettings,
} from '@/components/UpstreamFields';
import { toHttpRules } from '@/components/httpspec';
import { TlsSection } from '@/pages/rules/[protocol]/[listenAddr]/[listenPort]/index';

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (err) {
    return err instanceof TlsError ? err.code : 'other';
  }
};

// issue #187 の例（転送先への mTLS。tls: true なし）
const UPSTREAM = {
  server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem',
  cert_file: '/etc/rproxy/backend-client.pem', chain_file: '/etc/rproxy/backend-chain.pem', key_file: '/etc/rproxy/backend-client.key',
};
const HTTP = {
  routes: [{ name: 'app', match: 'PathPrefix(`/`)', service: 'app' }],
  services: { app: { servers: [{ url: 'https://backend.internal' }] } },
};
const tls: TlsSpec = normalizeTls({
  mode: 'terminate',
  certificates: [{ cert_file: '/etc/rproxy/site.pem', key_file: '/etc/rproxy/site.key' }],
  upstream: UPSTREAM,
});
const rule: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '', distPort: 0,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: tls, starttls: null, starttlsRequired: true, allowFrom: [], http: HTTP, crowdsec: false,
  targets: [], balance: 'round_robin', healthCheck: null,
};
const live = (r: ForwardRule): ForwardRules => ({
  ...r, id: 1, origin: 'dynamic', state: 'running', error: null, connections: 0, stats: null, startedAt: null, resolved: [],
});

describe('normalizeTls・checkTls：L7 のルールの tls.upstream', () => {
  it('tls なしの項目を残し、L7 では受け付ける（rproxy と同じ）', () => {
    expect(tls.upstream).toEqual(UPSTREAM);
    expect(code(() => checkTls('tcp', tls, null, 1, true))).toBeNull();
  });

  it('L7 では tls.upstream.tls を tls_config で断る（rproxy の check_http_tls）。L4 の終端では今までどおり使える', () => {
    const reencrypt = normalizeTls({ ...tls, upstream: { tls: true, ...UPSTREAM } });
    expect(code(() => checkTls('tcp', reencrypt, null, 1, true))).toBe('tls_config');
    expect(code(() => checkTls('tcp', reencrypt, null, 1, false))).toBeNull();
    // 終端しない L7（平文の HTTP）では upstream は使えない（rproxy も tls_config）
    expect(code(() => checkTls('tcp', normalizeTls({ mode: 'passthrough', upstream: UPSTREAM }), null, 1, true))).toBe('tls_config');
  });
});

describe('保存・送信・エクスポート・ずれ・履歴で落とさず、変えない', () => {
  it('DB の options に書いて読み直すと同じ', () => {
    const json = optionsJson(rule.tls, null, true);
    expect(parseOptions(json).tls).toEqual(tls);
    expect(parseOptions(JSON.parse(json!)).tls).toEqual(tls);
  });

  it('rproxy への POST と PATCH に tls なしで付ける', () => {
    expect(toRproxyRule(rule).tls).toEqual(tls);
    expect((toRproxyPatch(rule).tls as TlsSpec).upstream).toEqual(UPSTREAM);
    expect((toRproxyPatch(rule).tls as TlsSpec).upstream).not.toHaveProperty('tls');
  });

  it('エクスポートして読み込むと同じ値が本文に戻り、rproxy の設定ファイル（issue の例）も読める', () => {
    const body = settingsRuleToBody(parseDoc(JSON.stringify(exportDoc([rule]))).rules[0]);
    expect(normalizeTls(body.tls)).toEqual(tls);
    const yaml = [
      'version: 1',
      'rules:',
      '  - protocol: tcp',
      '    listen_addr: 0.0.0.0',
      '    listen_port: 443',
      '    tls:',
      '      mode: terminate',
      '      certificates:',
      '      - cert_file: /etc/rproxy/site.pem',
      '        key_file: /etc/rproxy/site.key',
      '      upstream:',
      '        ca_file: /etc/rproxy/backend-ca.pem',
      '        server_name: backend.internal',
      '        cert_file: /etc/rproxy/backend-client.pem',
      '        key_file: /etc/rproxy/backend-client.key',
      '    http:',
      '      routes:',
      '      - name: app',
      '        match: PathPrefix(`/`)',
      '        service: app',
      '      services:',
      '        app:',
      '          servers:',
      '          - url: https://backend.internal',
    ].join('\n');
    const fromFile = normalizeTls(settingsRuleToBody(parseDoc(yaml).rules[0]).tls);
    expect(fromFile.upstream).toEqual({
      server_name: 'backend.internal', ca_file: '/etc/rproxy/backend-ca.pem', cert_file: '/etc/rproxy/backend-client.pem', key_file: '/etc/rproxy/backend-client.key',
    });
  });

  it('rproxy の応答（tls: false と null を書く）から画面の形にしても同じで、ずれにならない', () => {
    const status = {
      ...toRproxyRule(rule), state: 'running', error: null, connections: 0, resolved: [],
      tls: {
        ...tls, unmatched: 'default', alpn: [], client_auth: { mode: 'none', ca_file: null },
        upstream: { tls: false, insecure_skip_verify: false, ...UPSTREAM },
      },
    } as unknown as RproxyRuleStatus;
    expect(ruleFromStatus(status, 0).tls).toEqual(tls);
    expect(ruleDrift(rule, status)).toEqual([]);
    // upstream がなくなっていればずれ
    const without: ForwardRule = { ...rule, tls: { ...tls, upstream: undefined } };
    expect(ruleDrift(without, status)).toEqual(['tls']);
  });

  it('履歴の差分に出す', () => {
    expect(ruleChanges({ ...rule, tls: { ...tls, upstream: undefined } }, rule)).toContain('TLS の設定を変更');
    expect(ruleChanges(rule, rule)).toEqual([]);
  });
});

describe('RuleForm：L7 のルールの upstream を tls なしで出して送る', () => {
  it('ruleUpstreamSpec：L7 は tls を付けず値を保ち、空なら送らない。L4 は「再暗号化する」のときだけ tls: true', () => {
    const form = toUpstreamForm(tls.upstream);
    // 「再暗号化する」の状態に関係なく、L7 では tls を付けない
    for (const reencrypt of [false, true]) {
      const sent = ruleUpstreamSpec(true, reencrypt, form);
      expect(sent).not.toHaveProperty('tls');
      expect(normalizeTls({ ...tls, upstream: sent }).upstream).toEqual(UPSTREAM);
      expect(ruleUpstreamSpec(true, reencrypt, EMPTY_UPSTREAM_FORM)).toBeUndefined();
    }
    // L4 の終端は今までどおり
    expect(ruleUpstreamSpec(false, false, form)).toBeUndefined();
    expect(ruleUpstreamSpec(false, true, form)).toEqual({ tls: true, ...form });
    expect(ruleUpstreamSpec(false, true, EMPTY_UPSTREAM_FORM)).toEqual({ tls: true, ...EMPTY_UPSTREAM_FORM });
  });

  it('変更の画面は L7 のルールの値を欄に入れて開き、「再暗号化する」のチェックを出さない', () => {
    const html = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: rule }));
    expect(html).toContain('data-testid="http-upstream"');
    expect(html).toContain('https:// の転送先への TLS');
    expect(html).toMatch(/id="rule-upstream-name"[^>]*value="backend.internal"/);
    expect(html).toMatch(/id="rule-upstream-ca"[^>]*value="\/etc\/rproxy\/backend-ca.pem"/);
    expect(html).toMatch(/id="rule-upstream-cert"[^>]*value="\/etc\/rproxy\/backend-client.pem"/);
    expect(html).toMatch(/id="rule-upstream-chain"[^>]*value="\/etc\/rproxy\/backend-chain.pem"/);
    expect(html).toMatch(/id="rule-upstream-key"[^>]*value="\/etc\/rproxy\/backend-client.key"/);
    expect(html).not.toContain('転送先へ TLS で再暗号化する');
    expect(html).not.toContain('data-testid="http-upstream-overridden"');
  });

  it('L4 の終端は今までどおり「再暗号化する」のチェックで欄を出す', () => {
    const l4: ForwardRule = { ...rule, http: null, distAddr: '10.0.0.5', distPort: 8443, tls: { ...tls, upstream: { tls: true, ...UPSTREAM } } };
    const html = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: l4 }));
    expect(html).toContain('転送先へ TLS で再暗号化する');
    expect(html).toMatch(/id="rule-upstream-name"[^>]*value="backend.internal"/);
    expect(html).not.toContain('data-testid="http-upstream"');
    const off = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: { ...l4, tls: { ...tls, upstream: undefined } } }));
    expect(off).toContain('転送先へ TLS で再暗号化する');
    expect(off).not.toContain('id="rule-upstream-name"');
  });

  it('サービスの tls（#236）がある L7 のルールでは、そのサービスで使わないことを出す', () => {
    const withServiceTls = { ...HTTP, services: { ...HTTP.services, api: { servers: [{ url: 'https://api.internal' }], tls: { ca_file: '/etc/rproxy/api-ca.pem' } } } };
    expect(servicesWithOwnTls(toHttpRules(withServiceTls))).toEqual(['api']);
    expect(servicesWithOwnTls(toHttpRules(HTTP))).toEqual([]);
    const html = renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData: { ...rule, http: withServiceTls } }));
    expect(html).toContain('data-testid="http-upstream-overridden"');
    expect(html).toContain('転送先への TLS を設定したサービス（api）では、ここの設定を使いません。');
  });
});

describe('詳細画面：L7 のルールの upstream', () => {
  const render = (r: ForwardRule) => renderToStaticMarkup(createElement(TlsSection, { rule: live(r) }));

  it('tls なしでも値を「https:// の転送先への TLS」に出し、平文とは言わない', () => {
    expect(upstreamHasSettings(tls.upstream)).toBe(true);
    const html = render(rule);
    expect(html).toContain('data-testid="http-upstream"');
    expect(html).toContain('https:// の転送先への TLS');
    for (const v of Object.values(UPSTREAM)) expect(html).toContain(v);
    expect(html).not.toContain('再暗号化しない（転送先へは平文）');
    expect(html).not.toContain('data-testid="http-upstream-overridden"');
  });

  it('値がなければ既定（Mozilla のルート）と出し、サービスの tls があればそれを使うと出す', () => {
    expect(upstreamHasSettings(undefined)).toBe(false);
    expect(upstreamHasSettings({ tls: true })).toBe(false);
    const html = render({ ...rule, tls: { ...tls, upstream: undefined } });
    expect(html).toContain('指定なし（Mozilla のルート証明書で検証し、クライアント証明書は出さない）');
    expect(html).not.toContain('再暗号化しない（転送先へは平文）');
    const withServiceTls = { ...HTTP, services: { app: { servers: [{ url: 'https://backend.internal' }], tls: { server_name: 'x.internal' } } } };
    expect(render({ ...rule, http: withServiceTls })).toContain('転送先への TLS を設定したサービス（app）では、この設定の代わりにサービスの設定を使います。');
  });

  it('L4 の終端は今までどおり（tls: true なら再暗号化、なければ平文）', () => {
    const l4: ForwardRule = { ...rule, http: null, distAddr: '10.0.0.5', distPort: 8443 };
    const on = render({ ...l4, tls: { ...tls, upstream: { tls: true, ...UPSTREAM } } });
    expect(on).toContain('転送先への TLS');
    expect(on).toContain('backend.internal');
    expect(on).not.toContain('data-testid="http-upstream"');
    expect(render({ ...l4, tls: { ...tls, upstream: undefined } })).toContain('再暗号化しない（転送先へは平文）');
  });
});
