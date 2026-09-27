// 宛先を複数にしたとき（rproxy v0.3.3 の targets / balance / health_check）のフォームの行と組み立て。
// React に依存しない（tests/targets.test.ts）。形の検証は components/tls.ts の normalizeTargets / checkBalancing

import { Balance, DEFAULT_BALANCE, HealthCheck, Protocol, Target, TargetStats } from './lib';
import { Balancing, checkBalancing, normalizeHealthCheck, normalizeTargets } from './tls';

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
}

export interface HealthCheckRow {
  enabled: boolean;
  interval: string;
  timeout: string;
  port: number | '';
}

export const EMPTY_ROW: TargetRow = { addr: '', port: '', weight: '', backup: false };
export const EMPTY_HEALTH_CHECK: HealthCheckRow = { enabled: false, interval: '', timeout: '', port: '' };

export function toRows(targets: Target[]): TargetRow[] {
  return targets.map((t) => ({ addr: t.addr, port: t.port, weight: t.weight ?? '', backup: t.backup ?? false }));
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
  const targets = normalizeTargets(rows.map((r) => ({
    addr: r.addr.trim(),
    port: r.port === '' ? undefined : r.port,
    ...(r.weight === '' ? {} : { weight: r.weight }),
    ...(r.backup ? { backup: true } : {}),
  })));
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

// ヘルスチェックの表示（「10s ごと、タイムアウト 3s、ポート 5432」）
export function healthCheckLabel(hc: HealthCheck | null): string {
  if (hc === null) return '使わない（接続の失敗だけで判定）';
  return [
    `${hc.interval ?? '既定の間隔'}ごと`,
    `タイムアウト ${hc.timeout ?? '既定'}`,
    hc.port !== undefined ? `ポート ${hc.port}` : '各宛先のポート',
  ].join('、');
}
