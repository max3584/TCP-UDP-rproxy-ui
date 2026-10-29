// rproxy の global の設定（/global。rproxy-api v0.4.19 の GET / PATCH /config/global、#342。UI #169）。管理者だけ。
// 項目ごとに今の値・出どころ（設定ファイル / 環境変数 / API / 既定）・変え方（すぐ効く / 再起動が要る）を出し、
// 設定ファイル・環境変数の項目は読み取り専用（「設定ファイルで固定」）、起動のときだけの項目は表示だけ。
// API で変えられる項目は、差分（dry run）を見てから適用する。グループを選べば全ノードに送る（1 台でも断れば全員を戻す）。
// どの項目が変えられるか・Unix ソケットだけかは rproxy の答え（settable・unix_only）に従う（UI は決め打ちしない）
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, errorDetail } from '@/components/ui';
import { explainError } from '@/components/messages';
import {
  GLOBAL_ITEM_LABELS, GlobalPatchError, SOURCE_LABELS, buildGlobalValue, editBlock, formatGlobalValue, toGlobalForm,
} from '@/components/globalsettings';
import type { GlobalForm, GlobalItem, GlobalNodeResult, GlobalNodeView } from '@/components/globalsettings';
import { localeTag, t } from '@/i18n/core';

interface GlobalData {
  nodes: GlobalNodeView[];
  groups: { name: string; nodes: string[] }[];
}

type Mode = 'keep' | 'set' | 'clear';

interface Edit {
  mode: Mode;
  form: GlobalForm;
}

const itemLabel = (name: string) => GLOBAL_ITEM_LABELS[name]?.label ?? name;

const SourceBadge: React.FC<{ source: string }> = ({ source }) => {
  const cls = source === 'api'
    ? 'bg-blue-100 text-blue-900 border-blue-300'
    : source === 'file' || source === 'env' ? 'bg-amber-100 text-amber-900 border-amber-300' : 'bg-gray-100 text-gray-800 border-gray-300';
  return <span className={`badge border ${cls}`} data-testid="global-source">{SOURCE_LABELS[source] ?? source}</span>;
};

const ApplyBadge: React.FC<{ apply: string }> = ({ apply }) => (
  apply === 'live'
    ? <span className="badge bg-green-100 text-green-900 border border-green-300">すぐ効く</span>
    : <span className="badge bg-gray-100 text-gray-800 border border-gray-300">再起動が要る</span>
);

const ItemRow: React.FC<{ name: string; item: GlobalItem; transport: 'unix' | 'tcp' }> = ({ name, item, transport }) => {
  const block = editBlock(item, transport);
  return (
    <tr data-testid={`global-item-${name}`}>
      <th scope="row" className="text-left font-normal text-gray-900 align-top">
        <span className="block">{itemLabel(name)}</span>
        <span className="block font-mono text-xs text-gray-600">{name}</span>
      </th>
      <td className="font-mono text-xs break-all align-top text-gray-900" data-testid="global-value">{formatGlobalValue(item.value)}</td>
      <td className="align-top"><SourceBadge source={item.source} /></td>
      <td className="align-top"><ApplyBadge apply={item.apply} /></td>
      <td className="align-top text-xs text-gray-800 space-y-1">
        {block && <span className="block" data-testid="global-block">{block}</span>}
        {item.shadowed && (
          <span className="block text-amber-900" data-testid="global-shadowed">
            {`API の値（${formatGlobalValue(item.api_value)}）は効いていません（設定ファイル・環境変数が優先）。`}
          </span>
        )}
        {item.kept && <span className="block text-amber-900" data-testid="global-kept">設定ファイルから消えたが、使うルールがあるので残しています。</span>}
        {item.error && (
          <span className="block text-red-800" data-testid="global-item-error">
            {item.api_value !== undefined
              ? `保存した API の値を効かせられませんでした（効いていません）: ${item.error}`
              : `新しい値を効かせられませんでした（今の値の欄は前から効いている値です）: ${item.error}`}
            {item.api_value !== undefined && <span className="block font-mono break-all">{`保存した値: ${formatGlobalValue(item.api_value)}`}</span>}
          </span>
        )}
      </td>
    </tr>
  );
};

