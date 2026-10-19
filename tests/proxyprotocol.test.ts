// rproxy-api v0.4.13 の 2 つの項目：ルールの proxy_protocol（PROXY protocol を前段から受け取る、#296）と、
// tls.routes[].source_ip（名前ごとの送信元 IP の渡し方、#297）。形の検証・DB / エクスポート / ずれ / 履歴で落とさないこと
import { describe, expect, it } from 'vitest';
import type { ForwardRule } from '@/components/lib';
import { checkTls, normalizeTls, optionsJson, parseOptions, TlsError } from '@/components/tls';
import { normalizeProxyProtocol, normalizeV04, v04Fields, v04PatchFields, usedV04Features } from '@/components/v04';
import { buildProxyProtocol, buildV04, toProxyProtocolForm, toV04Form } from '@/components/v04form';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import { toRproxyPatch } from '@/components/ruledb';
import type { RproxyRuleStatus } from '@/components/rproxy';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 25, srcPortEnd: null, distAddr: '10.0.0.25', distPort: 25,
  sourceIp: 'proxy_v2', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false,
  targets: [], balance: 'round_robin', healthCheck: null,
};

const pp = { from: ['10.2.0.0/16', '172.16.10.19/32'], required: true };

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (err) {
    return err instanceof TlsError ? err.code : 'other';
  }
};

describe('proxy_protocol の検証（rproxy の src/net/proxy_in.rs と同じ規則）', () => {
  it('from を CIDR に正規化し、required は既定 true で必ず書く', () => {
    expect(normalizeProxyProtocol({ from: ['10.2.9.9/16', '172.16.10.19', '[fd00::1]'] })).toEqual({ from: ['10.2.0.0/16', '172.16.10.19/32', 'fd00::1/128'], required: true });
    expect(normalizeProxyProtocol({ from: ['10.0.0.1'], required: false })).toEqual({ from: ['10.0.0.1/32'], required: false });
  });

  it('省略・null・{} はなし（PATCH の {} で外すのと同じ）', () => {
    expect(normalizeProxyProtocol(undefined)).toBeNull();
    expect(normalizeProxyProtocol(null)).toBeNull();
    expect(normalizeProxyProtocol({})).toBeNull();
  });

  it('from は空にできず、/0 は書けず、64 件まで。udp は unsupported', () => {
    expect(code(() => normalizeProxyProtocol({ from: [] }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ required: true }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: ['0.0.0.0/0'] }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: ['10.0.0.0/8', '::/0'] }))).toBe('invalid');
    // /0 でなければ広くてもよい（rproxy と同じ）
    expect(normalizeProxyProtocol({ from: ['0.0.0.0/1'] })?.from).toEqual(['0.0.0.0/1']);
    expect(code(() => normalizeProxyProtocol({ from: ['not-an-ip'] }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: Array.from({ length: 65 }, (_, i) => `10.0.${i}.1`) }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: ['10.0.0.1'], required: 'yes' }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: ['10.0.0.1'], trusted: true }))).toBe('invalid');
    expect(code(() => normalizeProxyProtocol({ from: ['10.0.0.1'] }, 'udp'))).toBe('unsupported');
    expect(normalizeProxyProtocol({ from: ['10.0.0.1'] }, 'tcp')).not.toBeNull();
  });

  it('features の名前は proxy_protocol_in', () => {
    expect(usedV04Features({ proxyProtocol: pp, labels: { a: '1' } }).sort()).toEqual(['labels', 'proxy_protocol_in']);
  });
});

