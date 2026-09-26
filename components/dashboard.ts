// ダッシュボードとルールの詳細画面で使う集計・整形の関数。React に依存しない（tests/dashboard.test.ts）

import { DEFAULT_UDP_IDLE_SECS } from './lib';
import type { ForwardRule, ForwardRules, HttpSpec, Protocol, RuleState, TlsSpec } from './lib';
import type { RproxyRuleStatus } from './rproxy';
import { normalizeTls } from './tls';

export const RULE_STATES: RuleState[] = ['running', 'failed', 'missing', 'unknown'];

export const STATE_LABELS: Record<RuleState, string> = {
  running: '稼働中',
  failed: '失敗',
  missing: '未登録',
  unknown: '不明',
};

// ドーナツ・帯グラフの色（running = 緑、failed = 赤、missing = 琥珀、unknown = 灰）
export const STATE_COLORS: Record<RuleState, string> = {
  running: '#16a34a',
  failed: '#dc2626',
  missing: '#f59e0b',
  unknown: '#9ca3af',
};

export type StateCounts = Record<RuleState, number> & { total: number };

export interface ProtocolSummary {
  protocol: Protocol;
  counts: StateCounts;
  // 現在の接続数（UDP はセッション数）
  connections: number;
  totalConnections: number;
  rxBytes: number;
  txBytes: number;
  tlsFailures: number;
  // allow_from の範囲外、または unmatched: reject で切断した接続
  denied: number;
}

export interface TlsBreakdown {
  passthrough: number;
  sni: number;
  // TCP の terminate
  tls: number;
  // UDP の terminate
  dtls: number;
  starttls: number;
  ranges: number;
}

export function emptyCounts(): StateCounts {
  return { running: 0, failed: 0, missing: 0, unknown: 0, total: 0 };
}

export function countStates(rules: Pick<ForwardRules, 'state'>[]): StateCounts {
  const counts = emptyCounts();
  for (const r of rules) {
    counts[r.state] += 1;
    counts.total += 1;
  }
  return counts;
}

export function summarizeProtocol(rules: ForwardRules[], protocol: Protocol): ProtocolSummary {
  const own = rules.filter((r) => r.protocol === protocol);
  const summary: ProtocolSummary = {
    protocol: protocol,
    counts: countStates(own),
    connections: 0,
    totalConnections: 0,
    rxBytes: 0,
    txBytes: 0,
    tlsFailures: 0,
    denied: 0,
  };
  for (const r of own) {
    summary.connections += r.connections ?? 0;
    summary.totalConnections += r.stats?.total_connections ?? 0;
    summary.rxBytes += r.stats?.rx_bytes ?? 0;
    summary.txBytes += r.stats?.tx_bytes ?? 0;
    summary.tlsFailures += r.stats?.tls_failures ?? 0;
    summary.denied += r.stats?.denied ?? 0;
  }
  return summary;
}

export function summarize(rules: ForwardRules[]): {
  tcp: ProtocolSummary; udp: ProtocolSummary; all: StateCounts; connections: number; staticRules: number;
} {
  const tcp = summarizeProtocol(rules, 'tcp');
  const udp = summarizeProtocol(rules, 'udp');
  return {
    tcp: tcp,
    udp: udp,
    all: countStates(rules),
    connections: tcp.connections + udp.connections,
    staticRules: rules.filter((r) => r.origin === 'static').length,
  };
}

function isHttpSpec(value: unknown): value is HttpSpec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// rproxy の応答のルールを画面の形にする（固定ルールは DB にないので、rproxy の応答だけから作る）。
// tls は既定値の項目を省いた形に揃える（読めない形なら受け取ったまま使う）
export function ruleFromStatus(status: RproxyRuleStatus, id: number): ForwardRules {
  let tls: TlsSpec;
  try {
    tls = normalizeTls(status.tls);
  } catch {
    tls = (status.tls ?? { mode: 'passthrough' }) as TlsSpec;
  }
  const starttls = status.starttls ?? null;
  return {
    id: id,
    origin: status.origin === 'static' ? 'static' : 'dynamic',
    protocol: String(status.protocol).toLowerCase() as Protocol,
    srcAddr: status.listen_addr,
    srcPort: status.listen_port,
    srcPortEnd: status.listen_port_end ?? null,
    // http のルールは転送先を持たない（rproxy は "" / 0 を返す）
    distAddr: status.remote_addr ?? '',
    distPort: status.remote_port ?? 0,
    sourceIp: status.source_ip ?? 'proxy',
    udpIdleSecs: status.udp_idle_secs ?? DEFAULT_UDP_IDLE_SECS,
    tls: tls,
    starttls: starttls,
    starttlsRequired: starttls === null ? true : status.starttls_required ?? true,
    allowFrom: status.allow_from ?? [],
    http: isHttpSpec(status.http) ? status.http : null,
    state: status.state,
    error: status.error ?? null,
    connections: status.connections ?? null,
    stats: status.stats ?? null,
    startedAt: status.started_at ?? null,
    resolved: status.resolved ?? [],
  };
}

