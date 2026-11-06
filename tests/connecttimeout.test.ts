// rproxy-api v0.4.3（features.connect_timeout）のルールの connect_timeout（tcp の宛先への接続にかけてよい時間）。
// UI の DB（forward_rules.options）から戻すのは rproxy-api v0.4.21 から（features.db_connect_timeout、max3584/rproxy-api#379）。
// 形の検証（rproxy の validate_connect_timeout と同じ規則）・DB / rproxy / エクスポート / ずれ / 履歴で落とさないこと（UI #184）
import { describe, expect, it, vi } from 'vitest';

// resendOne（ずれの直し）が rproxy に送るものを見る。ほかの試験は rproxy を呼ばない
const rp = vi.hoisted(() => ({ getRule: vi.fn(), modifyRule: vi.fn(), addRule: vi.fn(), deleteRule: vi.fn() }));
vi.mock('@/components/rproxy', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/rproxy')>()), ...rp }));
import type { ForwardRule } from '@/components/lib';
import { optionsJson, parseOptions, TlsError } from '@/components/tls';
import { connectTimeoutText, normalizeConnectTimeout, normalizeV04, usedV04Features, v04PatchFields } from '@/components/v04';
import { buildConnectTimeout, buildRelayTimeouts, buildV04, toV04Form } from '@/components/v04form';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import { fromRow, resendOne, toRproxyPatch } from '@/components/ruledb';
import { ruleFromStatus } from '@/components/dashboard';
import type { RproxyRuleStatus } from '@/components/rproxy';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 5432, srcPortEnd: null, distAddr: '10.0.0.5', distPort: 5432,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false,
  targets: [], balance: 'round_robin', healthCheck: null,
};

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (err) {
    return err instanceof TlsError ? err.code : 'other';
  }
};

const live = (rule: ForwardRule, extra: Record<string, unknown>): RproxyRuleStatus =>
  ({ ...toRproxyRule(rule), state: 'running', error: null, connections: 0, resolved: [], ...extra }) as unknown as RproxyRuleStatus;

