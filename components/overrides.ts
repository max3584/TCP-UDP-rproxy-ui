// グループのルールの、ノードごとの上書き（#98）。React と Node の API に依存しない（画面と API route の両方で使う）。
// 上書きできる項目：待ち受けアドレス（srcAddr・extraListenAddrs）、転送先（1 つの distAddr / distPort か、
// 複数の targets / balance / healthCheck）、接続を許可する送信元（allowFrom）、このノードだけの一時停止（enabled: false）。
// TLS・L7・送信元 IP の扱い・ポート範囲は上書きできない（グループで同じにする）。
// DB は forward_rule_overrides（rule_id, node, src_addr, dist_addr, dist_port, options）。options は forward_rules.options に
// JSON_MERGE_PATCH で重ねる差分で、ノードごとのビュー（db/node-view.mjs）が同じ重ね方で rproxy に渡す
import { DEFAULT_BALANCE } from './lib';
import type { Balance, ForwardRule, HealthCheck, Protocol, Target } from './lib';
import { parseCidr } from './cidr';
import { TlsError, checkBalancing, normalizeAllowFrom, normalizeBalance, normalizeExtraListenAddrs, normalizeHealthCheck, normalizeTargets, portCount } from './tls';

export interface NodeOverride {
  srcAddr?: string;
  extraListenAddrs?: string[];
  // 1 つの転送先（targets とどちらか一方）
  distAddr?: string;
  distPort?: number;
  // 複数の転送先
  targets?: Target[];
  balance?: Balance;
  healthCheck?: HealthCheck | null;
  allowFrom?: string[];
  // このノードだけ一時停止
  enabled?: false;
}

// ノードの名前 → 上書き
export type Overrides = Record<string, NodeOverride>;

const KEYS = ['srcAddr', 'extraListenAddrs', 'distAddr', 'distPort', 'targets', 'balance', 'healthCheck', 'allowFrom', 'enabled'];

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function invalid(message: string): TlsError {
  return new TlsError(message, 'invalid');
}

function ip(value: unknown, what: string): string {
  const parsed = typeof value === 'string' && !value.includes('/') ? parseCidr(value.trim()) : null;
  if (!parsed || !parsed.ok) throw invalid(`${what}には IP アドレスを指定してください。`);
  return parsed.value.replace(/\/\d+$/, '');
}

// 上書きを確かめて正規化する（API の body の形。空なら null）。rule はグループのルール（DB の内容）
export function normalizeOverride(value: unknown, rule: ForwardRule): NodeOverride | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('上書きの形式が不正です。');
  const raw = value as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (extra.length > 0) throw invalid(`上書きできない項目です: ${extra.join(', ')}`);
  const out: NodeOverride = {};
  if (raw.srcAddr !== undefined && raw.srcAddr !== null && raw.srcAddr !== '') out.srcAddr = ip(raw.srcAddr, '待ち受けアドレス');
  const listenAddr = out.srcAddr ?? rule.srcAddr;
  if (raw.extraListenAddrs !== undefined && raw.extraListenAddrs !== null) out.extraListenAddrs = normalizeExtraListenAddrs(raw.extraListenAddrs, listenAddr);
  const hasTargets = Array.isArray(raw.targets) && raw.targets.length > 0;
  const hasRemote = raw.distAddr !== undefined && raw.distAddr !== null && raw.distAddr !== '';
  if ((hasTargets || hasRemote) && rule.http !== null) throw invalid('L7（HTTP）のルールの転送先は上書きできません（L7 タブのサービスで設定します）。');
  if (hasTargets && hasRemote) throw invalid('転送先の上書きは、1 つの転送先か複数の宛先のどちらか一方にしてください。');
  if (hasRemote) {
    const addr = String(raw.distAddr).trim();
    if (parseCidr(addr).ok === false && !HOSTNAME_PATTERN.test(addr)) throw invalid('転送先には IP アドレスかホスト名を指定してください。');
    const port = raw.distPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid('転送先のポート番号は1から65535の範囲で指定してください。');
    out.distAddr = addr.includes(':') ? ip(addr, '転送先') : addr;
    out.distPort = port;
  } else if (hasTargets) {
    out.targets = normalizeTargets(raw.targets);
    out.balance = normalizeBalance(raw.balance);
    out.healthCheck = normalizeHealthCheck(raw.healthCheck);
    checkBalancing(rule.protocol as Protocol, { targets: out.targets, balance: out.balance, healthCheck: out.healthCheck }, portCount(rule.srcPort, rule.srcPortEnd, 0));
  }
  if (raw.allowFrom !== undefined && raw.allowFrom !== null) out.allowFrom = normalizeAllowFrom(raw.allowFrom);
  if (raw.enabled === false) out.enabled = false;
  else if (raw.enabled !== undefined && raw.enabled !== true) throw invalid('enabled は false（このノードだけ停止）だけを指定できます。');
  return Object.keys(out).length === 0 ? null : out;
}

