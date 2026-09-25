import { DefaultSession, ISODateString } from 'next-auth';
import pino from 'pino';


export const Logger = (level : string, {...propaty}: any) => {
  return pino({
    level: level
  }).child(propaty);
}

export type Protocol = 'tcp' | 'udp';
export type SourceIp = 'proxy' | 'proxy_v1' | 'proxy_v2' | 'transparent';
export const SOURCE_IPS: SourceIp[] = ['proxy', 'proxy_v1', 'proxy_v2', 'transparent'];
// proxy_v1 / proxy_v2 は TCP でのみ使える
export const TCP_ONLY_SOURCE_IPS: SourceIp[] = ['proxy_v1', 'proxy_v2'];
export const DEFAULT_UDP_IDLE_SECS = 30;
export const DEFAULT_MAX_RANGE_PORTS = 20000;

// TLS / DTLS の設定。rproxy の API と DB の options 列にそのまま渡すので、キーは API の名前（snake_case）にする
export type TlsMode = 'passthrough' | 'sni' | 'terminate';
export const TLS_MODES: TlsMode[] = ['passthrough', 'sni', 'terminate'];
export type StartTls = 'smtp' | 'imap' | 'pop3';
export const STARTTLS_PROTOCOLS: StartTls[] = ['smtp', 'imap', 'pop3'];
export type ClientAuthMode = 'none' | 'optional' | 'required';
export const CLIENT_AUTH_MODES: ClientAuthMode[] = ['none', 'optional', 'required'];

export interface TlsRoute {
  server_name: string;
  remote_addr: string;
  remote_port: number;
}

export interface TlsCertificate {
  cert_file: string;
  key_file: string;
}

export interface TlsClientAuth {
  mode: ClientAuthMode;
  ca_file?: string;
}

export interface TlsUpstream {
  tls?: boolean;
  server_name?: string;
  ca_file?: string;
  insecure_skip_verify?: boolean;
  cert_file?: string;
  key_file?: string;
}

// 既定値の項目は省く（components/tls.ts の normalizeTls がこの形に揃える）
export interface TlsSpec {
  mode: TlsMode;
  routes?: TlsRoute[];
  certificates?: TlsCertificate[];
  client_auth?: TlsClientAuth;
  alpn?: string[];
  upstream?: TlsUpstream;
}

export interface ForwardRule {
  protocol: Protocol;
  srcAddr: string;
  srcPort: number;
  // ポート範囲の終わり。単一ポートなら null
  srcPortEnd: number | null;
  distAddr: string;
  distPort: number;
  sourceIp: SourceIp;
  udpIdleSecs: number;
  tls: TlsSpec;
  starttls: StartTls | null;
  starttlsRequired: boolean;
}

// missing: DB にはあるが rproxy にない / unknown: rproxy に問い合わせできなかった
export type RuleState = 'running' | 'failed' | 'missing' | 'unknown';

export interface ForwardRules extends ForwardRule {
  id: number;
  state: RuleState;
  error: string | null;
  connections: number | null;
}

export interface PageAuthrized {
  isAuthorized: boolean;
}

export interface sessionUser extends DefaultSession {
  user: {
    name: string;
    email: string;
    image: string;
    id: string;
    role: string;
  }
  expires: ISODateString;
}