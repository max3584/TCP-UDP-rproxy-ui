// UI と rproxy-api の版の組み合わせ（#106）。React にも rproxy のクライアントにも依存しない（画面とサーバの両方で使う）。
// UI と rproxy-api のバージョン番号は別々に進める（docs/RELEASING.md）。機能ごとの細かい判断は今までどおり GET /capabilities の features

// この UI の版（package.json。next.config.mjs がビルドのときに埋め込む）
export const UI_VERSION: string = process.env.RPROXY_UI_VERSION ?? '';

// この UI が動く一番古い rproxy-api。一時停止（DB の options.enabled: false）を rproxy が読めるのが v0.3.5 から
// （それより前の rproxy は知らないキーとして行を拒否する）。それより新しい機能は features や項目の有無で確かめて使う。
// 新しい rproxy-api の機能が要るようになったら上げ、UI のリリースノートに書く
export const MIN_RPROXY_VERSION = '0.3.5';

// この UI が知っている rproxy-api のマイナー（これより新しいマイナーは、知らない形があるかもしれないので知らせるだけ）
export const KNOWN_RPROXY_MINOR = '0.4';

// ok: 問題なし / old: MIN_RPROXY_VERSION より古い / unknown: 版を返さない（v0.3.18 より前の rproxy-api）か読めない
// newer: UI が知らない新しいマイナー（知らせるだけ） / unreachable: rproxy に問い合わせできない（接続の表示は別にある）
export type VersionStatus = 'ok' | 'old' | 'unknown' | 'newer' | 'unreachable';

export interface NodeVersion {
  name: string;
  // GET /capabilities の version（返さない・問い合わせできないときは null）
  version: string | null;
  reachable: boolean;
  status: VersionStatus;
}

export interface VersionsView {
  ui: string;
  minimum: string;
  knownMinor: string;
  nodes: NodeVersion[];
}

// "0.3.18"・"v0.3.18"・"0.3.18-rc.1" を [0, 3, 18] に。読めなければ null
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// a < b なら負、同じなら 0、a > b なら正（どちらも読める版であること）
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function versionStatus(
  version: unknown,
  reachable: boolean,
  minimum: string = MIN_RPROXY_VERSION,
  knownMinor: string = KNOWN_RPROXY_MINOR,
): VersionStatus {
  if (!reachable) return 'unreachable';
  const v = parseVersion(version);
  if (!v) return 'unknown';
  const min = parseVersion(minimum);
  if (min && compareVersions(v, min) < 0) return 'old';
  const known = parseVersion(`${knownMinor}.0`);
  if (known && (v[0] > known[0] || (v[0] === known[0] && v[1] > known[1]))) return 'newer';
  return 'ok';
}

// ダッシュボードで知らせるノード（old・unknown・newer。問い合わせできないノードは接続の表示に任せる）
export function versionIssues(nodes: NodeVersion[]): NodeVersion[] {
  return nodes.filter((n) => n.status === 'old' || n.status === 'unknown' || n.status === 'newer');
}

// 注意か、知らせるだけか（newer だけなら知らせるだけ）
export function issueLevel(nodes: NodeVersion[]): 'warning' | 'info' | null {
  const issues = versionIssues(nodes);
  if (issues.length === 0) return null;
  return issues.some((n) => n.status !== 'newer') ? 'warning' : 'info';
}

// 画面とログに出す版（v を付ける。分からなければ null）
export function versionLabel(version: string | null | undefined): string | null {
  return parseVersion(version) ? `v${String(version).trim().replace(/^v/, '')}` : null;
}
