import { describe, expect, it } from 'vitest';
import {
  normalizeBandwidth, normalizeGeoip, normalizeHttpOutlier, normalizeL4Outlier, normalizeLabels, normalizeLimits, normalizeV04,
  parseDurationMs, parseRate, parseSize, v04Fields, v04PatchFields,
} from '@/components/v04';
import { buildV04, toV04Form } from '@/components/v04form';
import { optionsJson, parseOptions, DEFAULT_TLS, NO_BALANCING } from '@/components/tls';
import { toRproxyRule, settingsRuleToBody } from '@/components/settingsdoc';
import { toRproxyPatch, fromRow, ruleOptions } from '@/components/ruledb';
import { ruleDrift } from '@/components/drift';
import { ruleFromStatus, toRule } from '@/components/dashboard';
import { ruleChanges } from '@/components/history';
import { validateHttp, cleanHttp, toHttpRules } from '@/components/httpspec';
import type { ForwardRule } from '@/components/lib';
import type { RproxyRuleStatus } from '@/components/rproxy';

const base: ForwardRule = {
  protocol: 'udp', srcAddr: '0.0.0.0', srcPort: 27015, srcPortEnd: null, distAddr: '10.0.0.10', distPort: 27015,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [],
  http: null, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null, extraListenAddrs: [],
};

const v04 = {
  labels: { tenant: 'act', service: 'game' },
  limits: { max_connections: 20000, per_source: { max_connections: 8, new_connections: { average: 10, period: '1s', burst: 20 }, packets: { average: 2000 } } },
  bandwidth: { download: '500Mbps', per_source: { upload: '2Mbps', download: '10Mbps' } },
  geoip: { allow_countries: ['JP'] },
  outlier_detection: { consecutive_failures: 3, ejection_time: '10s', max_ejection_time: '5m', max_ejected_percent: 50 },
};

