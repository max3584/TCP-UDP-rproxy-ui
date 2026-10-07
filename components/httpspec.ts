// L7（ルールの http）の型、検証、match の式の組み立て（tests/httpspec.test.ts）。
// 形は rproxy-api の docs/API.md「v0.3 の設定」と src/http/mod.rs。最終的な検証は rproxy が行うので、
// ここでは画面で先に分かる誤り（名前の重複、存在しない参照、match の書き方、URL の形）だけを確かめる。
// React にも Node にも依存しない（画面と API route の両方で使う）

import { BALANCES, type Balance } from './lib';
import type { HttpSpec } from './lib';
import type { HttpOutlierSpec } from './v04';
import { normalizeHttpOutlier, parseDurationMs } from './v04';
import { joinList } from '@/i18n/core';

// ルートの時間の上限（rproxy の Gateway API 向けの項目、#227。features.http_options の route_timeouts）。0s は上限なし
export interface RouteTimeoutsSpec {
  // リクエストを受けてから応答の本文を送り終えるまで
  request?: string;
  // 転送先への 1 回の送信の、送り始めから応答の本文の終わりまで
  backend_request?: string;
}

export interface RouteSpec {
  name: string;
  match: string;
  priority?: number;
  service?: string;
  to?: string;
  middlewares?: string[];
  timeouts?: RouteTimeoutsSpec;
}

// 転送先。url（http:// / https://）か status（固定の状態コードで答える、#235）のどちらか一方
export interface ServerSpec {
  url?: string;
  weight?: number;
  status?: number;
  // この転送先へ送るリクエストにだけ働くミドルウェア（#229。SERVER_MIDDLEWARES の種類だけ）
  middlewares?: string[];
}

// 転送先との HTTP の版（#233。省略は http1）
export const UPSTREAM_PROTOCOLS = ['http1', 'h2', 'h2c', 'auto'] as const;
export type UpstreamProtocol = typeof UPSTREAM_PROTOCOLS[number];

export const UPSTREAM_PROTOCOL_LABELS: Record<UpstreamProtocol, string> = {
  http1: 'HTTP/1.1（既定）',
  h2: 'HTTP/2（TLS。https:// の転送先）',
  h2c: 'HTTP/2（平文。http:// の転送先）',
  auto: '自動（https:// は ALPN で選ぶ）',
};

// サービスの転送先への TLS（#236。ルールの tls.upstream の代わり）
export interface ServiceTlsSpec {
  server_name?: string;
  ca_file?: string;
  subject_alt_names?: string[];
  cert_file?: string;
  key_file?: string;
  chain_file?: string;
  insecure_skip_verify?: boolean;
}

export interface ServiceSpec {
  servers: ServerSpec[];
  health_check?: { path: string; interval?: string; timeout?: string };
  sticky?: { cookie: string };
  pass_host_header?: boolean;
  timeouts?: { connect?: string; response?: string };
  // 転送先の振り分け方（rproxy v0.3.3。省略は round_robin。failover は servers の順）
  balance?: Balance;
  // 受け身のヘルスチェック（rproxy v0.4、#170。features.services に outlier_detection があるとき）
  outlier_detection?: HttpOutlierSpec;
  // 転送先との HTTP の版（#233。features.services に protocol があるとき）
  protocol?: UpstreamProtocol;
  // https:// の転送先への TLS（#236。features.services に tls があるとき）
  tls?: ServiceTlsSpec;
}

// {種類: 設定}（種類は 1 つだけ）
export type MiddlewareSpec = Record<string, Record<string, unknown>>;

export interface DefaultSpec {
  status?: number;
  service?: string;
}

export interface HttpRules {
  http3?: boolean;
  routes: RouteSpec[];
  default?: DefaultSpec;
  services?: Record<string, ServiceSpec>;
  middlewares?: Record<string, MiddlewareSpec>;
}

