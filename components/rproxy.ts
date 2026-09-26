// rproxy-api の HTTP クライアント（契約は ../rproxy-api/docs/API.md）

import { Agent, fetch as undiciFetch } from 'undici';
import type { HttpSpec, Protocol, RuleOrigin, RuleStats, SourceIp, StartTls, TlsMode, TlsSpec } from './lib';
import type { InterfacesInfo } from './listen';

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
  origin?: RuleOrigin;
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
}

// この版の rproxy で動かせる v0.3 の機能（古い rproxy は features を返さない）
export interface CapabilityFeatures {
  http: boolean;
  http3: boolean;
  acme: boolean;
  tls_options: boolean;
  // 使えるミドルウェアの種類
  middlewares: string[];
}

export interface Capabilities {
  source_ip: SourceIp[];
  transparent?: boolean;
  tls_modes?: TlsMode[];
  dtls?: boolean;
  starttls?: StartTls[];
  max_range_ports?: number;
  features?: CapabilityFeatures;
}

export class RproxyError extends Error {
  // status は HTTP ステータス。通信自体に失敗したときは 0
  constructor(message: string, public readonly code: string, public readonly status: number) {
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
  text(): Promise<string>;
}

export function rulePath(key: RproxyRuleKey): string {
  return `/rules/${encodeURIComponent(key.protocol)}/${encodeURIComponent(key.listen_addr)}/${key.listen_port}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env.RPROXY_API_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: FetchResponse;
  try {
    const target = apiTarget(process.env.RPROXY_API_URL);
    if (target.socketPath === '') throw new Error('RPROXY_API_URL の unix: のあとにソケットのパスを書いてください');
    const init = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    // Unix ソケットは undici の fetch に dispatcher を渡す（グローバルの fetch はソケットを指定できない）
    res = target.socketPath !== undefined
      ? await undiciFetch(`${target.base}${path}`, { ...init, dispatcher: socketAgent(target.socketPath) })
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
    throw new RproxyError(message, code, res.status);
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

export async function deleteRule(key: RproxyRuleKey, drainSecs?: number): Promise<void> {
  const query = drainSecs !== undefined ? `?drain_secs=${drainSecs}` : '';
  await request<void>('DELETE', `${rulePath(key)}${query}`);
}