function keyString(protocol: string, addr: string, port: number): string {
  return `${protocol.toLowerCase()}|${addr.toLowerCase()}|${port}`;
}

// ダッシュボードの一覧：自分のルール（DB）のあとに、rproxy の固定ルール（origin: static）を読み取り専用の行として足す。
// 固定ルールの id は -1, -2, …（DB の id と重ならない）。同じキーの行が既にあれば足さない
export function mergeStaticRules(rules: ForwardRules[], live: RproxyRuleStatus[]): ForwardRules[] {
  const seen = new Set(rules.map((r) => keyString(r.protocol, r.srcAddr, r.srcPort)));
  const statics = live
    .filter((s) => s.origin === 'static' && !seen.has(keyString(s.protocol, s.listen_addr, s.listen_port)))
    .map((s, i) => ruleFromStatus(s, -(i + 1)));
  return [...rules, ...statics];
}

export function tlsBreakdown(rules: ForwardRule[]): TlsBreakdown {
  const b: TlsBreakdown = { passthrough: 0, sni: 0, tls: 0, dtls: 0, starttls: 0, ranges: 0 };
  for (const r of rules) {
    if (r.tls.mode === 'passthrough') b.passthrough += 1;
    else if (r.tls.mode === 'sni') b.sni += 1;
    else if (r.protocol === 'udp') b.dtls += 1;
    else b.tls += 1;
    if (r.starttls !== null) b.starttls += 1;
    if (r.srcPortEnd !== null) b.ranges += 1;
  }
  return b;
}

// 要確認のルール（failed を先に、次に missing。それぞれ元の順番のまま）
export function needsAttention(rules: ForwardRules[]): ForwardRules[] {
  return [...rules.filter((r) => r.state === 'failed'), ...rules.filter((r) => r.state === 'missing')];
}

export interface RuleFilter {
  protocol: Protocol | 'all';
  state: RuleState | 'all';
  // 待ち受け・転送先のアドレス、ポート、SNI のサーバ名で絞り込む
  text: string;
}

export const EMPTY_FILTER: RuleFilter = { protocol: 'all', state: 'all', text: '' };

function inRange(n: number, start: number, end: number | null): boolean {
  return n >= start && n <= (end ?? start);
}

export function matchesText(rule: ForwardRule, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (q === '') return true;
  const count = rule.srcPortEnd === null ? 1 : rule.srcPortEnd - rule.srcPort + 1;
  // 数字だけならポート（範囲の途中も含む）として探す
  if (/^[0-9]+$/.test(q)) {
    const n = Number(q);
    if (inRange(n, rule.srcPort, rule.srcPortEnd)) return true;
    if (rule.http === null && inRange(n, rule.distPort, rule.distPort + count - 1)) return true;
    if ((rule.tls.routes ?? []).some((r) => inRange(n, r.remote_port, r.remote_port + count - 1))) return true;
  }
  const haystack = [
    rule.srcAddr,
    `${rule.srcAddr}:${portsLabel(rule.srcPort, rule.srcPortEnd)}`,
    // L7 のルールは転送先を持たない（'L7 (HTTP)' で探せる）
    ...(rule.http === null ? [rule.distAddr, `${rule.distAddr}:${targetPortsLabel(rule)}`] : ['L7 (HTTP)']),
    ...(rule.tls.routes ?? []).flatMap((r) => [r.server_name, r.remote_addr]),
  ];
  return haystack.some((h) => h.toLowerCase().includes(q));
}

export function filterRules<T extends ForwardRules>(rules: T[], filter: RuleFilter): T[] {
  return rules.filter((r) =>
    (filter.protocol === 'all' || r.protocol === filter.protocol)
    && (filter.state === 'all' || r.state === filter.state)
    && matchesText(r, filter.text));
}

// 1024 単位（KiB / MiB / GiB …）。1024 未満はそのままバイト数
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US');
}

// 秒数を「3日 4時間」「2時間 5分」「3分 12秒」「45秒」の形にする（上から 2 単位まで）
export function formatDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '-';
  const s = Math.max(0, Math.floor(secs));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (days > 0) return hours > 0 ? `${days}日 ${hours}時間` : `${days}日`;
  if (hours > 0) return minutes > 0 ? `${hours}時間 ${minutes}分` : `${hours}時間`;
  if (minutes > 0) return seconds > 0 ? `${minutes}分 ${seconds}秒` : `${minutes}分`;
  return `${seconds}秒`;
}

// 稼働時間（秒）。started_at がなければ null。時計のずれで負にならないようにする
export function uptimeSecs(startedAt: number | null | undefined, nowMs: number): number | null {
  if (startedAt === null || startedAt === undefined) return null;
  return Math.max(0, Math.floor(nowMs / 1000) - startedAt);
}

