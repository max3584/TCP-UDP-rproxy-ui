// RuleForm の「制限・GeoIP」タブの入力（文字列の欄）と、v0.4 の項目（components/v04.ts）の行き来。React に依存しない（tests/v04.test.ts）
import type { Protocol } from './lib';
import { TlsError } from './tlserror';
import { normalizeBandwidth, normalizeGeoip, normalizeL4Outlier, normalizeLabels, normalizeLimits } from './v04';
import type { GeoipUnknown, RateSpec, V04Key, V04Settings } from './v04';

export interface LabelRow {
  key: string;
  value: string;
}

export interface RateRow {
  average: string;
  period: string;
  burst: string;
}

export interface V04Form {
  labels: LabelRow[];
  maxConnections: string;
  sourcePrefixV4: string;
  sourcePrefixV6: string;
  sourceMaxConnections: string;
  newConnections: RateRow;
  packets: RateRow;
  maxSources: string;
  upload: string;
  download: string;
  burst: string;
  sourceUpload: string;
  sourceDownload: string;
  bwPrefixV4: string;
  bwPrefixV6: string;
  bwMaxSources: string;
  allowCountries: string;
  denyCountries: string;
  allowAsns: string;
  denyAsns: string;
  unknown: GeoipUnknown;
  consecutiveFailures: string;
  shortLived: string;
  ejectionTime: string;
  maxEjectionTime: string;
  maxEjectedPercent: string;
}

const num = (v: number | undefined): string => (v === undefined ? '' : String(v));
const rateRow = (r: RateSpec | undefined): RateRow => ({ average: num(r?.average), period: r?.period ?? '', burst: num(r?.burst) });

export function toV04Form(v: V04Settings): V04Form {
  const ps = v.limits?.per_source;
  const bs = v.bandwidth?.per_source;
  return {
    labels: Object.entries(v.labels ?? {}).map(([key, value]) => ({ key: key, value: value })),
    maxConnections: num(v.limits?.max_connections),
    sourcePrefixV4: num(ps?.prefix_v4),
    sourcePrefixV6: num(ps?.prefix_v6),
    sourceMaxConnections: num(ps?.max_connections),
    newConnections: rateRow(ps?.new_connections),
    packets: rateRow(ps?.packets),
    maxSources: num(ps?.max_sources),
    upload: v.bandwidth?.upload ?? '',
    download: v.bandwidth?.download ?? '',
    burst: v.bandwidth?.burst ?? '',
    sourceUpload: bs?.upload ?? '',
    sourceDownload: bs?.download ?? '',
    bwPrefixV4: num(bs?.prefix_v4),
    bwPrefixV6: num(bs?.prefix_v6),
    bwMaxSources: num(bs?.max_sources),
    allowCountries: (v.geoip?.allow_countries ?? []).join(', '),
    denyCountries: (v.geoip?.deny_countries ?? []).join(', '),
    allowAsns: (v.geoip?.allow_asns ?? []).join(', '),
    denyAsns: (v.geoip?.deny_asns ?? []).join(', '),
    unknown: v.geoip?.unknown ?? 'allow',
    consecutiveFailures: num(v.outlierDetection?.consecutive_failures),
    shortLived: v.outlierDetection?.short_lived ?? '',
    ejectionTime: v.outlierDetection?.ejection_time ?? '',
    maxEjectionTime: v.outlierDetection?.max_ejection_time ?? '',
    maxEjectedPercent: num(v.outlierDetection?.max_ejected_percent),
  };
}

function invalid(message: string): TlsError {
  return new TlsError(message, 'invalid');
}

// 数の欄（空なら undefined。数でなければ誤り）
function intField(text: string, label: string): number | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  if (!/^[0-9]+$/.test(s)) throw invalid(`${label} は整数で指定してください。`);
  return Number(s);
}

function textField(text: string): string | undefined {
  const s = text.trim();
  return s === '' ? undefined : s;
}

function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length > 0 ? out : undefined;
}