// ミドルウェアの種類（rproxy の MiddlewareSpec と同じ順）と画面の名前
export const MIDDLEWARE_KINDS: Record<string, string> = {
  redirect_scheme: 'スキームのリダイレクト（HTTP→HTTPS）',
  redirect_regex: '正規表現のリダイレクト',
  rate_limit: 'レート制限',
  in_flight: '同時リクエスト数の制限',
  crowdsec: 'CrowdSec',
  ip_allow: '送信元 IP の許可リスト',
  headers: 'ヘッダ（HSTS・CSP・CORS など）',
  forward_auth: 'ForwardAuth（外部の認証）',
  oidc: 'OIDC（Keycloak など）',
  basic_auth: 'Basic 認証',
  strip_prefix: 'パスの接頭辞を取る',
  add_prefix: 'パスに接頭辞を足す',
  replace_path: 'パスを置き換える',
  replace_path_regex: 'パスを正規表現で置き換える',
  compress: '圧縮',
  buffering: '本文の大きさの上限',
  retry: '再試行',
  circuit_breaker: 'サーキットブレーカー',
  errors: '独自のエラーページ',
  respond: '固定の応答（拒否・メンテナンス表示）',
  geoip: 'GeoIP（国・AS での許可と拒否）',
  cors: 'CORS（オリジンの許可）',
  mirror: 'ミラー（リクエストの写しを送る）',
  replace_host: 'Host の書き換え',
};

// 新しいミドルウェアの設定のひな形（必須の項目を埋める）
export const MIDDLEWARE_TEMPLATES: Record<string, Record<string, unknown>> = {
  redirect_scheme: { scheme: 'https', permanent: true },
  redirect_regex: { regex: '^https?://www\\.(.+)$', replacement: 'https://$1', permanent: true },
  rate_limit: { average: 10, period: '1s', burst: 20, source: 'ip' },
  in_flight: { amount: 10 },
  crowdsec: { appsec: false, on_error: 'allow' },
  ip_allow: { source_range: ['10.0.0.0/8'] },
  headers: { hsts: { max_age: 31536000, include_subdomains: true }, frame_deny: true, content_type_nosniff: true },
  forward_auth: { address: 'http://127.0.0.1:4181/auth', response_headers: [], trust_forward_header: false },
  oidc: { issuer: '', client_id: '', client_secret_file: '', scopes: ['openid'], cookie_secret_file: '' },
  basic_auth: { users_file: '' },
  strip_prefix: { prefixes: ['/api'] },
  add_prefix: { prefix: '/api' },
  replace_path: { path: '/' },
  replace_path_regex: { regex: '^/old/(.*)$', replacement: '/new/$1' },
  compress: { encodings: ['zstd', 'br', 'gzip'] },
  buffering: { max_request_body: 10485760 },
  retry: { attempts: 3, initial_interval: '100ms' },
  circuit_breaker: { failure_percent: 50, window: '10s', recovery: '30s' },
  errors: { status: ['500-599'], service: '', path: '/{status}.html' },
  respond: { status: 403, body: 'Forbidden' },
  geoip: { allow_countries: ['JP'] },
  cors: { allow_origins: ['https://www.example.com'], allow_methods: ['GET', 'POST'] },
  mirror: { service: '', percent: 100 },
  replace_host: { host: 'app.example.com' },
};

// 転送先ごと（servers[].middlewares）に使えるミドルウェアの種類（rproxy の SERVER_MIDDLEWARES。書き換えるだけのもの）
export const SERVER_MIDDLEWARES = ['headers', 'replace_host', 'strip_prefix', 'add_prefix', 'replace_path', 'replace_path_regex'];

// リダイレクトの状態コード（#226）
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

// features.http_options の名前（rproxy の Features::http_options）
export const HTTP_OPTIONS = ['headers_add', 'redirect_status', 'route_timeouts', 'server_middlewares', 'server_status', 'retry_status'] as const;
export type HttpOption = typeof HTTP_OPTIONS[number];

// 応答を自分で返すミドルウェア（service のないルートでも使える）
export const ANSWERING_KINDS = ['redirect_scheme', 'redirect_regex', 'respond'];

export function middlewareKind(m: MiddlewareSpec): string {
  return Object.keys(m)[0] ?? '';
}

// ---- match の式（rproxy の src/http/matcher.rs と同じ書き方）----

type Token = { t: 'ident' | 'str' | '(' | ')' | ',' | '&&' | '||' | '!'; v?: string };

