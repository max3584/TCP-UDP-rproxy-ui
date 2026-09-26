// L7（ルールの http）の型、検証、match の式の組み立て（tests/httpspec.test.ts）。
// 形は rproxy-api の docs/API.md「v0.3 の設定」と src/http/mod.rs。最終的な検証は rproxy が行うので、
// ここでは画面で先に分かる誤り（名前の重複、存在しない参照、match の書き方、URL の形）だけを確かめる。
// React にも Node にも依存しない（画面と API route の両方で使う）

import type { HttpSpec } from './lib';

export interface RouteSpec {
  name: string;
  match: string;
  priority?: number;
  service?: string;
  to?: string;
  middlewares?: string[];
}

export interface ServerSpec {
  url: string;
  weight?: number;
}

export interface ServiceSpec {
  servers: ServerSpec[];
  health_check?: { path: string; interval?: string; timeout?: string };
  sticky?: { cookie: string };
  pass_host_header?: boolean;
  timeouts?: { connect?: string; response?: string };
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
};

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
    if (!arity) fail(`知らない条件 ${name}（使えるのは ${MATCHER_NAMES.join('・')}）`);
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

// 誤りの一覧（空なら問題なし）。features.middlewares を渡すと、この rproxy で使えない種類も誤りにする
export function validateHttp(spec: HttpRules, availableMiddlewares?: readonly string[]): string[] {
  const errors: string[] = [];
  const services = spec.services ?? {};
  const middlewares = spec.middlewares ?? {};

  for (const [name, s] of Object.entries(services)) {
    if (!NAME.test(name)) errors.push(`サービスの名前「${name}」には英数字と _ . - だけを使ってください。`);
    if (!Array.isArray(s.servers) || s.servers.length === 0) errors.push(`サービス「${name}」に転送先（servers）がありません。`);
    for (const srv of s.servers ?? []) {
      if (!isHttpUrl(srv.url ?? '')) errors.push(`サービス「${name}」の転送先「${srv.url ?? ''}」は http:// か https:// で始まる URL にしてください。`);
      if (srv.weight !== undefined && !(Number.isInteger(srv.weight) && srv.weight >= 0)) errors.push(`サービス「${name}」の重みは 0 以上の整数にしてください。`);
    }
    if (s.health_check && !(s.health_check.path ?? '').startsWith('/')) errors.push(`サービス「${name}」のヘルスチェックのパスは / で始めてください。`);
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
    return route;
  });
  if (spec.default && (spec.default.service || (spec.default.status !== undefined && spec.default.status !== 404))) {
    out.default = spec.default.service ? { status: spec.default.status ?? 404, service: spec.default.service } : { status: spec.default.status };
  }
  if (spec.services && Object.keys(spec.services).length > 0) {
    out.services = Object.fromEntries(Object.entries(spec.services).map(([name, s]) => {
      const svc: Record<string, unknown> = {
        servers: s.servers.map((srv) => (srv.weight !== undefined && srv.weight !== 1 ? { url: srv.url.trim(), weight: srv.weight } : { url: srv.url.trim() })),
      };
      if (s.health_check?.path) {
        svc.health_check = Object.fromEntries(Object.entries(s.health_check).filter(([, v]) => v !== undefined && v !== ''));
      }
      if (s.sticky?.cookie) svc.sticky = { cookie: s.sticky.cookie };
      if (s.pass_host_header === false) svc.pass_host_header = false;
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
