// 利用者（admin でない人）の転送先の確認（#155。tests/userlimits.test.ts）。サーバ側（API route）だけで使う。
// - RPROXY_UI_USER_TARGETS（CIDR とホスト名）があれば、その中だけ。ホスト名は名前が一致するか、解決したアドレスがすべて CIDR の中
// - 次の宛先は既定で断る：ループバック・リンクローカル（169.254.169.254 などのメタデータを含む）・未指定・マルチキャスト・ブロードキャスト。
//   許可リストにその範囲の中だけの CIDR（例 127.0.0.1/32）を書けば使える（0.0.0.0/0 のような広い範囲では使えない）
// - rproxy の制御 API・この UI・データベース（DB_HOST の解決先）のアドレスとポートと、RPROXY_UI_PROTECTED_TARGETS は、許可リストに書いても断る
// - URL を読めない宛先（ポートが数字でない・65535 より大きい・ゾーン ID など）は断る
// - ホスト名は UI のホストで解決し、解決したアドレスもすべて確かめる（解決できなければ断る）。
//   rproxy が後で解決し直したときに名前の向き先が変わる（DNS rebinding）ことまでは防げないので、名前は管理者が持つものを許可リストに書く

import { BlockList } from 'node:net';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import { parseCidr } from './cidr';
import type { DestRef } from './userlimits';
import { urlHostPort } from './userlimits';
import type { ProtectedTarget, UserTargets } from './roles';
import type { InterfacesInfo } from './listen';

// 守る相手の 1 件（アドレスは正規化した IP）
export interface ProtectedAddr {
  addr: string;
  port: number;
  what: string;
}

export interface Refusal {
  ref: DestRef;
  reason: string;
}

export interface TargetDeps {
  resolve: (host: string) => Promise<string[]>;
  protectedAddrs: ProtectedAddr[];
  // RPROXY_UI_PROTECTED_TARGETS（CIDR とポート。port が null ならすべて）
  protectedCidrs?: ProtectedTarget[];
}

// 既定で断る範囲
const SPECIAL: { cidr: string; label: string }[] = [
  { cidr: '127.0.0.0/8', label: 'ループバック' },
  { cidr: '::1/128', label: 'ループバック' },
  { cidr: '0.0.0.0/8', label: '未指定' },
  { cidr: '::/128', label: '未指定' },
  { cidr: '169.254.0.0/16', label: 'リンクローカル' },
  { cidr: 'fe80::/10', label: 'リンクローカル' },
  { cidr: '224.0.0.0/4', label: 'マルチキャスト' },
  { cidr: 'ff00::/8', label: 'マルチキャスト' },
  { cidr: '255.255.255.255/32', label: 'ブロードキャスト' },
  // クラウドのメタデータ（AWS の IPv6。IPv4 の 169.254.169.254 はリンクローカルに入る）
  { cidr: 'fd00:ec2::254/128', label: 'クラウドのメタデータ' },
];

// IP アドレスなら正規化した形（IPv6 は圧縮表記、IPv4-mapped は IPv4）。IP でなければ null
export function toIp(host: string): string | null {
  const s = host.trim().replace(/^\[|\]$/g, '');
  if (s === '' || s.includes('/') || s.includes('%')) return null;
  const r = parseCidr(s);
  return r.ok ? r.value.slice(0, r.value.lastIndexOf('/')) : null;
}

function family(ip: string): 'ipv4' | 'ipv6' {
  return ip.includes(':') ? 'ipv6' : 'ipv4';
}

function splitCidr(cidr: string): { net: string; prefix: number } {
  const i = cidr.lastIndexOf('/');
  return { net: cidr.slice(0, i), prefix: Number(cidr.slice(i + 1)) };
}

export function cidrContains(cidr: string, ip: string): boolean {
  const { net, prefix } = splitCidr(cidr);
  if (family(net) !== family(ip)) return false;
  const bl = new BlockList();
  bl.addSubnet(net, prefix, family(net));
  return bl.check(ip, family(ip));
}

// inner（CIDR）が outer（CIDR）の中にすっぽり入るか
function cidrWithin(inner: string, outer: string): boolean {
  const a = splitCidr(inner);
  const b = splitCidr(outer);
  return a.prefix >= b.prefix && cidrContains(outer, a.net);
}

// ホスト名が許可リストの名前に一致するか（*.example.com は下の名前すべて。example.com 自身は含まない）
export function nameAllowed(host: string, names: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return names.some((n) => (n.startsWith('*.') ? h.endsWith(n.slice(1)) : h === n));
}

function portsLabel(ports: [number, number]): string {
  return ports[0] === ports[1] ? String(ports[0]) : `${ports[0]}-${ports[1]}`;
}

