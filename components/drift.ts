// UI の定義（DB）と、ノードで実際に動いているルール（rproxy の GET /rules）の違い（#98 の「ずれ」）。React に依存しない。
// どちらも画面の形（ForwardRule）に揃えてから項目ごとに比べる。稼働情報（state・stats・resolved など）は比べない。
// 既定値・空の値の違い（null と省略、[] と省略、false と省略）はずれにしない
import type { DriftField, ForwardRule } from './lib';
import type { RproxyRuleStatus } from './rproxy';
import { ruleFromStatus } from './dashboard';
import { V04_KEYS, v04Fields } from './v04';

export const DRIFT_LABELS: Record<DriftField, string> = {
  remote: '転送先',
  targets: '宛先（複数）・振り分け方・ヘルスチェック',
  source_ip: '送信元 IP の扱い',
  udp_idle_secs: 'UDP のアイドルタイムアウト',
  port_range: 'ポート範囲',
  tls: 'TLS の設定',
  starttls: 'STARTTLS',
  allow_from: '接続を許可する送信元',
  http: 'L7 の設定',
  crowdsec: 'CrowdSec',
  extra_listen_addrs: '追加の待ち受けアドレス',
  enabled: '一時停止（UI では停止中なのに動いている）',
  labels: 'ラベル',
  limits: 'L4 の制限',
  bandwidth: '帯域の上限',
  geoip: 'GeoIP',
  outlier_detection: '受け身のヘルスチェック',
};

// 比べるための形：null / undefined / false / 空の配列・オブジェクトを省き、キーを並べ替える
export function canon(value: unknown): unknown {
  if (value === null || value === undefined || value === false) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(canon).filter((v) => v !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canon((value as Record<string, unknown>)[k]);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a) ?? null) === JSON.stringify(canon(b) ?? null);
}

const sorted = (list: string[] | undefined) => [...(list ?? [])].map((s) => s.toLowerCase()).sort();

// stored（DB の定義）と live（そのノードの GET /rules/{key} の 1 件）の違う項目。停止中のルールが動いていれば enabled
export function ruleDrift(stored: ForwardRule, live: RproxyRuleStatus): DriftField[] {
  if (stored.enabled === false) return ['enabled'];
  const actual = ruleFromStatus(live, 0);
  const out: DriftField[] = [];
  const multiStored = stored.targets.length > 0;
  const multiLive = actual.targets.length > 0;
  if (stored.http === null && actual.http === null && !multiStored && !multiLive) {
    if (stored.distAddr.toLowerCase() !== actual.distAddr.toLowerCase() || stored.distPort !== actual.distPort) out.push('remote');
  } else if (multiStored !== multiLive && stored.http === null) {
    out.push(multiStored ? 'targets' : 'remote');
  }
  if ((multiStored || multiLive) && !out.includes('targets') && !out.includes('remote')) {
    if (!same(stored.targets, actual.targets) || stored.balance !== actual.balance || !same(stored.healthCheck, actual.healthCheck)) out.push('targets');
  }
  if (stored.sourceIp !== actual.sourceIp) out.push('source_ip');
  if (stored.protocol === 'udp' && stored.udpIdleSecs !== actual.udpIdleSecs) out.push('udp_idle_secs');
  if ((stored.srcPortEnd ?? null) !== (actual.srcPortEnd ?? null)) out.push('port_range');
  if (!same(stored.tls, actual.tls)) out.push('tls');
  if ((stored.starttls ?? null) !== (actual.starttls ?? null)
    || (stored.starttls !== null && stored.starttlsRequired !== actual.starttlsRequired)) out.push('starttls');
  if (!same(sorted(stored.allowFrom), sorted(actual.allowFrom))) out.push('allow_from');
  if (!same(stored.http, actual.http)) out.push('http');
  if (stored.crowdsec !== actual.crowdsec) out.push('crowdsec');
  if (!same(sorted(stored.extraListenAddrs), sorted(actual.extraListenAddrs))) out.push('extra_listen_addrs');
  // v0.4 の項目（labels・limits・bandwidth・geoip・outlier_detection）
  const sv = v04Fields(stored);
  const av = v04Fields(actual);
  for (const key of V04_KEYS) if (!same(sv[key], av[key])) out.push(key);
  return out;
}

// 送り直しで PATCH では直せず、削除して作り直す違い（rproxy が PATCH で変えられない：送信元 IP の扱い・ポート範囲・L4 / L7）
export function needsRecreateOnNode(stored: ForwardRule, live: RproxyRuleStatus): boolean {
  const actual = ruleFromStatus(live, 0);
  return stored.sourceIp !== actual.sourceIp
    || (stored.srcPortEnd ?? null) !== (actual.srcPortEnd ?? null)
    || (stored.http === null) !== (actual.http === null);
}
