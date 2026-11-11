// 固定ルール（設定ファイルのルール、origin: static）の待ち受けに API で重ねる分（overlay。rproxy-api v0.4.23 の #397、UI #193）。
// 形・名前の重なり・ファイルの秘密の項目・履歴の差分。React にも Node にも依存しない（画面と API route の両方で使う。tests/overlay.test.ts）。
// rproxy-api の docs/API.md「固定ルールの待ち受けに重ねる分」と docs/DESIGN-v0.4.x.md 26. が正

import type { ForwardRule, TlsRoute, TlsSpec } from './lib';
import { routeNames } from './lib';
import type { MiddlewareSpec, RouteSpec, ServiceSpec } from './httpspec';
import { middlewareKind } from './httpspec';
import { joinList, translate } from '@/i18n/core';

// PUT /rules/{key}/overlay の本文（rproxy の OverlaySpec。どちらも省ける）
export interface OverlayHttp {
  routes?: RouteSpec[];
  services?: Record<string, ServiceSpec>;
  middlewares?: Record<string, MiddlewareSpec>;
}

export interface OverlaySpec {
  http?: OverlayHttp;
  tls?: { routes?: TlsRoute[] };
}

// ファイルが勝って外れた重ねる分の項目（rproxy の Shadowed）
export interface OverlayShadowed {
  kind: 'route' | 'service' | 'middleware' | 'tls_route' | string;
  name: string;
  reason: string;
}

// 効かない理由（rproxy の Reason）
export type OverlayReason = 'no_static_rule' | 'shape' | 'invalid' | 'failed';

// GET /rules/{key}/overlay の答え（rproxy の OverlayView。本文の形に状態が付く）
export interface OverlayView extends OverlaySpec {
  rule: string;
  state: 'applied' | 'not_applied';
  reason?: OverlayReason | string;
  error?: string;
  shadowed?: OverlayShadowed[];
  etag: string;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  // DB（rproxy_rule_overlays）にこのままあるか。DB がない・persist: false のトークンの分は付かない
  persisted?: boolean;
}

// ルールの表示（GET /rules）の overlay（rproxy の OverlaySummary）
export interface OverlaySummary {
  state: 'applied' | 'not_applied';
  reason?: OverlayReason | string;
  routes: number;
  tls_routes: number;
  shadowed?: number;
}

// 画面の名前
export const OVERLAY_REASON_LABELS: Record<string, string> = {
  no_static_rule: '設定ファイルにこのルールがなくなりました',
  shape: '設定ファイルのルールの形が変わり、重ねられません（http がなくなった・TLS のモードが変わったなど）',
  invalid: '設定ファイルのルールと合わせると検証が通りません（使っているファイルのサービス・ミドルウェアがなくなったなど）',
  failed: '組み立てに失敗しました（指しているファイル・名前など）',
};

export const OVERLAY_KIND_LABELS: Record<string, string> = {
  route: 'ルート',
  service: 'サービス',
  middleware: 'ミドルウェア',
  tls_route: 'サーバ名',
};

// 本文の形から view の付け足しを除く（PUT にそのまま送れる形）
export function overlaySpecOf(value: unknown): OverlaySpec {
  const v = isObject(value) ? value : {};
  const out: OverlaySpec = {};
  if (isObject(v.http)) {
    const h = v.http;
    const http: OverlayHttp = {};
    if (Array.isArray(h.routes) && h.routes.length > 0) http.routes = h.routes as RouteSpec[];
    if (isObject(h.services) && Object.keys(h.services).length > 0) http.services = h.services as Record<string, ServiceSpec>;
    if (isObject(h.middlewares) && Object.keys(h.middlewares).length > 0) http.middlewares = h.middlewares as Record<string, MiddlewareSpec>;
    if (Object.keys(http).length > 0) out.http = http;
  }
  if (isObject(v.tls) && Array.isArray(v.tls.routes) && v.tls.routes.length > 0) out.tls = { routes: v.tls.routes as TlsRoute[] };
  return out;
}

