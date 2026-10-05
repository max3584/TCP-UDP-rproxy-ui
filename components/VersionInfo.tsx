// UI と各ノードの rproxy-api の版の表示（#106）。サイドバーの下（SidebarVersions）と、
// ダッシュボードの注意（VersionNotice）・ノードごとの版の一覧（VersionsCard）
import { useEffect, useState } from 'react';
import { UI_VERSION, issueLevel, versionIssues, versionLabel, type NodeVersion, type VersionsView } from './version';

// 取得した結果は少しの間使い回す（サイドバーとダッシュボードが同時に聞くため。画面を移るたびに聞き直さない）
const CACHE_MS = 60_000;
let cache: { at: number; promise: Promise<VersionsView | null> } | null = null;

function fetchVersions(): Promise<VersionsView | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.promise;
  const promise = fetch('/api/forward/versions')
    .then(async (res) => (res.ok ? ((await res.json()) as VersionsView) : null))
    .catch(() => null);
  cache = { at: Date.now(), promise: promise };
  // 失敗したら次は聞き直す
  void promise.then((v) => {
    if (v === null && cache?.promise === promise) cache = null;
  });
  return promise;
}

// サインインしていない・取得できないときは null（UI の版だけを出す）
function useVersions(): VersionsView | null {
  const [view, setView] = useState<VersionsView | null>(null);
  useEffect(() => {
    let alive = true;
    // await の後でだけ state を変える
    void fetchVersions().then((v) => {
      if (alive) setView(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return view;
}

const VersionText: React.FC<{ version: string | null; testId?: string }> = ({ version, testId }) => {
  const label = versionLabel(version);
  return <span className="font-mono" data-testid={testId}>{label ?? '不明'}</span>;
};

// サイドバー（狭い幅ではメニュー）の下。暗い背景なので文字は gray-300
export const SidebarVersions: React.FC = () => {
  const view = useVersions();
  const nodes = view?.nodes ?? [];
  return (
    <div data-testid="sidebar-versions" className="mt-4 pt-4 border-t border-gray-700 text-xs text-gray-300 space-y-1 break-words">
      <p>UI <VersionText version={view?.ui || UI_VERSION} testId="ui-version" /></p>
      {nodes.length === 1 && (
        <p>rproxy-api <VersionText version={nodes[0].version} testId="rproxy-version" /></p>
      )}
      {nodes.length > 1 && (
        <>
          <p>rproxy-api</p>
          <ul className="space-y-0.5 pl-2">
            {nodes.map((n) => (
              <li key={n.name}><span className="font-mono">{n.name}</span>: <VersionText version={n.version} testId="rproxy-version" /></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

function issueText(n: NodeVersion, view: VersionsView): string {
  const label = versionLabel(n.version) ?? '';
  if (n.status === 'old') return `rproxy-api ${label} は、この UI が必要とする最小の版 v${view.minimum} より古いです。rproxy-api を更新してください。`;
  if (n.status === 'newer') return `rproxy-api ${label} は、この UI が知らない新しいマイナーの版です（この UI は ${view.knownMinor}.x まで）。新しい設定は画面に出ないことがあります。`;
  return `rproxy-api の版が分かりません（v0.3.18 より前の rproxy-api は版を返しません）。この UI には v${view.minimum} 以降が必要です。`;
}

// ダッシュボードの注意：最小の版より古い・版が分からない（注意）、UI が知らない新しいマイナー（知らせるだけ）
export const VersionNotice: React.FC = () => {
  const view = useVersions();
  if (!view) return null;
  const level = issueLevel(view.nodes);
  if (!level) return null;
  const issues = versionIssues(view.nodes);
  const many = view.nodes.length > 1;
  const colors = level === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-300 bg-blue-50 text-blue-900';
  return (
    <div role="status" data-testid="version-notice" data-level={level} className={`rounded border px-4 py-3 text-sm space-y-1 ${colors}`}>
      <p className="font-semibold">rproxy-api の版の組み合わせ</p>
      <ul className="space-y-1">
        {issues.map((n) => (
          <li key={n.name} className="break-words">
            {many && <span className="font-mono">{n.name}: </span>}
            {issueText(n, view)}
          </li>
        ))}
      </ul>
    </div>
  );
};

const STATUS_TEXT: Record<NodeVersion['status'], { text: string; className: string }> = {
  ok: { text: '対応しています', className: 'text-green-800' },
  old: { text: '古い版です', className: 'text-red-800 font-semibold' },
  unknown: { text: '版が分かりません', className: 'text-amber-900' },
  newer: { text: '新しいマイナー', className: 'text-blue-900' },
  unreachable: { text: '接続できません', className: 'text-red-800' },
};

// ノードの一覧（ノードが 2 つ以上のダッシュボードの「全体」）の rproxy-api の欄
export const NodeVersionCell: React.FC<{ name: string }> = ({ name }) => {
  const view = useVersions();
  const node = view?.nodes.find((n) => n.name === name);
  if (!node) return <span className="text-gray-700">-</span>;
  return (
    <>
      <VersionText version={node.version} testId="node-rproxy-version" />
      {node.status !== 'ok' && node.status !== 'unreachable' && (
        <div className={`text-xs ${STATUS_TEXT[node.status].className}`}>{STATUS_TEXT[node.status].text}</div>
      )}
    </>
  );
};

// ダッシュボードの下（ノードが 1 つのとき）：UI の版と、rproxy-api の版
export const VersionsCard: React.FC = () => {
  const view = useVersions();
  if (!view) return null;
  return (
    <section className="card" aria-labelledby="card-versions" data-testid="versions-card">
      <h2 id="card-versions" className="card-title p-4 pb-2">バージョン</h2>
      <p className="px-4 pb-2 text-sm text-gray-700">
        UI <span className="font-mono text-gray-900">{versionLabel(view.ui) ?? '不明'}</span>
        <span className="ml-3">{`必要な rproxy-api: v${view.minimum} 以降`}</span>
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="sr-only">ノードごとの rproxy-api の版</caption>
          <thead>
            <tr>
              <th scope="col">ノード</th>
              <th scope="col">rproxy-api</th>
              <th scope="col">状態</th>
            </tr>
          </thead>
          <tbody>
            {view.nodes.map((n) => (
              <tr key={n.name}>
                <td className="font-mono text-gray-900">{n.name}</td>
                <td className="text-gray-900"><VersionText version={n.version} testId="node-rproxy-version" /></td>
                <td className={STATUS_TEXT[n.status].className}>{STATUS_TEXT[n.status].text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
