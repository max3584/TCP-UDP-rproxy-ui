// 入力フォーム（RuleForm）とプロファイルの確認。ブラウザは使わず、サーバ側の描画結果（HTML）を見る。
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RuleForm, { ALLOW_FROM_HELP, CHAIN_HELP } from '@/components/RuleForm';
import { PROFILES } from '@/components/profiles';
import { DEFAULT_MAX_RANGE_PORTS, ForwardRule } from '@/components/lib';
import { checkTls, portCount } from '@/components/tls';

const render = (initialData?: ForwardRule, submitting = false) =>
  renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData, submitting }));

const udpRule: ForwardRule = {
  protocol: 'udp', srcAddr: '0.0.0.0', srcPort: 8000, srcPortEnd: 8001, distAddr: '10.0.0.30', distPort: 8000,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [],
};

const terminateRule: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.5', distPort: 8080,
  sourceIp: 'proxy', udpIdleSecs: 30, starttls: null, starttlsRequired: true, allowFrom: [],
  tls: {
    mode: 'terminate',
    certificates: [
      { cert_file: '/etc/rproxy/certs/example.pem', chain_file: '/etc/rproxy/certs/intermediates.pem', key_file: '/etc/rproxy/certs/example.key' },
      { cert_file: '/etc/rproxy/certs/other.pem', key_file: '/etc/rproxy/certs/other.key' },
    ],
    client_auth: { mode: 'required', ca_file: '/etc/rproxy/clients-root.pem', chain_file: '/etc/rproxy/clients-intermediates.pem' },
    upstream: { tls: true, cert_file: '/etc/rproxy/up.pem', chain_file: '/etc/rproxy/up-chain.pem', key_file: '/etc/rproxy/up.key' },
  },
};

describe('RuleForm', () => {
  it('splits the form into four accessible tabs with the basic tab selected', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    const tabs = Array.from(html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g));
    expect(tabs.map((t) => t[1])).toEqual(['基本', 'TLS / DTLS', 'メール (STARTTLS)', '詳細']);
    expect(tabs[0][0]).toContain('aria-selected="true"');
    expect(tabs[1][0]).toContain('aria-selected="false"');
    // tcp + passthrough では STARTTLS のタブは使えない
    expect(tabs[2][0]).toContain('aria-disabled="true"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
    expect(html).toContain('プロファイル');
  });

  it('titles the TLS tab DTLS for UDP and keeps the range read-only when editing', () => {
    const html = render(udpRule);
    expect(html).toMatch(/role="tab"[^>]*>DTLS<\/button>/);
    expect(html).not.toContain('プロファイル');
    expect(html).toMatch(/value="8001"[^>]*readOnly|readOnly[^>]*value="8001"/i);
  });

  it('is a page form with a submit and a cancel button instead of a modal overlay', () => {
    const html = render();
    expect(html).toMatch(/^<form[^>]*aria-label="ルールの追加"/);
    expect(html).not.toContain('fixed inset-0');
    expect(html).toMatch(/<button type="submit"[^>]*>ルールを追加<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>キャンセル<\/button>/);
    expect(render(udpRule)).toMatch(/<button type="submit"[^>]*>変更を保存<\/button>/);
    expect(render(udpRule, true)).toMatch(/<button type="submit" disabled=""[^>]*>保存中…<\/button>/);
  });

  it('labels every visible input', () => {
    const html = render(terminateRule);
    // id のある input / select にはすべて対応する label がある
    const ids = Array.from(html.matchAll(/<(?:input|select)[^>]*\sid="([^"]+)"/g)).map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(html).toContain(`for="${id}"`);
  });

  it('shows the chain fields of certificates, client auth and upstream as first-class inputs', () => {
    const html = render(terminateRule);
    expect(html.match(/data-testid="certificate-row"/g)).toHaveLength(2);
    expect(html).toMatch(/id="rule-cert-0-chain"[^>]*value="\/etc\/rproxy\/certs\/intermediates.pem"/);
    // 中間 CA のない証明書も欄は出す
    expect(html).toMatch(/id="rule-cert-1-chain"[^>]*value=""/);
    expect(html).toContain(CHAIN_HELP);
    expect(CHAIN_HELP).toBe('中間 CA（サーバ証明書を発行した CA からルートへ向かう順。ルートは不要）');
    expect(html).toMatch(/id="rule-client-auth-ca"[^>]*value="\/etc\/rproxy\/clients-root.pem"/);
    expect(html).toMatch(/id="rule-client-auth-chain"[^>]*value="\/etc\/rproxy\/clients-intermediates.pem"/);
    expect(html).toMatch(/id="rule-upstream-chain"[^>]*value="\/etc\/rproxy\/up-chain.pem"/);
    // TLS タブが開くまでは隠れている（hidden の tabpanel の中）
    expect(html).toMatch(/id="rule-panel-tls"[^>]*hidden=""/);
  });

  it('hides the client auth chain field when client auth is none', () => {
    const html = render({ ...terminateRule, tls: { ...terminateRule.tls, client_auth: undefined, upstream: undefined } });
    expect(html).toContain('id="rule-cert-0-chain"');
    expect(html).not.toContain('id="rule-client-auth-chain"');
    expect(html).not.toContain('id="rule-upstream-chain"');
  });
});