// 何も足さない（PUT の代わりに DELETE にする）
export function isEmptyOverlay(spec: OverlaySpec): boolean {
  const s = overlaySpecOf(spec);
  return s.http === undefined && s.tls === undefined;
}

// 固定ルールに何を重ねられるか（rproxy の merge と同じ条件）：
// http はルールに http があるときだけ。tls.routes は sni（tcp・udp）か、http も client_auth もない terminate だけ
export interface OverlayShape {
  http: boolean;
  tlsRoutes: boolean;
}

export function overlayShape(rule: Pick<ForwardRule, 'http' | 'tls'>): OverlayShape {
  const mode = rule.tls?.mode;
  const clientAuth = rule.tls?.client_auth?.mode !== undefined && rule.tls.client_auth.mode !== 'none';
  return {
    http: rule.http !== null && rule.http !== undefined,
    tlsRoutes: mode === 'sni' || (mode === 'terminate' && (rule.http === null || rule.http === undefined) && !clientAuth),
  };
}

// 設定ファイルのルールにある名前（重ねる分は使えない。PUT は 409 overlay_conflict）
export interface FileNames {
  routes: string[];
  services: string[];
  middlewares: string[];
  tlsPatterns: string[];
}

export function fileNames(rule: Pick<ForwardRule, 'http' | 'tls'>): FileNames {
  const http = (rule.http ?? {}) as { routes?: { name?: string }[]; services?: Record<string, unknown>; middlewares?: Record<string, unknown> };
  return {
    routes: (http.routes ?? []).map((r) => String(r.name ?? '')).filter((n) => n !== ''),
    services: Object.keys(http.services ?? {}),
    middlewares: Object.keys(http.middlewares ?? {}),
    tlsPatterns: (rule.tls?.routes ?? []).flatMap((r) => routeNames(r)).map((p) => p.toLowerCase()),
  };
}

// 名前 name がパターン pattern に当たるか（rproxy の tls::config::match_rank。どちらも ASCII の小文字にして比べる）
export function patternMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p.startsWith('**.')) {
    const dotted = `.${p.slice(3)}`;
    return n.length > dotted.length && n.endsWith(dotted) && !n.startsWith('.');
  }
  if (p.startsWith('*.')) {
    const dot = n.indexOf('.');
    return dot > 0 && n.slice(dot + 1) === p.slice(2);
  }
  return p === n;
}

// ファイルのパターン file が重ねる分のパターン p の名前をすべて受けるか（rproxy の core::overlay::covers。
// rproxy は Route::patterns で両方を小文字にしてから比べる）
export function coversPattern(file: string, p: string): boolean {
  const f = file.toLowerCase();
  const q = p.toLowerCase();
  const under = (d: string) => f.startsWith('**.') && (d === f.slice(3) || d.endsWith(`.${f.slice(3)}`));
  if (q.startsWith('**.')) return under(q.slice(3));
  if (q.startsWith('*.')) return f === q || under(q.slice(2));
  return patternMatches(f, q);
}

// 重ねる分がファイルの名前と重なる項目（rproxy は PUT を 409 overlay_conflict で断る）
export function overlayConflicts(file: FileNames, spec: OverlaySpec): OverlayShadowed[] {
  const out: OverlayShadowed[] = [];
  const s = overlaySpecOf(spec);
  for (const r of s.http?.routes ?? []) if (file.routes.includes(r.name)) out.push({ kind: 'route', name: r.name, reason: '設定ファイルに同じ名前のルートがあります' });
  for (const n of Object.keys(s.http?.services ?? {})) if (file.services.includes(n)) out.push({ kind: 'service', name: n, reason: '設定ファイルに同じ名前のサービスがあります' });
  for (const n of Object.keys(s.http?.middlewares ?? {})) if (file.middlewares.includes(n)) out.push({ kind: 'middleware', name: n, reason: '設定ファイルに同じ名前のミドルウェアがあります' });
  for (const r of s.tls?.routes ?? []) {
    for (const p of routeNames(r)) {
      const by = file.tlsPatterns.find((f) => coversPattern(f, p));
      if (by !== undefined) out.push({ kind: 'tls_route', name: p, reason: by === p.toLowerCase() ? '設定ファイルにこの名前があります' : `設定ファイルの ${by} がこの名前をすべて受けます` });
    }
  }
  return out;
}

