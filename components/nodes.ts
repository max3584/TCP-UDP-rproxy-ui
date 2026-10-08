// 複数の rproxy（ノード）とグループの設定（#98）。サーバ側だけで使う。
// RPROXY_UI_NODES に YAML / JSON のファイルを指定すると、そのノードとグループを使う。
// 指定しなければ今までどおり RPROXY_API_URL / RPROXY_API_TOKEN の 1 台だけ（名前は default。DB の target 列は使わない）
import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ClientTls, RproxyNode } from './rproxy';
import { clearStaleNodes, envApiToken, envClientTls, envClientTlsProblem } from './rproxy';
import type { GroupMode, NodesInfo } from './lib';

// RPROXY_UI_NODES がないときの 1 台の名前（DB の target 列の既定値と同じ）
export const DEFAULT_NODE = 'default';

// ノード・グループの名前。ノードごとのデータベース（rproxy_node_<名前>）と DB ユーザーの名前に使うので、
// 英小文字・数字・_ だけで 32 文字まで（db/node-view.mjs の NAME_PATTERN と同じ）
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

export const GROUP_MODES: GroupMode[] = ['single', 'active_standby'];

export interface NodeConfig {
  name: string;
  // http(s)://host:port か unix:/path（rproxy の RPROXY_API_SOCKET）
  url: string;
  tokenFile?: string;
  // token_file の中身（DB には置かない）
  token?: string;
  // https:// の制御 API のクライアント証明書・秘密鍵・CA（rproxy v0.4 の mTLS、#167。tls_cert・tls_key・tls_ca）
  tls?: ClientTls;
  // 見るだけのノード（Kubernetes の rproxy の Pod。RPROXY_UI_K8S_DISCOVERY）。変更・送り直しは 409 readonly_node、管理者にだけ見せる
  readonly?: boolean;
}

export interface GroupConfig {
  name: string;
  nodes: string[];
  // single: 全員に同じルールを送るだけ / active_standby: 同じルールを送り、VIP を持つノードを act と表示する
  mode: GroupMode;
  // active_standby の VIP（keepalived などが付け外しするアドレス）。空ならルールの待ち受けアドレス（特定のアドレスのとき）で判定する
  vips: string[];
  // active_standby で、ずれたノードに UI が自動で送り直すか（既定 true。false ならずれの表示だけ。#109）
  autoResend: boolean;
  // 見るだけのグループ（Kubernetes の Gateway の rproxy。RPROXY_UI_K8S_DISCOVERY）
  readonly?: boolean;
}

export interface NodesConfig {
  // RPROXY_UI_NODES のファイルを使っているか（false なら RPROXY_API_URL の 1 台で、DB の target 列を使わない）
  configured: boolean;
  nodes: NodeConfig[];
  groups: GroupConfig[];
  // 追加の画面で最初に選ぶもの（ノードかグループの名前）。null なら利用者が選ぶ
  defaultTarget: string | null;
}

export class NodesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodesConfigError';
  }
}

const TOP_KEYS = ['nodes', 'groups', 'default_target'];
const NODE_KEYS = ['name', 'url', 'token_file', 'tls_cert', 'tls_key', 'tls_ca'];
const GROUP_KEYS = ['name', 'nodes', 'mode', 'vip', 'auto_resend'];

// IPv6 は rproxy の GET /interfaces と同じ圧縮表記（小文字）に揃える
export function normalizeIp(addr: string): string {
  return isIP(addr) === 6 ? new URL(`http://[${addr}]`).hostname.slice(1, -1) : addr;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(v: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(v).filter((k) => !allowed.includes(k));
}

function checkName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new NodesConfigError(`${where}.name は英小文字・数字・_ の 32 文字までにしてください（例 node1）。`);
  }
  return value;
}

function checkUrl(value: unknown, where: string): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (/^https?:\/\/[^/\s]+/.test(url)) return url.replace(/\/+$/, '');
  if (/^unix:(\/\/)?\/\S+/.test(url)) return url;
  throw new NodesConfigError(`${where}.url は http://・https://・unix:/ のどれかで始めてください。`);
}

