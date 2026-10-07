// v0.4 のルールの項目（rproxy-api の docs/API.md「v0.4 の設定」・docs/DESIGN-v0.4.md）：
// ラベル（labels）、L4 の制限（limits、#165）、帯域（bandwidth、#166）、GeoIP（geoip、#168）、受け身のヘルスチェック（outlier_detection、#170）。
// 形と検証は rproxy の src/core/limits.rs・bandwidth.rs・outlier.rs・net/geoip.rs・core/ruleset.rs と同じにしてある（最終的な判定は rproxy）。
// 画面（RuleForm）と API route の両方で使う。React と Node に依存しない（tests/v04.test.ts）

import type { Protocol } from './lib';
import { TlsError } from './tlserror';

export type Labels = Record<string, string>;

// 速さ（新しい接続・UDP のデータグラム）。L7 の rate_limit と同じ形
export interface RateSpec {
  average: number;
  // 1ms〜1h（既定 1s）
  period?: string;
  // average 以上（既定 average）
  burst?: number;
}

export interface LimitsSpec {
  max_connections?: number;
  per_source?: {
    prefix_v4?: number;
    prefix_v6?: number;
    max_connections?: number;
    new_connections?: RateSpec;
    // UDP だけ
    packets?: RateSpec;
    max_sources?: number;
  };
}

export interface BandwidthSpec {
  upload?: string;
  download?: string;
  burst?: string;
  per_source?: {
    upload?: string;
    download?: string;
    prefix_v4?: number;
    prefix_v6?: number;
    max_sources?: number;
  };
}

export type GeoipUnknown = 'allow' | 'deny';

export interface GeoipSpec {
  allow_countries?: string[];
  deny_countries?: string[];
  allow_asns?: number[];
  deny_asns?: number[];
  // 既定 allow（そのときは省く）
  unknown?: GeoipUnknown;
}

export interface L4OutlierSpec {
  consecutive_failures?: number;
  short_lived?: string;
  ejection_time?: string;
  max_ejection_time?: string;
  max_ejected_percent?: number;
}

export interface HttpOutlierSpec {
  consecutive_5xx?: number;
  consecutive_gateway_failures?: number;
  failure_percent?: number;
  min_requests?: number;
  window?: string;
  ejection_time?: string;
  max_ejection_time?: string;
  max_ejected_percent?: number;
}

// ルールの v0.4 の項目（ForwardRule に同じ名前で付く。ないものは省く）
export interface V04Settings {
  labels?: Labels;
  limits?: LimitsSpec;
  bandwidth?: BandwidthSpec;
  geoip?: GeoipSpec;
  outlierDetection?: L4OutlierSpec;
}

// rproxy・DB の options での名前（snake_case）と ForwardRule での名前
export const V04_KEYS = ['labels', 'limits', 'bandwidth', 'geoip', 'outlier_detection'] as const;
export type V04Key = typeof V04_KEYS[number];

// GET /capabilities の features の名前（labels・limits・bandwidth・geoip・outlier_detection と同じ）
export type V04Feature = V04Key;

// Gateway API の形の状態（ルールの conditions。features.conditions）
export interface Condition {
  type: 'Accepted' | 'Programmed' | 'ResolvedRefs' | 'BackendsHealthy' | string;
  status: 'True' | 'False' | string;
  reason: string;
  message: string;
  // Unix 秒
  last_transition: number;
}

// ?dry_run=true の応答（RulePlan）
export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export interface RulePlan {
  dry_run: boolean;
  action: 'create' | 'update' | 'delete' | 'none';
  change: 'none' | 'in_place' | 'recreate';
  rule: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff: DiffEntry[];
  warnings: string[];
}

function invalid(message: string): TlsError {
  return new TlsError(message, 'invalid');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw invalid(`${where} に不明な項目があります: ${unknown.join(', ')}`);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

// 整数（省略・null・'' は undefined）。範囲の外は invalid
function intIn(value: unknown, where: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isInt(value) || value < min || value > max) throw invalid(`${where} は ${min}〜${max} の整数で指定してください。`);
  return value;
}

