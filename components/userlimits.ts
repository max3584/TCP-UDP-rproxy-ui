// 利用者（admin でない人）のルールに書けるものの制限（#155。tests/userlimits.test.ts）。
// - サーバのファイル（証明書・鍵・CA・秘密のファイル）を指す項目：利用者は新しく書けない・変えられない（API で 403 file_not_allowed）。
//   TLS の証明書は rproxy の証明書の API に admin が登録した名前（tls.certificates[].cert）から選ぶ
// - 転送先（remote_addr・targets・tls.routes の宛先・L7 の URL など）：usertargets.ts が許可リストと断る宛先で確かめる
// 自分のルールに前からある値は、変えなければそのまま残せる（変更のたびに既存のルールが壊れないように）。比べるのは
// 「項目の位置（配列の添字・サービスとミドルウェアの名前を除く）と値」の組で、同じ組が前の内容にあれば前からあるものとみなす。
// React にも Node にも依存しない（画面と API route の両方で使う）

import type { ForwardRule } from './lib';
import { parseHttpUrl } from './httpspec';
import { effectiveRule } from './overrides';
import type { Overrides } from './overrides';

// サーバのファイルを指す 1 項目。where は位置（例 tls.certificates[].cert_file、http.middlewares.*.basic_auth.users_file）
export interface FileRef {
  where: string;
  value: string;
}

// 転送先の 1 件。ports はこの宛先へつなぐポートの範囲（ポート範囲のルールでは範囲）
export interface DestRef {
  where: string;
  host: string;
  ports: [number, number];
  // URL を読めなかった（ホストとポートが分からない）。利用者には前からあっても断る（#155 のレビュー H1）
  invalid?: boolean;
}

// ファイルを指す項目の名前（rproxy の設定で *_file。今後の項目もこの名前なら同じ扱い）
const FILE_KEY = /_file$/;
// L7 の設定で、rproxy が自分から接続しに行く URL を書く項目（サービスの servers[].url、ルートの to、forward_auth の address、oidc の issuer）
const URL_KEYS = new Set(['url', 'to', 'address', 'issuer']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 値をたどる。http の services / middlewares の下の名前は位置では * にする（名前を変えても前からある値とみなす）
function walk(value: unknown, path: string, visit: (key: string, v: unknown, path: string) => void, isMap = false): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, visit);
    return;
  }
  if (!isObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const p = isMap ? `${path}.*` : `${path}.${k}`;
    visit(k, v, p);
    walk(v, p, visit, path === 'http' && (k === 'services' || k === 'middlewares'));
  }
}

// ルール（tls と http）にあるファイルのパス
export function fileRefs(rule: Pick<ForwardRule, 'tls' | 'http'> | null | undefined): FileRef[] {
  if (!rule) return [];
  const out: FileRef[] = [];
  const visit = (key: string, v: unknown, path: string) => {
    if (FILE_KEY.test(key) && typeof v === 'string' && v.trim() !== '') out.push({ where: path, value: v.trim() });
  };
  walk(rule.tls, 'tls', visit);
  walk(rule.http, 'http', visit);
  return out;
}

// ルールにある登録済みの証明書の名前（tls.certificates[].cert）
export function certNames(rule: Pick<ForwardRule, 'tls'> | null | undefined): string[] {
  return (rule?.tls?.certificates ?? []).map((c) => c.cert).filter((c): c is string => typeof c === 'string' && c !== '');
}

// http(s):// の URL のホストとポート（既定のポートを補う）。厳しく読み（httpspec.ts の parseHttpUrl）、読めなければ null
export function urlHostPort(text: string): { host: string; port: number } | null {
  const u = parseHttpUrl(text);
  return u ? { host: u.host, port: u.port } : null;
}

// ルールの転送先（1 つのルール。ノードごとの上書きは呼ぶ側で effectiveRule にしてから渡す）
export function destRefs(rule: ForwardRule | null | undefined): DestRef[] {
  if (!rule) return [];
  const out: DestRef[] = [];
  // ポート範囲のルールは、転送先のポートから同じ数だけ使う
  const span = rule.srcPortEnd !== null && rule.srcPortEnd !== undefined ? Math.max(0, rule.srcPortEnd - rule.srcPort) : 0;
  const add = (where: string, host: unknown, port: unknown, ranged: boolean) => {
    if (typeof host !== 'string' || host.trim() === '' || typeof port !== 'number' || !Number.isInteger(port) || port < 1) return;
    out.push({ where: where, host: host.trim().replace(/^\[|\]$/g, '').toLowerCase(), ports: [port, ranged ? port + span : port] });
  };
  if (rule.distAddr) add('remote', rule.distAddr, rule.distPort, true);
  for (const t of rule.targets ?? []) add('targets[]', t.addr, t.port, true);
  // 宛先の死活確認は、各宛先のアドレスの health_check.port につなぐ
  const hcPort = rule.healthCheck?.port;
  if (hcPort !== undefined && hcPort !== null) for (const t of rule.targets ?? []) add('health_check', t.addr, hcPort, false);
  for (const r of rule.tls?.routes ?? []) {
    add('tls.routes[].remote', r.remote_addr, r.remote_port, false);
    for (const t of r.targets ?? []) add('tls.routes[].targets[]', t.addr, t.port, false);
  }
  walk(rule.http, 'http', (key, v, path) => {
    if (!URL_KEYS.has(key) || typeof v !== 'string') return;
    if (v.trim() === '') return;
    const hp = urlHostPort(v.trim());
    if (hp) add(path, hp.host, hp.port, false);
    else out.push({ where: path, host: v.trim(), ports: [0, 0], invalid: true });
  });
  return out;
}