// tls_cert・tls_key・tls_ca（クライアント証明書の mTLS。https:// のときだけ）。ファイルが読めるかも確かめる。readFile は読む関数
export function checkClientTls(raw: Record<string, unknown>, where: string, url: string, readFile: (path: string) => string): ClientTls | undefined {
  const tls: ClientTls = {};
  for (const [key, field] of [['tls_cert', 'cert'], ['tls_key', 'key'], ['tls_ca', 'ca']] as const) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.trim() === '') throw new NodesConfigError(`${where}.${key} にはファイルのパスを書いてください。`);
    try {
      readFile(v.trim());
    } catch (err) {
      throw new NodesConfigError(`${where}.${key}（${v.trim()}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
    }
    tls[field] = v.trim();
  }
  if (Object.keys(tls).length === 0) return undefined;
  if (!url.startsWith('https://')) throw new NodesConfigError(`${where}: tls_cert・tls_key・tls_ca は https:// の url でだけ使えます。`);
  if ((tls.cert === undefined) !== (tls.key === undefined)) throw new NodesConfigError(`${where}: tls_cert と tls_key は両方書いてください。`);
  return tls;
}

// 設定ファイルの中身を確かめて読む。readToken は token_file を読む関数（テストで差し替える）
export function parseNodesConfig(text: string, readToken: (path: string) => string): NodesConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new NodesConfigError(`YAML / JSON として読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(doc)) throw new NodesConfigError('nodes と groups を持つオブジェクトにしてください。');
  const extraTop = unknownKeys(doc, TOP_KEYS);
  if (extraTop.length > 0) throw new NodesConfigError(`知らない項目があります: ${extraTop.join(', ')}`);

  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) throw new NodesConfigError('nodes にノードを 1 つ以上書いてください。');
  const names = new Set<string>();
  const nodes = doc.nodes.map((raw, i): NodeConfig => {
    const where = `nodes[${i}]`;
    if (!isObject(raw)) throw new NodesConfigError(`${where} は name・url・token_file を持つオブジェクトにしてください。`);
    const extra = unknownKeys(raw, NODE_KEYS);
    if (extra.length > 0) throw new NodesConfigError(`${where} に知らない項目があります: ${extra.join(', ')}`);
    const name = checkName(raw.name, where);
    if (names.has(name)) throw new NodesConfigError(`名前 ${name} が重なっています（ノードとグループの名前はすべて別にしてください）。`);
    names.add(name);
    const url = checkUrl(raw.url, where);
    const tls = checkClientTls(raw, where, url, readToken);
    if (raw.token_file === undefined || raw.token_file === null) return { name: name, url: url, ...(tls ? { tls: tls } : {}) };
    if (typeof raw.token_file !== 'string' || raw.token_file.trim() === '') {
      throw new NodesConfigError(`${where}.token_file にはファイルのパスを書いてください。`);
    }
    const tokenFile = raw.token_file.trim();
    let token: string;
    try {
      token = readToken(tokenFile).trim();
    } catch (err) {
      throw new NodesConfigError(`${where}.token_file（${tokenFile}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (token === '') throw new NodesConfigError(`${where}.token_file（${tokenFile}）が空です。`);
    return { name: name, url: url, tokenFile: tokenFile, token: token, ...(tls ? { tls: tls } : {}) };
  });

  const nodeNames = new Set(nodes.map((n) => n.name));
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawGroups)) throw new NodesConfigError('groups はグループの配列にしてください。');
  const groups = rawGroups.map((raw, i): GroupConfig => {
    const where = `groups[${i}]`;
    if (!isObject(raw)) throw new NodesConfigError(`${where} は name・nodes・mode を持つオブジェクトにしてください。`);
    const extra = unknownKeys(raw, GROUP_KEYS);
    if (extra.length > 0) throw new NodesConfigError(`${where} に知らない項目があります: ${extra.join(', ')}`);
    const name = checkName(raw.name, where);
    if (names.has(name)) throw new NodesConfigError(`名前 ${name} が重なっています（ノードとグループの名前はすべて別にしてください）。`);
    names.add(name);
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new NodesConfigError(`${where}.nodes にノードの名前を 1 つ以上書いてください。`);
    const members: string[] = [];
    for (const m of raw.nodes) {
      if (typeof m !== 'string' || !nodeNames.has(m)) throw new NodesConfigError(`${where}.nodes の ${String(m)} は nodes にありません。`);
      if (members.includes(m)) throw new NodesConfigError(`${where}.nodes に ${m} が 2 回あります。`);
      members.push(m);
    }
    const mode = raw.mode ?? 'single';
    if (!GROUP_MODES.includes(mode as GroupMode)) throw new NodesConfigError(`${where}.mode は single か active_standby にしてください。`);
    if (mode === 'active_standby' && members.length < 2) throw new NodesConfigError(`${where}: active_standby のグループにはノードを 2 つ以上書いてください。`);
    const rawVip = raw.vip ?? [];
    const vipList = Array.isArray(rawVip) ? rawVip : [rawVip];
    const vips = vipList.map((v) => {
      if (typeof v !== 'string' || isIP(v.trim()) === 0) throw new NodesConfigError(`${where}.vip には IP アドレス（または IP アドレスの配列）を書いてください。`);
      return normalizeIp(v.trim());
    });
    if (vips.length > 0 && mode !== 'active_standby') throw new NodesConfigError(`${where}.vip は active_standby のグループにだけ書けます。`);
    if (raw.auto_resend !== undefined && typeof raw.auto_resend !== 'boolean') throw new NodesConfigError(`${where}.auto_resend は true か false にしてください。`);
    return { name: name, nodes: members, mode: mode as GroupMode, vips: vips, autoResend: raw.auto_resend !== false };
  });

  let defaultTarget: string | null = null;
  if (doc.default_target !== undefined && doc.default_target !== null) {
    if (typeof doc.default_target !== 'string' || !names.has(doc.default_target)) {
      throw new NodesConfigError('default_target はノードかグループの名前にしてください。');
    }
    defaultTarget = doc.default_target;
  } else if (nodes.length === 1 && groups.length === 0) {
    defaultTarget = nodes[0].name;
  }
  return { configured: true, nodes: nodes, groups: groups, defaultTarget: defaultTarget };
}

