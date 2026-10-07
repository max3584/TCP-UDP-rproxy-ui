// rproxy の API で作ったルール（UI の DB にないルール。rproxy v0.4 の origin: api と rproxy_rules、#76）の画面の形。
// rproxy の GET /rules の応答と、rproxy が保存した rproxy_rules の行（migration 009）から作る。React と Node に依存しない（tests/apirules.test.ts）
import type { ForwardRules, RuleState, ShadowedBy } from './lib';
import type { RproxyRuleStatus } from './rproxy';
import { ruleFromStatus } from './dashboard';

// rproxy_rules の 1 行（UI は読むだけ）
export interface StoredApiRule {
  node: string;
  protocol: string;
  listen_addr: string;
  listen_port: number;
  // POST /rules の本文と同じ形
  spec: unknown;
  created_by: string;
  created_at: unknown;
  updated_by?: string;
  updated_at?: unknown;
}

const keyOf = (protocol: string, addr: string, port: number) => `${protocol.toLowerCase()}|${addr.toLowerCase()}|${port}`;

// DATETIME / 文字列 / Unix 秒を Unix 秒に
export function unixSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? Math.floor(d.getTime() / 1000) : undefined;
}

// rproxy の応答の 1 件を、API のルールの行にする（UI の DB にない、固定ルールでないもの）
export function apiRuleFromStatus(status: RproxyRuleStatus, id: number): ForwardRules {
  const r = ruleFromStatus(status, id);
  return {
    ...r,
    origin: 'api',
    persisted: status.persisted === true,
    ...(typeof status.created_by === 'string' ? { createdBy: status.created_by } : {}),
    ...(typeof status.created_at === 'number' ? { createdAt: status.created_at } : {}),
  };
}

// rproxy_rules の行を、rproxy が動かしていない（missing）・問い合わせできない（unknown）API のルールの行にする。spec が読めなければ null
export function apiRuleFromRow(row: StoredApiRule, id: number, state: RuleState): ForwardRules | null {
  let spec: unknown = row.spec;
  try {
    if (typeof spec === 'string') spec = JSON.parse(spec);
  } catch {
    return null;
  }
  if (typeof spec !== 'object' || spec === null) return null;
  const status = {
    ...(spec as Record<string, unknown>),
    protocol: row.protocol,
    listen_addr: row.listen_addr,
    listen_port: Number(row.listen_port),
    state: 'running',
    error: null,
    resolved: [],
    connections: 0,
  } as unknown as RproxyRuleStatus;
  const r = ruleFromStatus(status, id);
  const created = unixSeconds(row.created_at);
  return {
    ...r,
    origin: 'api',
    state: state,
    connections: null,
    stats: null,
    startedAt: null,
    persisted: true,
    createdBy: row.created_by,
    ...(created !== undefined ? { createdAt: created } : {}),
  };
}

// UI のルールと同じキーを rproxy で使っている API のルール・ルールの組（UI のルールの代わりに動いている）
export function shadowedBy(status: RproxyRuleStatus | undefined): ShadowedBy | undefined {
  if (!status) return undefined;
  const ruleset = typeof status.ruleset === 'string' && status.ruleset !== '' ? status.ruleset : undefined;
  if (status.origin !== 'api' && ruleset === undefined) return undefined;
  return {
    origin: String(status.origin ?? 'dynamic'),
    ...(ruleset ? { ruleset: ruleset } : {}),
    ...(typeof status.created_by === 'string' ? { createdBy: status.created_by } : {}),
  };
}

// ダッシュボードの一覧：UI のルール（DB）のあとに、固定ルール（だれにでも）と API のルール（管理者だけ）を読み取り専用の行として足す。
// API のルールは rproxy で動いているもの（GET /rules の static でないもの）と、rproxy_rules にあるが rproxy にないもの（live なら missing、
// 問い合わせできなければ unknown）。id は firstId から -1 ずつ（DB の id と重ならない）。同じキーの行が既にあれば足さない
export function mergeExternalRules(
  rules: ForwardRules[],
  statuses: RproxyRuleStatus[],
  opts: { api: boolean; stored?: StoredApiRule[]; live?: boolean; firstId?: number; seenKeys?: Set<string> },
): ForwardRules[] {
  // seenKeys：ほかで使っているキー（protocol|addr|port。ノードごとの一覧で、そのノードの UI のルールのキー）
  const seen = new Set([...rules.map((r) => keyOf(r.protocol, r.srcAddr, r.srcPort)), ...(opts.seenKeys ?? [])]);
  let next = opts.firstId ?? -1;
  const out: ForwardRules[] = [];
  for (const s of statuses) {
    const key = keyOf(s.protocol, s.listen_addr, s.listen_port);
    if (seen.has(key)) continue;
    if (s.origin === 'static') {
      seen.add(key);
      out.push(ruleFromStatus(s, next--));
    } else if (opts.api) {
      seen.add(key);
      out.push(apiRuleFromStatus(s, next--));
    }
  }
  if (opts.api) {
    for (const row of opts.stored ?? []) {
      const key = keyOf(row.protocol, row.listen_addr, Number(row.listen_port));
      if (seen.has(key)) continue;
      const r = apiRuleFromRow(row, next, opts.live === false ? 'unknown' : 'missing');
      if (!r) continue;
      next -= 1;
      seen.add(key);
      out.push(r);
    }
  }
  return [...rules, ...out];
}
