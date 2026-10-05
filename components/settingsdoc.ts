// ルールと、rproxy の設定ファイル（RPROXY_CONFIG）の形との変換（#60 のエクスポート / インポート）。
// rproxy へ送るルールの形（toRproxyRule）もここに置き、API route と共有する（tests/settingsdoc.test.ts）

import { parse as parseYaml } from 'yaml';
import { DEFAULT_UDP_IDLE_SECS } from './lib';
import type { ForwardRule } from './lib';
import type { RproxyRule } from './rproxy';
import { TlsError, isDefaultTls } from './tls';
import { settingsOverridesToBody, toSettingsOverride } from './overrides';

// starttls / starttls_required は STARTTLS を使うときだけ付ける
export function starttlsFields(rule: ForwardRule) {
  return rule.starttls !== null ? { starttls: rule.starttls, starttls_required: rule.starttlsRequired } : {};
}

// 転送先。http のルールは remote_addr / remote_port を書かず、http を付ける（書くと rproxy が invalid を返す）。
// 宛先を複数にしたルールは targets と balance（・health_check）を付ける（rproxy v0.3.3）
export function remoteFields(rule: ForwardRule) {
  if (rule.http !== null) return { http: rule.http };
  if (rule.targets.length > 0) {
    return {
      targets: rule.targets,
      balance: rule.balance,
      ...(rule.healthCheck !== null ? { health_check: rule.healthCheck } : {}),
    };
  }
  return { remote_addr: rule.distAddr, remote_port: rule.distPort };
}

export function extraAddrs(rule: ForwardRule): string[] {
  return rule.extraListenAddrs ?? [];
}

// rproxy の POST /rules の本文（設定ファイルの rules[] と同じ形）
export function toRproxyRule(rule: ForwardRule): RproxyRule {
  return {
    protocol: rule.protocol,
    listen_addr: rule.srcAddr,
    listen_port: rule.srcPort,
    ...(rule.srcPortEnd !== null ? { listen_port_end: rule.srcPortEnd } : {}),
    ...remoteFields(rule),
    source_ip: rule.sourceIp,
    udp_idle_secs: rule.udpIdleSecs,
    tls: rule.tls,
    ...starttlsFields(rule),
    ...(rule.allowFrom.length > 0 ? { allow_from: rule.allowFrom } : {}),
    // 古い rproxy（v0.3.2 より前）は知らない項目を拒否するので、使うときだけ付ける
    ...(rule.crowdsec ? { crowdsec: true } : {}),
    ...(extraAddrs(rule).length > 0 ? { extra_listen_addrs: extraAddrs(rule) } : {}),
  };
}

// エクスポートする 1 件。toRproxyRule から既定値の項目を省いて読みやすくする（読み込めば同じルールに戻る）
export function toSettingsRule(rule: ForwardRule): Record<string, unknown> {
  const out: Record<string, unknown> = { ...toRproxyRule(rule) };
  if (out.source_ip === 'proxy') delete out.source_ip;
  if (rule.protocol === 'tcp' || rule.udpIdleSecs === DEFAULT_UDP_IDLE_SECS) delete out.udp_idle_secs;
  if (isDefaultTls(rule.tls)) delete out.tls;
  if (rule.balance === 'round_robin') delete out.balance;
  // 一時停止中のルール（UI だけの印。エクスポートの形の中だけで使う）
  if (rule.enabled === false) out.enabled = false;
  // ノードごとの上書き（#98。UI のエクスポートだけの項目。{ノード名: {listen_addr, remote_addr, …}}）
  if (rule.overrides && Object.keys(rule.overrides).length > 0) {
    out.overrides = Object.fromEntries(Object.keys(rule.overrides).sort().map((n) => [n, toSettingsOverride(rule.overrides![n])]));
  }
  return out;
}

// UI のエクスポートの印。rproxy の設定ファイルと取り違えないように、rproxy が知らない項目を先頭に置く
// （RPROXY_CONFIG に置かれても rproxy は知らない項目として断る）
export const EXPORT_FORMAT = 'rproxy-ui-export';

export interface ExportDoc {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exported_at?: string;
  rules: Record<string, unknown>[];
}

export function exportDoc(rules: ForwardRule[], exportedAt?: string): ExportDoc {
  return { format: EXPORT_FORMAT, version: 1, ...(exportedAt ? { exported_at: exportedAt } : {}), rules: rules.map(toSettingsRule) };
}