// ---- ファイルのサービス・ミドルウェアの秘密（rproxy の OverlaySpec::file_items と rule_files） ----

// ファイルのサービス・ミドルウェアのうち、秘密のファイル（サービスのクライアントの鍵・oidc の秘密・basic_auth の users_file）を持つもの
function holdsSecret(kind: 'service' | 'middleware', value: unknown): boolean {
  if (!isObject(value)) return false;
  if (kind === 'service') {
    const tls = value.tls;
    return isObject(tls) && typeof tls.key_file === 'string' && tls.key_file !== '';
  }
  const k = middlewareKind(value as MiddlewareSpec);
  const config = (value as Record<string, unknown>)[k];
  if (!isObject(config)) return false;
  if (k === 'basic_auth') return typeof config.users_file === 'string' && config.users_file !== '';
  if (k === 'oidc') return Object.keys(config).some((key) => /secret_file$/.test(key) && typeof config[key] === 'string' && config[key] !== '');
  return false;
}

// サービス・ミドルウェアが名前で使うもの（ミドルウェアの service、サービスの servers[].middlewares）
function usesOf(kind: 'service' | 'middleware', value: unknown): { services: string[]; middlewares: string[] } {
  const services: string[] = [];
  const middlewares: string[] = [];
  if (!isObject(value)) return { services, middlewares };
  if (kind === 'service') {
    for (const srv of Array.isArray(value.servers) ? value.servers : []) {
      if (isObject(srv) && Array.isArray(srv.middlewares)) middlewares.push(...srv.middlewares.filter((m): m is string => typeof m === 'string'));
    }
  } else {
    const config = (value as Record<string, unknown>)[middlewareKind(value as MiddlewareSpec)];
    if (isObject(config) && typeof config.service === 'string') services.push(config.service);
  }
  return { services, middlewares };
}

// ファイルの秘密を持つ項目の名前（そこからたどり着くものを含め、管理者でない人は重ねる分から使えない）
export interface SecretItems {
  services: string[];
  middlewares: string[];
}

// ファイルの http で、秘密のファイルを持つか、そこへたどり着くサービス・ミドルウェア
export function fileSecretItems(fileHttp: unknown): SecretItems {
  const http = isObject(fileHttp) ? fileHttp : {};
  const services = isObject(http.services) ? http.services : {};
  const middlewares = isObject(http.middlewares) ? http.middlewares : {};
  const memo = new Map<string, boolean>();
  const secret = (kind: 'service' | 'middleware', name: string, seen: Set<string>): boolean => {
    const id = `${kind}:${name}`;
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return false;
    seen.add(id);
    const value = kind === 'service' ? services[name] : middlewares[name];
    const uses = usesOf(kind, value);
    const out = holdsSecret(kind, value)
      || uses.services.some((s) => s in services && secret('service', s, seen))
      || uses.middlewares.some((m) => m in middlewares && secret('middleware', m, seen));
    memo.set(id, out);
    return out;
  };
  return {
    services: Object.keys(services).filter((n) => secret('service', n, new Set())),
    middlewares: Object.keys(middlewares).filter((n) => secret('middleware', n, new Set())),
  };
}

