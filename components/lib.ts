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
// proxy_v1（テキスト）は TCP でのみ使える。proxy_v2 は UDP でも使える（データグラムごとにヘッダが付く）
export const TCP_ONLY_SOURCE_IPS: SourceIp[] = ['proxy_v1'];
export const DEFAULT_UDP_IDLE_SECS = 30;
export const DEFAULT_MAX_RANGE_PORTS = 20000;

// TLS / DTLS の設定。rproxy の API と DB の options 列にそのまま渡すので、キーは API の名前（snake_case）にする
export type TlsMode = 'passthrough' | 'sni' | 'terminate';
export const TLS_MODES: TlsMode[] = ['passthrough', 'sni', 'terminate'];
export type StartTls = 'smtp' | 'imap' | 'pop3';
export const STARTTLS_PROTOCOLS: StartTls[] = ['smtp', 'imap', 'pop3'];
export type ClientAuthMode = 'none' | 'optional' | 'required';
export const CLIENT_AUTH_MODES: ClientAuthMode[] = ['none', 'optional', 'required'];
// どの routes にも一致しない名前・SNI なしの接続：default はルールの転送先へ、reject は切断する
export type TlsUnmatched = 'default' | 'reject';

export interface TlsRoute {
  server_name: string;
  remote_addr: string;
  remote_port: number;
}

// ファイル（cert_file / chain_file / key_file）か ACME（acme / domains。v0.3）のどちらか一方。
// chain_file は中間 CA の証明書（サーバ証明書を発行した CA からルートへ向かう順。ルートは不要）
export interface TlsCertificate {
  cert_file?: string;
  chain_file?: string;
  key_file?: string;
  // rproxy の設定ファイルの global.acme.resolvers の名前
  acme?: string;
  // ACME の証明書に含める名前（小文字）
  domains?: string[];
}

// TLS のオプション（v0.3。GET /capabilities の features.tls_options）
export interface TlsOptions {
  min_version?: '1.2' | '1.3';
  cipher_suites?: string[];
}

// ca_file はルート CA（信頼の起点）、chain_file はクライアント証明書の中間 CA（経路を補うだけ）。
// chain_file は mode が optional / required のときだけ使える
export interface TlsClientAuth {
  mode: ClientAuthMode;
  ca_file?: string;
  chain_file?: string;
}

export interface TlsUpstream {
  tls?: boolean;
  server_name?: string;
  ca_file?: string;
  insecure_skip_verify?: boolean;
  cert_file?: string;
  // cert_file の中間 CA（cert_file があるときだけ）
  chain_file?: string;
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
  // 既定（default）なら省く。tcp の sni / terminate で routes があるときだけ reject にできる
  unmatched?: TlsUnmatched;
  // 空なら省く（terminate でのみ使える）
  options?: TlsOptions;
}

// L7 の設定（ルールの http。v0.3）。UI は中身を解釈せず、保存して rproxy に渡すだけ（検証は rproxy がする）
export type HttpSpec = Record<string, unknown>;

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
  // 接続を許可する送信元（正規化した CIDR。例 10.0.0.5/32）。空ならすべて許可
  allowFrom: string[];
  // L7 の設定。あるルールは remote_addr / remote_port を持たない（distAddr は ''、distPort は 0）。
  // 画面のフォームではまだ作れない・変えられない（UI #34）ので、変更のときは元の値を保つ
  http: HttpSpec | null;
}

// dynamic: API（この UI）で作ったルール / static: rproxy の設定ファイルの固定ルール（DB にはない。変更・削除できない）
export type RuleOrigin = 'dynamic' | 'static';

// missing: DB にはあるが rproxy にない / unknown: rproxy に問い合わせできなかった
export type RuleState = 'running' | 'failed' | 'missing' | 'unknown';

// rproxy がルールを開始してからの累計（rproxy の応答の stats をそのまま渡す）
export interface RuleStats {
  total_connections: number;
  rx_bytes: number;
  tx_bytes: number;
  tls_failures: number;
  // allow_from の範囲外、または unmatched: reject で切断した接続の数（古い rproxy は返さない）
  denied?: number;
}

// 稼働情報は rproxy に問い合わせできない（unknown）か rproxy にない（missing）ときは null / 空
// id は DB の id。固定ルール（origin: static）は DB にないので負の数を振る（画面の key にだけ使う）
export interface ForwardRules extends ForwardRule {
  id: number;
  origin: RuleOrigin;
  state: RuleState;
  error: string | null;
  connections: number | null;
  stats: RuleStats | null;
  // 待ち受けを始めた時刻（Unix 秒）
  startedAt: number | null;
  // 最後に名前解決できた転送先（"ip:port"）
  resolved: string[];
}

// GET /api/forward/dashboard の応答
export interface DashboardData {
  // rproxy の稼働状態を取得できたか
  reachable: boolean;
  // 取得できなかった理由
  rproxyError: string | null;
  // 自分のルール（DB）のあとに、rproxy の固定ルール（origin: static）を続ける
  rules: ForwardRules[];
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