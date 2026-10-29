// 宛先を複数にしたとき（rproxy v0.3.3 の targets / balance / health_check）のフォームの行と組み立て。
// React に依存しない（tests/targets.test.ts）。形の検証は components/tls.ts の normalizeTargets / checkBalancing

import { Balance, DEFAULT_BALANCE, ForwardRule, HealthCheck, Protocol, RuleStats, Target, TargetStats, TlsRouteStats } from './lib';
import { Balancing, checkBalancing, normalizeHealthCheck, normalizeTargets } from './tls';
import { joinList, translate } from '@/i18n/core';

export const BALANCE_HELP: Record<Balance, string> = {
  round_robin: '重みの比率で順番に回します。',
  least_conn: 'いまの接続数（UDP はセッション数）÷ 重みが一番小さい宛先へ送ります。長く続く接続で偏りにくい方式です。',
  failover: '上から順に、生きている最初の宛先だけを使います。上の宛先が戻ったら、新しい接続から戻します。',
};

// フォームの 1 行。数値の欄は空欄（''）のことがある
export interface TargetRow {
  addr: string;
  port: number | '';
  weight: number | '';
  backup: boolean;
  // 宛先ごとの同時接続の上限（max_connections。空欄は上限なし）
  maxConnections: number | '';
}

export interface HealthCheckRow {
  enabled: boolean;
  interval: string;
  timeout: string;
  port: number | '';
}

export const EMPTY_ROW: TargetRow = { addr: '', port: '', weight: '', backup: false, maxConnections: '' };

// 単一の宛先の欄から作る 1 行目（「宛先を追加」で複数にしたとき）
export function firstRow(addr: string, port: number | ''): TargetRow {
  return { ...EMPTY_ROW, addr: addr, port: port };
}

// 宛先ごとの上限の説明（rproxy v0.4.19、#341）
export const TARGET_CAP_HELP = '同時接続の上限（空欄は上限なし）：いっぱいの宛先は落ちた宛先と同じく飛ばし、すべていっぱいなら新しい接続を断ります。フェイルオーバーと組むと上から順に上限まで使います。';
// 宛先ごとの上限を使えない rproxy で、値があるとき
export const TARGET_CAP_PRESERVED = 'この rproxy では宛先ごとの上限を使えないので編集できません。そのまま残して送ります。';
export const EMPTY_HEALTH_CHECK: HealthCheckRow = { enabled: false, interval: '', timeout: '', port: '' };

export function toRows(targets: Target[]): TargetRow[] {
  return targets.map((t) => ({ addr: t.addr, port: t.port, weight: t.weight ?? '', backup: t.backup ?? false, maxConnections: t.max_connections ?? '' }));
}

// 1 行を rproxy の形の宛先にする（normalizeTargets で確かめる前の形）
export function rowToTarget(r: TargetRow): Record<string, unknown> {
  return {
    addr: r.addr.trim(),
    port: r.port === '' ? undefined : r.port,
    ...(r.weight === '' ? {} : { weight: r.weight }),
    ...(r.backup ? { backup: true } : {}),
    ...(r.maxConnections === '' ? {} : { max_connections: r.maxConnections }),
  };
}

export function toHealthCheckRow(hc: HealthCheck | null): HealthCheckRow {
  if (hc === null) return { ...EMPTY_HEALTH_CHECK };
  return { enabled: true, interval: hc.interval ?? '', timeout: hc.timeout ?? '', port: hc.port ?? '' };
}