// 重ねる分が名前で使うファイルのサービス・ミドルウェア（重ねる分の中で同じ名前を定義していれば重ねる分のもの）
export function fileItemsUsed(spec: OverlaySpec, file: FileNames): SecretItems {
  const s = overlaySpecOf(spec);
  const ownServices = s.http?.services ?? {};
  const ownMiddlewares = s.http?.middlewares ?? {};
  const services = new Set<string>();
  const middlewares = new Set<string>();
  const addService = (n: string) => { if (!(n in ownServices) && file.services.includes(n)) services.add(n); };
  const addMiddleware = (n: string) => { if (!(n in ownMiddlewares) && file.middlewares.includes(n)) middlewares.add(n); };
  for (const r of s.http?.routes ?? []) {
    if (r.service) addService(r.service);
    for (const m of r.middlewares ?? []) addMiddleware(m);
  }
  for (const v of Object.values(ownServices)) usesOf('service', v).middlewares.forEach(addMiddleware);
  for (const v of Object.values(ownMiddlewares)) usesOf('middleware', v).services.forEach(addService);
  return { services: [...services], middlewares: [...middlewares] };
}

// 重ねる分が使うファイルの項目のうち秘密を持つもの（管理者でなければ 409 file_in_use）
export function secretFileItemsUsed(spec: OverlaySpec, file: FileNames, secrets: SecretItems): SecretItems {
  const used = fileItemsUsed(spec, file);
  return {
    services: used.services.filter((n) => secrets.services.includes(n)),
    middlewares: used.middlewares.filter((n) => secrets.middlewares.includes(n)),
  };
}

// ---- 送り元を言うヘッダ（rproxy の l7::FORWARDING_HEADERS。身元のヘッダにできない。API・重ねる分は 400 invalid） ----

export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-server',
  'x-forwarded-client-cert',
  'x-client-verify',
];

export function isForwardingHeader(name: string): boolean {
  return FORWARDING_HEADERS.includes(name.toLowerCase().replace(/_/g, '-'));
}

// basic_auth の user_header・forward_auth の response_headers に送り元を言うヘッダを書いたミドルウェア（rproxy の forwarding_identities）
export function forwardingIdentityProblems(middlewares: Record<string, MiddlewareSpec> | undefined): string[] {
  const out: string[] = [];
  for (const [name, m] of Object.entries(middlewares ?? {})) {
    const kind = middlewareKind(m);
    const config = m?.[kind];
    if (!isObject(config)) continue;
    const headers = kind === 'basic_auth'
      ? (typeof config.user_header === 'string' ? [config.user_header] : [])
      : kind === 'forward_auth' && Array.isArray(config.response_headers)
        ? config.response_headers.filter((h): h is string => typeof h === 'string')
        : [];
    for (const h of headers.filter(isForwardingHeader)) {
      out.push(`ミドルウェア「${name}」の ${h} は送り元を言うヘッダなので、身元のヘッダ（${kind === 'basic_auth' ? 'user_header' : 'response_headers'}）にできません（rproxy はクライアントの値を消さないため）。`);
    }
  }
  return out;
}

// ---- 履歴（forward_rules_log の OVERLAY）の差分 ----

function names(spec: OverlaySpec | null): { routes: Map<string, string>; services: Map<string, string>; middlewares: Map<string, string>; tls: Map<string, string> } {
  const s = spec === null ? {} : overlaySpecOf(spec);
  return {
    routes: new Map((s.http?.routes ?? []).map((r) => [r.name, JSON.stringify(r)])),
    services: new Map(Object.entries(s.http?.services ?? {}).map(([n, v]) => [n, JSON.stringify(v)])),
    middlewares: new Map(Object.entries(s.http?.middlewares ?? {}).map(([n, v]) => [n, JSON.stringify(v)])),
    tls: new Map((s.tls?.routes ?? []).map((r) => [routeNames(r).join(', '), JSON.stringify(r)])),
  };
}