// 1 件の宛先を確かめる。断る理由（なければ null）
async function refusalOf(ref: DestRef, allow: UserTargets | null, deps: TargetDeps): Promise<string | null> {
  if (ref.invalid) return `URL「${ref.host}」のホストとポートを読めません（ポートは 1〜65535 の数字、ゾーン ID は不可）。`;
  const literal = toIp(ref.host);
  let addrs: string[];
  if (literal !== null) {
    addrs = [literal];
  } else {
    try {
      addrs = (await deps.resolve(ref.host)).map((a) => toIp(a)).filter((a): a is string => a !== null);
    } catch {
      addrs = [];
    }
    if (addrs.length === 0) return `${ref.host} を名前解決できません（解決できない名前は確かめられないので使えません）。`;
  }
  const byName = literal === null && allow !== null && nameAllowed(ref.host, allow.names);
  for (const a of addrs) {
    const hit = deps.protectedAddrs.find((p) => p.addr === a && p.port >= ref.ports[0] && p.port <= ref.ports[1]);
    if (hit) return `${a}:${hit.port} は ${hit.what} のアドレスです。`;
    const fixed = (deps.protectedCidrs ?? []).find((p) => cidrContains(p.cidr, a) && (p.port === null || (p.port >= ref.ports[0] && p.port <= ref.ports[1])));
    if (fixed) return `${a} は管理者が守る宛先（RPROXY_UI_PROTECTED_TARGETS の ${fixed.cidr}${fixed.port !== null ? `:${fixed.port}` : ''}）です。`;
    const special = SPECIAL.find((s) => cidrContains(s.cidr, a));
    if (special && !(allow?.cidrs ?? []).some((c) => cidrContains(c, a) && cidrWithin(c, special.cidr))) {
      return `${a} は ${special.label} のアドレスです。`;
    }
    if (allow !== null && !byName && !allow.cidrs.some((c) => cidrContains(c, a))) {
      return literal === null ? `${ref.host}（${a}）は許可された宛先の外です。` : `${a} は許可された宛先の外です。`;
    }
  }
  return null;
}

// 宛先をまとめて確かめ、断るものを返す（同じホストとポートは 1 回だけ）
export async function checkDestinations(refs: DestRef[], allow: UserTargets | null, deps: TargetDeps): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const done = new Map<string, string | null>();
  for (const ref of refs) {
    const k = `${ref.host}|${ref.ports[0]}-${ref.ports[1]}`;
    if (!done.has(k)) done.set(k, await refusalOf(ref, allow, deps));
    const reason = done.get(k)!;
    if (reason !== null) out.push({ ref: ref, reason: reason });
  }
  return out;
}

export function refusalText(refusals: Refusal[]): string {
  return refusals.map((r) => (r.ref.invalid ? r.reason : `${r.ref.host}:${portsLabel(r.ref.ports)}（${r.reason}）`)).join(' ');
}

// ---- 守る相手（制御 API・UI・DB）を集める ----

export async function resolveHost(host: string): Promise<string[]> {
  const ip = toIp(host);
  if (ip !== null) return [ip];
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((f) => f.address);
}

function localAddrs(): string[] {
  const out = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      const ip = toIp(i.address);
      if (ip) out.add(ip);
    }
  }
  return [...out];
}

function isWildcard(addr: string): boolean {
  return addr === '0.0.0.0' || addr === '::' || addr === '';
}

function isLoopback(ip: string): boolean {
  return cidrContains('127.0.0.0/8', ip) || ip === '::1';
}

export interface ProtectedSources {
  env: Record<string, string | undefined>;
  // rproxy の制御 API の URL（RPROXY_API_URL と RPROXY_UI_NODES のノード。unix: は除く）
  apiUrls: string[];
  // 置き場所のノードの GET /interfaces（取れなかったノードは入れない）
  interfaces: InterfacesInfo[];
  resolve?: (host: string) => Promise<string[]>;
  local?: () => string[];
}

// 守る相手の一覧。名前を解決できないものは飛ばす（そのアドレスはどのみち使われていない）
export async function protectedAddrs(src: ProtectedSources): Promise<ProtectedAddr[]> {
  const resolve = src.resolve ?? resolveHost;
  const local = src.local ?? localAddrs;
  const out: ProtectedAddr[] = [];
  const add = async (host: string, port: number, what: string, alsoLocal: boolean) => {
    let addrs: string[] = [];
    try {
      addrs = (await resolve(host)).map((a) => toIp(a)).filter((a): a is string => a !== null);
    } catch {
      addrs = [];
    }
    // ループバックで待ち受けているもの（同じホストの DB など）は、ほかのアドレスで待ち受けていることもあるので、このホストのアドレスも守る
    if (alsoLocal || addrs.some(isLoopback)) addrs = [...addrs, ...local()];
    for (const a of new Set(addrs)) out.push({ addr: a, port: port, what: what });
  };
  for (const url of src.apiUrls) {
    const hp = urlHostPort(url);
    if (hp) await add(hp.host, hp.port, 'rproxy の制御 API', false);
  }
  for (const info of src.interfaces) {
    const own = (info.interfaces ?? []).map((i) => toIp(i.addr)).filter((a): a is string => a !== null);
    for (const r of info.reserved ?? []) {
      const addrs = isWildcard(r.addr) ? [...own, '127.0.0.1', '::1'] : [toIp(r.addr) ?? r.addr];
      for (const a of addrs) out.push({ addr: a, port: r.port, what: 'rproxy の制御 API' });
    }
  }
  const env = src.env;
  const uiPort = Number(env.PORT) || 3000;
  const uiHost = (env.HOSTNAME ?? '').trim();
  await add(uiHost === '' || isWildcard(uiHost) ? '127.0.0.1' : uiHost, uiPort, 'この管理画面', uiHost === '' || isWildcard(uiHost));
  const self = env.NEXTAUTH_URL ? urlHostPort(env.NEXTAUTH_URL) : null;
  if (self) await add(self.host, self.port, 'この管理画面', false);
  await add((env.DB_HOST ?? '').trim() || 'localhost', Number(env.DB_PORT) || 3306, 'データベース', false);
  return out;
}
