// rproxy-api の HTTP クライアント（契約は ../rproxy-api/docs/API.md）

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, statSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Balance, CertStatus, HealthCheck, HttpSpec, Protocol, RuleOrigin, RuleStats, SourceIp, StartTls, Target, TlsMode, TlsSpec } from './lib';
import type { InterfacesInfo } from './listen';
import type { BandwidthSpec, Condition, GeoipSpec, L4OutlierSpec, Labels, LimitsSpec, RulePlan } from './v04';

export type { HttpSpec, Protocol, RuleStats, SourceIp, StartTls, TlsMode, TlsSpec };

// http のルールは remote_addr / remote_port を書かない（転送先は http.services）。応答では "" / 0 が返る
export interface RproxyRule {
  protocol: Protocol;
  listen_addr: string;
  listen_port: number;
  listen_port_end?: number;
  remote_addr?: string;
  remote_port?: number;
  source_ip?: SourceIp;
  udp_idle_secs?: number;
  tls?: TlsSpec;
  starttls?: StartTls;
  starttls_required?: boolean;
  // 接続を許可する送信元（CIDR か単一の IP。最大 64 件）。省略または空ならすべて許可
  allow_from?: string[];
  // L7 の設定（v0.3）。中身は rproxy が検証する
  http?: HttpSpec;
  // CrowdSec の判定での切断（v0.3.2。rproxy に global.crowdsec が必要）。応答では false のとき省かれる
  crowdsec?: boolean;
  // 宛先を複数にするとき（v0.3.3）。remote_addr / remote_port の代わり
  targets?: Target[];
  balance?: Balance;
  health_check?: HealthCheck;
  // 同じポートで追加で待ち受けるアドレス（v0.3.3）。応答では空のとき省かれる
  extra_listen_addrs?: string[];
  // v0.4（components/v04.ts）。使うときだけ付ける（古い rproxy は知らない項目を断る）
  labels?: Labels;
  limits?: LimitsSpec;
  bandwidth?: BandwidthSpec;
  geoip?: GeoipSpec;
  outlier_detection?: L4OutlierSpec;
}

// 応答では既定値の項目も含めて返る（tls はすべての項目、listen_port_end と starttls は null もある）。
// allow_from は正規化した CIDR（10.0.0.5 → 10.0.0.5/32）。origin は固定ルールなら static（古い rproxy は返さない）
export interface RproxyRuleStatus extends Omit<RproxyRule, 'listen_port_end' | 'starttls'> {
  listen_port_end?: number | null;
  starttls?: StartTls | null;
  state: 'running' | 'failed';
  error: string | null;
  resolved: string[];
  connections: number;
  // 古い rproxy は返さない
  stats?: RuleStats;
  started_at?: number | null;
  // static（設定ファイル）・dynamic・api（rproxy が rproxy_rules に保存した API のルール。v0.4）。知らない値は dynamic と同じに扱う
  origin?: RuleOrigin | string;
  // v0.4：Gateway API の形の状態（features.conditions）
  conditions?: Condition[];
  // v0.4：属するルールの組（features.rulesets）。組のルールの PATCH / DELETE は 409 owned
  ruleset?: string;
  // v0.4（#144）：rproxy_rules に保存したか、作ったトークン、作った時刻（Unix 秒）
  persisted?: boolean;
  created_by?: string;
  created_at?: number;
  // 証明書の期限（rproxy v0.3.5 以降。証明書がないルールでは省かれる）
  cert_status?: CertStatus[];
  // ACME の証明書の状態（rproxy v0.3.21 以降。ACME の証明書がないルールでは省かれる。components/acme.ts）
  acme?: unknown[];
}

export interface RproxyRuleKey {
  protocol: Protocol;
  listen_addr: string;
  listen_port: number;
}