// L7 の oidc ミドルウェアの設定（JSON。前からある設定と比べる）。rproxy は issuer の discovery の token_endpoint・jwks_uri にも
// つなぐが UI はそれを確かめられないので、利用者は oidc を新しく足せない・変えられない（#155 のレビュー M1）
export function oidcConfigs(rule: Pick<ForwardRule, 'http'> | null | undefined): string[] {
  const mws = rule?.http?.middlewares;
  if (!isObject(mws)) return [];
  return Object.values(mws).filter((m): m is Record<string, unknown> => isObject(m) && m.oidc !== undefined).map((m) => stableJson(m.oidc));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// 転送先を置き場所ごとに：ルールの分（rule:）と、ノードごとの上書きで変わる分（node:<名前>:）。
// 前からある値は同じ置き場所のものだけとみなす（ノードの上書きの値をルールへ、またはその逆へ動かせないように。#155 のレビュー L1）
export function locatedDests(rule: ForwardRule, overrides: Overrides | undefined): DestRef[] {
  const base = destRefs(rule);
  const baseKeys = new Set(base.map(destKey));
  const out = base.map((d) => ({ ...d, where: `rule:${d.where}` }));
  for (const [node, ov] of Object.entries(overrides ?? {})) {
    for (const d of destRefs(effectiveRule(rule, ov))) {
      if (!baseKeys.has(destKey(d))) out.push({ ...d, where: `node:${node}:${d.where}` });
    }
  }
  return out;
}

export function destKey(d: DestRef): string {
  return `${d.where}|${d.host}|${d.ports[0]}-${d.ports[1]}`;
}

export function fileKey(f: FileRef): string {
  return `${f.where}|${f.value}`;
}

// next にあって before にない組（前からあるものを除いた、新しく書いた・変えたもの）
export function addedRefs<T>(next: T[], before: T[], key: (v: T) => string): T[] {
  const old = new Set(before.map(key));
  const seen = new Set<string>();
  return next.filter((v) => {
    const k = key(v);
    if (old.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 利用者が使える登録済みの証明書の名前か（RPROXY_UI_USER_CERTS の名前の先頭。null なら制限なし）
export function certAllowed(name: string, prefixes: string[] | null): boolean {
  return prefixes === null || prefixes.some((p) => name.startsWith(p));
}

// 画面の注意（利用者に出す）
export const USER_FILES_NOTE =
  'ファイルのパス（証明書・鍵・CA・秘密のファイル）は管理者だけが指定できます。証明書は管理者が登録した名前（登録済みの証明書）から選んでください。前からある値はそのまま残せます。';
export const USER_TARGETS_NOTE =
  '転送先は管理者が許可した宛先（RPROXY_UI_USER_TARGETS）だけに使えます。ループバック・リンクローカル・rproxy の制御 API・この画面・データベースのアドレスには転送できません。';

// ---- 利用者に見せるほかの人のルール（固定ルールなど）からファイルのパスを伏せる ----

// 伏せた値（画面にもこのまま出る）
export const HIDDEN_FILE = '<hidden>';

function redactValue(value: unknown, found: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, found));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FILE_KEY.test(k) && typeof v === 'string' && v !== '') {
      found.add(v);
      out[k] = HIDDEN_FILE;
    } else {
      out[k] = redactValue(v, found);
    }
  }
  return out;
}

function redactText(text: string | null | undefined, found: Set<string>): string | null | undefined {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const f of found) out = out.split(f).join(HIDDEN_FILE);
  return out;
}

interface Redactable {
  tls?: unknown;
  http?: unknown;
  error?: string | null;
  certStatus?: { file?: string }[];
  nodes?: { error?: string | null; certStatus?: { file?: string }[] }[];
}

// tls・http の *_file、証明書の期限の file、誤りの文に出てくるそのパスを HIDDEN_FILE にする
export function redactFiles<T extends Redactable>(rule: T): T {
  const found = new Set<string>();
  const out: T = { ...rule };
  if (rule.tls !== undefined) out.tls = redactValue(rule.tls, found) as T['tls'];
  if (rule.http !== undefined && rule.http !== null) out.http = redactValue(rule.http, found) as T['http'];
  const certs = (list?: { file?: string }[]) => list?.map((c) => {
    if (typeof c.file === 'string' && c.file !== '') found.add(c.file);
    return typeof c.file === 'string' ? { ...c, file: HIDDEN_FILE } : c;
  });
  if (rule.certStatus) out.certStatus = certs(rule.certStatus) as T['certStatus'];
  if (rule.nodes) out.nodes = rule.nodes.map((n) => ({ ...n, ...(n.certStatus ? { certStatus: certs(n.certStatus) } : {}) })) as T['nodes'];
  // 誤りの文は最後に（上で見つけたパスをすべて伏せる）
  if (rule.error !== undefined) out.error = redactText(rule.error, found) as T['error'];
  if (out.nodes) out.nodes = out.nodes.map((n) => (n.error !== undefined ? { ...n, error: redactText(n.error, found) as string | null } : n)) as T['nodes'];
  return out;
}