// 関数名と引数の数（最小, 最大）
const MATCHERS: Record<string, [number, number]> = {
  Host: [1, Infinity],
  HostRegexp: [1, 1],
  Path: [1, Infinity],
  PathPrefix: [1, Infinity],
  PathRegexp: [1, 1],
  Method: [1, Infinity],
  Header: [2, 2],
  HeaderRegexp: [2, 2],
  Query: [1, 2],
  QueryRegexp: [2, 2],
  ClientIP: [1, Infinity],
};

export const MATCHER_NAMES = Object.keys(MATCHERS);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',' || c === '!') { out.push({ t: c }); i++; continue; }
    if (c === '&' || c === '|') {
      if (src[i + 1] !== c) throw new Error(`${c}${c} と書いてください（${i + 1} 文字目）`);
      out.push({ t: c === '&' ? '&&' : '||' });
      i += 2;
      continue;
    }
    if (c === '`' || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`${i + 1} 文字目からの文字列が閉じていません`);
      out.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      out.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`使えない文字 '${c}'（${i + 1} 文字目）`);
  }
  return out;
}

// 式の中の Host(...) に書かれた名前（書いた順。! で否定されたものは除く）。式が壊れていれば空
export function hostsOfMatch(src: string): string[] {
  if (checkMatch(src) !== null) return [];
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t !== 'ident' || tok.v !== 'Host' || tokens[i + 1]?.t !== '(') continue;
    if (tokens[i - 1]?.t === '!') continue;
    for (let j = i + 2; j < tokens.length && tokens[j].t !== ')'; j++) {
      if (tokens[j].t === 'str' && tokens[j].v) out.push(tokens[j].v as string);
    }
  }
  return out;
}

// 式の誤りを日本語で返す（正しければ null）。正規表現と CIDR の中身までは確かめない（rproxy が確かめる）
export function checkMatch(src: string): string | null {
  if (src.trim() === '') return 'match を入力してください。';
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (e) {
    return (e as Error).message;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (msg: string): never => { throw new Error(msg); };

  const unary = (): void => {
    const tok = next();
    if (!tok) fail('式が途中で終わっています');
    if (tok.t === '!') return unary();
    if (tok.t === '(') {
      or();
      if (next()?.t !== ')') fail(') が足りません');
      return;
    }
    if (tok.t !== 'ident') fail('Host(`...`) のような条件を書いてください');
    const name = tok.v!;
    const arity = MATCHERS[name];
    if (!arity) fail(`知らない条件 ${name}（使えるのは ${joinList(MATCHER_NAMES, '・')}）`);
    if (next()?.t !== '(') fail(`${name} の後に ( が必要です`);
    const args: string[] = [];
    for (;;) {
      const a = next();
      if (a?.t === ')' && args.length === 0) break;
      if (a?.t !== 'str') fail(`${name}: 引数は \`...\` で囲んでください`);
      args.push(a!.v!);
      const sep = next();
      if (sep?.t === ',') continue;
      if (sep?.t === ')') break;
      fail(`${name}: , か ) が必要です`);
    }
    if (args.length < arity[0] || args.length > arity[1]) {
      const want = arity[0] === arity[1] ? `${arity[0]}` : arity[1] === Infinity ? `${arity[0]} 個以上` : `${arity[0]}〜${arity[1]}`;
      fail(`${name} の引数は ${want} 個です（${args.length} 個）`);
    }
    if ((name === 'Path' || name === 'PathPrefix') && args.some((p) => !p.startsWith('/'))) {
      fail(`${name} のパスは / で始めてください`);
    }
  };
  const and = (): void => {
    unary();
    while (peek()?.t === '&&') { next(); unary(); }
  };
  const or = (): void => {
    and();
    while (peek()?.t === '||') { next(); and(); }
  };
  try {
    or();
    if (pos < tokens.length) fail('式の後ろに余分なものがあります');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---- 画面の組み立て（よく使う条件を選んで式を作る）----

export interface MatchParts {
  hosts: string[];
  pathPrefixes: string[];
  methods: string[];
  clientIps: string[];
}

const quote = (v: string) => `\`${v.replace(/`/g, '')}\``;

// 空の項目は省き、残りを && でつなぐ（同じ項目の複数の値は OR として 1 つの関数にまとめる）
export function buildMatch(parts: MatchParts): string {
  const terms: string[] = [];
  const add = (fn: string, values: string[]) => {
    const vs = values.map((v) => v.trim()).filter((v) => v !== '');
    if (vs.length > 0) terms.push(`${fn}(${vs.map(quote).join(', ')})`);
  };
  add('Host', parts.hosts);
  add('PathPrefix', parts.pathPrefixes);
  add('Method', parts.methods);
  add('ClientIP', parts.clientIps);
  return terms.join(' && ');
}

// Traefik と同じ既定の優先度（match の長さ）。表示用
export function defaultPriority(match: string): number {
  return match.length;
}

// ---- 検証 ----

function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s/]+/.test(v);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// rproxy の l7::parse_duration と同じ（数と単位 ms・s・m・h、365 日まで）
function isDuration(v: string): boolean {
  return parseDurationMs(v) !== null;
}