const NodeCard: React.FC<{ n: GlobalNodeView; many: boolean }> = ({ n, many }) => {
  const s = n.settings;
  return (
    <section className="card p-4" aria-labelledby={`global-${n.node}`} data-testid="global-node" data-node={n.node}>
      <h2 id={`global-${n.node}`} className="card-title mb-3">
        {many ? <span className="font-mono">{n.node}</span> : 'rproxy-api'}
        {n.readonly && <span className="ml-2 badge bg-gray-100 text-gray-800 border border-gray-300">見るだけ</span>}
      </h2>
      {!n.reachable ? (
        <p className="text-sm text-red-800">問い合わせできません{n.error ? `: ${n.error}` : ''}</p>
      ) : !n.supported ? (
        <p className="text-sm text-gray-700" data-testid="global-unsupported">この rproxy は global の設定の API に対応していません（rproxy-api v0.4.19 から）。</p>
      ) : !s ? (
        <p className="text-sm text-red-800">{explainError(n.code ?? undefined, n.error ?? '')}</p>
      ) : (
        <div className="space-y-3 text-sm text-gray-900">
          <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-4 gap-y-1">
            <dt className="text-gray-600">API の値の保存先</dt>
            <dd data-testid="global-storage">
              {s.storage === 'database' ? 'データベース（rproxy_global）' : 'このプロセスの中だけ（再起動で消える）'}
              {s.persisted === false && <span className="ml-2 badge bg-amber-100 text-amber-900 border border-amber-300">まだ保存できていません</span>}
            </dd>
            <dt className="text-gray-600">最後に変えた人</dt>
            <dd>{s.updated_by ?? '-'}{s.updated_at ? `（${new Date(s.updated_at * 1000).toLocaleString(localeTag())}）` : ''}</dd>
            <dt className="text-gray-600">制御 API への道</dt>
            <dd>{n.transport === 'unix' ? 'Unix ソケット' : 'TCP（Unix ソケットだけの項目は変えられません）'}</dd>
          </dl>
          {!s.loaded && (
            <p role="alert" className="rounded-sm border border-red-300 bg-red-50 p-2 text-red-800 text-xs" data-testid="global-not-loaded">
              rproxy が起動のときに保存した値（rproxy_global）を読めていません（DB に届かないか、行が読めない形）。読めるまで変えられません（rproxy が定期に読み直します。読めない形の行は直すまで）。
            </p>
          )}
          {s.warnings.length > 0 && (
            <ul className="rounded-sm border border-amber-300 bg-amber-50 p-2 text-amber-900 text-xs space-y-1" data-testid="global-warnings">
              {s.warnings.map((w, i) => <li key={i}>{w.item ? `${w.item}: ` : ''}{w.message ?? w.code}</li>)}
            </ul>
          )}
          <div className="table-scroll">
            <table className="data-table text-sm" data-testid="global-items">
              <thead>
                <tr><th scope="col">項目</th><th scope="col">今の値</th><th scope="col">出どころ</th><th scope="col">変え方</th><th scope="col">注記</th></tr>
              </thead>
              <tbody>
                {Object.entries(s.items).map(([name, item]) => <ItemRow key={name} name={name} item={item} transport={n.transport} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};

const FormFields: React.FC<{ name: string; form: GlobalForm; onChange: (f: GlobalForm) => void }> = ({ name, form, onChange }) => {
  const id = `global-input-${name.replace(/\./g, '-')}`;
  const input = 'w-full border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900 font-mono text-sm';
  switch (form.kind) {
    case 'lines':
      return <textarea id={id} aria-label={itemLabel(name)} className={input} rows={4} value={form.text} onChange={(e) => onChange({ ...form, text: e.target.value })} />;
    case 'text':
      return <input id={id} aria-label={itemLabel(name)} className={input} value={form.text} onChange={(e) => onChange({ ...form, text: e.target.value })} />;
    case 'number':
      return <input id={id} aria-label={itemLabel(name)} className={input} inputMode="numeric" value={form.text} onChange={(e) => onChange({ ...form, text: e.target.value })} />;
    case 'json':
      return <textarea id={id} aria-label={itemLabel(name)} className={input} rows={5} value={form.text} onChange={(e) => onChange({ ...form, text: e.target.value })} />;
    case 'fields':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-3 gap-y-1 items-center">
          {form.keys.map((k) => (
            <label key={k} className="contents">
              <span className="font-mono text-xs text-gray-700">{k}</span>
              <input
                id={`${id}-${k}`}
                className={input}
                value={form.fields[k] ?? ''}
                onChange={(e) => onChange({ ...form, fields: { ...form.fields, [k]: e.target.value } })}
              />
            </label>
          ))}
        </div>
      );
  }
};

const ResultView: React.FC<{ results: GlobalNodeResult[]; applied: boolean; many: boolean }> = ({ results, applied, many }) => (
  <section className="rounded-sm border border-blue-200 bg-blue-50 p-3 text-sm text-gray-900" data-testid={applied ? 'global-result' : 'global-plan'}>
    <h3 className="font-semibold mb-2">{applied ? '適用しました' : '適用したときの変化（まだ何も変えていません）'}</h3>
    {results.map((r) => (
      <div key={r.node} className="mb-2 last:mb-0" data-testid="global-plan-node">
        {many && <h4 className="font-mono font-semibold">{r.node}</h4>}
        {!r.ok ? (
          <p className="text-red-800">{explainError(r.code, r.error ?? '')}</p>
        ) : (r.changes ?? []).length === 0 ? (
          <p className="text-gray-700">変わる項目はありません。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table text-xs">
              <thead>
                <tr><th scope="col">項目</th><th scope="col">今の値</th><th scope="col">後の値</th><th scope="col">API の値（前 → 後）</th></tr>
              </thead>
              <tbody>
                {(r.changes ?? []).map((c) => (
                  <tr key={c.item} data-testid={`global-change-${c.item}`}>
                    <td>
                      {itemLabel(c.item)}
                      {(r.applied ?? []).includes(c.item) && <span className="ml-1 badge bg-green-100 text-green-900 border border-green-300">効く値が変わる</span>}
                    </td>
                    <td className="font-mono break-all text-red-900">{formatGlobalValue(c.before)}</td>
                    <td className="font-mono break-all text-green-900">{formatGlobalValue(c.after)}</td>
                    <td className="font-mono break-all">{formatGlobalValue(c.api_before)} → {formatGlobalValue(c.api_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {applied && r.ok && r.persisted === false && (
          <p className="text-amber-900 text-xs mt-1">値は効いていますが、まだ保存できていません（rproxy が後で書き直します。DB がなければ再起動で消えます）。</p>
        )}
      </div>
    ))}
  </section>
);

const GlobalPage: React.FC = () => {
  const [data, setData] = useState<GlobalData | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [plan, setPlan] = useState<{ body: string; results: GlobalNodeResult[] } | null>(null);
  const [result, setResult] = useState<GlobalNodeResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/forward/global');
      if (!res.ok) {
        setError(await errorDetail(res));
        return;
      }
      setData(await res.json() as GlobalData);
      setEdits({});
      setPlan(null);
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

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const many = nodes.length > 1;
  // 選べるもの：ノード（見るだけのものも見るために）とグループ
  const choices = useMemo(() => [
    ...nodes.map((n) => ({ name: n.node, nodes: [n.node], group: false })),
    ...(data?.groups ?? []).map((g) => ({ name: g.name, nodes: g.nodes, group: true })),
  ], [nodes, data]);
  // 選んでいたものが消えたら最初のものに戻す（描画中に直す）
  const selected = choices.find((c) => c.name === target) ?? choices[0];
  if (selected && selected.name !== target) setTarget(selected.name);
  const shown = useMemo(() => (selected ? nodes.filter((n) => selected.nodes.includes(n.node)) : []), [selected, nodes]);

  // 変えられる項目：見せているすべてのノードで API が変えられるもの
  const editable = useMemo(() => {
    if (shown.length === 0 || shown.some((n) => n.readonly || !n.settings)) return [];
    const first = shown[0].settings!;
    return Object.keys(first.items).filter((name) => shown.every((n) => {
      const item = n.settings!.items[name];
      return item !== undefined && editBlock(item, n.transport) === null;
    }));
  }, [shown]);

  const editOf = (name: string): Edit => edits[name] ?? { mode: 'keep', form: toGlobalForm(name, shown[0].settings!.items[name]) };
  const setEdit = (name: string, e: Edit) => {
    setEdits((prev) => ({ ...prev, [name]: e }));
    setPlan(null);
    setResult(null);
  };

  // 送る値（形の誤りは文で返す）
  const built = useMemo((): { values: Record<string, unknown> } | { error: string } => {
    const values: Record<string, unknown> = {};
    try {
      for (const name of editable) {
        const e = edits[name];
        if (!e || e.mode === 'keep') continue;
        values[name] = e.mode === 'clear' ? null : buildGlobalValue(name, e.form);
      }
    } catch (err) {
      if (err instanceof GlobalPatchError) return { error: err.message };
      throw err;
    }
    return { values: values };
  }, [editable, edits]);

  const send = async (dryRun: boolean) => {
    if ('error' in built || !selected) return;
    setBusy(true);
    setError('');
    try {
      const body = JSON.stringify({ target: selected.name, values: built.values, dryRun: dryRun });
      const res = await fetch('/api/forward/global', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
      if (!res.ok) {
        const data = await res.clone().json().catch(() => ({})) as { nodes?: GlobalNodeResult[] };
        setError(await errorDetail(res));
        if (Array.isArray(data.nodes)) setResult(data.nodes);
        return;
      }
      const out = await res.json() as { nodes: GlobalNodeResult[] };
      if (dryRun) {
        setPlan({ body: JSON.stringify(built.values), results: out.nodes });
      } else {
        await load();
        setResult(out.nodes);
      }
    } catch (err) {
      setError(`送れませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const hasChanges = 'values' in built && Object.keys(built.values).length > 0;
  // 保存した値を読めていないノードがあれば rproxy は 503 not_loaded で断る
  const notLoaded = shown.some((n) => n.settings?.loaded === false);
  const planOk = !notLoaded && plan !== null && 'values' in built && plan.body === JSON.stringify(built.values) && plan.results.every((r) => r.ok);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/system" className="link">rproxy の機能と設定</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>global の設定</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">global の設定</h1>
      <p className="text-sm text-gray-700">
        rproxy のプロセス全体の設定です。設定ファイル・環境変数に書いた項目はそちらが優先し、ここでは変えられません。書いていない項目のうち、すぐ効くものだけをここで変えられます（rproxy が保存し、再起動しても残ります）。
      </p>
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {!data && !error && <p className="text-gray-700">読み込み中…</p>}
      {data && choices.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="global-target" className="text-sm text-gray-800">ノード／グループ</label>
          <select
            id="global-target"
            className="border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900"
            value={selected?.name ?? ''}
            onChange={(e) => { setTarget(e.target.value); setEdits({}); setPlan(null); setResult(null); }}
          >
            {choices.map((c) => <option key={c.name} value={c.name}>{c.group ? t('グループ {name}', { name: c.name }) : c.name}</option>)}
          </select>
          {selected?.group && <span className="text-xs text-gray-700">グループのすべてのノードに同じ値を送ります（1 台でも断れば全員を戻します）。</span>}
        </div>
      )}
      {data && shown.length > 0 && (
        <div className={`grid grid-cols-1 ${shown.length > 1 ? 'xl:grid-cols-2' : ''} gap-4`}>
          {shown.map((n) => <NodeCard key={n.node} n={n} many={many} />)}
        </div>
      )}
      {data && editable.length > 0 && (
        <section className="card p-4 space-y-3" aria-labelledby="global-edit-heading" data-testid="global-edit">
          <h2 id="global-edit-heading" className="card-title">API で変える{selected?.group ? t('（グループ {name}）', { name: selected.name }) : many && selected ? `（${selected.name}）` : ''}</h2>
          {editable.map((name) => {
            const e = editOf(name);
            const item = shown[0].settings!.items[name];
            const hasApi = shown.some((n) => n.settings!.items[name]?.api_value !== undefined);
            return (
              <fieldset key={name} className="border border-gray-200 rounded-sm p-3 space-y-2" data-testid={`global-edit-${name}`}>
                <legend className="px-1 font-semibold text-gray-900">{itemLabel(name)} <span className="font-mono text-xs font-normal text-gray-600">{name}</span></legend>
                {GLOBAL_ITEM_LABELS[name] && <p className="text-xs text-gray-700">{GLOBAL_ITEM_LABELS[name].help}</p>}
                <div className="flex flex-wrap gap-3 text-sm text-gray-900" role="radiogroup" aria-label={itemLabel(name)}>
                  {(['keep', 'set', ...(hasApi ? ['clear'] : [])] as Mode[]).map((m) => (
                    <label key={m} className="inline-flex items-center gap-1">
                      <input type="radio" name={`global-mode-${name}`} value={m} checked={e.mode === m} onChange={() => setEdit(name, { ...e, mode: m })} />
                      {m === 'keep' ? '変えない' : m === 'set' ? '値を入れる' : 'API の値を消す（既定に戻す）'}
                    </label>
                  ))}
                </div>
                {e.mode === 'set' && (
                  <>
                    <FormFields name={name} form={e.form} onChange={(f) => setEdit(name, { ...e, form: f })} />
                    {item.unix_only && <p className="text-xs text-gray-700">守りに関わる項目です。rproxy は Unix ソケットからだけ受け付けます。</p>}
                  </>
                )}
              </fieldset>
            );
          })}
          {'error' in built && <p className="text-sm text-red-800" role="alert">{built.error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" disabled={busy || !hasChanges} onClick={() => void send(true)} data-testid="global-dry-run">差分を確かめる</button>
            <button type="button" className="btn-primary" disabled={busy || !hasChanges || !planOk} onClick={() => void send(false)} data-testid="global-apply">適用する</button>
          </div>
          {notLoaded && <p className="text-xs text-red-800">保存した値を読めていないノードがあるため、適用できません。</p>}
          {hasChanges && !planOk && !notLoaded && <p className="text-xs text-gray-700">先に「差分を確かめる」で、rproxy が受け付けるかと変わる値を確かめてください。</p>}
          {plan && <ResultView results={plan.results} applied={false} many={many} />}
        </section>
      )}
      {data && shown.length > 0 && editable.length === 0 && shown.every((n) => n.settings) && !shown.some((n) => n.readonly) && (
        <p className="text-sm text-gray-700" data-testid="global-nothing-editable">このノード／グループで API から変えられる項目はありません。</p>
      )}
      {result && <ResultView results={result} applied={result.every((r) => r.ok)} many={many} />}
    </div>
  );
};

export default GlobalPage;
