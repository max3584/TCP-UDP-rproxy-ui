// rproxy の機能と設定（/system）：各ノードの rproxy-api の版、v0.4 の機能の印、設定ファイルの global.performance で効く項目、
// 設定ファイルの状態を読み取り専用で出す。performance・GeoIP のデータベース・制御 API の守りなどは rproxy の設定ファイルと引数で変える（画面からは変えない）
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, errorDetail } from '@/components/ui';
import { PERFORMANCE_KEYS, V04_FEATURES } from '@/components/system';
import type { NodeSystemView } from '@/components/system';

const Yes: React.FC<{ on: boolean }> = ({ on }) => (
  on
    ? <span className="badge bg-green-100 text-green-900 border border-green-300">使える</span>
    : <span className="badge bg-gray-100 text-gray-800 border border-gray-300">使えない</span>
);

const NodeCard: React.FC<{ n: NodeSystemView; many: boolean }> = ({ n, many }) => (
  <section className="card p-4" aria-labelledby={`system-${n.node}`} data-testid="system-node">
    <h2 id={`system-${n.node}`} className="card-title mb-3">
      {many ? <span className="font-mono">{n.node}</span> : 'rproxy-api'}
      {n.version && <span className="ml-2 text-sm font-normal text-gray-700">v{n.version}</span>}
    </h2>
    {!n.reachable ? (
      <p className="text-sm text-red-800">問い合わせできません{n.error ? `: ${n.error}` : ''}</p>
    ) : (
      <div className="space-y-4 text-sm text-gray-900">
        {n.build?.sha256 && (
          <p className="text-xs text-gray-700 break-all">バイナリの SHA-256: <span className="font-mono">{n.build.sha256}</span></p>
        )}
        <div>
          <h3 className="font-semibold mb-1">v0.4 の機能</h3>
          {n.features === null ? (
            <p className="text-gray-700">この rproxy は v0.4 の機能を返しません（rproxy-api v0.4 より前）。</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table" data-testid="system-features">
                <tbody>
                  {V04_FEATURES.map((f) => (
                    <tr key={f.key}>
                      <th scope="row" className="text-left font-normal text-gray-800">{f.label}</th>
                      <td><Yes on={n.features![f.key] === true} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3 className="font-semibold mb-1">performance（設定ファイルの global.performance）</h3>
          {n.performance === null ? (
            <p className="text-gray-700">この rproxy は返しません（rproxy-api v0.4 より前）。</p>
          ) : (
            <ul className="flex flex-wrap gap-1" data-testid="system-performance">
              {PERFORMANCE_KEYS.map((k) => (
                <li key={k} className={`badge font-mono ${n.performance!.includes(k) ? 'bg-green-100 text-green-900' : 'bg-gray-100 text-gray-800'}`}>
                  {k}{n.performance!.includes(k) ? '' : '（環境変数だけ）'}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-gray-600">
            ワーカーの数・UDP のソケットの数・CPU の固定・busy poll・splice は rproxy の設定ファイルか環境変数で決め、再起動まで効きません。画面からは変えられません。
          </p>
        </div>
        <div>
          <h3 className="font-semibold mb-1">設定ファイル</h3>
          {!n.config.readable ? (
            <p className="text-gray-700">読めません（UI のトークンに rules:read がないか、古い rproxy）。</p>
          ) : !n.config.configured ? (
            <p className="text-gray-700">使っていません（RPROXY_CONFIG なし）。</p>
          ) : (
            <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-4 gap-y-1">
              <dt className="text-gray-600">ファイル</dt><dd className="font-mono break-all">{n.config.path ?? '-'}</dd>
              <dt className="text-gray-600">ルールの数</dt><dd>{n.config.rules ?? '-'}</dd>
              <dt className="text-gray-600">再起動が要る変更</dt><dd className="font-mono break-all">{n.config.restartNeeded.length > 0 ? n.config.restartNeeded.join(', ') : '-'}</dd>
              {n.config.error && <><dt className="text-gray-600">誤り</dt><dd className="text-red-800 break-all">{n.config.error}</dd></>}
            </dl>
          )}
        </div>
        <details>
          <summary className="cursor-pointer text-gray-800">使えるミドルウェアとサービスの項目</summary>
          <p className="mt-1 font-mono text-xs break-all">{n.middlewares.join(', ') || '-'}</p>
          <p className="mt-1 font-mono text-xs break-all">{n.services.join(', ') || '-'}</p>
        </details>
      </div>
    )}
  </section>
);

const SystemPage: React.FC = () => {
  const [nodes, setNodes] = useState<NodeSystemView[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/forward/system');
      if (!res.ok) {
        setError(await errorDetail(res));
        return;
      }
      const data = await res.json() as { nodes: NodeSystemView[] };
      setNodes(data.nodes);
      setError('');
    } catch (err) {
      setError(`読み込めませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, []);

  useEffect(() => {
    // load は await の後でだけ state を変える（同期の setState ではない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>rproxy の機能と設定</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">rproxy の機能と設定</h1>
      <p className="text-sm text-gray-700">
        rproxy-api が使える機能と、設定ファイルの状態です（読み取り専用）。プロセス全体の設定（performance・GeoIP のデータベース・制御 API の守り）は rproxy の設定ファイルと引数で変えます。
      </p>
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {!nodes && !error && <p className="text-gray-700">読み込み中…</p>}
      {nodes && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {nodes.map((n) => <NodeCard key={n.node} n={n} many={nodes.length > 1} />)}
        </div>
      )}
    </div>
  );
};

export default SystemPage;
