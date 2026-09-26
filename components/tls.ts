// TLS / STARTTLS / ポート範囲の入力の正規化と検証。画面（RuleForm）と API route の両方から使う。
// 組み合わせの規則は rproxy-api の src/tlsconf.rs の validate と同じにしてある（最終的な判定は rproxy）。
// エラーコードも rproxy に揃える（組み合わせの誤りは tls_config、UDP の sni は unsupported、形の誤りは invalid）。

import {
  CLIENT_AUTH_MODES,
  ClientAuthMode,
  Protocol,
  STARTTLS_PROTOCOLS,
  HttpSpec,
  StartTls,
  TLS_MODES,
  TlsCertificate,
  TlsClientAuth,
  TlsMode,
  TlsOptions,
  TlsRoute,
  TlsSpec,
  TlsUnmatched,
  TlsUpstream,
} from './lib';
import { checkAllowFrom } from './cidr';

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
  checkKeys(input, ['mode', 'routes', 'certificates', 'client_auth', 'alpn', 'upstream', 'unmatched', 'options'], 'tls');

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
    checkKeys(c, ['cert_file', 'chain_file', 'key_file', 'acme', 'domains'], 'tls.certificates');
    // ACME（v0.3）：ファイルの代わりに resolver の名前と名前の一覧。ファイルとは一緒に書けない（rproxy と同じく tls_config）
    const acme = optionalString(c.acme, 'ACME の resolver');
    if (acme !== undefined) {
      const hasFiles = [c.cert_file, c.chain_file, c.key_file].some((f) => optionalString(f, '証明書のファイル') !== undefined);
      if (hasFiles) throw new TlsError('ACME の証明書には証明書・中間 CA・秘密鍵のファイルを指定できません。', 'tls_config');
      const domains = list(c.domains, 'tls.certificates.domains').map((d) => requiredString(d, 'ACME の証明書の名前').toLowerCase());
      if (domains.length === 0) throw new TlsError('ACME の証明書には名前（domains）を 1 つ以上指定してください。', 'tls_config');
      // キーの順番は rproxy の応答（acme, domains）に揃える
      return { acme: acme, domains: domains };
    }
    if (list(c.domains, 'tls.certificates.domains').length > 0) {
      throw new TlsError('証明書の名前（domains）は ACME（acme）と一緒にだけ指定できます。', 'tls_config');
    }
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

  // 既定の default は省く（rproxy の応答には常に含まれる）
  const unmatched = input.unmatched ?? 'default';
  if (unmatched !== 'default' && unmatched !== 'reject') {
    throw invalid('どのサーバ名にも一致しない接続の扱い（unmatched）は default か reject で指定してください。');
  }
  if ((unmatched as TlsUnmatched) === 'reject') tls.unmatched = 'reject';

  // TLS のオプション（v0.3）。空なら省く
  if (input.options !== undefined && input.options !== null) {
    if (!isObject(input.options)) throw invalid('TLS のオプションの形式が不正です。');
    checkKeys(input.options, ['min_version', 'cipher_suites'], 'tls.options');
    const options: TlsOptions = {};
    const minVersion = optionalString(input.options.min_version, 'TLS の最小バージョン');
    if (minVersion !== undefined) {
      if (minVersion !== '1.2' && minVersion !== '1.3') {
        throw new TlsError('TLS の最小バージョン（min_version）は 1.2 か 1.3 で指定してください。', 'tls_config');
      }
      options.min_version = minVersion;
    }
    const suites = list(input.options.cipher_suites, 'tls.options.cipher_suites').map((c) => requiredString(c, '暗号スイート'));
    if (suites.length > 0) options.cipher_suites = suites;
    if (Object.keys(options).length > 0) tls.options = options;
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
  if (tls.mode !== 'terminate' && tls.options) {
    throw new TlsError('TLS のオプションは終端（terminate）でのみ使えます。', 'tls_config');
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
  if (tls.unmatched !== undefined && tls.unmatched !== 'default'
    && (protocol !== 'tcp' || tls.mode === 'passthrough' || routes.length === 0)) {
    throw new TlsError('どのサーバ名にも一致しない接続を切断する（unmatched: reject）のは、TCP の sni / 終端（terminate）で、サーバ名ごとの転送先があるときだけ指定できます。', 'tls_config');
  }
}

// allow_from（接続を許可する送信元）。CIDR か単一の IP の配列で、最大 64 件。正規化した形（10.0.0.5 → 10.0.0.5/32）にする
export function normalizeAllowFrom(value: unknown): string[] {
  const items = list(value, 'allow_from').map((v) => {
    if (typeof v !== 'string') throw invalid('接続を許可する送信元は文字列（CIDR か IP アドレス）で指定してください。');
    return v;
  });
  const r = checkAllowFrom(items);
  if (!r.ok) throw invalid(r.error);
  return r.value;
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

// DB の options 列（{"tls", "starttls", "starttls_required", "allow_from", "http", "crowdsec"} の JSON）。既定のままなら null を保存する。
// allow_from は空なら、http は null なら、crowdsec は false なら省く。
// rproxy は deny_unknown_fields で読むので、この 6 つ以外のキーを入れてはいけない（crowdsec は rproxy v0.3.2 から）
export const OPTIONS_KEYS = ['tls', 'starttls', 'starttls_required', 'allow_from', 'http', 'crowdsec'];

export function optionsJson(
  tls: TlsSpec,
  starttls: StartTls | null,
  starttlsRequired: boolean,
  allowFrom: string[] = [],
  http: HttpSpec | null = null,
  crowdsec = false,
): string | null {
  if (isDefaultTls(tls) && starttls === null && allowFrom.length === 0 && http === null && !crowdsec) return null;
  return JSON.stringify({
    tls: tls,
    starttls: starttls,
    starttls_required: starttlsRequired,
    ...(allowFrom.length > 0 ? { allow_from: allowFrom } : {}),
    ...(http !== null ? { http: http } : {}),
    ...(crowdsec ? { crowdsec: true } : {}),
  });
}

// ルールの crowdsec（L4 で CrowdSec の判定に入っている接続元を切る）。省略は false
export function normalizeCrowdsec(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid('crowdsec は true か false で指定してください。');
  return value;
}

// L7 の設定（ルールの http）。中身は rproxy が検証するので、オブジェクトであることだけを確かめる
export function normalizeHttp(value: unknown): HttpSpec | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw invalid('L7 の設定（http）の形式が不正です。');
  return value;
}

export interface RuleOptions {
  tls: TlsSpec;
  starttls: StartTls | null;
  starttlsRequired: boolean;
  allowFrom: string[];
  http: HttpSpec | null;
  crowdsec: boolean;
}

// options 列を読む。ドライバによっては JSON がオブジェクトで返るので両方を受け付ける
export function parseOptions(value: unknown): RuleOptions {
  const empty = (): RuleOptions => ({ tls: { ...DEFAULT_TLS }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false });
  if (value === undefined || value === null || value === '') return empty();
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (data === null) return empty();
  if (!isObject(data)) throw invalid('options 列の形式が不正です。');
  // rproxy と同じく未知のキーは拒否する
  checkKeys(data, OPTIONS_KEYS, 'options');
  const starttls = normalizeStartTls(data.starttls);
  return {
    tls: normalizeTls(data.tls),
    starttls: starttls,
    starttlsRequired: normalizeStartTlsRequired(data.starttls_required, starttls),
    allowFrom: normalizeAllowFrom(data.allow_from),
    http: normalizeHttp(data.http),
    crowdsec: normalizeCrowdsec(data.crowdsec),
  };
}
