// allow_from（接続を許可する送信元）の CIDR / 単一 IP の検証と正規化。画面と API route の両方から使う（Node の net に依存しない）。
// 規則は rproxy-api の src/cidr.rs と同じにしてある：
// - 単一の IP は /32（IPv4）・/128（IPv6）として扱う
// - 前後の [ ] は無視する（[fd00::]/8 も可）
// - IPv4-mapped IPv6（::ffff:10.0.0.1）は IPv4 として扱う（プレフィックスの上限も 32 になる）
// - ホスト部のビットは落とす（172.16.9.9/16 → 172.16.0.0/16）
// - 最大 64 件
// 正規化した形（rproxy の応答と同じ）で保存する。

export const MAX_ALLOW_FROM = 64;

export type CidrResult = { ok: true; value: string } | { ok: false; error: string };

type Parsed = { v4: boolean; bytes: number[] };

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    // 先頭の 0（010 など）は rproxy（Rust の Ipv4Addr）と同じく拒否する
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseGroups(s: string): number[] | null {
  if (s === '') return [];
  const groups: number[] = [];
  for (const g of s.split(':')) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function parseIpv6(s: string): number[] | null {
  // 末尾の IPv4 表記（::ffff:10.0.0.1 など）
  let tail: number[] = [];
  let body = s;
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    body = s.slice(0, lastColon + 1);
    // "a::b:10.0.0.1" の末尾の ":" を落とす（"::10.0.0.1" の "::" はそのまま残す）
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const rest = parseGroups(halves[1]);
    if (!head || !rest) return null;
    const missing = 8 - head.length - rest.length - tail.length;
    // "::" は 1 つ以上のグループを省く
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest, ...tail];
  } else {
    const all = parseGroups(body);
    if (!all) return null;
    groups = [...all, ...tail];
    if (groups.length !== 8) return null;
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

function parseIp(s: string): Parsed | null {
  const v4 = parseIpv4(s);
  if (v4) return { v4: true, bytes: v4 };
  if (!s.includes(':')) return null;
  const v6 = parseIpv6(s);
  if (!v6) return null;
  // IPv4-mapped（::ffff:a.b.c.d）は IPv4 にする
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return { v4: true, bytes: v6.slice(12) };
  return { v4: false, bytes: v6 };
}

function maskBytes(bytes: number[], prefix: number): number[] {
  return bytes.map((b, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return bits === 0 ? 0 : b & ((0xff << (8 - bits)) & 0xff);
  });
}

// RFC 5952 の圧縮表記（小文字、2 グループ以上続く 0 の最長の並びを :: にする。同じ長さなら先頭側）
export function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (gs: number[]) => gs.map((g) => g.toString(16)).join(':');
  if (bestLen < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`;
}

// 1 件の CIDR か IP を確かめて、正規化した形（10.0.0.5 → 10.0.0.5/32）にする
export function parseCidr(input: string): CidrResult {
  const s = input.trim();
  const bad: CidrResult = { ok: false, error: `CIDR か IP アドレスの形式ではありません: ${s === '' ? '（空）' : s}` };
  const slash = s.indexOf('/');
  const addrPart = (slash >= 0 ? s.slice(0, slash) : s).trim().replace(/^\[+/, '').replace(/\]+$/, '');
  const prefixPart = slash >= 0 ? s.slice(slash + 1) : null;
  let prefix: number | null = null;
  if (prefixPart !== null) {
    // rproxy はプレフィックスを 0〜255 の整数として読んでから、アドレスの種類ごとの上限と比べる
    if (!/^[0-9]{1,3}$/.test(prefixPart) || Number(prefixPart) > 255) return bad;
    prefix = Number(prefixPart);
  }
  const ip = parseIp(addrPart);
  if (!ip) return bad;
  const max = ip.v4 ? 32 : 128;
  if (prefix === null) prefix = max;
  if (prefix > max) {
    return { ok: false, error: `プレフィックス長 /${prefix} が長すぎます（${ip.v4 ? 'IPv4 は 32' : 'IPv6 は 128'} まで）: ${s}` };
  }
  const net = maskBytes(ip.bytes, prefix);
  const addr = ip.v4 ? net.join('.') : formatIpv6(net);
  return { ok: true, value: `${addr}/${prefix}` };
}

// フォームの入力（1 行に 1 件。空行は無視する）を配列にする
export function splitAllowFromText(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
}

// 配列を確かめて正規化する。最初の誤りを error で返す
export function checkAllowFrom(list: string[]): { ok: true; value: string[] } | { ok: false; error: string } {
  if (list.length > MAX_ALLOW_FROM) {
    return { ok: false, error: `接続を許可する送信元は ${MAX_ALLOW_FROM} 件までです（${list.length} 件あります）。` };
  }
  const value: string[] = [];
  for (const item of list) {
    const r = parseCidr(item);
    if (!r.ok) return { ok: false, error: r.error };
    value.push(r.value);
  }
  return { ok: true, value: value };
}
