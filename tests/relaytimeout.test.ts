// rproxy-api v0.4.20（#353、features.tcp_idle_timeout）のルールの idle_timeout・half_close_timeout（tcp の中継の時間切れ）と、
// #356（features.http_stream_limits）の global.http.timeouts の write_stall・upgraded_idle・http2_max_streams・mirror の max_in_flight。
// 形の検証（rproxy の validate_relay_timeout と同じ規則）・DB / rproxy / エクスポート / ずれ / 履歴で落とさないこと（UI #181）
import { describe, expect, it, vi } from 'vitest';

// resendOne（ずれの直し）が rproxy に送るものを見る。ほかの試験は rproxy を呼ばない
const rp = vi.hoisted(() => ({ getRule: vi.fn(), modifyRule: vi.fn(), addRule: vi.fn(), deleteRule: vi.fn() }));
vi.mock('@/components/rproxy', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/rproxy')>()), ...rp }));
import type { ForwardRule } from '@/components/lib';
import { optionsJson, parseOptions, TlsError } from '@/components/tls';
import { normalizeRelayTimeout, normalizeV04, relayTimeoutText, usedV04Features, v04PatchFields } from '@/components/v04';
import { buildRelayTimeouts, buildV04, toRelayTimeoutForm, toV04Form } from '@/components/v04form';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import { fromRow, resendOne, toRproxyPatch } from '@/components/ruledb';
import { ruleFromStatus } from '@/components/dashboard';
import type { RproxyRuleStatus } from '@/components/rproxy';
import { buildGlobalValue, GlobalPatchError, httpTimeoutKeys, toGlobalForm } from '@/components/globalsettings';
import type { GlobalItem } from '@/components/globalsettings';
import { toHttpRules, validateHttp } from '@/components/httpspec';
import type { HttpRules } from '@/components/httpspec';

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

describe('idle_timeout・half_close_timeout の検証（rproxy の validate_relay_timeout と同じ規則）', () => {
  it('0s は上限なし、ほかは 1s 以上。大きな単位の書き方に揃え、既定（1h・1m）は省く', () => {
    expect(normalizeRelayTimeout('idle_timeout', '0s', 'tcp')).toBe('0s');
    expect(normalizeRelayTimeout('idle_timeout', '0ms', 'tcp')).toBe('0s');
    expect(normalizeRelayTimeout('idle_timeout', ' 7200s ', 'tcp')).toBe('2h');
    expect(normalizeRelayTimeout('idle_timeout', '90s', 'tcp')).toBe('90s');
    expect(normalizeRelayTimeout('idle_timeout', '1500ms', 'tcp')).toBe('1500ms');
    expect(normalizeRelayTimeout('idle_timeout', '3600s', 'tcp')).toBeNull();
    expect(normalizeRelayTimeout('idle_timeout', '60m', 'tcp')).toBeNull();
    expect(normalizeRelayTimeout('half_close_timeout', '60s', 'tcp')).toBeNull();
    expect(normalizeRelayTimeout('half_close_timeout', '1h', 'tcp')).toBe('1h');
    expect(normalizeRelayTimeout('idle_timeout', undefined)).toBeNull();
    expect(normalizeRelayTimeout('idle_timeout', null)).toBeNull();
    expect(normalizeRelayTimeout('idle_timeout', '  ')).toBeNull();
  });

  it('読めない値・1s 未満・udp・L7 は invalid', () => {
    expect(code(() => normalizeRelayTimeout('idle_timeout', '999ms', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('idle_timeout', '1d', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('idle_timeout', '10', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('idle_timeout', 60, 'tcp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('idle_timeout', '8761h', 'tcp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('half_close_timeout', '30s', 'udp'))).toBe('invalid');
    expect(code(() => normalizeRelayTimeout('half_close_timeout', '30s', 'tcp', true))).toBe('invalid');
    expect(code(() => normalizeV04({ idle_timeout: '30s' }, 'tcp', true))).toBe('invalid');
  });

  it('features の名前は tcp_idle_timeout（2 つで 1 つ）', () => {
    expect(usedV04Features({ idleTimeout: '30s', halfCloseTimeout: '0s' })).toEqual(['tcp_idle_timeout']);
  });

  it('表示：省いたものは既定、0s は上限なし', () => {
    expect(relayTimeoutText('idle_timeout', undefined)).toBe('既定（1h）');
    expect(relayTimeoutText('half_close_timeout', undefined)).toBe('既定（1m）');
    expect(relayTimeoutText('idle_timeout', '0s')).toBe('上限なし（0s）');
    expect(relayTimeoutText('idle_timeout', '10m')).toBe('10m');
  });
});

describe('idle_timeout・half_close_timeout の行き来（フォーム・DB・rproxy・エクスポート・ずれ・履歴）', () => {
  const rule: ForwardRule = { ...base, idleTimeout: '0s', halfCloseTimeout: '0s' };

  it('フォームの欄から作る。features がなければ今の値を残し、udp・L7 では付けない', () => {
    expect(buildRelayTimeouts({ idle: '0s', halfClose: '' }, 'tcp', false, true, {})).toEqual({ idleTimeout: '0s' });
    expect(buildRelayTimeouts({ idle: '1h', halfClose: '1m' }, 'tcp', false, true, { idleTimeout: '0s' })).toEqual({});
    expect(buildRelayTimeouts({ idle: '', halfClose: '' }, 'tcp', false, false, { idleTimeout: '0s', halfCloseTimeout: '5m' }))
      .toEqual({ idleTimeout: '0s', halfCloseTimeout: '5m' });
    expect(buildRelayTimeouts({ idle: '30s', halfClose: '' }, 'udp', false, true, {})).toEqual({});
    expect(buildRelayTimeouts({ idle: '30s', halfClose: '' }, 'tcp', true, true, {})).toEqual({});
    expect(() => buildRelayTimeouts({ idle: '', halfClose: '500ms' }, 'tcp', false, true, {})).toThrow(/half_close_timeout/);
    expect(toRelayTimeoutForm({ idleTimeout: '0s' })).toEqual({ idle: '0s', halfClose: '' });
  });

  it('「制限・GeoIP」タブの組み立ては中継の時間切れを落とさない', () => {
    const editable = {
      labels: true, limits: true, bandwidth: true, geoip: true, outlier_detection: true, proxy_protocol: true, idle_timeout: true, half_close_timeout: true,
    };
    const v = buildV04(toV04Form({ idleTimeout: '0s' }), 'tcp', false, editable, { idleTimeout: '0s', halfCloseTimeout: '5m' });
    expect(v.idleTimeout).toBe('0s');
    expect(v.halfCloseTimeout).toBe('5m');
  });

  it('DB の options に書いて読み直すと 0s のまま（UI の DB から戻すルールでも上限なしにできる）', () => {
    const json = optionsJson(rule.tls, null, true, [], null, false, undefined, [], true, { idleTimeout: '0s', halfCloseTimeout: '0s' });
    expect(JSON.parse(json!)).toMatchObject({ idle_timeout: '0s', half_close_timeout: '0s' });
    expect(parseOptions(json).v04).toEqual({ idleTimeout: '0s', halfCloseTimeout: '0s' });
    const row = { protocol: 'TCP', src_addr: '0.0.0.0', src_port: 5432, src_port_end: null, dist_addr: '10.0.0.5', dist_port: 5432, source_ip: 'proxy', udp_idle_secs: 30, options: json };
    expect(fromRow(row).idleTimeout).toBe('0s');
    expect(fromRow(row).halfCloseTimeout).toBe('0s');
    // 使わなければ書かない（rproxy は知らないキーの行を断る）
    expect(optionsJson(rule.tls, null, true)).toBeNull();
  });

  it('rproxy へは使うときだけ付け、PATCH で外すときは既定（1h・1m）を送る', () => {
    expect(toRproxyRule(rule)).toMatchObject({ idle_timeout: '0s', half_close_timeout: '0s' });
    expect('idle_timeout' in toRproxyRule(base)).toBe(false);
    expect(toRproxyPatch(rule).idle_timeout).toBe('0s');
    const back = toRproxyPatch(base, false, false, false, rule);
    expect(back.idle_timeout).toBe('1h');
    expect(back.half_close_timeout).toBe('1m');
    expect('idle_timeout' in toRproxyPatch(base, false, false, false, base)).toBe(false);
    expect(v04PatchFields({}, { halfCloseTimeout: '0s' })).toEqual({ half_close_timeout: '1m' });
  });

  it('エクスポートして読み込むと同じ値が本文に戻る', () => {
    const doc = parseDoc(JSON.stringify(exportDoc([rule])));
    const body = settingsRuleToBody(doc.rules[0]);
    expect(body.idleTimeout).toBe('0s');
    expect(body.halfCloseTimeout).toBe('0s');
    expect(normalizeV04(body, 'tcp')).toEqual({ idleTimeout: '0s', halfCloseTimeout: '0s' });
    expect(toSettingsRule(rule)).toMatchObject({ idle_timeout: '0s', half_close_timeout: '0s' });
    // rproxy の設定ファイルのルールも読める
    const file = parseDoc('rules:\n  - {protocol: tcp, listen_addr: 0.0.0.0, listen_port: 22, remote_addr: 10.0.0.22, remote_port: 22, idle_timeout: 0s}\n');
    expect(settingsRuleToBody(file.rules[0]).idleTimeout).toBe('0s');
  });

  it('rproxy の応答（3600s のような秒の書き方・既定を書いたもの）と比べてもずれにならず、違えばずれ', () => {
    expect(ruleDrift(rule, live(rule, {}))).toEqual([]);
    expect(ruleFromStatus(live(base, { idle_timeout: '7200s', half_close_timeout: '60s' }), 0)).toMatchObject({ idleTimeout: '2h' });
    expect(ruleDrift({ ...base, idleTimeout: '2h' }, live(base, { idle_timeout: '7200s' }))).toEqual([]);
    // 外した後の PATCH（1h・1m）で rproxy が既定を返しても、DB の「省略」とずれにしない
    expect(ruleDrift(base, live(base, { idle_timeout: '3600s', half_close_timeout: '60s' }))).toEqual([]);
    expect(ruleDrift(base, live(base, { idle_timeout: '0s' }))).toEqual(['idle_timeout']);
    expect(ruleDrift(rule, live(base, { idle_timeout: '0s' }))).toEqual(['half_close_timeout']);
  });

  it('ずれの直し（resendOne）：rproxy が 30s で DB に値がなければ、既定の 1h を PATCH で送る', async () => {
    rp.getRule.mockResolvedValue(live(base, { idle_timeout: '30s', origin: 'dynamic' }));
    rp.modifyRule.mockResolvedValue({});
    expect(await resendOne(base)).toBe('modified');
    const patch = rp.modifyRule.mock.calls[0][1];
    expect(patch.idle_timeout).toBe('1h');
    expect('half_close_timeout' in patch).toBe(false);
    expect(rp.addRule).not.toHaveBeenCalled();
    expect(rp.deleteRule).not.toHaveBeenCalled();
    // 直った後（rproxy は 3600s を返す）はずれがなく何もしない
    rp.modifyRule.mockClear();
    rp.getRule.mockResolvedValue(live(base, { idle_timeout: '3600s', origin: 'dynamic' }));
    expect(await resendOne(base)).toBe('unchanged');
    expect(rp.modifyRule).not.toHaveBeenCalled();
  });

  it('ほかの項目が読めない応答でも、3600s は既定として扱いずれにしない', () => {
    // labels が読めない（normalizeV04 が投げる）ときの読み方でも、中継の時間切れは項目ごとに揃える
    const broken = live(base, { idle_timeout: '3600s', half_close_timeout: '0ms', labels: { 'bad key!': 1 } });
    const actual = ruleFromStatus(broken, 0);
    expect(actual.idleTimeout).toBeUndefined();
    // 読めない labels はそのまま（normalizeV04 が投げた道を通ったこと）
    expect(actual.labels).toEqual({ 'bad key!': 1 });
    expect(actual.halfCloseTimeout).toBe('0s');
  });

  it('履歴の差分に前と後の値を出す', () => {
    expect(ruleChanges(base, rule)).toEqual(expect.arrayContaining([
      'TCP の中継の時間切れ（idle_timeout）: 既定（1h） → 上限なし（0s）',
      '片側が送り終えた後の時間切れ（half_close_timeout）: 既定（1m） → 上限なし（0s）',
    ]));
    expect(ruleChanges(rule, { ...rule, idleTimeout: '10m' })).toEqual(['TCP の中継の時間切れ（idle_timeout）: 上限なし（0s） → 10m']);
    expect(ruleChanges(rule, rule)).toEqual([]);
  });
});

describe('global.http.timeouts の v0.4.20 の項目（features.http_stream_limits）', () => {
  const item = (apiValue?: unknown): GlobalItem => ({
    value: {}, source: apiValue === undefined ? 'default' : 'api', apply: 'live', unix_only: false, settable: true,
    ...(apiValue !== undefined ? { api_value: apiValue } : {}),
  });

  it('features があるときだけ write_stall・upgraded_idle・http2_max_streams の欄を出す', () => {
    expect(httpTimeoutKeys(false)).not.toContain('write_stall');
    expect(httpTimeoutKeys(true)).toEqual(expect.arrayContaining(['write_stall', 'upgraded_idle', 'http2_max_streams', 'idle']));
    const form = toGlobalForm('http.timeouts', item(), true);
    expect(form.kind === 'fields' && form.keys).toEqual(expect.arrayContaining(['write_stall', 'upgraded_idle', 'http2_max_streams']));
    const old = toGlobalForm('http.timeouts', item(), false);
    expect(old.kind === 'fields' && old.keys.includes('http2_max_streams')).toBe(false);
  });

  it('API の値にある名前は features がなくても欄に出す（丸ごとの置き換えで落とさない）', () => {
    const form = toGlobalForm('http.timeouts', item({ idle: '5m', http2_max_streams: 256 }), false);
    expect(form.kind === 'fields' && form.fields).toMatchObject({ idle: '5m', http2_max_streams: '256' });
  });

  it('http2_max_streams は数で送り、1〜10000 の外は断る', () => {
    const form = toGlobalForm('http.timeouts', item(), true);
    if (form.kind !== 'fields') throw new Error('fields');
    const set = (fields: Record<string, string>) => buildGlobalValue('http.timeouts', { ...form, fields: { ...form.fields, ...fields } });
    expect(set({ write_stall: '30s', upgraded_idle: '0s', http2_max_streams: '512' })).toEqual({ write_stall: '30s', upgraded_idle: '0s', http2_max_streams: 512 });
    expect(set({ write_stall: '30s' })).toEqual({ write_stall: '30s' });
    for (const bad of ['0', '10001', '1.5', 'many']) expect(() => set({ http2_max_streams: bad })).toThrow(GlobalPatchError);
    expect(set({ http2_max_streams: '10000' })).toEqual({ http2_max_streams: 10000 });
  });
});

describe('mirror の max_in_flight（#356）', () => {
  const http = (mirror: Record<string, unknown>): HttpRules => toHttpRules({
    routes: [{ name: 'app', match: 'PathPrefix(`/`)', service: 'app', middlewares: ['copy'] }],
    services: { app: { servers: [{ url: 'http://10.0.0.1:8080' }] }, shadow: { servers: [{ url: 'http://10.0.0.2:8080' }] } },
    middlewares: { copy: { mirror: { service: 'shadow', ...mirror } } },
  } as never);

  it('1〜10000 の整数だけ', () => {
    expect(validateHttp(http({ max_in_flight: 64 }))).toEqual([]);
    expect(validateHttp(http({ max_in_flight: 10000 }))).toEqual([]);
    expect(validateHttp(http({}))).toEqual([]);
    for (const bad of [0, 10001, 1.5, '64']) {
      expect(validateHttp(http({ max_in_flight: bad })).join('\n')).toContain('max_in_flight');
    }
  });
});
