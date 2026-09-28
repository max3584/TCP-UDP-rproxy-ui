// 変更の履歴（forward_rules_log。#61）の型と、前の版との差分。React に依存しない（tests/history.test.ts）

import type { ForwardRule } from './lib';
import { hostPort, portsLabel } from './dashboard';

export type HistoryAction = 'ADD' | 'UPDATE' | 'DELETE';
export const HISTORY_ACTIONS: HistoryAction[] = ['ADD', 'UPDATE', 'DELETE'];

export const ACTION_LABELS: Record<HistoryAction, string> = {
  ADD: '追加',
  UPDATE: '変更',
  DELETE: '削除',
};

// 1 件の履歴。rule はその操作のあとの内容（DELETE は削除する前の内容）。
// rule が null なのは、古い行などで内容を読めなかったとき
export interface HistoryEntry {
  id: number;
  // ISO 8601
  at: string;
  // 操作した利用者（IdP の sub）。004 より前の行は null
  actor: string | null;
  action: HistoryAction;
  protocol: string;
  srcAddr: string;
  srcPort: number;
  rule: ForwardRule | null;
  // 同じルールの 1 つ前の版との違い（最初の版、または読めないときは空）
  changes: string[];
  // 利用者が巻き戻せるか（固定ルールの履歴、内容が読めない履歴は false）
  revertible: boolean;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  total: number;
  page: number;
  perPage: number;
}

export interface HistoryFilter {
  protocol?: string;
  addr?: string;
  port?: number;
  user?: string;
  action?: HistoryAction;
  // YYYY-MM-DD（その日を含む）
  from?: string;
  to?: string;
}

function destination(rule: ForwardRule): string {
  if (rule.http !== null) return 'L7 (HTTP)';
  if (rule.targets.length > 0) {
    return rule.targets.map((t) => hostPort(t.addr, t.port)).join(', ') + `（${rule.balance}）`;
  }
  return hostPort(rule.distAddr, rule.distPort);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// 前の版からの違いを、画面に出す短い文にする（値の小さい項目は「前 → 後」、大きい項目は変わったことだけ）
export function ruleChanges(prev: ForwardRule | null, next: ForwardRule | null): string[] {
  if (prev === null || next === null) return [];
  const out: string[] = [];
  const scalar = (label: string, a: unknown, b: unknown) => {
    if (!same(a, b)) out.push(`${label}: ${a === null || a === undefined || a === '' ? '（なし）' : String(a)} → ${b === null || b === undefined || b === '' ? '（なし）' : String(b)}`);
  };
  if (prev.srcPortEnd !== next.srcPortEnd) {
    out.push(`待ち受けポート: ${portsLabel(prev.srcPort, prev.srcPortEnd)} → ${portsLabel(next.srcPort, next.srcPortEnd)}`);
  }
  if (destination(prev) !== destination(next)) out.push(`転送先: ${destination(prev)} → ${destination(next)}`);
  else if (!same(prev.targets, next.targets)) out.push('宛先の重み・予備を変更');
  scalar('送信元 IP の扱い', prev.sourceIp, next.sourceIp);
  if (prev.protocol === 'udp' || next.protocol === 'udp') scalar('UDP のアイドルタイムアウト（秒）', prev.udpIdleSecs, next.udpIdleSecs);
  if (!same(prev.tls, next.tls)) {
    out.push(prev.tls.mode !== next.tls.mode ? `TLS のモード: ${prev.tls.mode} → ${next.tls.mode}` : 'TLS の設定を変更');
  }
  scalar('STARTTLS', prev.starttls, next.starttls);
  if (prev.starttls !== null && next.starttls !== null) scalar('STARTTLS を必須にする', prev.starttlsRequired, next.starttlsRequired);
  if (!same(prev.allowFrom, next.allowFrom)) out.push(`接続を許可する送信元: ${prev.allowFrom.join(', ') || 'すべて'} → ${next.allowFrom.join(', ') || 'すべて'}`);
  if (!same(prev.http, next.http)) out.push('L7 の設定を変更');
  scalar('CrowdSec', prev.crowdsec ? '有効' : '無効', next.crowdsec ? '有効' : '無効');
  if (!same(prev.healthCheck, next.healthCheck)) out.push('ヘルスチェックを変更');
  if (!same(prev.extraListenAddrs ?? [], next.extraListenAddrs ?? [])) {
    out.push(`追加の待ち受けアドレス: ${(prev.extraListenAddrs ?? []).join(', ') || '（なし）'} → ${(next.extraListenAddrs ?? []).join(', ') || '（なし）'}`);
  }
  // 一時停止・再開（#63）
  scalar('状態', prev.enabled === false ? '停止中' : '有効', next.enabled === false ? '停止中' : '有効');
  return out;
}

// 画面の日付の入力（YYYY-MM-DD）を確かめる
export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function historyQuery(filter: HistoryFilter, page: number, perPage: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  return params.toString();
}