// そのノードで動かす内容（ルールに上書きを重ねたもの）。ルール全体の一時停止はそのまま
export function effectiveRule<T extends ForwardRule>(rule: T, ov: NodeOverride | undefined): T {
  if (!ov) return rule;
  const r: T = { ...rule };
  if (ov.srcAddr !== undefined) r.srcAddr = ov.srcAddr;
  if (ov.extraListenAddrs !== undefined) r.extraListenAddrs = ov.extraListenAddrs;
  if (ov.targets !== undefined && ov.targets.length > 0) {
    r.targets = ov.targets;
    r.balance = ov.balance ?? DEFAULT_BALANCE;
    r.healthCheck = ov.healthCheck ?? null;
    r.distAddr = '';
    r.distPort = 0;
  } else if (ov.distAddr !== undefined) {
    r.distAddr = ov.distAddr;
    r.distPort = ov.distPort ?? r.distPort;
    r.targets = [];
    r.balance = DEFAULT_BALANCE;
    r.healthCheck = null;
  }
  if (ov.allowFrom !== undefined) r.allowFrom = ov.allowFrom;
  if (ov.enabled === false) r.enabled = false;
  return r;
}

// DB の行（forward_rule_overrides）。options は forward_rules.options に重ねる JSON の差分（RFC 7396。null はキーを消す）
export interface OverrideRow {
  src_addr: string | null;
  dist_addr: string | null;
  dist_port: number | null;
  options: string | null;
}

export function overrideRow(ov: NodeOverride): OverrideRow {
  const patch: Record<string, unknown> = {};
  let distAddr: string | null = null;
  let distPort: number | null = null;
  if (ov.targets !== undefined && ov.targets.length > 0) {
    patch.targets = ov.targets;
    patch.balance = ov.balance && ov.balance !== DEFAULT_BALANCE ? ov.balance : null;
    patch.health_check = ov.healthCheck ?? null;
    distAddr = '';
    distPort = 0;
  } else if (ov.distAddr !== undefined) {
    // グループのルールが複数の宛先でも、このノードは 1 つの転送先
    patch.targets = null;
    patch.balance = null;
    patch.health_check = null;
    distAddr = ov.distAddr;
    distPort = ov.distPort ?? null;
  }
  if (ov.allowFrom !== undefined) patch.allow_from = ov.allowFrom;
  if (ov.extraListenAddrs !== undefined) patch.extra_listen_addrs = ov.extraListenAddrs;
  if (ov.enabled === false) patch.enabled = false;
  return {
    src_addr: ov.srcAddr ?? null,
    dist_addr: distAddr,
    dist_port: distPort,
    options: Object.keys(patch).length > 0 ? JSON.stringify(patch) : null,
  };
}

export function overrideFromRow(row: { src_addr?: unknown; dist_addr?: unknown; dist_port?: unknown; options?: unknown }): NodeOverride {
  let patch: Record<string, unknown> = {};
  if (typeof row.options === 'string' && row.options.trim() !== '') patch = JSON.parse(row.options);
  else if (typeof row.options === 'object' && row.options !== null) patch = row.options as Record<string, unknown>;
  const ov: NodeOverride = {};
  if (typeof row.src_addr === 'string' && row.src_addr !== '') ov.srcAddr = row.src_addr;
  if (Array.isArray(patch.extra_listen_addrs)) ov.extraListenAddrs = patch.extra_listen_addrs as string[];
  if (Array.isArray(patch.targets) && patch.targets.length > 0) {
    ov.targets = patch.targets as Target[];
    ov.balance = (typeof patch.balance === 'string' ? patch.balance : DEFAULT_BALANCE) as Balance;
    ov.healthCheck = (patch.health_check ?? null) as HealthCheck | null;
  } else if (typeof row.dist_addr === 'string' && row.dist_addr !== '' && row.dist_port !== null && row.dist_port !== undefined) {
    ov.distAddr = row.dist_addr;
    ov.distPort = Number(row.dist_port);
  }
  if (Array.isArray(patch.allow_from)) ov.allowFrom = patch.allow_from as string[];
  if (patch.enabled === false) ov.enabled = false;
  return ov;
}