// tls を付けると TLS の設定（starttls / starttls_required を含む）を丸ごと置き換える。
// source_ip とポート範囲は変えられない（listen_port_end は同じ値なら付けてもよい）
// http を付けると L7 の設定を丸ごと置き換える（そのときは remote_addr / remote_port を付けない）
export interface RproxyRulePatch {
  remote_addr?: string;
  remote_port?: number;
  udp_idle_secs?: number;
  tls?: TlsSpec;
  starttls?: StartTls;
  starttls_required?: boolean;
  // 付けると丸ごと置き換える（[] ですべて許可に戻す）
  allow_from?: string[];
  listen_port_end?: number;
  http?: HttpSpec;
  // 付けると有効・無効を切り替える
  crowdsec?: boolean;
  // 付けると宛先を丸ごと置き換える（そのときは remote_addr / remote_port を付けない）
  targets?: Target[];
  balance?: Balance;
  health_check?: HealthCheck | null;
  // 付けると追加の待ち受けアドレスを丸ごと置き換える（[] ですべて外す。v0.3.3）
  extra_listen_addrs?: string[];
  // v0.4：付けると丸ごと置き換える（{} で外す。省けば今のまま）
  labels?: Labels;
  limits?: LimitsSpec | Record<string, never>;
  bandwidth?: BandwidthSpec | Record<string, never>;
  geoip?: GeoipSpec | Record<string, never>;
  outlier_detection?: L4OutlierSpec | Record<string, never>;
}

// この版の rproxy で動かせる v0.3 の機能（古い rproxy は features を返さない）
export interface CapabilityFeatures {
  http: boolean;
  http3: boolean;
  acme: boolean;
  tls_options: boolean;
  // 使えるミドルウェアの種類
  middlewares: string[];
  // 使えるサービスの項目（health_check・sticky・balance、v0.4 の outlier_detection）
  services?: string[];
  // v0.4（docs/DESIGN-v0.4.md 13.2）。古い rproxy は返さない
  rulesets?: boolean;
  labels?: boolean;
  conditions?: boolean;
  readyz?: boolean;
  limits?: boolean;
  bandwidth?: boolean;
  geoip?: boolean;
  outlier_detection?: boolean;
  dry_run?: boolean;
  persistence?: boolean;
  client_cert_auth?: boolean;
  token_expiry?: boolean;
  api_lockout?: boolean;
  handoff?: boolean;
  self_update?: boolean;
  // 設定ファイルの global.performance で効く項目の名前
  performance?: string[];
}

export interface Capabilities {
  // rproxy-api の版（例 0.3.18。v0.3.18 から。古い rproxy は返さない。components/version.ts）
  version?: string;
  source_ip: SourceIp[];
  transparent?: boolean;
  tls_modes?: TlsMode[];
  dtls?: boolean;
  starttls?: StartTls[];
  max_range_ports?: number;
  transparent_ipv6?: boolean;
  features?: CapabilityFeatures;
  // v0.4（#174）：このバイナリの版とハッシュ
  build?: { version?: string; sha256?: string };
}

export class RproxyError extends Error {
  // status は HTTP ステータス。通信自体に失敗したときは 0。retryAfter は 429 locked_out の Retry-After（秒）
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly retryAfter?: number) {
    super(message);
    this.name = 'RproxyError';
  }
}

const TIMEOUT_MS = 10_000;

export interface ApiTarget {
  // リクエストの URL の先頭（末尾の / は除く）
  base: string;
  // Unix ソケットで接続するときのソケットのパス
  socketPath?: string;
}

// RPROXY_API_URL を読む。unix:/run/rproxy/api.sock なら Unix ソケット（rproxy の RPROXY_API_SOCKET）に、
// HTTP の Host は localhost で接続する。unix:///run/... の書き方も受け付ける
export function apiTarget(url: string | undefined): ApiTarget {
  const value = (url ?? '').trim() || 'http://127.0.0.1:8080';
  if (value.startsWith('unix:')) {
    const socketPath = value.slice('unix:'.length).replace(/^\/\/(?=\/)/, '');
    return { base: 'http://localhost', socketPath: socketPath };
  }
  return { base: value.replace(/\/+$/, '') };
}

