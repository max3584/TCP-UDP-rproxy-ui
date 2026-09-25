// TLS / STARTTLS / ポート範囲の入力の正規化と検証。画面（RuleForm）と API route の両方から使う。
// 組み合わせの規則は rproxy-api の src/tlsconf.rs の validate と同じにしてある（最終的な判定は rproxy）。
// エラーコードも rproxy に揃える（組み合わせの誤りは tls_config、UDP の sni は unsupported、形の誤りは invalid）。

import {
  CLIENT_AUTH_MODES,
  ClientAuthMode,
  Protocol,
  STARTTLS_PROTOCOLS,
  StartTls,
  TLS_MODES,
  TlsCertificate,
  TlsClientAuth,
  TlsMode,
  TlsRoute,
  TlsSpec,
  TlsUpstream,
} from './lib';

export type TlsErrorCode = 'invalid' | 'tls_config' | 'unsupported';

export class TlsError extends Error {
  constructor(message: string, public readonly code: TlsErrorCode) {
    super(message);
    this.name = 'TlsError';
  }
}

export const DEFAULT_TLS: TlsSpec = { mode: 'passthrough' };

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;

// 転送先に書けるアドレス（IP アドレスかホスト名）。IPv6 は文字種だけを見る
export function isRemoteAddr(addr: string): boolean {
  return IPV4_PATTERN.test(addr) || (addr.includes(':') && IPV6_CHARS.test(addr)) || HOSTNAME_PATTERN.test(addr);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

// `*.example.com` は 1 階層だけのワイルドカード（rproxy の valid_pattern と同じ）
export function isServerNamePattern(pattern: string): boolean {
  const name = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  return name.length > 0 && name.length <= 253
    && name.split('.').every((l) => l.length > 0 && l.length <= 63 && /^[A-Za-z0-9-]+$/.test(l));
}

function invalid(message: string): TlsError {
  return new TlsError(message, 'invalid');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// rproxy は未知のキーを拒否する（DB の options も deny_unknown_fields で読む）ので、ここでも拒否する
function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw invalid(`${where} に不明な項目があります: ${unknown.join(', ')}`);
}

// 空文字は「指定なし」として扱う
function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${where} は文字列で指定してください。`);
  const s = value.trim();
  return s === '' ? undefined : s;
}

function requiredString(value: unknown, where: string): string {
  const s = optionalString(value, where);
  if (s === undefined) throw invalid(`${where} を指定してください。`);
  return s;
}

function optionalBool(value: unknown, where: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid(`${where} は true か false で指定してください。`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${where} は配列で指定してください。`);
  return value;
}