// エクスポートは JSON だけ（rproxy の設定ファイルの YAML と区別する）
export function formatDoc(doc: ExportDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function invalid(message: string): TlsError {
  return new TlsError(message, 'invalid');
}

// 設定ファイルのルール（rproxy の形。snake_case）を、UI の API の本文（ForwardRule の形。camelCase）に直す。
// 値の検証は API route の parseRule がする。rproxy と同じく、知らない項目は拒否する
const FIELD_MAP: Record<string, string> = {
  protocol: 'protocol',
  listen_addr: 'srcAddr',
  listen_port: 'srcPort',
  listen_port_end: 'srcPortEnd',
  remote_addr: 'distAddr',
  remote_port: 'distPort',
  source_ip: 'sourceIp',
  udp_idle_secs: 'udpIdleSecs',
  tls: 'tls',
  starttls: 'starttls',
  starttls_required: 'starttlsRequired',
  allow_from: 'allowFrom',
  http: 'http',
  crowdsec: 'crowdsec',
  targets: 'targets',
  balance: 'balance',
  health_check: 'healthCheck',
  extra_listen_addrs: 'extraListenAddrs',
  // UI での一時停止（エクスポートした停止中のルール）。rproxy の設定ファイルにはない項目
  enabled: 'enabled',
  // ノードごとの上書き（UI のエクスポートだけ）
  overrides: 'overrides',
};

export function settingsRuleToBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('ルールの形式が不正です（オブジェクトではありません）。');
  const body: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const to = FIELD_MAP[key];
    if (to === undefined) throw invalid(`知らない項目があります: ${key}`);
    body[to] = key === 'overrides' ? settingsOverridesToBody(v) : v;
  }
  return body;
}

export interface ParsedDoc {
  rules: unknown[];
  // global があった（UI では使わないので読み飛ばす）
  ignoredGlobal: boolean;
  // UI のエクスポート（format: rproxy-ui-export）か。false なら rproxy の設定ファイル
  uiExport: boolean;
}

// 読めるもの：UI のエクスポート（JSON。{format: rproxy-ui-export, version: 1, rules}）と、
// rproxy の設定ファイル（YAML / JSON。{version: 1, global, rules}、またはルールの配列だけの rproxy 0.2 の固定ルールのファイル）。
// YAML として読む（JSON も YAML として読める）
export function parseDoc(text: string): ParsedDoc {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (err) {
    throw invalid(`YAML / JSON として読めません: ${err instanceof Error ? err.message : err}`);
  }
  if (Array.isArray(value)) return { rules: value, ignoredGlobal: false, uiExport: false };
  if (typeof value !== 'object' || value === null) throw invalid('ルールがありません（rules: の配列か、ルールの配列を書いてください）。');
  const doc = value as Record<string, unknown>;
  const uiExport = doc.format !== undefined;
  if (uiExport && doc.format !== EXPORT_FORMAT) throw invalid(`format が不正です（${String(doc.format)}）。UI のエクスポートは ${EXPORT_FORMAT} です。`);
  const keys = uiExport ? ['format', 'version', 'exported_at', 'rules'] : ['version', 'global', 'rules'];
  for (const key of Object.keys(doc)) {
    if (!keys.includes(key)) throw invalid(`知らない項目があります: ${key}`);
  }
  if (doc.version !== undefined && doc.version !== 1) throw invalid(`version は 1 だけを読めます（${String(doc.version)}）。`);
  const rules = doc.rules ?? [];
  if (!Array.isArray(rules)) throw invalid('rules は配列で書いてください。');
  // 停止中（enabled）は UI のエクスポートだけの項目。rproxy の設定ファイルにはない
  if (!uiExport && rules.some((r) => typeof r === 'object' && r !== null && 'enabled' in r)) {
    throw invalid('enabled（停止中）は UI のエクスポート（format: rproxy-ui-export）の中でだけ使えます。');
  }
  if (!uiExport && rules.some((r) => typeof r === 'object' && r !== null && 'overrides' in r)) {
    throw invalid('overrides（ノードごとの上書き）は UI のエクスポート（format: rproxy-ui-export）の中でだけ使えます。');
  }
  return { rules: rules, ignoredGlobal: doc.global !== undefined, uiExport: uiExport };
}