function str(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${where} は文字列で指定してください。`);
  const s = value.trim();
  return s === '' ? undefined : s;
}

// rproxy の l7::parse_duration と同じ：数字と単位（ms・s・m・h）1 つ。ミリ秒にする（読めなければ null）
export function parseDurationMs(s: string): number | null {
  const m = /^([0-9]+)(ms|s|m|h)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  return ms <= 365 * 24 * 3_600_000 ? ms : null;
}

const HOUR = 3_600_000;

// 時間の文字列を確かめる（min〜max ミリ秒）
function duration(value: unknown, where: string, min: number, max: number, example: string): string | undefined {
  const s = str(value, where);
  if (s === undefined) return undefined;
  const ms = s === '0s' ? 0 : parseDurationMs(s);
  if (ms === null) throw invalid(`${where} は ${example} のように数と単位（ms・s・m・h）で指定してください。`);
  if (ms < min || ms > max) throw invalid(`${where} の範囲の外です（${formatMs(min)}〜${formatMs(max)}）。`);
  return s;
}

function formatMs(ms: number): string {
  if (ms === 0) return '0s';
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

// 帯域（ビット毎秒）："<数><bps|kbps|Mbps|Gbps>"、8kbps〜100Gbps。読めなければ null
export function parseRate(s: string): number | null {
  const m = /^([0-9]+)(bps|kbps|Mbps|Gbps)$/.exec(s);
  if (!m) return null;
  const mult = m[2] === 'bps' ? 1 : m[2] === 'kbps' ? 1e3 : m[2] === 'Mbps' ? 1e6 : 1e9;
  return Number(m[1]) * mult;
}

// 量（バイト）：数だけか "<数><B|KiB|MiB|GiB>"。読めなければ null
export function parseSize(s: string): number | null {
  const m = /^([0-9]+)(B|KiB|MiB|GiB)?$/.exec(s);
  if (!m) return null;
  const mult = m[2] === 'KiB' ? 1024 : m[2] === 'MiB' ? 1024 ** 2 : m[2] === 'GiB' ? 1024 ** 3 : 1;
  return Number(m[1]) * mult;
}

function rate(value: unknown, where: string): string | undefined {
  const s = str(value, where);
  if (s === undefined) return undefined;
  const n = parseRate(s);
  if (n === null) throw invalid(`${where} は 500kbps・10Mbps・1Gbps のように指定してください。`);
  if (n < 8e3 || n > 100e9) throw invalid(`${where} は 8kbps〜100Gbps で指定してください。`);
  return s;
}

// ---- labels ----

export const MAX_LABELS = 16;
const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,61}[A-Za-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizeLabels(value: unknown): Labels {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw invalid('ラベル（labels）は {キー: 値} の形で指定してください。');
  const entries = Object.entries(value);
  if (entries.length > MAX_LABELS) throw invalid(`ラベルは ${MAX_LABELS} 個までです。`);
  const out: Labels = {};
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!LABEL_KEY.test(k)) throw invalid(`ラベルのキー ${k} は英数字と . _ / - の 63 文字までにしてください（先頭と末尾は英数字）。`);
    if (typeof v !== 'string') throw invalid(`ラベル ${k} の値は文字列で指定してください。`);
    if ([...v].length > 253 || CONTROL.test(v)) throw invalid(`ラベル ${k} の値は制御文字なしの 253 文字までにしてください。`);
    out[k] = v;
  }
  return out;
}

// ---- limits（#165） ----

function rateSpec(value: unknown, where: string): RateSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw invalid(`${where} の形式が不正です。`);
  checkKeys(value, ['average', 'period', 'burst'], where);
  if (!isInt(value.average) || value.average < 1) throw invalid(`${where} の平均（average）は 1 以上の整数で指定してください。`);
  const period = duration(value.period, `${where} の期間（period）`, 1, HOUR, '1s');
  const burst = intIn(value.burst, `${where} のバースト（burst）`, 1, Number.MAX_SAFE_INTEGER);
  if (burst !== undefined && burst < value.average) throw invalid(`${where} のバースト（burst）は平均（average）以上にしてください。`);
  return { average: value.average, ...(period !== undefined ? { period: period } : {}), ...(burst !== undefined ? { burst: burst } : {}) };
}

// {} や中身のないものは null（「上限なし」）
export function normalizeLimits(value: unknown, protocol?: Protocol): LimitsSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid('L4 の制限（limits）の形式が不正です。');
  checkKeys(value, ['max_connections', 'per_source'], 'limits');
  const out: LimitsSpec = {};
  const max = intIn(value.max_connections, 'ルール全体の同時接続数', 1, 10_000_000);
  if (max !== undefined) out.max_connections = max;
  if (value.per_source !== undefined && value.per_source !== null) {
    const p = value.per_source;
    if (!isObject(p)) throw invalid('送信元ごとの制限（limits.per_source）の形式が不正です。');
    checkKeys(p, ['prefix_v4', 'prefix_v6', 'max_connections', 'new_connections', 'packets', 'max_sources'], 'limits.per_source');
    const ps: NonNullable<LimitsSpec['per_source']> = {};
    const v4 = intIn(p.prefix_v4, '送信元をまとめる大きさ（IPv4）', 1, 32);
    const v6 = intIn(p.prefix_v6, '送信元をまとめる大きさ（IPv6）', 1, 128);
    const mc = intIn(p.max_connections, '送信元ごとの同時接続数', 1, 1_000_000);
    const nc = rateSpec(p.new_connections, '新しい接続の速さ');
    const pk = rateSpec(p.packets, 'データグラムの速さ');
    const ms = intIn(p.max_sources, '覚える送信元の数', 1, 10_000_000);
    if (v4 !== undefined) ps.prefix_v4 = v4;
    if (v6 !== undefined) ps.prefix_v6 = v6;
    if (mc !== undefined) ps.max_connections = mc;
    if (nc !== undefined) ps.new_connections = nc;
    if (pk !== undefined) {
      if (protocol === 'tcp') throw invalid('データグラムの速さ（packets）は UDP のルールでだけ使えます。');
      ps.packets = pk;
    }
    if (ms !== undefined) ps.max_sources = ms;
    if (Object.keys(ps).length > 0) {
      if (mc === undefined && nc === undefined && pk === undefined) {
        throw invalid('送信元ごとの制限には、同時接続数・新しい接続の速さ・データグラムの速さのどれかを指定してください。');
      }
      out.per_source = ps;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---- bandwidth（#166） ----

export function normalizeBandwidth(value: unknown): BandwidthSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid('帯域の上限（bandwidth）の形式が不正です。');
  checkKeys(value, ['upload', 'download', 'burst', 'per_source'], 'bandwidth');
  const out: BandwidthSpec = {};
  const up = rate(value.upload, 'ルール全体の上り（upload）');
  const down = rate(value.download, 'ルール全体の下り（download）');
  if (up !== undefined) out.upload = up;
  if (down !== undefined) out.download = down;
  const burst = str(value.burst, 'バースト（burst）');
  if (burst !== undefined) {
    const n = parseSize(burst);
    if (n === null) throw invalid('バースト（burst）は 64KiB・1MiB のように指定してください。');
    if (n < 1024 || n > 1024 ** 3) throw invalid('バースト（burst）は 1KiB〜1GiB で指定してください。');
    out.burst = burst;
  }
  if (value.per_source !== undefined && value.per_source !== null) {
    const p = value.per_source;
    if (!isObject(p)) throw invalid('送信元ごとの帯域（bandwidth.per_source）の形式が不正です。');
    checkKeys(p, ['upload', 'download', 'prefix_v4', 'prefix_v6', 'max_sources'], 'bandwidth.per_source');
    const ps: NonNullable<BandwidthSpec['per_source']> = {};
    const pu = rate(p.upload, '送信元ごとの上り（upload）');
    const pd = rate(p.download, '送信元ごとの下り（download）');
    const v4 = intIn(p.prefix_v4, '送信元をまとめる大きさ（IPv4）', 1, 32);
    const v6 = intIn(p.prefix_v6, '送信元をまとめる大きさ（IPv6）', 1, 128);
    const ms = intIn(p.max_sources, '覚える送信元の数', 1, 10_000_000);
    if (pu !== undefined) ps.upload = pu;
    if (pd !== undefined) ps.download = pd;
    if (v4 !== undefined) ps.prefix_v4 = v4;
    if (v6 !== undefined) ps.prefix_v6 = v6;
    if (ms !== undefined) ps.max_sources = ms;
    if (Object.keys(ps).length > 0) {
      if (pu === undefined && pd === undefined) throw invalid('送信元ごとの帯域には、上りか下りの速さを指定してください。');
      out.per_source = ps;
    }
  }
  if (Object.keys(out).length === 0) return null;
  if (out.upload === undefined && out.download === undefined && out.per_source === undefined) {
    throw invalid('帯域の上限には、上り・下り・送信元ごとの速さのどれかを指定してください。');
  }
  return out;
}

// ---- geoip（#168） ----

const COUNTRY = /^[A-Z]{2}$/;
// 国・AS の一覧の件数の上限（ラベルと同じく、DB の options と rproxy に送る量を抑える。セキュリティレビュー L7）
export const MAX_GEOIP_ITEMS = 256;

function countries(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${where} は配列で指定してください。`);
  if (value.length > MAX_GEOIP_ITEMS) throw invalid(`${where} は ${MAX_GEOIP_ITEMS} 件までです。`);
  const out: string[] = [];
  for (const c of value) {
    const s = typeof c === 'string' ? c.trim().toUpperCase() : '';
    if (!COUNTRY.test(s)) throw invalid(`${where}: ${String(c)} は国のコード（ISO 3166-1 alpha-2、例 JP）ではありません。`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function asns(value: unknown, where: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${where} は配列で指定してください。`);
  if (value.length > MAX_GEOIP_ITEMS) throw invalid(`${where} は ${MAX_GEOIP_ITEMS} 件までです。`);
  const out: number[] = [];
  for (const a of value) {
    const n = typeof a === 'string' && /^(AS)?[0-9]+$/i.test(a.trim()) ? Number(a.trim().replace(/^AS/i, '')) : a;
    if (!isInt(n) || n < 1 || n > 4294967295) throw invalid(`${where}: ${String(a)} は AS 番号（1〜4294967295）ではありません。`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// L4 のルールの geoip とミドルウェアの geoip（同じ形）。リストが 1 つもなければ null
export function normalizeGeoip(value: unknown): GeoipSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid('GeoIP（geoip）の形式が不正です。');
  checkKeys(value, ['allow_countries', 'deny_countries', 'allow_asns', 'deny_asns', 'unknown'], 'geoip');
  const ac = countries(value.allow_countries, '許可する国');
  const dc = countries(value.deny_countries, '拒否する国');
  const aa = asns(value.allow_asns, '許可する AS');
  const da = asns(value.deny_asns, '拒否する AS');
  const unknown = value.unknown ?? 'allow';
  if (unknown !== 'allow' && unknown !== 'deny') throw invalid('判定できないとき（unknown）は allow か deny を指定してください。');
  if (ac.length + dc.length + aa.length + da.length === 0) {
    if (unknown === 'deny') throw invalid('GeoIP には、国か AS のリストを 1 つ以上指定してください。');
    return null;
  }
  const both = ac.find((c) => dc.includes(c));
  if (both) throw invalid(`国 ${both} が許可と拒否の両方にあります。`);
  const bothAs = aa.find((a) => da.includes(a));
  if (bothAs !== undefined) throw invalid(`AS${bothAs} が許可と拒否の両方にあります。`);
  return {
    ...(ac.length > 0 ? { allow_countries: ac } : {}),
    ...(dc.length > 0 ? { deny_countries: dc } : {}),
    ...(aa.length > 0 ? { allow_asns: aa } : {}),
    ...(da.length > 0 ? { deny_asns: da } : {}),
    ...(unknown === 'deny' ? { unknown: 'deny' as const } : {}),
  };
}

// ---- outlier_detection（#170） ----

function ejection(first: string | undefined, max: string | undefined, defaultFirstMs: number): void {
  if (max === undefined) return;
  const f = first !== undefined ? parseDurationMs(first) ?? 0 : defaultFirstMs;
  if ((parseDurationMs(max) ?? 0) < f) throw invalid('外す時間の上限（max_ejection_time）は最初に外す時間（ejection_time）以上にしてください。');
}

const L4_OUTLIER_KEYS = ['consecutive_failures', 'short_lived', 'ejection_time', 'max_ejection_time', 'max_ejected_percent'];

export function normalizeL4Outlier(value: unknown): L4OutlierSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid('受け身のヘルスチェック（outlier_detection）の形式が不正です。');
  checkKeys(value, L4_OUTLIER_KEYS, 'outlier_detection');
  const out: L4OutlierSpec = {};
  const cf = intIn(value.consecutive_failures, '続けて失敗した回数', 1, 1000);
  const sl = duration(value.short_lived, '短すぎる接続（short_lived）', 0, 60_000, '0s');
  const et = duration(value.ejection_time, '最初に外す時間（ejection_time）', 1000, HOUR, '10s');
  const mt = duration(value.max_ejection_time, '外す時間の上限（max_ejection_time）', 1000, HOUR, '5m');
  const mp = intIn(value.max_ejected_percent, '同時に外せる割合（%）', 0, 100);
  ejection(et, mt, 10_000);
  if (cf !== undefined) out.consecutive_failures = cf;
  if (sl !== undefined) out.short_lived = sl;
  if (et !== undefined) out.ejection_time = et;
  if (mt !== undefined) out.max_ejection_time = mt;
  if (mp !== undefined) out.max_ejected_percent = mp;
  return Object.keys(out).length > 0 ? out : null;
}

const HTTP_OUTLIER_KEYS = ['consecutive_5xx', 'consecutive_gateway_failures', 'failure_percent', 'min_requests', 'window', 'ejection_time', 'max_ejection_time', 'max_ejected_percent'];

// L7 のサービスの outlier_detection（http.services.<名前>.outlier_detection）。where は画面に出す場所
export function normalizeHttpOutlier(value: unknown, where = 'outlier_detection'): HttpOutlierSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid(`${where} の形式が不正です。`);
  checkKeys(value, HTTP_OUTLIER_KEYS, where);
  const out: HttpOutlierSpec = {};
  const c5 = intIn(value.consecutive_5xx, `${where}: 続けて 5xx を返した回数`, 0, 1000);
  const cg = intIn(value.consecutive_gateway_failures, `${where}: 続けて転送先に届かなかった回数`, 0, 1000);
  const fp = intIn(value.failure_percent, `${where}: 失敗の割合（%）`, 1, 100);
  const mr = intIn(value.min_requests, `${where}: 割合を見る最小のリクエスト数`, 1, 1_000_000);
  const w = duration(value.window, `${where}: 割合を数える時間（window）`, 1, 365 * 24 * HOUR, '30s');
  const et = duration(value.ejection_time, `${where}: 最初に外す時間（ejection_time）`, 1000, HOUR, '30s');
  const mt = duration(value.max_ejection_time, `${where}: 外す時間の上限（max_ejection_time）`, 1000, HOUR, '5m');
  const mp = intIn(value.max_ejected_percent, `${where}: 同時に外せる割合（%）`, 0, 100);
  ejection(et, mt, 30_000);
  if (c5 === 0 && cg === 0 && fp === undefined) throw invalid(`${where}: すべての判定が 0（見ない）になっています。`);
  if (c5 !== undefined) out.consecutive_5xx = c5;
  if (cg !== undefined) out.consecutive_gateway_failures = cg;
  if (fp !== undefined) out.failure_percent = fp;
  if (mr !== undefined) out.min_requests = mr;
  if (w !== undefined) out.window = w;
  if (et !== undefined) out.ejection_time = et;
  if (mt !== undefined) out.max_ejection_time = mt;
  if (mp !== undefined) out.max_ejected_percent = mp;
  return Object.keys(out).length > 0 ? out : null;
}

// ---- まとめて ----

// API の本文・DB の options・rproxy の応答（snake_case のキー）から v0.4 の項目を読む。
// rule は本文の名前（camelCase の outlierDetection）も受け付ける。http: L7 のルールか（outlier_detection は使えない）
export function normalizeV04(source: Record<string, unknown>, protocol?: Protocol, http = false): V04Settings {
  const out: V04Settings = {};
  const labels = normalizeLabels(source.labels);
  if (Object.keys(labels).length > 0) out.labels = labels;
  const limits = normalizeLimits(source.limits, protocol);
  if (limits) out.limits = limits;
  const bandwidth = normalizeBandwidth(source.bandwidth);
  if (bandwidth) out.bandwidth = bandwidth;
  const geoip = normalizeGeoip(source.geoip);
  if (geoip) out.geoip = geoip;
  const outlier = normalizeL4Outlier(source.outlier_detection ?? source.outlierDetection);
  if (outlier) {
    if (http) throw invalid('L7（HTTP）のルールでは、ルールの受け身のヘルスチェックは使えません（L7 タブのサービスごとに設定します）。');
    out.outlierDetection = outlier;
  }
  return out;
}

// ルールの v0.4 の項目だけを取り出す（ないものは省く）
export function v04Of(rule: V04Settings): V04Settings {
  const out: V04Settings = {};
  if (rule.labels && Object.keys(rule.labels).length > 0) out.labels = rule.labels;
  if (rule.limits) out.limits = rule.limits;
  if (rule.bandwidth) out.bandwidth = rule.bandwidth;
  if (rule.geoip) out.geoip = rule.geoip;
  if (rule.outlierDetection) out.outlierDetection = rule.outlierDetection;
  return out;
}

// rproxy・DB の options の形（snake_case）
export interface V04Wire {
  labels?: Labels;
  limits?: LimitsSpec;
  bandwidth?: BandwidthSpec;
  geoip?: GeoipSpec;
  outlier_detection?: L4OutlierSpec;
}

// PATCH の形（{} は外す）
export type V04Patch = { [K in keyof V04Wire]?: V04Wire[K] | Record<string, never> };

// rproxy・DB の options の形（snake_case）。あるものだけ
export function v04Fields(rule: V04Settings): V04Wire {
  const v = v04Of(rule);
  return {
    ...(v.labels !== undefined ? { labels: v.labels } : {}),
    ...(v.limits !== undefined ? { limits: v.limits } : {}),
    ...(v.bandwidth !== undefined ? { bandwidth: v.bandwidth } : {}),
    ...(v.geoip !== undefined ? { geoip: v.geoip } : {}),
    ...(v.outlierDetection !== undefined ? { outlier_detection: v.outlierDetection } : {}),
  };
}

// PATCH の v0.4 の項目：今あるものは丸ごと置き換え、前にあって今ないものは {} で外す（どちらもないものは送らない。
// 古い rproxy は知らない項目を断るので）
export function v04PatchFields(after: V04Settings, before?: V04Settings): V04Patch {
  const out: V04Patch = { ...v04Fields(after) };
  const prev = before ? v04Fields(before) : {};
  for (const key of V04_KEYS) {
    if (out[key] === undefined && prev[key] !== undefined) out[key] = {};
  }
  return out;
}

// 使っている v0.4 の項目（features の名前）
export function usedV04Features(rule: V04Settings): V04Feature[] {
  return Object.keys(v04Fields(rule)) as V04Feature[];
}

// 画面の名前
export const V04_LABELS: Record<V04Key, string> = {
  labels: 'ラベル',
  limits: 'L4 の制限',
  bandwidth: '帯域の上限',
  geoip: 'GeoIP',
  outlier_detection: '受け身のヘルスチェック',
};

// ---- 画面の表示 ----

export function rateLabel(r: RateSpec): string {
  return `${r.average} / ${r.period ?? '1s'}${r.burst !== undefined ? `（burst ${r.burst}）` : ''}`;
}

export function asnLabel(a: number): string {
  return `AS${a}`;
}

// conditions の 1 つが悪いか（status が False）
export function conditionProblem(c: Condition): boolean {
  return c.status === 'False';
}

export const CONDITION_LABELS: Record<string, string> = {
  Accepted: '受け付け（Accepted）',
  Programmed: '待ち受け（Programmed）',
  ResolvedRefs: '参照の解決（ResolvedRefs）',
  BackendsHealthy: '転送先の状態（BackendsHealthy）',
};

export const PLAN_ACTION_LABELS: Record<RulePlan['action'], string> = {
  create: '作成',
  update: '変更',
  delete: '削除',
  none: '変更なし',
};

export const PLAN_CHANGE_LABELS: Record<RulePlan['change'], string> = {
  none: '変わらない',
  in_place: '接続を切らずに変わる',
  recreate: '待ち受けを作り直す（今の接続は切れる）',
};

// 差分の値を 1 行で見せる
export function diffValue(v: unknown): string {
  if (v === undefined || v === null) return '-';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
