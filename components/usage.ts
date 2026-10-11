// 利用量の集計（UI #101）の計算。rproxy の統計（単調に増える rx_bytes・tx_bytes・total_connections）の差分の取り方、
// 時間・日・月の区切り、グラフの棒、所有者・ラベルごとの集計、CSV。React と Node に依存しない（tests/usage.test.ts）。時刻は UTC

export interface UsageCounters {
  rx: number;
  tx: number;
  connections: number;
  // rproxy v0.4 の stats.counters_since（数え始め。作り直すと変わり、引き継ぎでは変わらない）
  countersSince?: number | null;
  // counters_since を返さない古い rproxy では started_at で見分ける
  startedAt?: number | null;
}

export interface UsageDelta {
  rx: number;
  tx: number;
  connections: number;
  // 数え直した（rproxy の再起動・ルールの作り直し）と判断した
  reset: boolean;
}

// 同じ数え始めか。counters_since があればそれで、なければ started_at で比べる
function sameEpoch(prev: UsageCounters, cur: UsageCounters): boolean {
  if (cur.countersSince !== undefined && cur.countersSince !== null) return prev.countersSince === cur.countersSince;
  if (prev.countersSince !== undefined && prev.countersSince !== null) return false;
  return (prev.startedAt ?? null) === (cur.startedAt ?? null);
}

// 前に見た数（prev）から今の数（cur）までに増えた分。
// - 前がない（初めて見る）：数え始めが前回の集計より後なら、数え始めからの全部を足す（間に作られたルール）。分からなければ足さない（基準にするだけ）
// - 同じ数え始めで増えていれば差、数え始めが変わった・数が減ったなら数え直したとみなして今の数を全部足す
export function usageDelta(prev: UsageCounters | null, cur: UsageCounters, lastRunAt: number | null = null): UsageDelta {
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  if (prev === null) {
    const since = cur.countersSince ?? cur.startedAt ?? null;
    const fresh = since !== null && lastRunAt !== null && since >= lastRunAt;
    return fresh ? { rx: clamp(cur.rx), tx: clamp(cur.tx), connections: clamp(cur.connections), reset: true } : { rx: 0, tx: 0, connections: 0, reset: false };
  }
  if (sameEpoch(prev, cur) && cur.rx >= prev.rx && cur.tx >= prev.tx && cur.connections >= prev.connections) {
    return { rx: cur.rx - prev.rx, tx: cur.tx - prev.tx, connections: cur.connections - prev.connections, reset: false };
  }
  return { rx: clamp(cur.rx), tx: clamp(cur.tx), connections: clamp(cur.connections), reset: true };
}

const pad = (n: number) => String(n).padStart(2, '0');

