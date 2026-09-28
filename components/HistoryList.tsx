// 変更の履歴の表（#61）。ルールの詳細画面（そのルールだけ）と履歴の画面（全体・絞り込み）で使う
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Protocol } from './lib';
import { ACTION_LABELS, HistoryEntry, HistoryFilter, HistoryPage, historyQuery } from './history';
import { hostPort, portsLabel, ruleHref } from './dashboard';
import { ConfirmDialog, ErrorBanner, errorDetail } from './ui';

const RESULT_LABELS: Record<string, string> = {
  added: '作り直しました',
  modified: '変更しました',
  recreated: '削除して作り直しました（送信元 IP の扱い・ポート範囲・L4 / L7 が違うため）',
};

function formatAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP');
}

const HistoryList: React.FC<{
  filter: HistoryFilter;
  // 全体の履歴ではルールの列を出す
  showRule?: boolean;
  perPage?: number;
  // 巻き戻したあと（詳細画面ではルールを読み直す）
  onReverted?: () => void;
}> = ({ filter, showRule = false, perPage = 20, onReverted }) => {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryPage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const query = historyQuery(filter, page, perPage);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/forward/history?${query}`);
      if (!res.ok) {
        setError(`履歴を取得できませんでした: ${await errorDetail(res)}`);
        return;
      }
      setData(await res.json() as HistoryPage);
      setError('');
    } catch (err) {
      setError(`履歴を取得できませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, [query]);

  useEffect(() => {
    // load は await の後でだけ state を変える
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const revert = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch('/api/forward/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      if (!res.ok) {
        setError(`巻き戻しに失敗しました: ${await errorDetail(res)}`);
        return;
      }
      const body = await res.json() as { result: string };
      setNotice(`${formatAt(target.at)} の版に戻しました（${RESULT_LABELS[body.result] ?? body.result}）。`);
      setPage(1);
      await load();
      onReverted?.();
    } catch (err) {
      setError(`巻き戻しに失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <div data-testid="history-list">
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {notice && (
        <p role="status" className="mb-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">{notice}</p>
      )}
      {data === null ? (
        !error && <p className="text-gray-700 text-sm">読み込み中…</p>
      ) : data.entries.length === 0 ? (
        <p className="text-gray-700 text-sm">履歴はありません。</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  {showRule && <th scope="col">ルール</th>}
                  <th scope="col">操作</th>
                  <th scope="col">操作した利用者</th>
                  <th scope="col">内容</th>
                  <th scope="col"><span className="sr-only">巻き戻し</span></th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id} data-testid="history-row">
                    <td className="whitespace-nowrap">{formatAt(e.at)}</td>
                    {showRule && (
                      <td className="font-mono break-all">
                        <Link
                          className="link"
                          href={ruleHref({ protocol: e.protocol as Protocol, addr: e.srcAddr, port: e.srcPort })}
                        >
                          {e.protocol.toUpperCase()} {hostPort(e.srcAddr, e.rule ? portsLabel(e.rule.srcPort, e.rule.srcPortEnd) : e.srcPort)}
                        </Link>
                      </td>
                    )}
                    <td className="whitespace-nowrap">{ACTION_LABELS[e.action] ?? e.action}</td>
                    <td className="font-mono break-all">{e.actor ?? '-'}</td>
                    <td>
                      {e.rule === null ? (
                        <span className="text-gray-700">内容を読めません</span>
                      ) : e.changes.length > 0 ? (
                        <ul className="list-disc pl-5">{e.changes.map((c) => <li key={c}>{c}</li>)}</ul>
                      ) : (
                        <span className="text-gray-700">{e.action === 'UPDATE' ? '（前の版との違いなし）' : '-'}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {e.revertible && (
                        <button type="button" className="btn-secondary" onClick={() => setTarget(e)}>
                          この版に戻す
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-900">
              <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>前へ</button>
              <span>{page} / {pages}（{data.total} 件）</span>
              <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>次へ</button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={target !== null}
        title="この版に戻しますか？"
        confirmLabel="戻す"
        busy={busy}
        onConfirm={() => void revert()}
        onCancel={() => setTarget(null)}
      >
        {target && (
          <p>
            <span className="font-mono break-all">{target.protocol.toUpperCase()} {hostPort(target.srcAddr, target.srcPort)}</span> を、
            {formatAt(target.at)} の{ACTION_LABELS[target.action]}{target.action === 'DELETE' ? 'の直前' : 'のあと'}の内容に戻します。
            今のルールは置き換えられます（削除されていれば作り直します）。送信元 IP の扱い・ポート範囲・L4 / L7 が違う版に戻すときは、ルールを作り直すので既存の接続が切れます。巻き戻しも履歴に残ります。
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
};

export default HistoryList;