// rproxy の parse_status_range と同じ：「500」か「502-504」（100〜599、前 ≤ 後）
export function isStatusRange(v: string): boolean {
  const [a, b = a] = v.split('-', 2).length === 2 ? v.split('-', 2) : [v, v];
  const n = (x: string) => (/^\s*[0-9]+\s*$/.test(x) ? Number(x) : NaN);
  const lo = n(a);
  const hi = n(b);
  return lo >= 100 && hi <= 599 && lo <= hi;
}

// ヘッダの値に使える文字（hyper の HeaderValue::from_str：表示できる ASCII・空白・タブ）
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

// サーバ名か IP アドレス（rustls の ServerName と同じく、ラベルは英数字・- ・_ で 63 文字まで）
function isServerName(v: string): boolean {
  if (v.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(v);
  return v.length <= 253 && /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/.test(v);
}

// replace_host の host（host か host:port。@ や / を含まない）
function isAuthority(v: string): boolean {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~-]+)(?::([0-9]{1,5}))?$/.exec(v);
  return m !== null && (m[2] === undefined || Number(m[2]) <= 65535);
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ミドルウェアの種類ごとの中身（rproxy の MiddlewareSpec::validate のうち、Gateway API 向けの項目）
function checkMiddlewareConfig(name: string, kind: string, c: Record<string, unknown>, services: Record<string, ServiceSpec>, errors: string[]): void {
  const label = `ミドルウェア「${name}」`;
  if ((kind === 'redirect_scheme' || kind === 'redirect_regex') && c.status !== undefined && !REDIRECT_STATUSES.includes(c.status as number)) {
    errors.push(`${label}の状態コードは 301・302・303・307・308 のどれかにしてください。`);
  }
  if (kind === 'retry' && c.status !== undefined) {
    const list = strings(c.status);
    if (list === null) errors.push(`${label}の送り直す状態コードは文字列の一覧にしてください。`);
    else for (const st of list) if (!isStatusRange(st)) errors.push(`${label}の送り直す状態コード「${st}」は 500 や 502-504 のように書いてください（100〜599）。`);
  }
  if (kind === 'headers') {
    for (const side of ['request', 'response']) {
      const ops = c[side];
      if (!isObject(ops) || ops.add === undefined) continue;
      if (!isObject(ops.add) || !Object.values(ops.add).every((v) => typeof v === 'string')) {
        errors.push(`${label}の ${side}.add は {名前: 値} の形にしてください。`);
      }
    }
  }
  if (kind === 'replace_host') {
    const host = c.host;
    if (typeof host !== 'string' || !isAuthority(host)) errors.push(`${label}の host は host か host:port の形にしてください。`);
  }
  if (kind === 'mirror') {
    const svc = c.service;
    if (typeof svc !== 'string' || svc === '') errors.push(`${label}にミラーの送り先のサービスを指定してください。`);
    else if (!(svc in services)) errors.push(`${label}のサービス「${svc}」がありません。`);
    if (c.percent !== undefined && c.fraction !== undefined) errors.push(`${label}は割合（percent）と分数（fraction）のどちらか一方にしてください。`);
    if (c.percent !== undefined && !(Number.isInteger(c.percent) && (c.percent as number) >= 0 && (c.percent as number) <= 100)) {
      errors.push(`${label}の割合は 0〜100 の整数にしてください。`);
    }
    if (c.fraction !== undefined) {
      const f = isObject(c.fraction) ? c.fraction : {};
      const num = f.numerator;
      const den = f.denominator ?? 100;
      if (!Number.isInteger(num) || !Number.isInteger(den) || (num as number) < 0 || (den as number) < 1 || (num as number) > (den as number)) {
        errors.push(`${label}の分数は、分母を 1 以上、分子を 0 以上で分母以下の整数にしてください。`);
      }
    }
  }
  if (kind === 'cors') {
    const origins = strings(c.allow_origins);
    if (origins === null || origins.length === 0) errors.push(`${label}に許可するオリジン（allow_origins）を 1 つ以上書いてください。`);
    for (const o of origins ?? []) {
      if (o !== '*' && !/^https?:\/\//.test(o)) errors.push(`${label}のオリジン「${o}」は * か http:// / https:// で始めてください。`);
    }
    for (const key of ['allow_origins', 'allow_methods', 'allow_headers', 'expose_headers']) {
      if (c[key] === undefined) continue;
      const list = strings(c[key]);
      if (list === null) {
        errors.push(`${label}の ${key} は文字列の一覧にしてください。`);
        continue;
      }
      for (const v of list) if (!HEADER_VALUE.test(v) || v.includes(',')) errors.push(`${label}の「${v}」はヘッダの値に使えません（カンマや制御文字を含めない）。`);
    }
    if (c.max_age !== undefined && !(Number.isInteger(c.max_age) && (c.max_age as number) >= 0)) errors.push(`${label}の max_age は 0 以上の整数（秒）にしてください。`);
  }
}

// サービスの tls（rproxy の ServiceTlsSpec::validate と同じ）
function checkServiceTls(name: string, t: ServiceTlsSpec, errors: string[]): void {
  const label = `サービス「${name}」の転送先の TLS`;
  if ((t.cert_file === undefined) !== (t.key_file === undefined)) errors.push(`${label}: クライアント証明書と秘密鍵は両方とも指定してください。`);
  if (t.chain_file !== undefined && t.cert_file === undefined) errors.push(`${label}: 中間 CA はクライアント証明書と一緒に指定してください。`);
  if (t.server_name !== undefined && !isServerName(t.server_name)) errors.push(`${label}: サーバ名「${t.server_name}」はホスト名か IP アドレスにしてください。`);
  for (const n of t.subject_alt_names ?? []) {
    if (n === '' || /[\s\x00-\x1f\x7f]/.test(n)) errors.push(`${label}: 確かめる名前（SAN）「${n}」は DNS 名か URI にしてください。`);
  }
  if (t.insecure_skip_verify && ((t.subject_alt_names ?? []).length > 0 || t.ca_file !== undefined)) {
    errors.push(`${label}: 証明書を確かめないときは CA ファイルと確かめる名前（SAN）を指定できません。`);
  }
}

// この設定が使う features.http_options の名前（rproxy の HttpSpec::options_used と同じ）
export function httpOptionsUsed(spec: HttpRules): HttpOption[] {
  const used = new Set<HttpOption>();
  const hasAdd = (o: unknown) => isObject(o) && isObject(o.add) && Object.keys(o.add).length > 0;
  for (const m of Object.values(spec.middlewares ?? {})) {
    const kind = middlewareKind(m);
    const c = (m[kind] ?? {}) as Record<string, unknown>;
    if (kind === 'headers' && (hasAdd(c.request) || hasAdd(c.response))) used.add('headers_add');
    if ((kind === 'redirect_scheme' || kind === 'redirect_regex') && c.status !== undefined) used.add('redirect_status');
    if (kind === 'retry' && Array.isArray(c.status) && c.status.length > 0) used.add('retry_status');
  }
  if (spec.routes.some((r) => r.timeouts !== undefined)) used.add('route_timeouts');
  const servers = Object.values(spec.services ?? {}).flatMap((s) => s.servers ?? []);
  if (servers.some((s) => (s.middlewares ?? []).length > 0)) used.add('server_middlewares');
  if (servers.some((s) => s.status !== undefined)) used.add('server_status');
  return HTTP_OPTIONS.filter((o) => used.has(o));
}

// 誤りの一覧（空なら問題なし）。features.middlewares を渡すと、この rproxy で使えない種類も誤りにする
export function validateHttp(spec: HttpRules, availableMiddlewares?: readonly string[]): string[] {
  const errors: string[] = [];
  const services = spec.services ?? {};
  const middlewares = spec.middlewares ?? {};

  for (const [name, s] of Object.entries(services)) {
    if (!NAME.test(name)) errors.push(`サービスの名前「${name}」には英数字と _ . - だけを使ってください。`);
    if (!Array.isArray(s.servers) || s.servers.length === 0) errors.push(`サービス「${name}」に転送先（servers）がありません。`);
    const protocol = s.protocol ?? 'http1';
    if (!UPSTREAM_PROTOCOLS.includes(protocol)) errors.push(`サービス「${name}」の HTTP の版は http1 / h2 / h2c / auto から選んでください。`);
    for (const srv of s.servers ?? []) {
      const url = srv.url ?? '';
      if (srv.status !== undefined) {
        if (url !== '') errors.push(`サービス「${name}」の転送先は URL と状態コードのどちらか一方にしてください。`);
        if (!(Number.isInteger(srv.status) && srv.status >= 100 && srv.status <= 599)) errors.push(`サービス「${name}」の転送先の状態コードは 100〜599 にしてください。`);
        if ((srv.middlewares ?? []).length > 0) errors.push(`サービス「${name}」の状態コードで答える転送先には、ミドルウェアを付けられません。`);
      } else if (!isHttpUrl(url)) {
        errors.push(`サービス「${name}」の転送先「${url}」は http:// か https:// で始まる URL にしてください。`);
      }
      if (srv.weight !== undefined && !(Number.isInteger(srv.weight) && srv.weight >= 1)) errors.push(`サービス「${name}」の重みは 1 以上の整数にしてください。`);
      for (const mw of srv.middlewares ?? []) {
        if (!(mw in middlewares)) errors.push(`サービス「${name}」の転送先のミドルウェア「${mw}」がありません。`);
        else if (!SERVER_MIDDLEWARES.includes(middlewareKind(middlewares[mw]))) {
          errors.push(`サービス「${name}」の転送先のミドルウェア「${mw}」は、転送先ごとには使えない種類です（使えるのは ${joinList(SERVER_MIDDLEWARES, '・')}）。`);
        }
      }
      if (protocol === 'h2' && url !== '' && !url.startsWith('https://')) errors.push(`サービス「${name}」の HTTP/2（h2）には https:// の転送先が要ります（平文の HTTP/2 は h2c）。`);
      if (protocol === 'h2c' && url.startsWith('https://')) errors.push(`サービス「${name}」の平文の HTTP/2（h2c）には http:// の転送先が要ります（TLS の HTTP/2 は h2）。`);
    }
    if ((s.servers ?? []).length > 0 && s.servers.every((srv) => srv.status !== undefined) && (s.health_check || s.sticky)) {
      errors.push(`サービス「${name}」のヘルスチェックとスティッキーには、URL の転送先が 1 つ以上要ります。`);
    }
    if (s.tls !== undefined) checkServiceTls(name, s.tls, errors);
    if (s.health_check && !(s.health_check.path ?? '').startsWith('/')) errors.push(`サービス「${name}」のヘルスチェックのパスは / で始めてください。`);
    if (s.outlier_detection !== undefined) {
      try {
        normalizeHttpOutlier(s.outlier_detection, `サービス「${name}」の受け身のヘルスチェック`);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (s.balance !== undefined && !BALANCES.includes(s.balance)) errors.push(`サービス「${name}」の振り分け方は round_robin / least_conn / failover から選んでください。`);
  }

  for (const [name, m] of Object.entries(middlewares)) {
    if (!NAME.test(name)) errors.push(`ミドルウェアの名前「${name}」には英数字と _ . - だけを使ってください。`);
    const kinds = Object.keys(m ?? {});
    if (kinds.length !== 1) {
      errors.push(`ミドルウェア「${name}」には種類を 1 つだけ書いてください。`);
      continue;
    }
    if (!(kinds[0] in MIDDLEWARE_KINDS)) errors.push(`ミドルウェア「${name}」の種類「${kinds[0]}」は知らない種類です。`);
    else if (availableMiddlewares && !availableMiddlewares.includes(kinds[0])) {
      errors.push(`ミドルウェア「${name}」の種類「${kinds[0]}」は、この rproxy ではまだ使えません。`);
    }
    const config = m[kinds[0]];
    if (isObject(config)) checkMiddlewareConfig(name, kinds[0], config, services, errors);
  }

  const seen = new Set<string>();
  spec.routes.forEach((r, i) => {
    const label = r.name ? `ルート「${r.name}」` : `${i + 1} 番目のルート`;
    if (!r.name) errors.push(`${i + 1} 番目のルートに名前を付けてください。`);
    else if (!NAME.test(r.name)) errors.push(`${label}の名前には英数字と _ . - だけを使ってください。`);
    else if (seen.has(r.name)) errors.push(`ルートの名前「${r.name}」が重複しています。`);
    seen.add(r.name);
    const m = checkMatch(r.match ?? '');
    if (m) errors.push(`${label}の match: ${m}`);
    if (r.service && r.to) errors.push(`${label}は service と to のどちらか一方にしてください。`);
    if (r.service && !(r.service in services)) errors.push(`${label}のサービス「${r.service}」がありません。`);
    if (r.to !== undefined && !isHttpUrl(r.to)) errors.push(`${label}の転送先（to）は http:// か https:// で始まる URL にしてください。`);
    for (const mw of r.middlewares ?? []) {
      if (!(mw in middlewares)) errors.push(`${label}のミドルウェア「${mw}」がありません。`);
    }
    for (const d of [r.timeouts?.request, r.timeouts?.backend_request]) {
      if (d !== undefined && !isDuration(d)) errors.push(`${label}の時間の上限「${d}」は 10s・500ms・1m のように書いてください。`);
    }
    if (!r.service && !r.to) {
      const answers = (r.middlewares ?? []).some((mw) => ANSWERING_KINDS.includes(middlewareKind(middlewares[mw] ?? {})));
      if (!answers) errors.push(`${label}に転送先（サービスか to）を指定するか、リダイレクト・固定の応答のミドルウェアを付けてください。`);
    }
  });

  if (spec.default) {
    const st = spec.default.status;
    if (st !== undefined && !(Number.isInteger(st) && st >= 100 && st <= 599)) errors.push('一致しないときの状態コードは 100〜599 にしてください。');
    if (spec.default.service && !(spec.default.service in services)) errors.push(`一致しないときのサービス「${spec.default.service}」がありません。`);
  }
  if (spec.routes.length === 0 && !spec.default?.service) errors.push('ルートを 1 つ以上作るか、一致しないときのサービスを指定してください。');
  return errors;
}

// 空の文字列・undefined の項目を省く（残りがなければ undefined）
function compact<T extends object>(o: T | undefined): Partial<T> | undefined {
  if (o === undefined || o === null) return undefined;
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
  return Object.keys(out).length > 0 ? out : undefined;
}

// 転送先の 1 件（url か status。重み 1 と空のミドルウェアは省く）
function cleanServer(srv: ServerSpec): ServerSpec {
  const out: ServerSpec = srv.status !== undefined ? { status: srv.status } : { url: (srv.url ?? '').trim() };
  if (srv.weight !== undefined && srv.weight !== 1) out.weight = srv.weight;
  if (srv.status === undefined && srv.middlewares && srv.middlewares.length > 0) out.middlewares = srv.middlewares;
  return out;
}

// サービスの tls（空の欄・空の一覧・false を省く。何もなければ undefined）
export function cleanServiceTls(t: ServiceTlsSpec | undefined): ServiceTlsSpec | undefined {
  if (t === undefined) return undefined;
  const out: ServiceTlsSpec = {};
  for (const k of ['server_name', 'ca_file', 'cert_file', 'key_file', 'chain_file'] as const) {
    const v = t[k]?.trim();
    if (v) out[k] = v;
  }
  const sans = (t.subject_alt_names ?? []).map((n) => n.trim()).filter((n) => n !== '');
  if (sans.length > 0) out.subject_alt_names = sans;
  if (t.insecure_skip_verify === true) out.insecure_skip_verify = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

// 空の項目を省いて rproxy に送る形に揃える
export function cleanHttp(spec: HttpRules): HttpSpec {
  const out: Record<string, unknown> = {};
  if (spec.http3) out.http3 = true;
  out.routes = spec.routes.map((r) => {
    const route: Record<string, unknown> = { name: r.name.trim(), match: r.match.trim() };
    if (r.priority !== undefined && r.priority !== null && !Number.isNaN(r.priority)) route.priority = r.priority;
    if (r.service) route.service = r.service;
    else if (r.to) route.to = r.to.trim();
    if (r.middlewares && r.middlewares.length > 0) route.middlewares = r.middlewares;
    const t = compact(r.timeouts);
    if (t !== undefined) route.timeouts = t;
    return route;
  });
  if (spec.default && (spec.default.service || (spec.default.status !== undefined && spec.default.status !== 404))) {
    out.default = spec.default.service ? { status: spec.default.status ?? 404, service: spec.default.service } : { status: spec.default.status };
  }
  if (spec.services && Object.keys(spec.services).length > 0) {
    out.services = Object.fromEntries(Object.entries(spec.services).map(([name, s]) => {
      const svc: Record<string, unknown> = {
        servers: s.servers.map(cleanServer),
      };
      if (s.protocol !== undefined && s.protocol !== 'http1') svc.protocol = s.protocol;
      const tls = cleanServiceTls(s.tls);
      if (tls !== undefined) svc.tls = tls;
      if (s.health_check?.path) {
        svc.health_check = Object.fromEntries(Object.entries(s.health_check).filter(([, v]) => v !== undefined && v !== ''));
      }
      if (s.sticky?.cookie) svc.sticky = { cookie: s.sticky.cookie };
      if (s.pass_host_header === false) svc.pass_host_header = false;
      if (s.balance !== undefined && s.balance !== 'round_robin') svc.balance = s.balance;
      // 受け身のヘルスチェック（{} は rproxy の既定値で有効）
      if (s.outlier_detection !== undefined) svc.outlier_detection = s.outlier_detection;
      const t = Object.fromEntries(Object.entries(s.timeouts ?? {}).filter(([, v]) => v !== undefined && v !== ''));
      if (Object.keys(t).length > 0) svc.timeouts = t;
      return [name, svc];
    }));
  }
  if (spec.middlewares && Object.keys(spec.middlewares).length > 0) out.middlewares = spec.middlewares;
  return out;
}

// DB・rproxy の値（形が崩れていても）から画面の値を作る
export function toHttpRules(value: HttpSpec | null | undefined): HttpRules {
  const v = (value ?? {}) as Record<string, unknown>;
  const routes = Array.isArray(v.routes) ? (v.routes as RouteSpec[]) : [];
  return {
    http3: v.http3 === true,
    routes: routes.map((r) => ({ ...r, name: String(r.name ?? ''), match: String(r.match ?? '') })),
    default: (v.default as DefaultSpec | undefined) ?? undefined,
    services: (v.services as Record<string, ServiceSpec> | undefined) ?? {},
    middlewares: (v.middlewares as Record<string, MiddlewareSpec> | undefined) ?? {},
  };
}

// 新しく L7 にしたときのひな形（リバースプロキシ）
export function emptyHttp(): HttpRules {
  return {
    routes: [{ name: 'all', match: 'PathPrefix(`/`)', service: 'backend' }],
    services: { backend: { servers: [{ url: 'http://127.0.0.1:8080' }] } },
    middlewares: {},
  };
}

// 80 番で HTTP を HTTPS へ転送するひな形
export function redirectHttp(): HttpRules {
  return {
    routes: [{ name: 'to-https', match: 'PathPrefix(`/`)', middlewares: ['to-https'] }],
    services: {},
    middlewares: { 'to-https': { redirect_scheme: { scheme: 'https', permanent: true } } },
  };
}