// DATETIME / DATE の文字列（UTC）
export function hourKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00:00`;
}

export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

// グラフの期間：24h は時間ごと、7d・30d は日ごと、12m は月ごと（7 日を時間ごとの 168 本にすると、どの日がどれだけかが読めない）。
// 期間の中をポートごとに分けて見るのは portUsage（グラフの「詳細」）
export type UsageRange = '24h' | '7d' | '30d' | '12m';
export const USAGE_RANGES: UsageRange[] = ['24h', '7d', '30d', '12m'];
export type UsageBucket = 'hour' | 'day' | 'month';

export interface RangeSpec {
  bucket: UsageBucket;
  // 表（月ごとは日ごとの表をまとめる）
  table: 'usage_hourly' | 'usage_daily';
  // 棒の数
  count: number;
}

export const RANGE_SPECS: Record<UsageRange, RangeSpec> = {
  '24h': { bucket: 'hour', table: 'usage_hourly', count: 24 },
  '7d': { bucket: 'day', table: 'usage_daily', count: 7 },
  '30d': { bucket: 'day', table: 'usage_daily', count: 30 },
  '12m': { bucket: 'month', table: 'usage_daily', count: 12 },
};

export function parseRange(value: unknown): UsageRange {
  return USAGE_RANGES.includes(value as UsageRange) ? value as UsageRange : '24h';
}

// 棒の始まり（古い順、最後が now を含む区切り）
export function bucketStarts(range: UsageRange, now: Date): Date[] {
  const spec = RANGE_SPECS[range];
  const out: Date[] = [];
  for (let i = spec.count - 1; i >= 0; i--) {
    if (spec.bucket === 'hour') out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - i)));
    else if (spec.bucket === 'day') out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)));
    else out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
  }
  return out;
}

export function bucketKey(bucket: UsageBucket, d: Date): string {
  return bucket === 'hour' ? hourKey(d) : bucket === 'day' ? dayKey(d) : monthKey(d);
}

export interface UsagePoint {
  // 区切りの始まり（ISO 8601、UTC）
  at: string;
  rx: number;
  tx: number;
  connections: number;
}

export interface UsageSeries {
  range: UsageRange;
  bucket: UsageBucket;
  points: UsagePoint[];
  total: { rx: number; tx: number; connections: number };
}

// DB の行（key は bucketKey の形）を棒に並べ、ない区切りは 0 で埋める
export function fillSeries(range: UsageRange, now: Date, rows: { key: string; rx: number; tx: number; connections: number }[]): UsageSeries {
  const spec = RANGE_SPECS[range];
  const byKey = new Map<string, { rx: number; tx: number; connections: number }>();
  for (const r of rows) {
    const cur = byKey.get(r.key) ?? { rx: 0, tx: 0, connections: 0 };
    byKey.set(r.key, { rx: cur.rx + Number(r.rx), tx: cur.tx + Number(r.tx), connections: cur.connections + Number(r.connections) });
  }
  const points = bucketStarts(range, now).map((d) => ({ at: d.toISOString(), ...(byKey.get(bucketKey(spec.bucket, d)) ?? { rx: 0, tx: 0, connections: 0 }) }));
  const total = points.reduce((a, p) => ({ rx: a.rx + p.rx, tx: a.tx + p.tx, connections: a.connections + p.connections }), { rx: 0, tx: 0, connections: 0 });
  return { range: range, bucket: spec.bucket, points: points, total: total };
}

// 期間の中のポートごとの通信量（グラフの「詳細」）。同じポートでも TCP と UDP は別
export interface PortUsage {
  protocol: string;
  port: number;
  rx: number;
  tx: number;
  connections: number;
}

export interface PortUsageSeries {
  range: UsageRange;
  // 多い順。グラフは上から PORT_BARS 本と「その他」、表はすべて
  ports: PortUsage[];
  total: { rx: number; tx: number; connections: number };
}

// グラフに並べるポートの数（ほかは「その他」の 1 本にまとめる）
export const PORT_BARS = 20;

// DB の行（protocol・port ごとの合計）を多い順に。ノード・待ち受けアドレスが違っても同じポートはまとめる
export function portUsage(range: UsageRange, rows: { protocol: string; port: number; rx: number; tx: number; connections: number }[]): PortUsageSeries {
  const byPort = new Map<string, PortUsage>();
  for (const r of rows) {
    const key = `${r.protocol}/${Number(r.port)}`;
    const cur = byPort.get(key) ?? { protocol: r.protocol, port: Number(r.port), rx: 0, tx: 0, connections: 0 };
    byPort.set(key, { ...cur, rx: cur.rx + Number(r.rx), tx: cur.tx + Number(r.tx), connections: cur.connections + Number(r.connections) });
  }
  const ports = [...byPort.values()]
    .filter((p) => p.rx + p.tx + p.connections > 0)
    .sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx) || a.port - b.port || a.protocol.localeCompare(b.protocol));
  const total = ports.reduce((a, p) => ({ rx: a.rx + p.rx, tx: a.tx + p.tx, connections: a.connections + p.connections }), { rx: 0, tx: 0, connections: 0 });
  return { range: range, ports: ports, total: total };
}

// ---- 所有者・ラベルごとの集計（/usage） ----

// owner：UI のルールの持ち主、label:<キー>：ラベルの値、node：ノード、rule：ルール
export type UsageGroup = 'owner' | 'node' | 'rule' | `label:${string}`;

export function parseGroup(value: unknown): UsageGroup {
  if (value === 'owner' || value === 'node' || value === 'rule') return value;
  if (typeof value === 'string' && /^label:[A-Za-z0-9]([A-Za-z0-9._/-]{0,61}[A-Za-z0-9])?$/.test(value)) return value as UsageGroup;
  return 'owner';
}

export interface UsageRow {
  node: string;
  protocol: string;
  listen_addr: string;
  listen_port: number;
  target: string | null;
  owner: string | null;
  origin: string;
  labels: Record<string, string> | null;
  rx: number;
  tx: number;
  connections: number;
}

export interface ReportLine {
  // まとめた値（所有者・ラベルの値・ノード・ルール）。ないものは null
  key: string | null;
  rx: number;
  tx: number;
  connections: number;
  rules: number;
}

function parseLabels(v: unknown): Record<string, string> | null {
  if (v === null || v === undefined) return null;
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? o as Record<string, string> : null;
  } catch {
    return null;
  }
}

export function ruleLabel(r: Pick<UsageRow, 'protocol' | 'listen_addr' | 'listen_port'>): string {
  const addr = r.listen_addr.includes(':') ? `[${r.listen_addr}]` : r.listen_addr;
  return `${r.protocol}/${addr}:${r.listen_port}`;
}

// 行を group でまとめる（多い順）
export function groupUsage(rows: UsageRow[], group: UsageGroup): ReportLine[] {
  const map = new Map<string, { key: string | null; rx: number; tx: number; connections: number; rules: Set<string> }>();
  for (const raw of rows) {
    const labels = parseLabels(raw.labels);
    const key = group === 'owner' ? raw.owner
      : group === 'node' ? raw.node
      : group === 'rule' ? ruleLabel(raw)
      : labels?.[group.slice('label:'.length)] ?? null;
    const id = key ?? '\u0000';
    const cur = map.get(id) ?? { key: key, rx: 0, tx: 0, connections: 0, rules: new Set<string>() };
    cur.rx += Number(raw.rx);
    cur.tx += Number(raw.tx);
    cur.connections += Number(raw.connections);
    cur.rules.add(`${raw.node}|${ruleLabel(raw)}`);
    map.set(id, cur);
  }
  return [...map.values()]
    .map((v) => ({ key: v.key, rx: v.rx, tx: v.tx, connections: v.connections, rules: v.rules.size }))
    .sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx));
}

// 使われているラベルのキー（集計の選択肢）
export function labelKeys(rows: Pick<UsageRow, 'labels'>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(parseLabels(r.labels) ?? {})) keys.add(k);
  return [...keys].sort();
}

// 表計算ソフトが式として読む先頭の文字（= + - @、全角の ＝ ＋ － ＠、DDE の | と %、タブ・改行）。先頭の空白は飛ばして見る
// （LibreOffice などは " =cmd" や全角の「＝」で始まる値も式にすることがある）
const FORMULA_START = /^[\s\u3000]*[=+\-@|%\uFF1D\uFF0B\uFF0D\uFF20\u2212]/;

export function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  // 数（バイト数など）はそのまま。文字列で式として読まれうるものは ' を前に付ける
  const safe = typeof v === 'string' && (FORMULA_START.test(s) || /^[\t\r\n]/.test(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// CSV（UTF-8、先頭は見出し）。バイト数はそのままの数
export function reportCsv(period: string, group: UsageGroup, lines: ReportLine[]): string {
  const head = ['period', group, 'rx_bytes', 'tx_bytes', 'total_bytes', 'connections', 'rules'];
  const body = lines.map((l) => [period, l.key, l.rx, l.tx, l.rx + l.tx, l.connections, l.rules].map(csvCell).join(','));
  return `${[head.join(','), ...body].join('\r\n')}\r\n`;
}

// /usage の期間：YYYY-MM（月）か YYYY-MM-DD（日）。読めなければ null
export function parsePeriod(value: unknown): { kind: 'month' | 'day'; from: string; to: string; label: string } | null {
  if (typeof value !== 'string') return null;
  let m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const next = new Date(Date.UTC(y, mo, 1));
    return { kind: 'month', from: `${value}-01`, to: dayKey(next), label: value };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || dayKey(d) !== value) return null;
    return { kind: 'day', from: value, to: dayKey(new Date(d.getTime() + 86_400_000)), label: value };
  }
  return null;
}

// 管理者でない利用者に見せる集計の失敗（集計の失敗の文はノードごとの rproxy の通信の失敗で、内部のアドレスを含むので管理者だけ）
export const USAGE_ERROR_HIDDEN = '利用量の集計に失敗しています（詳しい理由は管理者だけが見られます）。';

// ---- 設定（環境変数） ----

export interface UsageConfig {
  // 集計の間隔（秒）。0 なら集計しない
  intervalSecs: number;
  // 時間ごとの行を残す日数・日ごとの行を残す日数
  hourlyDays: number;
  dailyDays: number;
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((value ?? '').trim());
  return (value ?? '').trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function usageConfig(env: Record<string, string | undefined> = process.env): UsageConfig {
  const interval = envInt(env.RPROXY_UI_USAGE_SECS, 300, 0, 86_400);
  return {
    intervalSecs: interval === 0 ? 0 : Math.max(30, interval),
    hourlyDays: envInt(env.RPROXY_UI_USAGE_HOURLY_DAYS, 32, 1, 3650),
    dailyDays: envInt(env.RPROXY_UI_USAGE_DAILY_DAYS, 400, 1, 36_500),
  };
}
