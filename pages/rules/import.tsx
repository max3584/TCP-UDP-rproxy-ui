// ルールのインポート（/rules/import。#60）。rproxy の設定ファイルと同じ形の YAML / JSON を読み込む
import { useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, errorDetail } from '@/components/ui';

type Status = 'new' | 'exists' | 'error';
type Result = 'added' | 'replaced' | 'skipped' | 'error';

interface PreviewItem {
  index: number;
  key: string | null;
  status: Status;
  message?: string;
}

interface ResultItem {
  index: number;
  key: string | null;
  result: Result;
  message?: string;
}

const STATUS_LABELS: Record<Status, string> = { new: '追加', exists: '同じキーがある', error: '誤り' };
const RESULT_LABELS: Record<Result, string> = { added: '追加しました', replaced: '置き換えました', skipped: 'スキップ', error: '失敗' };
const STATUS_BADGE: Record<Status | Result, string> = {
  new: 'bg-green-100 text-green-900',
  added: 'bg-green-100 text-green-900',
  exists: 'bg-amber-100 text-amber-900',
  replaced: 'bg-blue-100 text-blue-900',
  skipped: 'bg-gray-100 text-gray-900',
  error: 'bg-red-100 text-red-800',
};

// protocol|addr|port → 画面の表示
function keyLabel(key: string | null): string {
  if (key === null) return '-';
  const [protocol, addr, port] = key.split('|');
  return `${protocol.toUpperCase()} ${addr.includes(':') ? `[${addr}]` : addr}:${port}`;
}

async function postImport(body: unknown) {
  const res = await fetch('/api/forward/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

const ImportPage: React.FC = () => {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ items: PreviewItem[]; ignoredGlobal: boolean } | null>(null);
  // 同じキーがあるときに置き換えるキー
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<ResultItem[] | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    setPreview(null);
    setResults(null);
  };

  const check = async () => {
    setBusy(true);
    setError('');
    setResults(null);
    try {
      const out = await postImport({ text: text, dryRun: true }) as { items: PreviewItem[]; ignoredGlobal: boolean };
      setPreview(out);
      setReplace(new Set());
    } catch (err) {
      setPreview(null);
      setError(`読み込めませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await postImport({ text: text, replace: [...replace] }) as { results: ResultItem[] };
      setResults(out.results);
      setPreview(null);
    } catch (err) {
      setError(`インポートに失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(replace);
    if (on) next.add(key);
    else next.delete(key);
    setReplace(next);
  };

  const runnable = preview !== null && preview.items.some((i) => i.status === 'new' || (i.status === 'exists' && i.key !== null && replace.has(i.key)));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>ルールのインポート</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">ルールのインポート</h1>
      <div className="card p-4 space-y-3 text-sm text-gray-900">
        <p>
          rproxy の設定ファイル（<code>RPROXY_CONFIG</code>）と同じ形の YAML / JSON を読み込みます（<code>version: 1</code> と <code>rules:</code>、またはルールの配列）。
          ダッシュボードの「エクスポート」で書き出したファイルもそのまま読めます。<code>global</code> は rproxy 側の設定なので読み飛ばします。
        </p>
        <p>先に「確かめる」で 1 件ずつ検証し、結果を見てから実行します。1 件ずつ追加・置き換えるので、途中で失敗しても成功した分は残ります。</p>
        <label className="block">
          <span className="block mb-1">ファイル</span>
          <input type="file" accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml" onChange={(e) => void onFile(e)} />
        </label>
        <label className="block">
          <span className="block mb-1">または貼り付け</span>
          <textarea
            className="w-full h-64 border border-gray-400 rounded p-2 font-mono text-xs bg-white text-gray-900"
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); setResults(null); }}
            placeholder={'version: 1\nrules:\n  - protocol: tcp\n    listen_addr: 0.0.0.0\n    listen_port: 8443\n    remote_addr: 10.0.0.10\n    remote_port: 443'}
            aria-label="読み込む YAML / JSON"
          />
        </label>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" disabled={busy || text.trim() === ''} onClick={() => void check()}>確かめる</button>
          <button type="button" className="btn-primary" disabled={busy || !runnable} onClick={() => void run()}>{busy ? '処理中…' : 'インポートする'}</button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError('')} />}

      {preview && (
        <section className="card p-4" aria-labelledby="import-preview">
          <h2 id="import-preview" className="card-title mb-3">確かめた結果（{preview.items.length} 件）</h2>
          {preview.ignoredGlobal && (
            <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <code>global</code> は読み飛ばします（rproxy の設定ファイルの側で設定してください）。
            </p>
          )}
          <table className="data-table w-full text-sm" data-testid="import-preview">
            <thead>
              <tr><th scope="col">#</th><th scope="col">ルール</th><th scope="col">結果</th><th scope="col">内容</th></tr>
            </thead>
            <tbody>
              {preview.items.map((i) => (
                <tr key={i.index}>
                  <td>{i.index + 1}</td>
                  <td className="font-mono break-all">{keyLabel(i.key)}</td>
                  <td><span className={`badge ${STATUS_BADGE[i.status]}`}>{STATUS_LABELS[i.status]}</span></td>
                  <td>
                    {i.status === 'exists' && i.key !== null ? (
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" checked={replace.has(i.key)} onChange={(e) => toggle(i.key as string, e.target.checked)} />
                        置き換える（外すとスキップ）
                      </label>
                    ) : i.message ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {results && (
        <section className="card p-4" aria-labelledby="import-results">
          <h2 id="import-results" className="card-title mb-3">インポートの結果</h2>
          <table className="data-table w-full text-sm" data-testid="import-results">
            <thead>
              <tr><th scope="col">#</th><th scope="col">ルール</th><th scope="col">結果</th><th scope="col">内容</th></tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.index}>
                  <td>{r.index + 1}</td>
                  <td className="font-mono break-all">{keyLabel(r.key)}</td>
                  <td><span className={`badge ${STATUS_BADGE[r.result]}`}>{RESULT_LABELS[r.result]}</span></td>
                  <td>{r.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm"><Link href="/" className="link">ダッシュボードに戻る</Link></p>
        </section>
      )}
    </div>
  );
};

export default ImportPage;