// 入力の形を確かめて、既定値の項目を省いた形に揃える。組み合わせは checkTls で確かめる
export function normalizeTls(input: unknown): TlsSpec {
  if (input === undefined || input === null) return { ...DEFAULT_TLS };
  if (!isObject(input)) throw invalid('TLS の設定の形式が不正です。');
  checkKeys(input, ['mode', 'routes', 'certificates', 'client_auth', 'alpn', 'upstream'], 'tls');

  const mode = input.mode ?? 'passthrough';
  if (!TLS_MODES.includes(mode as TlsMode)) throw invalid('TLS のモードは passthrough / sni / terminate から選んでください。');
  const tls: TlsSpec = { mode: mode as TlsMode };

  const routes = list(input.routes, 'tls.routes').map((r): TlsRoute => {
    if (!isObject(r)) throw invalid('サーバ名ごとの転送先の形式が不正です。');
    checkKeys(r, ['server_name', 'remote_addr', 'remote_port'], 'tls.routes');
    const remotePort = r.remote_port;
    if (!isPort(remotePort)) throw invalid('サーバ名ごとの転送先のポート番号は1から65535の範囲で指定してください。');
    return {
      server_name: requiredString(r.server_name, 'サーバ名').toLowerCase(),
      remote_addr: requiredString(r.remote_addr, 'サーバ名ごとの転送先のアドレス'),
      remote_port: remotePort,
    };
  });
  if (routes.length > 0) tls.routes = routes;

  const certificates = list(input.certificates, 'tls.certificates').map((c): TlsCertificate => {
    if (!isObject(c)) throw invalid('証明書の指定の形式が不正です。');
    checkKeys(c, ['cert_file', 'chain_file', 'key_file'], 'tls.certificates');
    // キーの順番も rproxy の応答（cert_file, chain_file, key_file）に揃える
    const certFile = requiredString(c.cert_file, '証明書のファイル');
    const chain = optionalString(c.chain_file, '中間 CA のファイル');
    const keyFile = requiredString(c.key_file, '秘密鍵のファイル');
    return chain === undefined
      ? { cert_file: certFile, key_file: keyFile }
      : { cert_file: certFile, chain_file: chain, key_file: keyFile };
  });
  if (certificates.length > 0) tls.certificates = certificates;

  if (input.client_auth !== undefined && input.client_auth !== null) {
    if (!isObject(input.client_auth)) throw invalid('クライアント認証の設定の形式が不正です。');
    checkKeys(input.client_auth, ['mode', 'ca_file', 'chain_file'], 'tls.client_auth');
    const authMode = input.client_auth.mode ?? 'none';
    if (!CLIENT_AUTH_MODES.includes(authMode as ClientAuthMode)) {
      throw invalid('クライアント認証は none / optional / required から選んでください。');
    }
    const ca = optionalString(input.client_auth.ca_file, 'クライアント認証の CA ファイル');
    const chain = optionalString(input.client_auth.chain_file, 'クライアント証明書の中間 CA のファイル');
    // none でも chain_file があれば残して、checkTls で組み合わせの誤り（tls_config）にする（rproxy と同じ）
    if (authMode !== 'none' || chain !== undefined) {
      const auth: TlsClientAuth = { mode: authMode as ClientAuthMode };
      if (ca !== undefined && authMode !== 'none') auth.ca_file = ca;
      if (chain !== undefined) auth.chain_file = chain;
      tls.client_auth = auth;
    }
  }

  const alpn = list(input.alpn, 'tls.alpn').map((a) => {
    const s = requiredString(a, 'ALPN');
    if (s.length > 255) throw invalid('ALPN のプロトコル名が長すぎます。');
    return s;
  });
  if (alpn.length > 0) tls.alpn = alpn;

  if (input.upstream !== undefined && input.upstream !== null) {
    if (!isObject(input.upstream)) throw invalid('転送先の TLS の設定の形式が不正です。');
    const u = input.upstream;
    checkKeys(u, ['tls', 'server_name', 'ca_file', 'insecure_skip_verify', 'cert_file', 'chain_file', 'key_file'], 'tls.upstream');
    const upstream: TlsUpstream = {};
    if (optionalBool(u.tls, 'upstream.tls')) upstream.tls = true;
    const serverName = optionalString(u.server_name, '転送先のサーバ名');
    if (serverName !== undefined) upstream.server_name = serverName;
    const ca = optionalString(u.ca_file, '転送先の CA ファイル');
    if (ca !== undefined) upstream.ca_file = ca;
    if (optionalBool(u.insecure_skip_verify, 'upstream.insecure_skip_verify')) upstream.insecure_skip_verify = true;
    const cert = optionalString(u.cert_file, '転送先へのクライアント証明書');
    if (cert !== undefined) upstream.cert_file = cert;
    const upstreamChain = optionalString(u.chain_file, '転送先へのクライアント証明書の中間 CA');
    if (upstreamChain !== undefined) upstream.chain_file = upstreamChain;
    const key = optionalString(u.key_file, '転送先へのクライアント証明書の秘密鍵');
    if (key !== undefined) upstream.key_file = key;
    if (Object.keys(upstream).length > 0) tls.upstream = upstream;
  }

  return tls;
}

export function normalizeStartTls(value: unknown): StartTls | null {
  if (value === undefined || value === null || value === '') return null;
  if (!STARTTLS_PROTOCOLS.includes(value as StartTls)) throw invalid('STARTTLS は smtp / imap / pop3 から選んでください。');
  return value as StartTls;
}

// STARTTLS を必須にしないことを選べるのは SMTP だけ（IMAP / POP3 では rproxy が常に必須にする）
export function normalizeStartTlsRequired(value: unknown, starttls: StartTls | null): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') throw invalid('starttlsRequired は true か false で指定してください。');
  return starttls === 'smtp' ? value : true;
}

export function isDefaultTls(tls: TlsSpec): boolean {
  return tls.mode === 'passthrough' && Object.keys(tls).length === 1;
}