// RPROXY_API_TOKEN（なければ RPROXY_API_TOKEN_FILE）。読めなければ付けない（問い合わせが 401 になり、起動時の確認がログに出す）
function implicitToken(): string | undefined {
  try {
    return envApiToken() || undefined;
  } catch {
    return undefined;
  }
}

// RPROXY_UI_NODES がないとき：RPROXY_API_URL / RPROXY_API_TOKEN（RPROXY_API_TOKEN_FILE）の 1 台（環境変数は毎回読む）
export function implicitConfig(): NodesConfig {
  return {
    configured: false,
    nodes: [{ name: DEFAULT_NODE, url: process.env.RPROXY_API_URL ?? '', token: implicitToken(), ...(envClientTls() ? { tls: envClientTls() } : {}) }],
    groups: [],
    defaultTarget: DEFAULT_NODE,
  };
}

let cached: { path: string; config: NodesConfig } | null = null;

// RPROXY_UI_NODES のファイル（なければ RPROXY_API_URL の 1 台）。ファイルは最初に読んだものを使い回す（変えたら UI を再起動する）
function loadBaseNodes(): NodesConfig {
  const path = (process.env.RPROXY_UI_NODES ?? '').trim();
  if (path === '') return implicitConfig();
  if (cached?.path === path) return cached.config;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new NodesConfigError(`RPROXY_UI_NODES（${path}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  let config: NodesConfig;
  try {
    config = parseNodesConfig(text, (p) => readFileSync(p, 'utf8'));
  } catch (err) {
    throw new NodesConfigError(`RPROXY_UI_NODES（${path}）: ${err instanceof Error ? err.message : String(err)}`);
  }
  cached = { path: path, config: config };
  return config;
}

// ---- Kubernetes の rproxy（rproxy-gateway が UI の namespace に書く Secret rproxy-ui-discovery。RPROXY_UI_K8S_DISCOVERY） ----
// rproxy-gateway の docs/DESIGN-v0.4.x.md 4.。ディレクトリ（Secret のボリューム）の nodes.yaml に、見せてよい Gateway の rproxy の Pod
// （名前 k8s:<namespace>/<Gateway>/<Pod>、グループ k8s:<namespace>/<Gateway>）と、読むだけのトークン（rules:read・metrics:read）のファイル・
// 制御 API の CA の名前がある。すべて見るだけ（readonly）で、管理者にだけ見せる。中身はコントローラが書き換える（Pod の入れ替え）ので、
// nodes.yaml の更新時刻が変われば読み直す（kubelet は Secret のファイルをまとめて入れ替える）

export const K8S_PREFIX = 'k8s:';
// usage_counters・usage_hourly の node 列（VARCHAR(255)）に入る長さ
const K8S_NAME_MAX = 255;

export interface K8sDiscovery {
  nodes: NodeConfig[];
  groups: GroupConfig[];
}

const EMPTY_DISCOVERY: K8sDiscovery = { nodes: [], groups: [] };

// ディレクトリの中のファイルの名前（相対で、.. や / を含まない）。外のファイルを読ませない
function discoveryFile(dir: string, value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.includes('/') || value.includes('\\') || value.startsWith('.')) {
    throw new NodesConfigError(`${where} はディレクトリの中のファイルの名前にしてください。`);
  }
  return normalize(join(dir, value));
}

function k8sName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.startsWith(K8S_PREFIX) || value.length > K8S_NAME_MAX || /[\s\u0000-\u001f]/.test(value)) {
    throw new NodesConfigError(`${where}.name は ${K8S_PREFIX} で始まる ${K8S_NAME_MAX} 文字までの名前にしてください。`);
  }
  return value;
}

// nodes.yaml の中身を読む（readFile はディレクトリの中のファイルを読む関数。テストで差し替える）。
// コントローラの新しい版が足した項目は無視する（RPROXY_UI_NODES と違い、手で書くファイルではない）
export function parseDiscovery(text: string, dir: string, readFile: (path: string) => string): K8sDiscovery {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new NodesConfigError(`YAML として読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) return EMPTY_DISCOVERY;
  if (!isObject(doc)) throw new NodesConfigError('nodes と groups を持つオブジェクトにしてください。');
  const rawNodes = doc.nodes ?? [];
  const rawGroups = doc.groups ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawGroups)) throw new NodesConfigError('nodes と groups は配列にしてください。');
  const names = new Set<string>();
  const tokens = new Map<string, string>();
  const nodes = rawNodes.map((raw, i): NodeConfig => {
    const where = `nodes[${i}]`;
    if (!isObject(raw)) throw new NodesConfigError(`${where} はオブジェクトにしてください。`);
    const name = k8sName(raw.name, where);
    if (names.has(name)) throw new NodesConfigError(`名前 ${name} が重なっています。`);
    names.add(name);
    const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : '';
    if (!/^https:\/\/[^/\s]+$/.test(url)) throw new NodesConfigError(`${where}.url は https://<アドレス>:<ポート> にしてください。`);
    const servername = raw.tls_server_name;
    if (typeof servername !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(servername)) {
      throw new NodesConfigError(`${where}.tls_server_name は DNS の名前にしてください。`);
    }
    const ca = discoveryFile(dir, raw.tls_ca, `${where}.tls_ca`);
    try {
      readFile(ca);
    } catch (err) {
      throw new NodesConfigError(`${where}.tls_ca（${ca}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tokenFile = discoveryFile(dir, raw.token_file, `${where}.token_file`);
    let token = tokens.get(tokenFile);
    if (token === undefined) {
      try {
        token = readFile(tokenFile).trim();
      } catch (err) {
        throw new NodesConfigError(`${where}.token_file（${tokenFile}）を読めません: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (token === '') throw new NodesConfigError(`${where}.token_file（${tokenFile}）が空です。`);
      tokens.set(tokenFile, token);
    }
    return { name: name, url: url, tokenFile: tokenFile, token: token, tls: { ca: ca, servername: servername }, readonly: true };
  });
  const groups: GroupConfig[] = [];
  rawGroups.forEach((raw, i) => {
    const where = `groups[${i}]`;
    if (!isObject(raw)) throw new NodesConfigError(`${where} はオブジェクトにしてください。`);
    const name = k8sName(raw.name, where);
    if (names.has(name)) throw new NodesConfigError(`名前 ${name} が重なっています。`);
    names.add(name);
    if (!Array.isArray(raw.nodes)) throw new NodesConfigError(`${where}.nodes はノードの名前の配列にしてください。`);
    const members: string[] = [];
    for (const m of raw.nodes) {
      if (typeof m !== 'string' || !nodes.some((n) => n.name === m)) throw new NodesConfigError(`${where}.nodes の ${String(m)} は nodes にありません。`);
      if (!members.includes(m)) members.push(m);
    }
    // Pod がまだないグループは出さない
    if (members.length > 0) groups.push({ name: name, nodes: members, mode: 'single', vips: [], autoResend: false, readonly: true });
  });
  return { nodes: nodes, groups: groups };
}

