// rproxy の機能と設定の読み取り専用の表示（/system）。各ノードの GET /capabilities と GET /config から、
// v0.4 の機能の印・performance の効く項目・設定ファイルの状態だけを取り出す（秘密やファイルの中身は rproxy も返さない）。
// React と Node に依存しない（tests/system.test.ts）
import type { Capabilities, CapabilityFeatures, RproxyConfigStatus } from './rproxy';

// v0.4 の機能（docs/DESIGN-v0.4.md 13.2）と画面の名前
export const V04_FEATURES: { key: keyof CapabilityFeatures; label: string }[] = [
  { key: 'labels', label: 'ラベル' },
  { key: 'limits', label: 'L4 の制限' },
  { key: 'bandwidth', label: '帯域の上限' },
  { key: 'geoip', label: 'GeoIP' },
  { key: 'outlier_detection', label: '受け身のヘルスチェック' },
  { key: 'dry_run', label: '変更前の差分（dry run）' },
  { key: 'persistence', label: 'API で作ったルールの保存' },
  { key: 'rulesets', label: 'ルールの組（rulesets）' },
  { key: 'conditions', label: '状態（conditions）' },
  { key: 'readyz', label: 'readiness（/readyz）' },
  { key: 'client_cert_auth', label: '制御 API のクライアント証明書（mTLS）' },
  { key: 'token_expiry', label: 'トークンの期限の知らせ' },
  { key: 'api_lockout', label: '認証の失敗が続く送信元の一時停止' },
  { key: 'handoff', label: '再起動なしの更新（handoff）' },
  { key: 'self_update', label: 'コンテナでの自動更新' },
];

// global.performance の項目（設定ファイルにあれば使う。再起動まで効かない）
export const PERFORMANCE_KEYS = ['workers', 'udp_shards', 'cpu_affinity', 'busy_poll_usecs', 'splice'];

export interface NodeSystemView {
  node: string;
  reachable: boolean;
  error: string | null;
  version: string | null;
  build: { version?: string; sha256?: string } | null;
  // v0.4 の機能（rproxy が返さなければ null：v0.4 より前）
  features: Record<string, boolean> | null;
  middlewares: string[];
  services: string[];
  // 設定ファイルから効く performance の項目（features.performance）
  performance: string[] | null;
  config: {
    readable: boolean;
    configured: boolean;
    path: string | null;
    rules: number | null;
    error: string | null;
    restartNeeded: string[];
  };
}

export function nodeSystemView(node: string, caps: Capabilities | null, config: RproxyConfigStatus | null, error: string | null): NodeSystemView {
  const f = caps?.features;
  const hasV04 = f !== undefined && V04_FEATURES.some((x) => typeof f[x.key] === 'boolean');
  return {
    node: node,
    reachable: caps !== null,
    error: error,
    version: typeof caps?.version === 'string' ? caps.version : null,
    build: caps?.build && typeof caps.build === 'object' ? caps.build : null,
    features: hasV04 ? Object.fromEntries(V04_FEATURES.map((x) => [x.key, f![x.key] === true])) : null,
    middlewares: Array.isArray(f?.middlewares) ? f!.middlewares : [],
    services: Array.isArray(f?.services) ? f!.services : [],
    performance: Array.isArray(f?.performance) ? f!.performance : null,
    config: {
      readable: config !== null,
      configured: config?.configured === true,
      path: typeof config?.path === 'string' ? config.path : null,
      rules: typeof config?.rules === 'number' ? config.rules : null,
      error: typeof config?.error === 'string' ? config.error : null,
      restartNeeded: Array.isArray(config?.restart_needed) ? config.restart_needed : [],
    },
  };
}
