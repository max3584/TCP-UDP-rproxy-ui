// 変更の履歴（forward_rules_log。#61）の型と、前の版との差分。React に依存しない（tests/history.test.ts）

import type { ForwardRule } from './lib';
import { hostPort, portsLabel } from './dashboard';
import { tc, translate } from '@/i18n/core';
import { v04Fields } from './v04';

// RESEND は 1 つのノードへの送り直し（#98。内容は変えない）、OVERRIDE はノードごとの上書きの変更（内容はそのノードで動かす内容）
export type HistoryAction = 'ADD' | 'UPDATE' | 'DELETE' | 'RESEND' | 'OVERRIDE';
export const HISTORY_ACTIONS: HistoryAction[] = ['ADD', 'UPDATE', 'DELETE', 'RESEND', 'OVERRIDE'];

export const ACTION_LABELS: Record<HistoryAction, string> = {
  ADD: '追加',
  UPDATE: '変更',
  DELETE: '削除',
  RESEND: '送り直し',
  OVERRIDE: 'ノードの上書き',
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
  // ノード／グループ（RPROXY_UI_NODES でノードを設定したときだけ）
  target?: string;
  // 送り直し（RESEND）の相手のノード
  node?: string;
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
  target?: string;
  user?: string;
  action?: HistoryAction;
  // YYYY-MM-DD（その日を含む）
  from?: string;
  to?: string;
}

function destination(rule: ForwardRule): string {
  if (rule.http !== null) return 'L7 (HTTP)';
  if (rule.targets.length > 0) {
    return translate(`${rule.targets.map((t) => hostPort(t.addr, t.port)).join(', ')}（${rule.balance}）`);
  }
  return hostPort(rule.distAddr, rule.distPort);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const NONE = '（なし）';
// 「有効」は機能のオン・オフ・ルールの状態の意味で訳す（証明書の「有効」とは訳が違う）
const onOff = (on: boolean) => (on ? tc('有効', 'on-off') : translate('無効'));
const ruleState = (rule: ForwardRule) => (rule.enabled === false ? translate('停止中') : tc('有効', 'on-off'));

// 前の版からの違いを、画面に出す短い文にする（値の小さい項目は「前 → 後」、大きい項目は変わったことだけ）。
// 文は今の言語で作る（API が返す。値の「有効」などは場面に合わせて訳す）
export function ruleChanges(prev: ForwardRule | null, next: ForwardRule | null): string[] {
  if (prev === null || next === null) return [];
  const out: string[] = [];
  const change = (label: string, a: string, b: string) => out.push(`${translate(label)}: ${a} → ${b}`);
  const value = (v: unknown) => (v === null || v === undefined || v === '' ? translate(NONE) : String(v));
  const scalar = (label: string, a: unknown, b: unknown) => {
    if (!same(a, b)) change(label, value(a), value(b));
  };
  const note = (text: string) => out.push(translate(text));
  if (prev.srcPortEnd !== next.srcPortEnd) {
    change('待ち受けポート', portsLabel(prev.srcPort, prev.srcPortEnd), portsLabel(next.srcPort, next.srcPortEnd));
  }
  if (destination(prev) !== destination(next)) change('転送先', destination(prev), destination(next));
  else if (!same(prev.targets, next.targets)) note('宛先の重み・予備を変更');
  scalar('送信元 IP の扱い', prev.sourceIp, next.sourceIp);
  if (prev.protocol === 'udp' || next.protocol === 'udp') scalar('UDP のアイドルタイムアウト（秒）', prev.udpIdleSecs, next.udpIdleSecs);
  if (!same(prev.tls, next.tls)) {
    if (prev.tls.mode !== next.tls.mode) change('TLS のモード', prev.tls.mode, next.tls.mode);
    else note('TLS の設定を変更');
  }
  scalar('STARTTLS', prev.starttls, next.starttls);
  if (prev.starttls !== null && next.starttls !== null) scalar('STARTTLS を必須にする', prev.starttlsRequired, next.starttlsRequired);
  if (!same(prev.allowFrom, next.allowFrom)) {
    change('接続を許可する送信元', prev.allowFrom.join(', ') || translate('すべて'), next.allowFrom.join(', ') || translate('すべて'));
  }
  if (!same(prev.http, next.http)) note('L7 の設定を変更');
  scalar('CrowdSec', onOff(prev.crowdsec), onOff(next.crowdsec));
  if (!same(prev.healthCheck, next.healthCheck)) note('ヘルスチェックを変更');
  if (!same(prev.extraListenAddrs ?? [], next.extraListenAddrs ?? [])) {
    change('追加の待ち受けアドレス', value((prev.extraListenAddrs ?? []).join(', ')), value((next.extraListenAddrs ?? []).join(', ')));
  }
  // v0.4 の項目（中身が大きいので変わったことだけ）
  const pv = v04Fields(prev);
  const nv = v04Fields(next);
  if (!same(pv.labels, nv.labels)) note('ラベルを変更');
  if (!same(pv.limits, nv.limits)) note('L4 の制限を変更');
  if (!same(pv.bandwidth, nv.bandwidth)) note('帯域の上限を変更');
  if (!same(pv.geoip, nv.geoip)) note('GeoIP を変更');
  if (!same(pv.outlier_detection, nv.outlier_detection)) note('受け身のヘルスチェックを変更');
  // 一時停止・再開（#63）
  scalar('状態', ruleState(prev), ruleState(next));
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