describe('v0.4 の値の検証（rproxy と同じ規則）', () => {
  it('単位を読む', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('1h30m')).toBeNull();
    expect(parseRate('10Mbps')).toBe(10_000_000);
    expect(parseRate('10mbps')).toBeNull();
    expect(parseSize('64KiB')).toBe(65536);
    expect(parseSize('4096')).toBe(4096);
  });

  it('labels のキーと値', () => {
    expect(normalizeLabels({ b: '2', a: '1' })).toEqual({ a: '1', b: '2' });
    expect(normalizeLabels({ 'gateway.networking.k8s.io/gateway-name': 'web' })).toBeTruthy();
    expect(() => normalizeLabels({ '-bad': 'x' })).toThrow(/キー/);
    expect(() => normalizeLabels({ a: 'x\ny' })).toThrow(/制御文字/);
    expect(() => normalizeLabels(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])))).toThrow(/16/);
  });

  it('limits', () => {
    expect(normalizeLimits(v04.limits, 'udp')).toEqual(v04.limits);
    expect(normalizeLimits({}, 'tcp')).toBeNull();
    expect(() => normalizeLimits({ per_source: { packets: { average: 1 } } }, 'tcp')).toThrow(/UDP/);
    expect(() => normalizeLimits({ max_connections: 0 })).toThrow(/1〜10000000/);
    expect(() => normalizeLimits({ per_source: { prefix_v4: 33, max_connections: 1 } })).toThrow();
    expect(() => normalizeLimits({ per_source: { prefix_v4: 24 } })).toThrow(/どれか/);
    expect(() => normalizeLimits({ per_source: { new_connections: { average: 10, burst: 5 } } })).toThrow(/バースト/);
    expect(() => normalizeLimits({ per_source: { new_connections: { average: 10, period: '2h' } } })).toThrow(/範囲/);
    expect(() => normalizeLimits({ max_conns: 1 })).toThrow(/不明な項目/);
  });

  it('bandwidth', () => {
    expect(normalizeBandwidth(v04.bandwidth)).toEqual(v04.bandwidth);
    expect(normalizeBandwidth({})).toBeNull();
    expect(() => normalizeBandwidth({ upload: '1kbps' })).toThrow(/8kbps/);
    expect(() => normalizeBandwidth({ burst: '1MiB' })).toThrow(/どれか/);
    expect(() => normalizeBandwidth({ download: '1Mbps', burst: '2GiB' })).toThrow(/1KiB/);
    expect(() => normalizeBandwidth({ per_source: { prefix_v4: 24 } })).toThrow(/上りか下り/);
  });

  it('geoip', () => {
    expect(normalizeGeoip({ allow_countries: ['jp', 'JP'], deny_asns: ['AS64496'] })).toEqual({ allow_countries: ['JP'], deny_asns: [64496] });
    expect(normalizeGeoip({ unknown: 'allow' })).toBeNull();
    expect(() => normalizeGeoip({ unknown: 'deny' })).toThrow(/リスト/);
    expect(() => normalizeGeoip({ allow_countries: ['JPN'] })).toThrow(/国のコード/);
    expect(() => normalizeGeoip({ allow_countries: ['JP'], deny_countries: ['JP'] })).toThrow(/両方/);
    expect(() => normalizeGeoip({ allow_asns: [0] })).toThrow(/AS 番号/);
    // 件数の上限（セキュリティレビュー L7）
    expect(normalizeGeoip({ allow_asns: Array.from({ length: 256 }, (_, i) => i + 1) })?.allow_asns).toHaveLength(256);
    expect(() => normalizeGeoip({ allow_asns: Array.from({ length: 257 }, (_, i) => i + 1) })).toThrow(/256 件まで/);
    expect(() => normalizeGeoip({ deny_countries: Array.from({ length: 257 }, () => 'JP') })).toThrow(/256 件まで/);
  });

  it('outlier_detection（L4 と L7）', () => {
    expect(normalizeL4Outlier(v04.outlier_detection)).toEqual(v04.outlier_detection);
    expect(() => normalizeL4Outlier({ ejection_time: '1m', max_ejection_time: '30s' })).toThrow(/上限/);
    expect(() => normalizeL4Outlier({ max_ejection_time: '5s' })).toThrow(/上限/);
    expect(() => normalizeL4Outlier({ max_ejected_percent: 101 })).toThrow();
    expect(() => normalizeL4Outlier({ short_lived: '2m' })).toThrow(/範囲/);
    expect(normalizeHttpOutlier({ consecutive_5xx: 5, failure_percent: 50, window: '30s' })).toEqual({ consecutive_5xx: 5, failure_percent: 50, window: '30s' });
    expect(() => normalizeHttpOutlier({ consecutive_5xx: 0, consecutive_gateway_failures: 0 })).toThrow(/0/);
    expect(() => normalizeHttpOutlier({ min_requests: 0 })).toThrow();
  });

  it('L7 のルールにはルールの outlier_detection を付けられない', () => {
    expect(() => normalizeV04({ outlier_detection: { consecutive_failures: 2 } }, 'tcp', true)).toThrow(/L7/);
  });
});