// エクスポートの形（rproxy の項目の名前。UI のエクスポートだけの項目 overrides の中身）
export function toSettingsOverride(ov: NodeOverride): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ov.srcAddr !== undefined) out.listen_addr = ov.srcAddr;
  if (ov.extraListenAddrs !== undefined) out.extra_listen_addrs = ov.extraListenAddrs;
  if (ov.distAddr !== undefined) {
    out.remote_addr = ov.distAddr;
    out.remote_port = ov.distPort;
  }
  if (ov.targets !== undefined) {
    out.targets = ov.targets;
    if (ov.balance && ov.balance !== DEFAULT_BALANCE) out.balance = ov.balance;
    if (ov.healthCheck) out.health_check = ov.healthCheck;
  }
  if (ov.allowFrom !== undefined) out.allow_from = ov.allowFrom;
  if (ov.enabled === false) out.enabled = false;
  return out;
}

const SETTINGS_MAP: Record<string, keyof NodeOverride> = {
  listen_addr: 'srcAddr',
  extra_listen_addrs: 'extraListenAddrs',
  remote_addr: 'distAddr',
  remote_port: 'distPort',
  targets: 'targets',
  balance: 'balance',
  health_check: 'healthCheck',
  allow_from: 'allowFrom',
  enabled: 'enabled',
};

// エクスポートの overrides（{ノード: {rproxy の項目}}）を API の形に直す。値の検証は normalizeOverride
export function settingsOverridesToBody(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('overrides は {ノード名: 上書き} のオブジェクトで書いてください。');
  const out: Record<string, Record<string, unknown>> = {};
  for (const [node, ov] of Object.entries(value)) {
    if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) throw invalid(`overrides.${node} の形式が不正です。`);
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ov)) {
      const to = SETTINGS_MAP[k];
      if (to === undefined) throw invalid(`overrides.${node} に上書きできない項目があります: ${k}`);
      body[to] = v;
    }
    out[node] = body;
  }
  return out;
}

// 2 つの上書きの一覧が同じか（置き換えで作り直しが要るか）
export function sameOverrides(a: Overrides | undefined, b: Overrides | undefined): boolean {
  const norm = (o: Overrides | undefined) => JSON.stringify(Object.keys(o ?? {}).sort().map((k) => [k, overrideRow((o ?? {})[k])]));
  return norm(a) === norm(b);
}

// 画面の宛先の欄（1 行に「アドレス:ポート [重み] [backup]」。IPv6 は [::1]:80）
export function parseTargetsText(text: string): Target[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((line) => {
    const [hostPort, ...rest] = line.split(/\s+/);
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(hostPort) ?? /^([^:\s]+):(\d+)$/.exec(hostPort);
    if (!m) throw invalid(`宛先は「アドレス:ポート」で書いてください: ${line}`);
    const t: Target = { addr: m[1], port: Number(m[2]) };
    for (const r of rest) {
      if (r === 'backup') t.backup = true;
      else if (/^\d+$/.test(r)) t.weight = Number(r);
      else throw invalid(`宛先の後ろには重み（数）か backup を書いてください: ${line}`);
    }
    return t;
  });
}

export function formatTargetsText(targets: Target[]): string {
  return targets.map((t) => [
    t.addr.includes(':') ? `[${t.addr}]:${t.port}` : `${t.addr}:${t.port}`,
    ...(t.weight !== undefined && t.weight !== 1 ? [String(t.weight)] : []),
    ...(t.backup ? ['backup'] : []),
  ].join(' ')).join('\n');
}
