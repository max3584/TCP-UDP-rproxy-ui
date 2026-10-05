// active_standby のグループで、どのノードが VIP を持っているか（act）を決める（#98）。React に依存しない。
// 各ノードの GET /interfaces のアドレスに VIP があれば act。グループの vip を設定していなければ、
// ルールの待ち受けアドレス（0.0.0.0・::・ループバック以外の特定のアドレス）を VIP とみなす
import type { HaStatus, NodeRole } from './lib';

// 判定に使えない待ち受けアドレス（全アドレス・ループバック）
export function isSpecificAddr(addr: string): boolean {
  const a = addr.toLowerCase();
  return a !== '0.0.0.0' && a !== '::' && !a.startsWith('127.') && a !== '::1';
}

// 判定に使うアドレス：グループの vip、なければルールの特定の待ち受けアドレス
export function vipAddrs(groupVips: string[], rule?: { srcAddr: string; extraListenAddrs?: string[] }): string[] {
  if (groupVips.length > 0) return groupVips;
  if (!rule) return [];
  return [rule.srcAddr, ...(rule.extraListenAddrs ?? [])].filter(isSpecificAddr).map((a) => a.toLowerCase());
}

// held: ノード → そのノードのアドレス（GET /interfaces。問い合わせできなければ null）。
// 役割は判定できたノードだけ。warning は判定できたノードがすべて VIP を持たない（none）か、2 つ以上が持つ（split）
export function haStatus(addrs: string[], nodes: string[], held: Map<string, Set<string> | null>): { status: HaStatus; roles: Map<string, NodeRole> } | null {
  if (addrs.length === 0) return null;
  const roles = new Map<string, NodeRole>();
  const active: string[] = [];
  let known = 0;
  for (const n of nodes) {
    const set = held.get(n);
    if (!set) continue;
    known += 1;
    const has = addrs.some((a) => set.has(a));
    roles.set(n, has ? 'active' : 'standby');
    if (has) active.push(n);
  }
  const warning = active.length > 1 ? 'split' : active.length === 0 && known === nodes.length ? 'none' : null;
  return { status: { addrs: addrs, active: active, warning: warning }, roles: roles };
}

// GET /interfaces の応答からアドレスの集合
export function interfaceAddrs(info: { interfaces?: { addr?: unknown }[] } | null | undefined): Set<string> {
  return new Set((info?.interfaces ?? []).map((i) => String(i.addr ?? '').toLowerCase()).filter((a) => a !== ''));
}