describe('PATCH と DB と rproxy の形', () => {
  const rule: ForwardRule = { ...base, ...normalizeV04(v04, 'udp') };

  it('rproxy の POST の本文と DB の options に同じ形で書き、読み戻せる', () => {
    expect(toRproxyRule(rule)).toMatchObject(v04);
    const opts = ruleOptions(rule)!;
    expect(JSON.parse(opts)).toMatchObject(v04);
    const back = fromRow({ protocol: 'udp', src_addr: '0.0.0.0', src_port: 27015, src_port_end: null, dist_addr: '10.0.0.10', dist_port: 27015, source_ip: 'proxy', udp_idle_secs: 30, options: opts });
    expect(v04Fields(back)).toEqual(v04);
    // 使わなければ options は今までどおり NULL
    expect(optionsJson(DEFAULT_TLS, null, true, [], null, false, NO_BALANCING, [], true, {})).toBeNull();
    expect(parseOptions(null).v04).toEqual({});
  });

  it('PATCH はあるものを置き換え、なくなったものを {} で外し、どちらもないものは送らない', () => {
    expect(v04PatchFields({ labels: { a: '1' } }, { labels: { a: '0' }, limits: { max_connections: 1 } })).toEqual({ labels: { a: '1' }, limits: {} });
    expect(v04PatchFields({}, {})).toEqual({});
    const patch = toRproxyPatch({ ...base, geoip: { deny_countries: ['XX'] } }, false, false, false, { bandwidth: { upload: '1Mbps' } });
    expect(patch.geoip).toEqual({ deny_countries: ['XX'] });
    expect(patch.bandwidth).toEqual({});
    expect('labels' in patch).toBe(false);
  });

  it('エクスポートの形から読み込める（outlier_detection は outlierDetection に）', () => {
    const body = settingsRuleToBody({ protocol: 'udp', listen_addr: '0.0.0.0', listen_port: 1, remote_addr: 'a', remote_port: 1, ...v04 });
    expect(body.outlierDetection).toEqual(v04.outlier_detection);
    expect(body.labels).toEqual(v04.labels);
  });

  it('ずれと履歴と表示', () => {
    const live = { ...toRproxyRule(rule), state: 'running', error: null, resolved: [], connections: 0, conditions: [{ type: 'Accepted', status: 'True', reason: 'Accepted', message: '', last_transition: 1 }] } as RproxyRuleStatus;
    expect(ruleDrift(rule, live)).toEqual([]);
    expect(ruleDrift({ ...rule, labels: { tenant: 'other' } }, live)).toEqual(['labels']);
    expect(ruleDrift({ ...rule, limits: undefined }, live)).toEqual(['limits']);
    const shown = ruleFromStatus(live, 1);
    expect(v04Fields(shown)).toEqual(v04);
    expect(shown.conditions?.[0].type).toBe('Accepted');
    expect(v04Fields(toRule(shown))).toEqual(v04);
    expect(ruleChanges(rule, { ...rule, bandwidth: undefined, labels: { a: 'b' } })).toEqual(['ラベルを変更', '帯域の上限を変更']);
  });
});

describe('フォームの欄', () => {
  const all = { labels: true, limits: true, bandwidth: true, geoip: true, outlier_detection: true };
  const none = { labels: false, limits: false, bandwidth: false, geoip: false, outlier_detection: false };
  const current = normalizeV04(v04, 'udp');

  it('値から欄を作り、欄から同じ値に戻す', () => {
    expect(buildV04(toV04Form(current), 'udp', false, all, {})).toEqual(current);
  });

  it('使えない項目は欄を見ずに今の値を残す', () => {
    const form = toV04Form({});
    expect(buildV04(form, 'udp', false, none, current)).toEqual(current);
    expect(buildV04(form, 'udp', false, all, current)).toEqual({});
  });

  it('欄の誤り', () => {
    const form = toV04Form({});
    expect(() => buildV04({ ...form, maxConnections: 'abc' }, 'tcp', false, all, {})).toThrow(/整数/);
    expect(() => buildV04({ ...form, labels: [{ key: '', value: 'x' }] }, 'tcp', false, all, {})).toThrow(/キー/);
    expect(() => buildV04({ ...form, newConnections: { average: '', period: '1s', burst: '' } }, 'tcp', false, all, {})).toThrow(/平均/);
    expect(() => buildV04({ ...form, upload: '10 Mbps' }, 'tcp', false, all, {})).toThrow(/10Mbps/);
  });

  it('TCP ではデータグラムの速さを、L7 ではルールの受け身のヘルスチェックを送らない', () => {
    const form = { ...toV04Form({}), packets: { average: '5', period: '', burst: '' }, consecutiveFailures: '3' };
    expect(buildV04(form, 'tcp', true, all, {})).toEqual({});
  });
});

describe('L7 のサービスの outlier_detection とミドルウェアの geoip', () => {
  it('保存する形に残り、誤りは validateHttp が出す', () => {
    const spec = toHttpRules({ routes: [{ name: 'a', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'http://10.0.0.1' }], outlier_detection: { consecutive_5xx: 3 } } } });
    expect((cleanHttp(spec).services as Record<string, Record<string, unknown>>).s.outlier_detection).toEqual({ consecutive_5xx: 3 });
    const bad = { ...spec, services: { s: { servers: [{ url: 'http://10.0.0.1' }], outlier_detection: { max_ejected_percent: 200 } } } };
    expect(validateHttp(bad).join(' ')).toContain('受け身のヘルスチェック');
  });
});