// 行を入れ替える（failover では順番が優先度になる）
export function moveRow<T>(rows: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

// 行から rproxy の形を組み立てて確かめる。誤りがあれば日本語のメッセージを投げる（TlsError）
export function buildBalancing(
  rows: TargetRow[],
  balance: Balance,
  hc: HealthCheckRow,
  protocol: Protocol,
  portCount: number,
): Balancing {
  const targets = normalizeTargets(rows.map(rowToTarget));
  const healthCheck = hc.enabled
    ? normalizeHealthCheck({
      ...(hc.interval.trim() ? { interval: hc.interval.trim() } : {}),
      ...(hc.timeout.trim() ? { timeout: hc.timeout.trim() } : {}),
      ...(hc.port === '' ? {} : { port: hc.port }),
    })
    : null;
  const b: Balancing = { targets: targets, balance: balance ?? DEFAULT_BALANCE, healthCheck: healthCheck };
  checkBalancing(protocol, b, portCount);
  return b;
}

// 宛先ごとの状態を rproxy の stats.targets から探す（addr と port が合うもの。なければ同じ位置のもの）。
// rproxy の版によって返さない・項目が欠けることがあるので、見つからなければ null
export function targetStatus(targets: Target[], stats: TargetStats[] | undefined, index: number): TargetStats | null {
  if (!stats || stats.length === 0) return null;
  const t = targets[index];
  const byKey = stats.find((s) => s.addr !== undefined && s.port !== undefined && s.addr === t.addr && s.port === t.port);
  if (byKey) return byKey;
  if (stats.length === targets.length && stats[index] && stats[index].addr === undefined) return stats[index];
  return null;
}

// ヘルスチェックの表示（「10s ごと、タイムアウト 3s、ポート 5432」。英語は語句ごとに訳して ", " でつなぐ）
export function healthCheckLabel(hc: HealthCheck | null): string {
  if (hc === null) return '使わない（接続の失敗だけで判定）';
  return joinList([
    hc.interval !== undefined ? `${hc.interval}ごと` : '既定の間隔ごと',
    hc.timeout !== undefined ? `タイムアウト ${hc.timeout}` : 'タイムアウト 既定',
    hc.port !== undefined ? `ポート ${hc.port}` : '各宛先のポート',
  ]);
}

// 宛先の上限と今の数（「12 / 200」。上限がなければ数だけ、どちらもなければ null）
export function capUsageLabel(current: number | undefined, max: number | undefined): string | null {
  if (max === undefined) return current === undefined ? null : formatNumber(current);
  return `${current === undefined ? '-' : formatNumber(current)} / ${formatNumber(max)}`;
}

const formatNumber = (n: number) => n.toLocaleString('en-US');

// 宛先の今の数と上限の表示。aggregate（ノードが 2 つ以上のルールの「全体」）では数はノードの合計で、上限はノードごとなので
// 「12（上限 200・ノードごと）」と分けて出す（合計を 1 つのノードの上限と並べない）。どちらもなければ null
export function capText(current: number | undefined, max: number | undefined, aggregate: boolean): string | null {
  if (!aggregate) return capUsageLabel(current, max);
  if (current === undefined && max === undefined) return null;
  const count = current === undefined ? '-' : formatNumber(current);
  return max === undefined ? count : `${count}${translate(`（上限 ${formatNumber(max)}・ノードごと）`)}`;
}

// 上限で新しい接続・リクエストを断っているか（rproxy-api #341）：up の宛先があればそれがすべていっぱい
// （down の宛先は試さない）、up の宛先がなければすべていっぱい。いっぱいの宛先がなければ false。
// L4 は stats.targets、サーバ名ごとの転送先は stats.tls_routes、L7 はサービスごとの stats.http.services（どれか 1 つでも）
export function refusingAllFull(list: { up?: boolean; full?: boolean }[]): boolean {
  if (!list.some((t) => t.full === true)) return false;
  const up = list.filter((t) => t.up !== false);
  return (up.length > 0 ? up : list).every((t) => t.full === true);
}

// http：ルールの L7 の設定。状態コードで答える転送先のあるサービスは、いっぱいでもその転送先が答えるので断らない
// （rproxy の stats.http.services に状態コードの転送先は出ない）。stats は 1 つのノードの値で渡す（上限はノードごと）
export function targetsAllFull(stats: Pick<RuleStats, 'targets' | 'tls_routes' | 'http'> | null | undefined, http?: unknown): boolean {
  if (refusingAllFull(stats?.targets ?? [])) return true;
  if ((stats?.tls_routes ?? []).some((r) => refusingAllFull(r.targets ?? []))) return true;
  const specs = (http as { services?: Record<string, { servers?: { status?: unknown }[] }> } | null | undefined)?.services ?? {};
  const answersItself = (name: string) => (specs[name]?.servers ?? []).some((x) => x.status !== undefined);
  return Object.entries(stats?.http?.services ?? {}).some(([name, servers]) => !answersItself(name) && refusingAllFull(servers));
}

// 同じ宛先の、ノードごとのいっぱいのノード（ノードが 2 つ以上のルールの「全体」の表示。#341）
export function fullNodes(nodes: { node: string; stats: RuleStats | null }[] | undefined, find: (stats: RuleStats | null, node: string) => { full?: boolean } | null | undefined): string[] {
  if (!nodes || nodes.length < 2) return [];
  return nodes.filter((n) => find(n.stats, n.node)?.full === true).map((n) => n.node);
}

// ノードの stats.targets からルールの index 番目の宛先を探す。ノードごとの上書きで宛先が変わるノード（distAddr・targets）は
// 並びがルールと違うので、アドレスとポートが同じものだけ（位置では合わせない。上限のバッジを別の宛先に付けないように）
export function nodeTargetStatus(targets: Target[], overridden: boolean, stats: TargetStats[] | undefined, index: number): TargetStats | null {
  if (!overridden) return targetStatus(targets, stats, index);
  const t = targets[index];
  return stats?.find((s) => s.addr !== undefined && s.port !== undefined && s.addr === t.addr && s.port === t.port) ?? null;
}

// サーバ名ごとの転送先の宛先の状態を stats.tls_routes から探す（名前の組が同じもの。なければ同じ位置で名前のないもの）
export function tlsRouteStatus(names: string[], stats: TlsRouteStats[] | undefined, index: number): TlsRouteStats | null {
  if (!stats || stats.length === 0) return null;
  const key = (list: string[]) => [...list].map((n) => n.toLowerCase()).sort().join(',');
  return stats.find((s) => Array.isArray(s.server_names) && key(s.server_names) === key(names))
    ?? (stats[index] && !Array.isArray(stats[index].server_names) ? stats[index] : null);
}

// 宛先の生死を rproxy が報告するか：宛先が 1 つでヘルスチェックのないルールは、上限のためだけに stats.targets を出し、
// up / down は報告しない（rproxy-api #341）
export function reportsTargetHealth(rule: Pick<ForwardRule, 'targets' | 'healthCheck'>): boolean {
  return rule.targets.length > 1 || rule.healthCheck !== null;
}

// いま上限に達している宛先の数（L4 の宛先と L7 の転送先）
export function fullTargetCount(stats: Pick<RuleStats, 'targets' | 'tls_routes' | 'http'> | null | undefined): number {
  const l4 = [...(stats?.targets ?? []), ...(stats?.tls_routes ?? []).flatMap((r) => r.targets ?? [])].filter((t) => t.full === true).length;
  const l7 = Object.values(stats?.http?.services ?? {}).flat().filter((s) => s.full === true).length;
  return l4 + l7;
}

type CapsPart = Pick<ForwardRule, 'targets' | 'tls' | 'http'>;

// 宛先ごとの上限（targets[]・tls.routes[].targets[]・L7 の servers[] の max_connections。#341）を外した形
// （ずれ（drift.ts）・履歴（history.ts）は上限の違いを target_max_connections として別に出すので、targets・tls・http の比べ方からは外す）
export function withoutTargetCaps<T extends CapsPart>(rule: T): T {
  const strip = <U extends object>(t: U): U => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'max_connections')) as U;
  const services = (rule.http as { services?: Record<string, { servers?: object[] }> } | null)?.services;
  return {
    ...rule,
    targets: rule.targets.map(strip),
    tls: rule.tls.routes ? { ...rule.tls, routes: rule.tls.routes.map((r) => (r.targets ? { ...r, targets: r.targets.map(strip) } : r)) } : rule.tls,
    http: rule.http !== null && services
      ? { ...rule.http, services: Object.fromEntries(Object.entries(services).map(([n, s]) => [n, Array.isArray(s?.servers) ? { ...s, servers: s.servers.map(strip) } : s])) }
      : rule.http,
  };
}

// 宛先ごとの上限だけを並べた形（上限のない宛先は 0）。どこにも上限がなければ null
export function targetCapsOf(rule: CapsPart): unknown {
  const cap = (t: { max_connections?: unknown }) => (typeof t.max_connections === 'number' ? t.max_connections : 0);
  const services = (rule.http as { services?: Record<string, { servers?: { max_connections?: unknown }[] }> } | null)?.services ?? {};
  const out = {
    targets: rule.targets.map(cap),
    routes: (rule.tls.routes ?? []).map((r) => (r.targets ?? []).map(cap)),
    servers: Object.fromEntries(Object.keys(services).sort().map((n) => [n, (Array.isArray(services[n]?.servers) ? services[n].servers! : []).map(cap)])),
  };
  const any = out.targets.some((n) => n > 0) || out.routes.flat().some((n) => n > 0) || Object.values(out.servers).flat().some((n) => n > 0);
  return any ? out : null;
}
