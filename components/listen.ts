// 待ち受けアドレスの選択肢と、rproxy 自身が使うアドレスとの重なりの判定（tests/listen.test.ts）

import type { Protocol } from './lib';

export interface NetInterface {
  name: string;
  addr: string;
  family: 'ipv4' | 'ipv6';
  loopback: boolean;
  link_local: boolean;
}

export interface ReservedAddr {
  protocol: Protocol;
  addr: string;
  port: number;
  purpose: string;
}

export interface InterfacesInfo {
  interfaces: NetInterface[];
  reserved: ReservedAddr[];
}

export interface ListenOption {
  value: string;
  label: string;
}

// 選択肢：すべてのインターフェース、各インターフェース（ループバックは最後）。リンクローカルは除く
export function listenOptions(info: InterfacesInfo | null): ListenOption[] {
  const options: ListenOption[] = [
    { value: '0.0.0.0', label: '0.0.0.0 — すべての IPv4 インターフェース' },
    { value: '::', label: ':: — すべての IPv6 インターフェース' },
  ];
  const usable = (info?.interfaces ?? []).filter((i) => !i.link_local);
  const sorted = [...usable].sort((a, b) =>
    Number(a.loopback) - Number(b.loopback) || (a.family === b.family ? 0 : a.family === 'ipv4' ? -1 : 1) || a.name.localeCompare(b.name));
  for (const i of sorted) {
    if (options.some((o) => o.value === i.addr)) continue;
    options.push({ value: i.addr, label: `${i.name} — ${i.addr}${i.loopback ? '（ループバック）' : ''}` });
  }
  return options;
}

function isWildcard(addr: string): boolean {
  return addr === '0.0.0.0' || addr === '::';
}

// ルールが rproxy 自身の待ち受け（制御 API）と重なるなら、その相手を返す
export function reservedClash(
  reserved: ReservedAddr[],
  protocol: Protocol,
  addr: string,
  port: number | '',
  portEnd: number | '' | null,
): ReservedAddr | null {
  if (port === '' || addr === '') return null;
  const end = portEnd === '' || portEnd === null ? port : portEnd;
  return (
    reserved.find((r) =>
      r.protocol === protocol &&
      (r.addr === addr || isWildcard(r.addr) || isWildcard(addr)) &&
      r.port >= port && r.port <= end,
    ) ?? null
  );
}