// ソケットのパスごとに接続を使い回す
const socketAgents = new Map<string, Agent>();

function socketAgent(socketPath: string): Agent {
  let agent = socketAgents.get(socketPath);
  if (!agent) {
    agent = new Agent({ connect: { socketPath: socketPath } });
    socketAgents.set(socketPath, agent);
  }
  return agent;
}

// fetch（グローバル）と undici の fetch の応答のうち、ここで使う部分
interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export function rulePath(key: RproxyRuleKey): string {
  return `/rules/${encodeURIComponent(key.protocol)}/${encodeURIComponent(key.listen_addr)}/${key.listen_port}`;
}

// 制御 API のクライアント証明書（rproxy v0.4 の mTLS、#167）。PEM のファイルのパス。ca は rproxy の証明書を確かめる CA
export interface ClientTls {
  cert?: string;
  key?: string;
  ca?: string;
}

// 問い合わせ先の rproxy（#98 のノード）。url は RPROXY_API_URL と同じ書き方
export interface RproxyNode {
  name: string;
  url: string;
  token?: string;
  // https:// の制御 API に、クライアント証明書・CA を使うとき（RPROXY_UI_NODES の tls_cert・tls_key・tls_ca）
  tls?: ClientTls;
}

// withNode の外（RPROXY_API_URL）で使うクライアント証明書（RPROXY_API_TLS_CERT・RPROXY_API_TLS_KEY・RPROXY_API_TLS_CA）
export function envClientTls(): ClientTls | undefined {
  const tls: ClientTls = {};
  const cert = (process.env.RPROXY_API_TLS_CERT ?? '').trim();
  const key = (process.env.RPROXY_API_TLS_KEY ?? '').trim();
  const ca = (process.env.RPROXY_API_TLS_CA ?? '').trim();
  if (cert) tls.cert = cert;
  if (key) tls.key = key;
  if (ca) tls.ca = ca;
  return Object.keys(tls).length > 0 ? tls : undefined;
}

// ファイルの組と更新時刻ごとに接続を使い回す（証明書を入れ替えたら、次の問い合わせから新しいファイルで接続する）
const tlsAgents = new Map<string, Agent>();

