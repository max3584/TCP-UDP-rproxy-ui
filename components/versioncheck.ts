// 各ノードの rproxy-api の版を GET /capabilities で確かめる（#106）。サーバ側だけで使う
import { getCapabilities, withNode } from './rproxy';
import { loadNodes, toRproxyNode, type NodesConfig } from './nodes';
import {
  KNOWN_RPROXY_MINOR,
  MIN_RPROXY_VERSION,
  UI_VERSION,
  versionLabel,
  versionStatus,
  type NodeVersion,
  type VersionsView,
} from './version';

// 1 台に聞く。問い合わせできなければ reachable: false（理由は error）
async function probe(fetchCaps: () => Promise<{ version?: unknown }>, name: string): Promise<NodeVersion & { error?: string }> {
  try {
    const caps = await fetchCaps();
    const version = typeof caps.version === 'string' ? caps.version : null;
    return { name: name, version: version, reachable: true, status: versionStatus(version, true) };
  } catch (err) {
    return { name: name, version: null, reachable: false, status: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }
}

// ノードごとの版（設定ファイルの順）。RPROXY_UI_NODES がなければ RPROXY_API_URL の 1 台（名前は default）
export async function checkVersions(config: NodesConfig = loadNodes()): Promise<(NodeVersion & { error?: string })[]> {
  if (!config.configured) return [await probe(() => getCapabilities(), config.nodes[0].name)];
  return Promise.all(config.nodes.map((n) => probe(() => withNode(toRproxyNode(n), () => getCapabilities()), n.name)));
}

// 画面に渡す形（エラーの文は出さない。接続できないことはダッシュボードの別の表示で分かる）
export async function versionsView(config?: NodesConfig): Promise<VersionsView> {
  const nodes = await checkVersions(config);
  return {
    ui: UI_VERSION,
    minimum: MIN_RPROXY_VERSION,
    knownMinor: KNOWN_RPROXY_MINOR,
    nodes: nodes.map((n) => ({ name: n.name, version: n.version, reachable: n.reachable, status: n.status })),
  };
}

// ログの 1 行（ノードごと）
export function versionLogLine(n: NodeVersion & { error?: string }): { level: 'info' | 'warn'; message: string } {
  const label = versionLabel(n.version) ?? 'unknown';
  switch (n.status) {
    case 'ok':
      return { level: 'info', message: `rproxy-ui: node ${n.name}: rproxy-api ${label}` };
    case 'old':
      return { level: 'warn', message: `rproxy-ui: node ${n.name}: rproxy-api ${label} is older than v${MIN_RPROXY_VERSION}, the oldest this UI supports; upgrade rproxy-api` };
    case 'unknown':
      return { level: 'warn', message: `rproxy-ui: node ${n.name}: rproxy-api does not report its version (older than v0.3.18?); this UI needs v${MIN_RPROXY_VERSION} or later` };
    case 'newer':
      return { level: 'info', message: `rproxy-ui: node ${n.name}: rproxy-api ${label} is a newer minor than this UI knows (${KNOWN_RPROXY_MINOR}.x); settings it added may not be shown` };
    default:
      return { level: 'warn', message: `rproxy-ui: node ${n.name}: could not check the rproxy-api version: ${n.error ?? 'unreachable'}` };
  }
}

// 起動時に各ノードの版をログに出す。失敗しても投げない（起動を止めない）
export async function logVersions(log: { info: (m: string) => void; warn: (m: string) => void } = { info: console.log, warn: console.warn }): Promise<void> {
  try {
    log.info(`rproxy-ui: v${UI_VERSION || 'unknown'} (needs rproxy-api v${MIN_RPROXY_VERSION} or later)`);
    for (const n of await checkVersions()) {
      const line = versionLogLine(n);
      log[line.level](line.message);
    }
  } catch (err) {
    log.warn(`rproxy-ui: could not check the rproxy-api versions: ${err instanceof Error ? err.message : String(err)}`);
  }
}