interface DiscoveryState {
  dir: string;
  // nodes.yaml の更新時刻（読めなければ 0）
  mtime: number;
  value: K8sDiscovery;
  // 読めなかった・誤りがあった理由（同じ誤りは 1 回だけログに出す）
  error: string | null;
}

let discoveryCache: DiscoveryState | null = null;

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// RPROXY_UI_K8S_DISCOVERY のディレクトリの nodes.yaml。なければ・読めなければ空（Secret はコントローラが消すことがある。
// 誤りで UI を止めず、ログに出して前に読めた内容も使わない：古い Pod の IP に聞き続けないため）
export function loadDiscovery(): K8sDiscovery {
  const dir = (process.env.RPROXY_UI_K8S_DISCOVERY ?? '').trim();
  if (dir === '') return EMPTY_DISCOVERY;
  const file = join(dir, 'nodes.yaml');
  const at = mtimeOf(file);
  if (discoveryCache?.dir === dir && discoveryCache.mtime === at) return discoveryCache.value;
  let value = EMPTY_DISCOVERY;
  let error: string | null = null;
  if (at !== 0) {
    try {
      value = parseDiscovery(readFileSync(file, 'utf8'), dir, (p) => readFileSync(p, 'utf8'));
    } catch (err) {
      error = `RPROXY_UI_K8S_DISCOVERY（${file}）: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (error !== null && error !== discoveryCache?.error) console.warn(`rproxy-ui: ${error}`);
  else if (error === null && (discoveryCache?.dir !== dir || JSON.stringify(names(discoveryCache.value)) !== JSON.stringify(names(value)))) {
    console.log(`rproxy-ui: Kubernetes の rproxy（見るだけ）: ${value.nodes.length} 台（${value.groups.map((g) => g.name).join(', ') || '-'}）`);
  }
  discoveryCache = { dir: dir, mtime: at, value: value, error: error };
  // 401 を返したノードを、新しい内容でもう一度聞く
  clearStaleNodes();
  return value;
}

function names(d: K8sDiscovery): string[] {
  return [...d.nodes.map((n) => n.name), ...d.groups.map((g) => g.name)];
}

// RPROXY_UI_NODES（または RPROXY_API_URL）の設定に、Kubernetes の rproxy（見るだけ）を足す。
// Kubernetes の rproxy がなければ今までと同じ設定。RPROXY_UI_NODES も RPROXY_API_URL もなければ Kubernetes の rproxy だけ
export function withDiscovery(base: NodesConfig, k8s: K8sDiscovery, hasApiUrl: boolean): NodesConfig {
  if (k8s.nodes.length === 0) return base;
  const own = base.configured || hasApiUrl ? base.nodes : [];
  const taken = new Set([...own.map((n) => n.name), ...base.groups.map((g) => g.name)]);
  const nodes = k8s.nodes.filter((n) => !taken.has(n.name));
  const groups = k8s.groups.filter((g) => !taken.has(g.name) && g.nodes.every((m) => nodes.some((n) => n.name === m)));
  return {
    configured: true,
    nodes: [...own, ...nodes],
    groups: [...base.groups, ...groups],
    defaultTarget: own.length > 0 ? base.defaultTarget : null,
  };
}

// 今の設定。RPROXY_UI_NODES の誤りは NodesConfigError（Kubernetes の rproxy の誤りはログに出して使わない）
export function loadNodes(): NodesConfig {
  return withDiscovery(loadBaseNodes(), loadDiscovery(), (process.env.RPROXY_API_URL ?? '').trim() !== '');
}

// テストで読み直すため
export function resetNodesCache(): void {
  cached = null;
  discoveryCache = null;
}

// 見るだけのノード・グループ（Kubernetes の rproxy）か
export function isReadonlyTarget(config: NodesConfig, name: string): boolean {
  return config.nodes.some((n) => n.name === name && n.readonly === true) || config.groups.some((g) => g.name === name && g.readonly === true);
}

// 管理者でない人の設定：見るだけのノード・グループ（Kubernetes の rproxy）を外す（Kubernetes のルールと利用量は管理者だけ。
// rproxy-gateway の docs/DESIGN-v0.4.x.md 10. Q9）。Kubernetes の rproxy しかなければノードのない設定になる
export function visibleNodes(config: NodesConfig, admin: boolean): NodesConfig {
  if (admin || !config.nodes.some((n) => n.readonly === true)) return config;
  return {
    ...config,
    nodes: config.nodes.filter((n) => n.readonly !== true),
    groups: config.groups.filter((g) => g.readonly !== true),
  };
}

// 集計の行（usage_hourly・usage_daily）の node：Kubernetes の Pod は Gateway（そのグループ）にまとめる（レプリカの差分を足す）。
// それ以外はノードの名前（今までと同じ）
export function usageRowNode(config: NodesConfig, node: string): string {
  const n = config.nodes.find((x) => x.name === node);
  if (n?.readonly !== true) return node;
  return config.groups.find((g) => g.readonly === true && g.nodes.includes(node))?.name ?? node;
}

export function isGroup(config: NodesConfig, name: string): boolean {
  return config.groups.some((g) => g.name === name);
}

export function groupOf(config: NodesConfig, name: string): GroupConfig | undefined {
  return config.groups.find((g) => g.name === name);
}

// ノードかグループの名前から、送り先のノード（設定ファイルの順）。知らない名前なら null
export function targetNodes(config: NodesConfig, target: string): NodeConfig[] | null {
  const node = config.nodes.find((n) => n.name === target);
  if (node) return [node];
  const group = config.groups.find((g) => g.name === target);
  if (!group) return null;
  return config.nodes.filter((n) => group.nodes.includes(n.name));
}

// rproxy のクライアントに渡すノード
export function toRproxyNode(node: NodeConfig): RproxyNode {
  return {
    name: node.name, url: node.url, ...(node.token !== undefined ? { token: node.token } : {}), ...(node.tls ? { tls: node.tls } : {}),
    ...(node.readonly ? { readonly: true } : {}),
  };
}

// 2 つのノード／グループに共通のノードがあるか（同じキーのルールを両方に置くと、そのノードで重なる）
export function targetsOverlap(config: NodesConfig, a: string, b: string): boolean {
  if (a === b) return true;
  const na = targetNodes(config, a);
  const nb = targetNodes(config, b);
  if (!na || !nb) return false;
  return na.some((n) => nb.some((m) => m.name === n.name));
}

// forward_rule_targets の行：ノードごとに、そのノードが読むべき target（自分の名前と、自分を含むグループ）
export function membership(config: NodesConfig): { node: string; target: string }[] {
  const rows: { node: string; target: string }[] = [];
  // 見るだけのノード（Kubernetes の rproxy）は UI のルールを置かないので載せない（名前も列の長さを超える）
  for (const n of config.nodes.filter((x) => x.readonly !== true)) {
    rows.push({ node: n.name, target: n.name });
    for (const g of config.groups) if (g.nodes.includes(n.name)) rows.push({ node: n.name, target: g.name });
  }
  return rows;
}

// 画面に渡す形（URL とトークンは出さない）
export function nodesInfo(config: NodesConfig): NodesInfo {
  return {
    configured: config.configured,
    nodes: config.nodes.map((n) => ({ name: n.name, ...(n.readonly ? { readonly: true } : {}) })),
    groups: config.groups.map((g) => ({
      name: g.name, mode: g.mode, nodes: [...g.nodes], ...(g.vips.length > 0 ? { vips: [...g.vips] } : {}),
      ...(g.mode === 'active_standby' ? { autoResend: g.autoResend } : {}),
      ...(g.readonly ? { readonly: true } : {}),
    })),
    defaultTarget: config.defaultTarget,
  };
}

// 1 台だけに聞けばよい問い合わせ（対応機能・インターフェース・設定ファイルの状態）の相手。
// RPROXY_UI_NODES がなければ null（今までどおり RPROXY_API_URL に聞く）。target があればその先頭のノード、
// なければ default_target の先頭のノード、それもなければ最初のノード。知らない名前なら NodesConfigError
export function probeNode(config: NodesConfig, target: string | undefined): RproxyNode | null {
  if (!config.configured) return null;
  const name = target || config.defaultTarget || config.nodes[0].name;
  const nodes = targetNodes(config, name);
  if (!nodes || nodes.length === 0) throw new NodesConfigError(`ノード／グループ ${name} は設定にありません。`);
  return toRproxyNode(nodes[0]);
}

// 起動時の確認（instrumentation.ts）。誤りがあれば理由を出して終了する。
// RPROXY_UI_NODES がなければ RPROXY_API_TLS_* と RPROXY_API_URL の組み合わせだけを確かめる（https でなければ止める）
export function checkNodesAtStartup(): void {
  // Kubernetes の rproxy（見るだけ）：読めた台数・誤りをログに出す（誤りでも止めない。Secret はコントローラが後から書く）
  if ((process.env.RPROXY_UI_K8S_DISCOVERY ?? '').trim() !== '') loadDiscovery();
  const usesFile = (process.env.RPROXY_UI_NODES ?? '').trim() !== '';
  if (!usesFile) {
    const problem = envClientTlsProblem();
    if (problem) {
      console.error(`rproxy-ui: ${problem}`);
      process.exit(1);
      return;
    }
    // RPROXY_API_TOKEN_FILE が読めない・トークンがない（グループ rproxy に入っていないなど）
    try {
      envApiToken();
    } catch (err) {
      console.error(`rproxy-ui: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }
  if (envClientTls()) console.warn('rproxy-ui: RPROXY_UI_NODES があるため RPROXY_API_TLS_* は使いません（ノードごとの tls_cert・tls_key・tls_ca を書いてください）');
  try {
    const config = loadNodes();
    console.log(`rproxy-ui: RPROXY_UI_NODES: nodes ${config.nodes.map((n) => n.name).join(', ')}; groups ${config.groups.map((g) => `${g.name}(${g.nodes.join(',')})`).join(', ') || '-'}`);
  } catch (err) {
    console.error(`rproxy-ui: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
