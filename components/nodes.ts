// 複数の rproxy（ノード）とグループの設定（#98）。サーバ側だけで使う。
// RPROXY_UI_NODES に YAML / JSON のファイルを指定すると、そのノードとグループを使う。
// 指定しなければ今までどおり RPROXY_API_URL / RPROXY_API_TOKEN の 1 台だけ（名前は default。DB の target 列は使わない）
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { RproxyNode } from './rproxy';
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
}

export interface GroupConfig {
  name: string;
  nodes: string[];
  // single: 全員に同じルールを送るだけ / active_standby: 同じ（役割の表示は後の版。#98）
  mode: GroupMode;
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
const NODE_KEYS = ['name', 'url', 'token_file'];
const GROUP_KEYS = ['name', 'nodes', 'mode'];

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
    if (raw.token_file === undefined || raw.token_file === null) return { name: name, url: url };
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
    return { name: name, url: url, tokenFile: tokenFile, token: token };
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
    return { name: name, nodes: members, mode: mode as GroupMode };
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

// RPROXY_UI_NODES がないとき：RPROXY_API_URL / RPROXY_API_TOKEN の 1 台（環境変数は毎回読む）
export function implicitConfig(): NodesConfig {
  return {
    configured: false,
    nodes: [{ name: DEFAULT_NODE, url: process.env.RPROXY_API_URL ?? '', token: process.env.RPROXY_API_TOKEN || undefined }],
    groups: [],
    defaultTarget: DEFAULT_NODE,
  };
}

let cached: { path: string; config: NodesConfig } | null = null;

// 今の設定。ファイルは最初に読んだものを使い回す（変えたら UI を再起動する）。誤りは NodesConfigError
export function loadNodes(): NodesConfig {
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

// テストで読み直すため
export function resetNodesCache(): void {
  cached = null;
}

export function isGroup(config: NodesConfig, name: string): boolean {
  return config.groups.some((g) => g.name === name);
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
  return { name: node.name, url: node.url, ...(node.token !== undefined ? { token: node.token } : {}) };
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
  for (const n of config.nodes) {
    rows.push({ node: n.name, target: n.name });
    for (const g of config.groups) if (g.nodes.includes(n.name)) rows.push({ node: n.name, target: g.name });
  }
  return rows;
}

// 画面に渡す形（URL とトークンは出さない）
export function nodesInfo(config: NodesConfig): NodesInfo {
  return {
    configured: config.configured,
    nodes: config.nodes.map((n) => ({ name: n.name })),
    groups: config.groups.map((g) => ({ name: g.name, mode: g.mode, nodes: [...g.nodes] })),
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