// 組み合わせを確かめる。portCount はポート範囲のポート数（単一ポートなら 1）
export function checkTls(protocol: Protocol, tls: TlsSpec, starttls: StartTls | null, portCount: number): void {
  const certificates = tls.certificates ?? [];
  const routes = tls.routes ?? [];
  if (protocol === 'udp' && tls.mode === 'sni') {
    throw new TlsError('SNI での振り分けは TCP でのみ使えます（UDP では「終端 (DTLS)」を使ってください）。', 'unsupported');
  }
  if (tls.mode === 'terminate' && certificates.length === 0) {
    throw new TlsError('終端（terminate）には証明書と秘密鍵を 1 組以上指定してください。', 'tls_config');
  }
  if (tls.mode !== 'terminate' && certificates.length > 0) {
    throw new TlsError('証明書は終端（terminate）でのみ使います。', 'tls_config');
  }
  if (tls.mode === 'passthrough' && routes.length > 0) {
    throw new TlsError('サーバ名ごとの転送先は sni か terminate でのみ使えます。', 'tls_config');
  }
  if (tls.mode !== 'terminate' && (tls.client_auth || tls.upstream || tls.alpn)) {
    throw new TlsError('クライアント認証・ALPN・転送先の TLS は終端（terminate）でのみ使えます。', 'tls_config');
  }
  if (tls.client_auth && tls.client_auth.mode !== 'none' && !tls.client_auth.ca_file) {
    throw new TlsError('クライアント証明書を検証するには CA ファイル（ルート CA）を指定してください。', 'tls_config');
  }
  if (tls.client_auth && tls.client_auth.mode === 'none' && tls.client_auth.chain_file !== undefined) {
    throw new TlsError('クライアント証明書の中間 CA は、クライアント証明書を検証する（optional / required）ときだけ指定できます。', 'tls_config');
  }
  if (tls.upstream && (tls.upstream.cert_file === undefined) !== (tls.upstream.key_file === undefined)) {
    throw new TlsError('転送先へのクライアント証明書と秘密鍵は両方とも指定してください。', 'tls_config');
  }
  if (tls.upstream && tls.upstream.chain_file !== undefined && tls.upstream.cert_file === undefined) {
    throw new TlsError('転送先へのクライアント証明書の中間 CA は、クライアント証明書と一緒に指定してください。', 'tls_config');
  }
  if (protocol === 'udp' && tls.alpn) {
    throw new TlsError('ALPN は TCP でのみ使えます。', 'tls_config');
  }
  for (const route of routes) {
    if (!isServerNamePattern(route.server_name)) {
      throw new TlsError(`サーバ名の形式が不正です: ${route.server_name}`, 'tls_config');
    }
    if (!isRemoteAddr(route.remote_addr)) {
      throw invalid(`サーバ名ごとの転送先には IP アドレスかホスト名を指定してください: ${route.remote_addr}`);
    }
    // ポート範囲では routes の remote_port も同じだけずれる
    if (route.remote_port + portCount - 1 > 65535) {
      throw invalid(`${route.server_name} の転送先ポートにポート範囲の長さを足すと 65535 を超えます。`);
    }
  }
  if (starttls !== null && (protocol !== 'tcp' || tls.mode !== 'terminate')) {
    throw new TlsError('STARTTLS は TCP で終端（terminate）のときだけ使えます。', 'tls_config');
  }
}

// ポート範囲のポート数。範囲の終わりが不正なら TlsError（invalid）
export function portCount(srcPort: number, srcPortEnd: number | null, distPort: number, maxRangePorts?: number): number {
  if (srcPortEnd === null) return 1;
  if (srcPortEnd < srcPort) throw invalid('ポート範囲の終わりは開始ポート以上にしてください。');
  const count = srcPortEnd - srcPort + 1;
  if (maxRangePorts !== undefined && count > maxRangePorts) {
    throw invalid(`ポート範囲は 1 ルールで ${maxRangePorts} ポートまでです。`);
  }
  if (distPort + count - 1 > 65535) throw invalid('転送先ポートにポート範囲の長さを足すと 65535 を超えます。');
  return count;
}

// DB の options 列（{"tls", "starttls", "starttls_required"} の JSON）。既定のままなら null を保存する。
// rproxy は deny_unknown_fields で読むので、この 3 つ以外のキーを入れてはいけない
export function optionsJson(tls: TlsSpec, starttls: StartTls | null, starttlsRequired: boolean): string | null {
  if (isDefaultTls(tls) && starttls === null) return null;
  return JSON.stringify({ tls: tls, starttls: starttls, starttls_required: starttlsRequired });
}

export interface RuleOptions {
  tls: TlsSpec;
  starttls: StartTls | null;
  starttlsRequired: boolean;
}

// options 列を読む。ドライバによっては JSON がオブジェクトで返るので両方を受け付ける
export function parseOptions(value: unknown): RuleOptions {
  if (value === undefined || value === null || value === '') {
    return { tls: { ...DEFAULT_TLS }, starttls: null, starttlsRequired: true };
  }
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (data === null) return { tls: { ...DEFAULT_TLS }, starttls: null, starttlsRequired: true };
  if (!isObject(data)) throw invalid('options 列の形式が不正です。');
  const starttls = normalizeStartTls(data.starttls);
  return {
    tls: normalizeTls(data.tls),
    starttls: starttls,
    starttlsRequired: normalizeStartTlsRequired(data.starttls_required, starttls),
  };
}