// Unix 秒を「2026-09-25 13:24:53」（ローカル時刻）にする
export function formatTimestamp(unixSecs: number | null | undefined): string {
  if (unixSecs === null || unixSecs === undefined) return '-';
  const d = new Date(unixSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function portsLabel(start: number, end: number | null): string {
  return end === null ? `${start}` : `${start}-${end}`;
}

// 転送先のポート（範囲ルールでは同じ数だけずらした範囲）
export function targetPortsLabel(rule: Pick<ForwardRule, 'srcPort' | 'srcPortEnd' | 'distPort'>): string {
  return portsLabel(rule.distPort, rule.srcPortEnd === null ? null : rule.distPort + rule.srcPortEnd - rule.srcPort);
}

// IPv6 のアドレスは [ ] で囲む
export function hostPort(addr: string, port: string | number): string {
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`;
}

// L7 の設定（http）のルートの数。routes が配列でなければ 0
export function httpRouteCount(http: HttpSpec | null | undefined): number {
  const routes = http?.routes;
  return Array.isArray(routes) ? routes.length : 0;
}

// 一覧・詳細の「転送先」の表示。L7 のルールは転送先を持たないので「L7 (HTTP)」とルートの数を出す
export function targetLabel(rule: Pick<ForwardRule, 'srcPort' | 'srcPortEnd' | 'distAddr' | 'distPort' | 'http'>): string {
  if (rule.http !== null && rule.http !== undefined) {
    return `L7 (HTTP) ・ルート ${httpRouteCount(rule.http)} 件`;
  }
  return hostPort(rule.distAddr, targetPortsLabel(rule));
}

export function tlsLabel(rule: Pick<ForwardRule, 'protocol' | 'tls'>): string {
  switch (rule.tls.mode) {
    case 'passthrough': return 'passthrough';
    case 'sni': return 'SNI';
    case 'terminate': return rule.protocol === 'udp' ? 'DTLS 終端' : 'TLS 終端';
  }
}

export interface RuleKey {
  protocol: Protocol;
  addr: string;
  port: number;
}

export function ruleKeyOf(rule: Pick<ForwardRule, 'protocol' | 'srcAddr' | 'srcPort'>): RuleKey {
  return { protocol: rule.protocol, addr: rule.srcAddr, port: rule.srcPort };
}

// 詳細画面の URL。アドレスは URL エンコードする（IPv6 の : を含められるように）
export function ruleHref(key: RuleKey): string {
  return `/rules/${key.protocol}/${encodeURIComponent(key.addr)}/${key.port}`;
}

export function ruleEditHref(key: RuleKey): string {
  return `${ruleHref(key)}/edit`;
}

// 1 件取得の API の URL
export function ruleApiUrl(key: RuleKey): string {
  const q = new URLSearchParams({ protocol: key.protocol, addr: key.addr, port: String(key.port) });
  return `/api/forward/rule?${q.toString()}`;
}

// ページの query（Next.js がデコード済み）からキーを読む。不正なら null
export function parseRuleKey(query: Record<string, string | string[] | undefined>): RuleKey | null {
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
  const protocol = one(query.protocol)?.toLowerCase();
  const addr = one(query.listenAddr);
  const portText = one(query.listenPort);
  if (protocol !== 'tcp' && protocol !== 'udp') return null;
  if (!addr || !portText || !/^[0-9]+$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { protocol: protocol, addr: addr, port: port };
}

// ドーナツの conic-gradient。ルールがなければ灰色一色
export function donutGradient(counts: StateCounts): string {
  if (counts.total === 0) return `conic-gradient(${STATE_COLORS.unknown} 0 100%)`;
  let at = 0;
  const parts: string[] = [];
  for (const s of RULE_STATES) {
    if (counts[s] === 0) continue;
    const next = at + (counts[s] / counts.total) * 100;
    parts.push(`${STATE_COLORS[s]} ${round(at)}% ${round(next)}%`);
    at = next;
  }
  return `conic-gradient(${parts.join(', ')})`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// スクリーンリーダー向けの内訳（「稼働中 3、失敗 1」）
export function countsDescription(counts: StateCounts): string {
  if (counts.total === 0) return 'ルールはありません';
  return RULE_STATES.filter((s) => counts[s] > 0).map((s) => `${STATE_LABELS[s]} ${counts[s]}`).join('、');
}

// 画面で送るルール（ForwardRules の稼働情報を落とす）
export function toRule(rule: ForwardRule): ForwardRule {
  return {
    protocol: rule.protocol,
    srcAddr: rule.srcAddr,
    srcPort: rule.srcPort,
    srcPortEnd: rule.srcPortEnd,
    distAddr: rule.distAddr,
    distPort: rule.distPort,
    sourceIp: rule.sourceIp,
    udpIdleSecs: rule.udpIdleSecs,
    tls: rule.tls,
    starttls: rule.starttls,
    starttlsRequired: rule.starttlsRequired,
    allowFrom: rule.allowFrom,
    http: rule.http,
  };
}
