import { DefaultSession, ISODateString } from 'next-auth';
import pino from 'pino';
import type { Access } from './roles';


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

// サーバ名は server_name（1 つ）か server_names（複数）のどちらか一方。`*.example.com` は 1 階層、`**.example.com` は何階層でも一致する。
// passthrough（terminate のルールだけ）は、その名前を終端せずに ClientHello ごと転送先へ流す（証明書は転送先のもの）
export interface TlsRoute {
  server_name?: string;
  server_names?: string[];
  remote_addr: string;
  remote_port: number;
  // true のときだけ付ける
  passthrough?: boolean;
}

// route のサーバ名の一覧（server_name / server_names のどちらでも）
export function routeNames(route: Pick<TlsRoute, 'server_name' | 'server_names'>): string[] {
  return route.server_names ?? (route.server_name !== undefined ? [route.server_name] : []);
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

// 宛先を複数にしたときの振り分け方（rproxy の balance。L7 の services.<名前>.balance も同じ）
// round_robin: 重みの比率で順に回す / least_conn: 接続数（UDP はセッション数）÷ 重みが一番小さい宛先 /
// failover: 上から順に、生きている最初の宛先だけを使う
export type Balance = 'round_robin' | 'least_conn' | 'failover';
export const BALANCES: Balance[] = ['round_robin', 'least_conn', 'failover'];
export const DEFAULT_BALANCE: Balance = 'round_robin';

// 宛先の 1 件（rproxy の targets[]）。weight は 1 なら、backup は false なら省く
export interface Target {
  addr: string;
  port: number;
  weight?: number;
  // 通常の宛先がすべて落ちたときだけ使う
  backup?: boolean;
}

// 宛先の死活確認（TCP の接続で確かめる）。port を省くと各宛先のポート（UDP のルールでは必須）
export interface HealthCheck {
  interval?: string;
  timeout?: string;
  port?: number;
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
  // 接続を許可する送信元（正規化した CIDR。例 10.0.0.5/32）。空ならすべて許可
  allowFrom: string[];
  // L7 の設定。あるルールは remote_addr / remote_port を持たない（distAddr は ''、distPort は 0）。
  // 画面のフォームではまだ作れない・変えられない（UI #34）ので、変更のときは元の値を保つ
  http: HttpSpec | null;
  // CrowdSec の判定に入っている接続元を、受け付けた直後に切る（L4。rproxy v0.3.2 の global.crowdsec が必要）
  crowdsec: boolean;
  // 宛先を複数にしたとき（rproxy の targets）。空なら distAddr / distPort の単一の宛先。
  // 空でないときは distAddr は ''、distPort は 0（rproxy に remote_addr / remote_port を送らない）
  targets: Target[];
  // targets があるときの振り分け方
  balance: Balance;
  // targets があるときの死活確認。null なら接続の失敗だけで判定する
  healthCheck: HealthCheck | null;
  // 同じポート（範囲）で追加で待ち受けるアドレス（IPv4 と IPv6 を同時に、など。rproxy v0.3.3。最大 16 件）。省略は []
  extraListenAddrs?: string[];
  // false なら一時停止中（DB に残したまま rproxy から外している）。省略は true
  enabled?: boolean;
  // ルールを置くノードかグループの名前（#98）。RPROXY_UI_NODES でノードを設定したときだけ付く
  target?: string;
  // グループのルールの、ノードごとの上書き（components/overrides.ts。上書きがあるときだけ）
  overrides?: Record<string, import('./overrides').NodeOverride>;
}

export const MAX_EXTRA_LISTEN_ADDRS = 16;

// dynamic: API（この UI）で作ったルール / static: rproxy の設定ファイルの固定ルール（DB にはない。変更・削除できない）
export type RuleOrigin = 'dynamic' | 'static';

// missing: DB にはあるが rproxy にない / unknown: rproxy に問い合わせできなかった / paused: UI で一時停止中（DB にだけある）
export type RuleState = 'running' | 'failed' | 'missing' | 'unknown' | 'paused';

// rproxy がルールを開始してからの累計（rproxy の応答の stats をそのまま渡す）
export interface RuleStats {
  total_connections: number;
  rx_bytes: number;
  tx_bytes: number;
  tls_failures: number;
  // allow_from の範囲外、または unmatched: reject で切断した接続の数（古い rproxy は返さない）
  denied?: number;
  // UDP で rproxy が転送できずに捨てたデータグラムの数（rproxy v0.3.9 以降。古い rproxy は返さない）
  dropped?: number;
  // http のルールのリクエストの数（rproxy v0.3.1 以降。ほかのルールと古い rproxy は返さない）
  http?: HttpStats;
  // 宛先ごとの状態（宛先を複数にしたルール。rproxy v0.3.3 以降。古い rproxy は返さない）
  targets?: TargetStats[];
}

// rproxy の証明書の期限（ルールの cert_status の 1 要素。rproxy v0.3.5 以降）
export type CertRole = 'certificate' | 'client_ca' | 'client_chain' | 'upstream_ca' | 'upstream_certificate';
export type CertState = 'ok' | 'expiring' | 'expired';
export interface CertStatus {
  role: CertRole;
  file: string;
  // RFC 3339（UTC）
  not_after: string;
  // 残りの日数。切れたら負
  days_left: number;
  state: CertState;
}

// 宛先ごとの状態。rproxy の版によって項目が欠けることがあるので、どれも省略できる
export interface TargetStats {
  addr?: string;
  port?: number;
  // 生きているか（ヘルスチェックと接続の失敗から rproxy が判定）
  up?: boolean;
  // いまの接続数（UDP はセッション数）
  connections?: number;
  total_connections?: number;
  backup?: boolean;
  weight?: number;
}

// 状態コードの百の位ごとの区分。0 件の区分は省かれる
export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
export type StatusCounts = Partial<Record<StatusClass, number>>;

// ルールごとの L7 のリクエストの数。limited は rate_limit / in_flight、blocked は crowdsec で断った数
// （どちらも by_status の 4xx にも数える。0 件なら省かれる）
export interface HttpStats {
  requests: number;
  by_status: StatusCounts;
  // ルールの名前ごと。どのルートにも一致しなかったリクエストは "(none)"
  routes: Record<string, HttpRouteStats>;
  limited?: number;
  blocked?: number;
}

// limited / blocked はミドルウェアの名前ごと
export interface HttpRouteStats {
  requests: number;
  by_status: StatusCounts;
  limited?: Record<string, number>;
  blocked?: Record<string, number>;
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
  // 作成した利用者（Keycloak の sub）。管理者（rproxy-admin）が見るときだけ付く
  owner?: string;
  // 証明書の期限（rproxy の cert_status）。証明書がないルールと古い rproxy では付かない
  certStatus?: CertStatus[];
  // ノードごとの稼働情報（RPROXY_UI_NODES でノードを設定したときだけ。グループのルールでは全員分）。
  // 上の state などはその集計（state は悪いほう、接続数と stats は合計）
  nodes?: NodeLiveState[];
  // active_standby のグループのルールの act の判定（判定に使うアドレスがないときは付かない）
  ha?: HaStatus;
}

// ルールの 1 ノードでの稼働情報
export interface NodeLiveState {
  node: string;
  state: RuleState;
  error: string | null;
  connections: number | null;
  stats: RuleStats | null;
  startedAt: number | null;
  resolved: string[];
  certStatus?: CertStatus[];
  // UI の定義とこのノードの実際のルール（GET /rules）の違い（項目のコード。components/drift.ts）。空なら同じ。
  // rproxy にない（missing）・問い合わせできない（unknown）ときは付かない
  drift?: DriftField[];
  // active_standby のグループで、VIP を持っているか（GET /interfaces）。判定できなければ付かない
  role?: NodeRole;
}

// UI の定義と rproxy の実際のルールで違う項目（画面で名前に直す）
export type DriftField = 'remote' | 'targets' | 'source_ip' | 'udp_idle_secs' | 'port_range' | 'tls' | 'starttls' | 'allow_from' | 'http' | 'crowdsec' | 'extra_listen_addrs' | 'enabled';

export type NodeRole = 'active' | 'standby';

// active_standby のグループ（またはそのルール）の act の判定。warning: none は VIP をだれも持っていない、split は複数が持っている
export interface HaStatus {
  // 判定に使ったアドレス
  addrs: string[];
  active: string[];
  warning: 'none' | 'split' | null;
}

// ダッシュボードのノードの一覧の 1 行
export interface NodeSummary {
  name: string;
  // rproxy の GET /rules に答えたか
  reachable: boolean;
  error: string | null;
  // このノードに置くルール（ノードのルールとグループのルール。固定ルールは含めない）の数
  rules: number;
  // そのうち、このノードで failed / missing のもの
  failed: number;
  // そのうち、UI の定義とずれているもの
  drifted: number;
  // このノードに最後に反映した時刻（ISO 8601。このノードを含むノード／グループの履歴の最後。なければ null）
  lastSync?: string | null;
}

// ダッシュボードの active_standby のグループ（vip を設定したものだけ）
export interface GroupHa extends HaStatus {
  name: string;
  nodes: string[];
}

// single: 全員に同じルールを送る / active_standby: 同じルールを送り、どれが動いているかを表示する（表示は後の版）
export type GroupMode = 'single' | 'active_standby';

// GET /api/forward/nodes の応答（URL とトークンは含めない）
export interface NodesInfo {
  // RPROXY_UI_NODES を使っているか
  configured: boolean;
  nodes: { name: string }[];
  groups: { name: string; mode: GroupMode; nodes: string[]; vips?: string[] }[];
  // 追加の画面で最初に選ぶノード／グループ。null なら選んでもらう
  defaultTarget: string | null;
  // 利用者が使えるノード／グループ（RPROXY_UI_USER_NODES で絞ったときだけ。admin には付かない）
  allowedTargets?: string[];
}

// GET /api/forward/dashboard の応答
export interface DashboardData {
  // rproxy の稼働状態を取得できたか
  reachable: boolean;
  // 取得できなかった理由
  rproxyError: string | null;
  // 自分のルール（DB。管理者ならすべての利用者のルール）のあとに、rproxy の固定ルール（origin: static）を続ける
  rules: ForwardRules[];
  // 管理者（rproxy-admin）として見ているか（所有者の列を出す）
  admin?: boolean;
  // ノードごとの状態（RPROXY_UI_NODES でノードを設定したときだけ）
  nodes?: NodeSummary[];
  // vip を設定した active_standby のグループの act
  groups?: GroupHa[];
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
    // Keycloak のロール（NextAuth の jwt コールバックで保存したもの）。古いセッションにはない
    roles?: string[];
    // admin / user / none（components/roles.ts）
    access?: Access;
  }
  expires: ISODateString;
}