function mtime(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function tlsAgent(tls: ClientTls): Agent {
  const id = JSON.stringify([tls.cert, mtime(tls.cert), tls.key, mtime(tls.key), tls.ca, mtime(tls.ca)]);
  let agent = tlsAgents.get(id);
  if (!agent) {
    const read = (path: string | undefined) => (path ? readFileSync(path) : undefined);
    agent = new Agent({ connect: { cert: read(tls.cert), key: read(tls.key), ca: read(tls.ca) } });
    tlsAgents.set(id, agent);
  }
  return agent;
}

// withNode の中（await の先を含む）の問い合わせは、そのノードに送る。外では RPROXY_API_URL / RPROXY_API_TOKEN。
// 関数の引数を変えずに済むので、1 台のときの呼び出しは今までと同じ
const nodeContext = new AsyncLocalStorage<RproxyNode>();

export function withNode<T>(node: RproxyNode, fn: () => Promise<T>): Promise<T> {
  return nodeContext.run(node, fn);
}

// 今の問い合わせ先のノード（withNode の外なら undefined）
export function currentNode(): RproxyNode | undefined {
  return nodeContext.getStore();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const node = nodeContext.getStore();
  const clientTls = node ? node.tls : envClientTls();
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = node ? node.token : process.env.RPROXY_API_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: FetchResponse;
  try {
    const target = apiTarget(node ? node.url : process.env.RPROXY_API_URL);
    if (target.socketPath === '') throw new Error('RPROXY_API_URL の unix: のあとにソケットのパスを書いてください');
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    // Unix ソケットは undici の fetch に dispatcher を渡す（グローバルの fetch はソケットを指定できない）。
    // クライアント証明書・CA を使う https も undici の Agent に証明書を渡す
    res = target.socketPath !== undefined
      ? await undiciFetch(`${target.base}${path}`, { ...init, dispatcher: socketAgent(target.socketPath) })
      : clientTls && target.base.startsWith('https://')
        ? await undiciFetch(`${target.base}${path}`, { ...init, dispatcher: tlsAgent(clientTls) })
        : await fetch(`${target.base}${path}`, init);
  } catch (err) {
    throw new RproxyError(`rproxy に接続できません: ${err instanceof Error ? err.message : String(err)}`, 'unreachable', 0);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = text || res.statusText;
    let code = 'internal';
    try {
      const data = JSON.parse(text);
      if (typeof data?.error === 'string') message = data.error;
      if (typeof data?.code === 'string') code = data.code;
    } catch {
      // JSON でない応答はそのまま message にする
    }
    const retry = Number(res.headers?.get('retry-after') ?? '');
    throw new RproxyError(message, code, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }

  if (res.status === 204 || text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RproxyError(`rproxy の応答を解釈できません: ${text.slice(0, 200)}`, 'bad_response', res.status);
  }
}

export function getInterfaces(): Promise<InterfacesInfo> {
  return request<InterfacesInfo>('GET', '/interfaces');
}

export function getCapabilities(): Promise<Capabilities> {
  return request<Capabilities>('GET', '/capabilities');
}

// rproxy の設定ファイル（RPROXY_CONFIG）の状態（GET /config。rules:read のスコープ）
export interface RproxyConfigStatus {
  configured: boolean;
  path?: string;
  rules?: number;
  // 最新の版を反映できなかった理由（それまでの版が動いている）
  error?: string | null;
  // 再起動しないと効かない global の変更
  restart_needed?: string[];
}

export function getConfigStatus(): Promise<RproxyConfigStatus> {
  return request<RproxyConfigStatus>('GET', '/config');
}

// ACME の状態（GET /acme。rules:read のスコープ）。global.acme がなければ 404。秘密は rproxy も返さない
export function getAcme(): Promise<unknown> {
  return request<unknown>('GET', '/acme');
}

export function listRules(): Promise<RproxyRuleStatus[]> {
  return request<RproxyRuleStatus[]>('GET', '/rules');
}

export function getRule(key: RproxyRuleKey): Promise<RproxyRuleStatus> {
  return request<RproxyRuleStatus>('GET', rulePath(key));
}

export function addRule(rule: RproxyRule): Promise<RproxyRuleStatus> {
  return request<RproxyRuleStatus>('POST', '/rules', rule);
}

export function modifyRule(key: RproxyRuleKey, patch: RproxyRulePatch): Promise<RproxyRuleStatus> {
  return request<RproxyRuleStatus>('PATCH', rulePath(key), patch);
}

// 変更前の差分（v0.4 の ?dry_run=true、#169）。何も変えずに RulePlan を返す。features.dry_run が false の rproxy は 400 unsupported
export function planAdd(rule: RproxyRule): Promise<RulePlan> {
  return request<RulePlan>('POST', '/rules?dry_run=true', rule);
}

export function planModify(key: RproxyRuleKey, patch: RproxyRulePatch): Promise<RulePlan> {
  return request<RulePlan>('PATCH', `${rulePath(key)}?dry_run=true`, patch);
}

export function planDelete(key: RproxyRuleKey): Promise<RulePlan> {
  return request<RulePlan>('DELETE', `${rulePath(key)}?dry_run=true`);
}

export async function deleteRule(key: RproxyRuleKey, drainSecs?: number): Promise<void> {
  const query = drainSecs !== undefined ? `?drain_secs=${drainSecs}` : '';
  await request<void>('DELETE', `${rulePath(key)}${query}`);
}
