// rproxy-api の HTTP クライアント（契約は ../rproxy-api/docs/API.md）

import type { Protocol, RuleStats, SourceIp, StartTls, TlsMode, TlsSpec } from './lib';
import type { InterfacesInfo } from './listen';

export type { Protocol, RuleStats, SourceIp, StartTls, TlsMode, TlsSpec };

export interface RproxyRule {
  protocol: Protocol;
  listen_addr: string;
  listen_port: number;
  listen_port_end?: number;
  remote_addr: string;
  remote_port: number;
  source_ip?: SourceIp;
  udp_idle_secs?: number;
  tls?: TlsSpec;
  starttls?: StartTls;
  starttls_required?: boolean;
}

// 応答では既定値の項目も含めて返る（tls はすべての項目、listen_port_end と starttls は null もある）
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
}

export interface RproxyRuleKey {
  protocol: Protocol;
  listen_addr: string;
  listen_port: number;
}

// tls を付けると TLS の設定（starttls / starttls_required を含む）を丸ごと置き換える。
// source_ip とポート範囲は変えられない（listen_port_end は同じ値なら付けてもよい）
export interface RproxyRulePatch {
  remote_addr: string;
  remote_port: number;
  udp_idle_secs?: number;
  tls?: TlsSpec;
  starttls?: StartTls;
  starttls_required?: boolean;
  listen_port_end?: number;
}

export interface Capabilities {
  source_ip: SourceIp[];
  transparent?: boolean;
  tls_modes?: TlsMode[];
  dtls?: boolean;
  starttls?: StartTls[];
  max_range_ports?: number;
}

export class RproxyError extends Error {
  // status は HTTP ステータス。通信自体に失敗したときは 0
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'RproxyError';
  }
}

const TIMEOUT_MS = 10_000;

function baseUrl(): string {
  return (process.env.RPROXY_API_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

export function rulePath(key: RproxyRuleKey): string {
  return `/rules/${encodeURIComponent(key.protocol)}/${encodeURIComponent(key.listen_addr)}/${key.listen_port}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = process.env.RPROXY_API_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
