// ルールと、rproxy の設定ファイル（RPROXY_CONFIG）の形との変換（#60 のエクスポート / インポート）。
// rproxy へ送るルールの形（toRproxyRule）もここに置き、API route と共有する（tests/settingsdoc.test.ts）

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DEFAULT_UDP_IDLE_SECS } from './lib';
import type { ForwardRule } from './lib';
import type { RproxyRule } from './rproxy';
import { TlsError, isDefaultTls } from './tls';

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
  // 一時停止中のルール（UI だけの印。rproxy の設定ファイルには書けないので、そのまま RPROXY_CONFIG には使えない）
  if (rule.enabled === false) out.enabled = false;
  return out;
}

export type ExportFormat = 'yaml' | 'json';

export interface SettingsDoc {
  version: 1;
  rules: Record<string, unknown>[];
}

export function exportDoc(rules: ForwardRule[]): SettingsDoc {
  return { version: 1, rules: rules.map(toSettingsRule) };
}

export function formatDoc(doc: SettingsDoc, format: ExportFormat, header?: string): string {
  if (format === 'json') return `${JSON.stringify(doc, null, 2)}\n`;
  const comment = header ? header.split('\n').map((l) => `# ${l}`).join('\n') + '\n' : '';
  return comment + stringifyYaml(doc, { lineWidth: 0 });
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
};

export function settingsRuleToBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('ルールの形式が不正です（オブジェクトではありません）。');
  const body: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const to = FIELD_MAP[key];
    if (to === undefined) throw invalid(`知らない項目があります: ${key}`);
    body[to] = v;
  }
  return body;
}

export interface ParsedDoc {
  rules: unknown[];
  // global があった（UI では使わないので読み飛ばす）
  ignoredGlobal: boolean;
}

// YAML（JSON も YAML として読める）を読み、ルールの配列を取り出す。
// 設定ファイルの形（{version: 1, global, rules}）と、ルールの配列だけの形（rproxy 0.2 の固定ルールのファイル）を受け付ける
export function parseDoc(text: string): ParsedDoc {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (err) {
    throw invalid(`YAML / JSON として読めません: ${err instanceof Error ? err.message : err}`);
  }
  if (Array.isArray(value)) return { rules: value, ignoredGlobal: false };
  if (typeof value !== 'object' || value === null) throw invalid('ルールがありません（rules: の配列か、ルールの配列を書いてください）。');
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!['version', 'global', 'rules'].includes(key)) throw invalid(`知らない項目があります: ${key}`);
  }
  if (doc.version !== undefined && doc.version !== 1) throw invalid(`version は 1 だけを読めます（${String(doc.version)}）。`);
  const rules = doc.rules ?? [];
  if (!Array.isArray(rules)) throw invalid('rules は配列で書いてください。');
  return { rules: rules, ignoredGlobal: doc.global !== undefined };
}