describe('RuleForm: allow_from and unmatched', () => {
  const route = { server_name: 'dashboard.proxy.home', remote_addr: '127.0.0.1', remote_port: 3001 };
  const sniRule: ForwardRule = { ...terminateRule, tls: { mode: 'sni', routes: [route], unmatched: 'reject' }, allowFrom: ['172.16.0.0/16', '10.0.0.5/32'] };
  const panel = (html: string, tab: string) => {
    const start = html.indexOf(`id="rule-panel-${tab}"`);
    const next = html.indexOf('role="tabpanel"', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  };

  it('puts a labelled allow_from textarea with its help text in the advanced tab', () => {
    const html = render();
    const advanced = panel(html, 'advanced');
    expect(advanced).toContain('<label for="rule-allow-from"');
    expect(advanced).toContain('接続を許可する送信元（allow_from）');
    expect(advanced).toMatch(/<textarea[^>]*id="rule-allow-from"[^>]*aria-describedby="rule-allow-from-help"/);
    expect(advanced).toContain(ALLOW_FROM_HELP);
    expect(ALLOW_FROM_HELP).toBe('空欄ならすべて許可。範囲外からの接続は TLS より前に切断します');
    expect(panel(html, 'basic')).not.toContain('rule-allow-from');
  });

  it('fills the textarea with one CIDR per line when editing', () => {
    const html = render(sniRule);
    expect(html).toMatch(/<textarea[^>]*id="rule-allow-from"[^>]*>172\.16\.0\.0\/16\n10\.0\.0\.5\/32<\/textarea>/);
  });

  it('offers the unmatched choice in the TLS tab for tcp sni / terminate with routes', () => {
    const html = render(sniRule);
    const tls = panel(html, 'tls');
    expect(tls).toContain('<label for="rule-tls-unmatched"');
    expect(tls).toContain('どのサーバ名にも一致しない接続');
    expect(tls).toMatch(/<option value="default"[^>]*>基本の転送先へ送る<\/option>/);
    expect(tls).toMatch(/<option value="reject" selected=""[^>]*>切断する<\/option>/);
    const terminate = render({ ...terminateRule, tls: { ...terminateRule.tls, routes: [route] } });
    expect(terminate).toMatch(/<option value="default" selected=""[^>]*>基本の転送先へ送る<\/option>/);
  });

  it('hides the unmatched choice without routes, for passthrough and for UDP', () => {
    expect(render({ ...sniRule, tls: { mode: 'sni' } })).not.toContain('rule-tls-unmatched');
    expect(render(terminateRule)).not.toContain('rule-tls-unmatched');
    expect(render()).not.toContain('rule-tls-unmatched');
    expect(render({ ...udpRule, srcPortEnd: null, tls: { mode: 'terminate', certificates: [{ cert_file: '/c', key_file: '/k' }], routes: [route] } }))
      .not.toContain('rule-tls-unmatched');
  });
});

describe('profiles', () => {
  const cert = [{ cert_file: '/c.pem', key_file: '/k.pem' }];

  it.each(PROFILES.map((p) => [p.id, p] as const))('%s is a valid rule', (_id, p) => {
    const count = portCount(p.srcPort, p.srcPortEnd ?? null, p.distPort, DEFAULT_MAX_RANGE_PORTS);
    const tls = p.tlsMode === 'terminate' ? { mode: p.tlsMode, certificates: cert } : { mode: p.tlsMode };
    expect(() => checkTls(p.protocol, tls, p.starttls ?? null, count)).not.toThrow();
    expect(p.description.length).toBeGreaterThan(0);
  });

  it('follows the PROFILES.md warnings', () => {
    const byId = Object.fromEntries(PROFILES.map((p) => [p.id, p]));
    expect(byId['webrtc-media']).toMatchObject({ protocol: 'udp', tlsMode: 'passthrough', srcPort: 50000, srcPortEnd: 60000, udpIdleSecs: 60 });
    expect(byId['smtp']).toMatchObject({ srcPort: 25, tlsMode: 'passthrough', sourceIp: 'proxy_v2' });
    expect(byId['smtp'].description).toContain('必須にする');
    expect(byId['rtsp']).toMatchObject({ protocol: 'tcp', srcPort: 554, tlsMode: 'passthrough' });
    expect(byId['turns-dtls']).toMatchObject({ protocol: 'udp', tlsMode: 'terminate' });
    expect(byId['submission']).toMatchObject({ srcPort: 587, tlsMode: 'terminate', starttls: 'smtp' });
  });
});