function rateFrom(row: RateRow, label: string): Record<string, unknown> | undefined {
  const average = intField(row.average, `${label} の平均`);
  const period = textField(row.period);
  const burst = intField(row.burst, `${label} のバースト`);
  if (average === undefined) {
    if (period !== undefined || burst !== undefined) throw invalid(`${label} の平均を指定してください。`);
    return undefined;
  }
  return compact({ average: average, period: period, burst: burst });
}

export function splitList(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
}

// 欄ごとの値を組み立てて検証する。editable は編集できる項目（それ以外は current の値をそのまま残す）
export function buildV04(form: V04Form, protocol: Protocol, l7: boolean, editable: Record<V04Key, boolean>, current: V04Settings): V04Settings {
  const out: V04Settings = {};
  if (editable.labels) {
    const raw: Record<string, string> = {};
    for (const row of form.labels) {
      const key = row.key.trim();
      if (key === '' && row.value.trim() === '') continue;
      if (key === '') throw invalid('ラベルのキーを入力してください。');
      if (key in raw) throw invalid(`ラベルのキー ${key} が重なっています。`);
      raw[key] = row.value;
    }
    const labels = normalizeLabels(raw);
    if (Object.keys(labels).length > 0) out.labels = labels;
  } else if (current.labels) out.labels = current.labels;

  if (editable.limits) {
    const perSource = compact({
      prefix_v4: intField(form.sourcePrefixV4, '送信元をまとめる大きさ（IPv4）'),
      prefix_v6: intField(form.sourcePrefixV6, '送信元をまとめる大きさ（IPv6）'),
      max_connections: intField(form.sourceMaxConnections, '送信元ごとの同時接続数'),
      new_connections: rateFrom(form.newConnections, '新しい接続の速さ'),
      packets: protocol === 'udp' ? rateFrom(form.packets, 'データグラムの速さ') : undefined,
      max_sources: intField(form.maxSources, '覚える送信元の数'),
    });
    const limits = normalizeLimits(compact({ max_connections: intField(form.maxConnections, 'ルール全体の同時接続数'), per_source: perSource }), protocol);
    if (limits) out.limits = limits;
  } else if (current.limits) out.limits = current.limits;

  if (editable.bandwidth) {
    const perSource = compact({
      upload: textField(form.sourceUpload),
      download: textField(form.sourceDownload),
      prefix_v4: intField(form.bwPrefixV4, '送信元をまとめる大きさ（IPv4）'),
      prefix_v6: intField(form.bwPrefixV6, '送信元をまとめる大きさ（IPv6）'),
      max_sources: intField(form.bwMaxSources, '覚える送信元の数'),
    });
    const bandwidth = normalizeBandwidth(compact({ upload: textField(form.upload), download: textField(form.download), burst: textField(form.burst), per_source: perSource }));
    if (bandwidth) out.bandwidth = bandwidth;
  } else if (current.bandwidth) out.bandwidth = current.bandwidth;

  if (editable.geoip) {
    const geoip = normalizeGeoip({
      allow_countries: splitList(form.allowCountries),
      deny_countries: splitList(form.denyCountries),
      allow_asns: splitList(form.allowAsns),
      deny_asns: splitList(form.denyAsns),
      unknown: form.unknown,
    });
    if (geoip) out.geoip = geoip;
  } else if (current.geoip) out.geoip = current.geoip;

  // ルールの受け身のヘルスチェックは L4 だけ（L7 はサービスごと）
  if (editable.outlier_detection && !l7) {
    const outlier = normalizeL4Outlier(compact({
      consecutive_failures: intField(form.consecutiveFailures, '続けて失敗した回数'),
      short_lived: textField(form.shortLived),
      ejection_time: textField(form.ejectionTime),
      max_ejection_time: textField(form.maxEjectionTime),
      max_ejected_percent: intField(form.maxEjectedPercent, '同時に外せる割合（%）'),
    }));
    if (outlier) out.outlierDetection = outlier;
  } else if (!l7 && current.outlierDetection) out.outlierDetection = current.outlierDetection;
  return out;
}