describe('proxy_protocol の行き来（フォーム・DB・rproxy・エクスポート）', () => {
  const rule: ForwardRule = { ...base, proxyProtocol: pp };

  it('フォームの欄から作り、編集できないときは今の値をそのまま残す', () => {
    const form = toProxyProtocolForm(pp);
    expect(form).toEqual({ enabled: true, fromText: '10.2.0.0/16\n172.16.10.19/32', required: true });
    expect(buildProxyProtocol(form, 'tcp', true, pp)).toEqual(pp);
    expect(buildProxyProtocol({ ...form, required: false }, 'tcp', true, pp)).toEqual({ ...pp, required: false });
    expect(buildProxyProtocol({ ...form, enabled: false }, 'tcp', true, pp)).toBeUndefined();
    expect(() => buildProxyProtocol({ ...form, fromText: '\n  \n' }, 'tcp', true, pp)).toThrow(/1 件以上/);
    expect(() => buildProxyProtocol({ ...form, fromText: '0.0.0.0/0' }, 'tcp', true, pp)).toThrow(/だれのヘッダでも/);
    // rproxy が features.proxy_protocol_in を返さない：欄の中身にかかわらず、読んだ値を送る
    expect(buildProxyProtocol({ enabled: false, fromText: '', required: true }, 'tcp', false, pp)).toEqual(pp);
    expect(buildProxyProtocol(toProxyProtocolForm(undefined), 'tcp', false, undefined)).toBeUndefined();
  });

  it('「制限・GeoIP」タブの組み立ては proxy_protocol を落とさない', () => {
    const editable = { labels: true, limits: true, bandwidth: true, geoip: true, outlier_detection: true, proxy_protocol: true };
    expect(buildV04(toV04Form({ proxyProtocol: pp }), 'tcp', false, editable, { proxyProtocol: pp }).proxyProtocol).toEqual(pp);
  });

  it('DB の options に書いて読み直すと同じ', () => {
    const json = optionsJson(rule.tls, null, true, [], null, false, undefined, [], true, { proxyProtocol: pp });
    expect(JSON.parse(json!).proxy_protocol).toEqual(pp);
    expect(parseOptions(json).v04.proxyProtocol).toEqual(pp);
    // 使わなければ書かない（v0.3 の rproxy は知らないキーの行を断る）
    expect(optionsJson(rule.tls, null, true)).toBeNull();
  });

  it('rproxy へは使うときだけ付け、PATCH では外すときに {}', () => {
    expect(toRproxyRule(rule).proxy_protocol).toEqual(pp);
    expect('proxy_protocol' in toRproxyRule(base)).toBe(false);
    expect(toRproxyPatch(rule).proxy_protocol).toEqual(pp);
    expect(toRproxyPatch(base, false, false, false, rule).proxy_protocol).toEqual({});
    expect('proxy_protocol' in toRproxyPatch(base, false, false, false, base)).toBe(false);
    expect(v04PatchFields({}, { proxyProtocol: pp })).toEqual({ proxy_protocol: {} });
  });

  it('エクスポートして読み込むと同じ値が本文に戻る', () => {
    const doc = parseDoc(JSON.stringify(exportDoc([rule])));
    const body = settingsRuleToBody(doc.rules[0]);
    expect(body.proxyProtocol).toEqual(pp);
    expect(normalizeV04(body, 'tcp').proxyProtocol).toEqual(pp);
    expect(toSettingsRule(rule).proxy_protocol).toEqual(pp);
  });

  it('rproxy の応答（required を常に出す）と比べてもずれにならず、違えばずれ', () => {
    const live = { ...toRproxyRule(rule), state: 'running', error: null, connections: 0, resolved: [], proxy_protocol: { from: ['10.2.0.0/16', '172.16.10.19/32'], required: true } } as unknown as RproxyRuleStatus;
    expect(ruleDrift(rule, live)).toEqual([]);
    expect(ruleDrift(base, live)).toEqual(['proxy_protocol']);
  });

  it('履歴の差分に出す', () => {
    expect(ruleChanges(base, rule)).toContain('PROXY protocol の受け取りを変更');
  });
});

describe('tls.routes[].source_ip（rproxy の check_route_source_ip と同じ規則）', () => {
  const sni = { mode: 'sni', routes: [{ server_name: 'k8s.example.com', remote_addr: '10.2.255.131', remote_port: 443, source_ip: 'proxy_v2' }] };
  const terminate = (passthrough: boolean, sourceIp: string) => ({
    mode: 'terminate',
    certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }],
    routes: [{ server_names: ['**.tenant.example.com'], remote_addr: '10.2.255.131', remote_port: 443, passthrough: passthrough, source_ip: sourceIp }],
  });

  it('normalizeTls は source_ip を残し、省略なら付けない（キーは rproxy の応答の順）', () => {
    const tls = normalizeTls(sni);
    expect(tls.routes?.[0]).toEqual({ server_name: 'k8s.example.com', remote_addr: '10.2.255.131', remote_port: 443, source_ip: 'proxy_v2' });
    expect(Object.keys(normalizeTls(terminate(true, 'proxy_v1')).routes![0])).toEqual(['server_names', 'remote_addr', 'remote_port', 'passthrough', 'source_ip']);
    expect('source_ip' in normalizeTls({ ...sni, routes: [{ ...sni.routes[0], source_ip: '' }] }).routes![0]).toBe(false);
    expect(code(() => normalizeTls({ ...sni, routes: [{ ...sni.routes[0], source_ip: 'transparent' }] }))).toBe('unsupported');
    expect(code(() => normalizeTls({ ...sni, routes: [{ ...sni.routes[0], source_ip: 'proxy_v3' }] }))).toBe('invalid');
  });

  it('TLS を終端しない route だけ（sni の route、terminate の passthrough。L7 のルールの passthrough も）', () => {
    for (const s of ['proxy', 'proxy_v1', 'proxy_v2']) {
      expect(code(() => checkTls('tcp', normalizeTls({ ...sni, routes: [{ ...sni.routes[0], source_ip: s }] }), null, 1))).toBeNull();
      expect(code(() => checkTls('tcp', normalizeTls(terminate(true, s)), null, 1))).toBeNull();
      expect(code(() => checkTls('tcp', normalizeTls(terminate(true, s)), null, 1, true))).toBeNull();
      expect(code(() => checkTls('tcp', normalizeTls(terminate(false, s)), null, 1))).toBe('unsupported');
    }
    // udp の sni：proxy_v2 はよいが proxy_v1 は不可
    expect(code(() => checkTls('udp', normalizeTls(sni), null, 1))).toBeNull();
    expect(code(() => checkTls('udp', normalizeTls({ ...sni, routes: [{ ...sni.routes[0], source_ip: 'proxy_v1' }] }), null, 1))).toBe('unsupported');
  });

  it('DB の options・エクスポートで落とさない', () => {
    const rule: ForwardRule = { ...base, sourceIp: 'proxy', tls: normalizeTls(sni) };
    expect(parseOptions(optionsJson(rule.tls, null, true)).tls).toEqual(rule.tls);
    const body = settingsRuleToBody(parseDoc(JSON.stringify(exportDoc([rule]))).rules[0]);
    expect(normalizeTls(body.tls)).toEqual(rule.tls);
  });
});
