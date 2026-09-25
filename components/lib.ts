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

export interface ForwardRule {
  protocol: Protocol;
  srcAddr: string;
  srcPort: number;
  distAddr: string;
  distPort: number;
  sourceIp: SourceIp;
  udpIdleSecs: number;
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