// 前の重ねる分から次の重ねる分への違い（null は重ねる分がない）。項目の種類ごとに「足した・変えた・外した」
export function overlayChanges(before: OverlaySpec | null, after: OverlaySpec | null): string[] {
  if (after === null) return before === null ? [] : [translate('重ねる分を外しました')];
  const a = names(before);
  const b = names(after);
  const out: string[] = [];
  // 文は種類ごとに書く（英語で種類の名前を文の途中の小文字にするため）
  const say: Record<keyof typeof a, [(n: string) => string, (n: string) => string, (n: string) => string]> = {
    routes: [(n) => translate(`ルートを追加: ${n}`), (n) => translate(`ルートを変更: ${n}`), (n) => translate(`ルートを削除: ${n}`)],
    services: [(n) => translate(`サービスを追加: ${n}`), (n) => translate(`サービスを変更: ${n}`), (n) => translate(`サービスを削除: ${n}`)],
    middlewares: [(n) => translate(`ミドルウェアを追加: ${n}`), (n) => translate(`ミドルウェアを変更: ${n}`), (n) => translate(`ミドルウェアを削除: ${n}`)],
    tls: [(n) => translate(`サーバ名ごとの転送先を追加: ${n}`), (n) => translate(`サーバ名ごとの転送先を変更: ${n}`), (n) => translate(`サーバ名ごとの転送先を削除: ${n}`)],
  };
  for (const key of ['routes', 'services', 'middlewares', 'tls'] as const) {
    const added = [...b[key].keys()].filter((n) => !a[key].has(n));
    const changed = [...b[key].keys()].filter((n) => a[key].has(n) && a[key].get(n) !== b[key].get(n));
    const removed = [...a[key].keys()].filter((n) => !b[key].has(n));
    // 名前は訳さない（joinList は日本語でない語をそのまま並べる）
    if (added.length > 0) out.push(say[key][0](joinList(added)));
    if (changed.length > 0) out.push(say[key][1](joinList(changed)));
    if (removed.length > 0) out.push(say[key][2](joinList(removed)));
  }
  return out;
}

// 履歴の options 列（{"overlay": spec | null}）から重ねる分を読む。読めなければ undefined
export function overlayFromLogOptions(value: unknown): OverlaySpec | null | undefined {
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!isObject(v) || !('overlay' in v)) return undefined;
  return v.overlay === null ? null : overlaySpecOf(v.overlay);
}

// 履歴の options 列の created_at（rproxy が重ねる分を作った時刻、Unix 秒）。なければ undefined
export function overlayCreatedAt(value: unknown): number | undefined {
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return isObject(v) && typeof v.created_at === 'number' ? v.created_at : undefined;
}

// 重ねる分の形のルール（利用者の制限の確かめ・TLS の検証に使う。キーと待ち受けはファイルのルールのもの）
export function overlayAsRule<T extends ForwardRule>(file: T, spec: OverlaySpec | null): T {
  const s = spec === null ? {} : overlaySpecOf(spec);
  const tls: TlsSpec = { mode: file.tls.mode, ...(s.tls?.routes ? { routes: s.tls.routes } : {}) };
  return {
    ...file,
    distAddr: '',
    distPort: 0,
    targets: [],
    tls: tls,
    http: s.http ? { routes: s.http.routes ?? [], ...(s.http.services ? { services: s.http.services } : {}), ...(s.http.middlewares ? { middlewares: s.http.middlewares } : {}) } : null,
  };
}

// 利用者に伏せて見せたファイルのパス（userlimits.ts の HIDDEN_FILE）を、今の重ねる分の同じ場所の値に戻す。
// 同じ場所（サービス・ミドルウェアは名前、配列は添字）に値がなければ missing にその場所を入れる（呼ぶ側が 400 にする）
export function restoreHidden<T>(next: T, current: unknown, hidden: string): { value: T; missing: string[] } {
  const missing: string[] = [];
  const walk = (v: unknown, cur: unknown, path: string): unknown => {
    if (v === hidden) {
      if (typeof cur === 'string' && cur !== '') return cur;
      missing.push(path);
      return v;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, Array.isArray(cur) ? cur[i] : undefined, `${path}[${i}]`));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item, isObject(cur) ? cur[k] : undefined, path === '' ? k : `${path}.${k}`)]));
    return v;
  };
  return { value: walk(next, current, '') as T, missing: missing };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