describe('connect_timeout の検証（rproxy の validate_connect_timeout と同じ規則）', () => {
  it('100ms〜10m。0s と空はなし（rproxy の既定）、大きな単位の書き方に揃える', () => {
    expect(normalizeConnectTimeout('1500ms', 'tcp')).toBe('1500ms');
    expect(normalizeConnectTimeout(' 3s ', 'tcp')).toBe('3s');
    expect(normalizeConnectTimeout('120s', 'tcp')).toBe('2m');
    expect(normalizeConnectTimeout('100ms', 'tcp')).toBe('100ms');
    expect(normalizeConnectTimeout('10m', 'tcp')).toBe('10m');
    expect(normalizeConnectTimeout('600000ms', 'tcp')).toBe('10m');
    expect(normalizeConnectTimeout('0s', 'tcp')).toBeNull();
    expect(normalizeConnectTimeout('0ms', 'tcp')).toBeNull();
    expect(normalizeConnectTimeout(undefined)).toBeNull();
    expect(normalizeConnectTimeout(null)).toBeNull();
    expect(normalizeConnectTimeout('  ')).toBeNull();
    // rproxy と同じく 0s は udp・L7 でも断らない（外すだけ）
    expect(normalizeConnectTimeout('0s', 'udp')).toBeNull();
    expect(normalizeConnectTimeout('0s', 'tcp', true)).toBeNull();
  });

  it('読めない値・範囲の外・udp・L7 は invalid', () => {
    expect(code(() => normalizeConnectTimeout('99ms', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('601s', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('1h', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('1.5s', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('3', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout(3, 'tcp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('3s', 'udp'))).toBe('invalid');
    expect(code(() => normalizeConnectTimeout('3s', 'tcp', true))).toBe('invalid');
    expect(code(() => normalizeV04({ connect_timeout: '3s' }, 'tcp', true))).toBe('invalid');
  });

  it('features の名前は db_connect_timeout（UI の DB から戻せる rproxy、v0.4.21）', () => {
    expect(usedV04Features({ connectTimeout: '3s' })).toEqual(['db_connect_timeout']);
  });

  it('表示：省いたものは rproxy の既定', () => {
    expect(connectTimeoutText(undefined)).toBe('既定（ほかに宛先があれば 5s、なければ 30s）');
    expect(connectTimeoutText('1500ms')).toBe('1500ms');
  });
});

describe('connect_timeout の行き来（フォーム・DB・rproxy・エクスポート・ずれ・履歴）', () => {
  const rule: ForwardRule = { ...base, connectTimeout: '1500ms' };

  it('フォームの欄から作る。DB から戻せない rproxy では今の値を残し、udp・L7 では付けない', () => {
    expect(buildConnectTimeout('1500ms', 'tcp', false, true, {})).toEqual({ connectTimeout: '1500ms' });
    expect(buildConnectTimeout('', 'tcp', false, true, { connectTimeout: '3s' })).toEqual({});
    expect(buildConnectTimeout('0s', 'tcp', false, true, { connectTimeout: '3s' })).toEqual({});
    expect(buildConnectTimeout('', 'tcp', false, false, { connectTimeout: '3s' })).toEqual({ connectTimeout: '3s' });
    expect(buildConnectTimeout('9s', 'tcp', false, false, {})).toEqual({});
    expect(buildConnectTimeout('3s', 'udp', false, true, {})).toEqual({});
    expect(buildConnectTimeout('3s', 'tcp', true, true, {})).toEqual({});
    expect(() => buildConnectTimeout('50ms', 'tcp', false, true, {})).toThrow(/connect_timeout/);
  });

  it('ほかのタブの組み立ては connect_timeout を落とさない', () => {
    const editable = {
      labels: true, limits: true, bandwidth: true, geoip: true, outlier_detection: true, proxy_protocol: true, idle_timeout: true, half_close_timeout: true, connect_timeout: true,
    };
    expect(buildV04(toV04Form({}), 'tcp', false, editable, { connectTimeout: '3s' }).connectTimeout).toBe('3s');
    expect(buildRelayTimeouts({ idle: '', halfClose: '' }, 'tcp', false, true, { connectTimeout: '3s' })).toEqual({});
  });

  it('DB の options に書いて読み直すと同じ値（使わなければ書かない）', () => {
    const json = optionsJson(rule.tls, null, true, [], null, false, undefined, [], true, { connectTimeout: '1500ms' });
    expect(JSON.parse(json!)).toMatchObject({ connect_timeout: '1500ms' });
    expect(parseOptions(json).v04).toEqual({ connectTimeout: '1500ms' });
    const row = { protocol: 'TCP', src_addr: '0.0.0.0', src_port: 5432, src_port_end: null, dist_addr: '10.0.0.5', dist_port: 5432, source_ip: 'proxy', udp_idle_secs: 30, options: json };
    expect(fromRow(row).connectTimeout).toBe('1500ms');
    // 使わなければ書かない（v0.4.21 より前の rproxy は知らないキーの行を戻さない）
    expect(optionsJson(rule.tls, null, true)).toBeNull();
    expect(JSON.parse(optionsJson(rule.tls, null, true, ['10.0.0.0/8'])!)).not.toHaveProperty('connect_timeout');
  });

  it('rproxy へは使うときだけ付け、PATCH で外すときは 0s を送る', () => {
    expect(toRproxyRule(rule)).toMatchObject({ connect_timeout: '1500ms' });
    expect('connect_timeout' in toRproxyRule(base)).toBe(false);
    expect(toRproxyPatch(rule).connect_timeout).toBe('1500ms');
    expect(toRproxyPatch(base, false, false, false, rule).connect_timeout).toBe('0s');
    expect('connect_timeout' in toRproxyPatch(base, false, false, false, base)).toBe(false);
    expect(v04PatchFields({}, { connectTimeout: '3s' })).toEqual({ connect_timeout: '0s' });
  });

  it('エクスポートして読み込むと同じ値が本文に戻る', () => {
    const doc = parseDoc(JSON.stringify(exportDoc([rule])));
    const body = settingsRuleToBody(doc.rules[0]);
    expect(body.connectTimeout).toBe('1500ms');
    expect(normalizeV04(body, 'tcp')).toEqual({ connectTimeout: '1500ms' });
    expect(toSettingsRule(rule)).toMatchObject({ connect_timeout: '1500ms' });
    // rproxy の設定ファイルのルールも読める
    const file = parseDoc('rules:\n  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 22, remote_addr: 10.0.0.22, remote_port: 22, connect_timeout: 2s}\n');
    expect(settingsRuleToBody(file.rules[0]).connectTimeout).toBe('2s');
  });

  it('rproxy の応答（120s のような書き方）と比べてもずれにならず、違えばずれ', () => {
    expect(ruleDrift(rule, live(rule, {}))).toEqual([]);
    expect(ruleFromStatus(live(base, { connect_timeout: '120s' }), 0)).toMatchObject({ connectTimeout: '2m' });
    expect(ruleDrift({ ...base, connectTimeout: '2m' }, live(base, { connect_timeout: '120s' }))).toEqual([]);
    expect(ruleDrift(base, live(base, { connect_timeout: '3s' }))).toEqual(['connect_timeout']);
    expect(ruleDrift(rule, live(base, {}))).toEqual(['connect_timeout']);
  });

  it('ほかの項目が読めない応答でも connect_timeout は揃えて読む', () => {
    const actual = ruleFromStatus(live(base, { connect_timeout: '120s', labels: { 'bad key!': 1 } }), 0);
    expect(actual.labels).toEqual({ 'bad key!': 1 });
    expect(actual.connectTimeout).toBe('2m');
  });

  it('ずれの直し（resendOne）：rproxy に値があり DB になければ、0s を PATCH で送って外す', async () => {
    rp.getRule.mockResolvedValue(live(base, { connect_timeout: '3s', origin: 'dynamic' }));
    rp.modifyRule.mockResolvedValue({});
    expect(await resendOne(base)).toBe('modified');
    const patch = rp.modifyRule.mock.calls[0][1];
    expect(patch.connect_timeout).toBe('0s');
    expect(rp.addRule).not.toHaveBeenCalled();
    expect(rp.deleteRule).not.toHaveBeenCalled();
    // 外れた後（rproxy は返さない）はずれがなく何もしない
    rp.modifyRule.mockClear();
    rp.getRule.mockResolvedValue(live(base, { origin: 'dynamic' }));
    expect(await resendOne(base)).toBe('unchanged');
    expect(rp.modifyRule).not.toHaveBeenCalled();
  });

  it('履歴の差分に前と後の値を出す', () => {
    expect(ruleChanges(base, rule)).toEqual(['宛先への接続の時間（connect_timeout）: 既定（ほかに宛先があれば 5s、なければ 30s） → 1500ms']);
    expect(ruleChanges(rule, { ...rule, connectTimeout: '3s' })).toEqual(['宛先への接続の時間（connect_timeout）: 1500ms → 3s']);
    expect(ruleChanges(rule, rule)).toEqual([]);
  });
});
