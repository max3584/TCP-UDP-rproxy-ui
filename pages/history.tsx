// 変更の履歴（/history。#61）。利用者は自分のルールの履歴、rproxy-admin はすべて
import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import HistoryList from '@/components/HistoryList';
import { ACTION_LABELS, HISTORY_ACTIONS, HistoryAction, HistoryFilter, historyQuery, isDate } from '@/components/history';
import type { sessionUser } from '@/components/lib';

const inputClass = 'border border-gray-400 rounded px-2 py-1 text-sm bg-white text-gray-900 max-sm:w-full max-lg:min-h-11';

const HistoryPage: React.FC = () => {
  const { data: session } = useSession();
  const admin = (session as sessionUser | null)?.user?.access === 'admin';
  const [draft, setDraft] = useState<HistoryFilter>({});
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [formError, setFormError] = useState('');

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if ((draft.from && !isDate(draft.from)) || (draft.to && !isDate(draft.to))) {
      setFormError('期間は YYYY-MM-DD で指定してください。');
      return;
    }
    setFormError('');
    setFilter(draft);
  };
  const set = (patch: Partial<HistoryFilter>) => setDraft({ ...draft, ...patch });

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>変更の履歴</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">変更の履歴</h1>
      <p className="text-sm text-gray-800">
        ルールの追加・変更・削除の履歴です。{admin ? 'すべての利用者の履歴を表示しています。' : '自分が操作した履歴と、自分のルールの履歴を表示しています。'}
        「この版に戻す」で、その時点の内容に戻せます（rproxy の固定ルールは対象外です）。
      </p>

      <form onSubmit={apply} className="card p-4 flex flex-wrap items-end gap-3 text-sm text-gray-900" aria-label="履歴の絞り込み">
        <label className="flex flex-col gap-1 max-sm:w-full">
          プロトコル
          <select className={inputClass} value={draft.protocol ?? ''} onChange={(e) => set({ protocol: e.target.value || undefined })}>
            <option value="">すべて</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 max-sm:w-full">
          待ち受けアドレス
          <input className={inputClass} value={draft.addr ?? ''} onChange={(e) => set({ addr: e.target.value.trim() || undefined })} placeholder="0.0.0.0" />
        </label>
        <label className="flex flex-col gap-1 max-sm:w-full">
          ポート
          <input className={`${inputClass} sm:w-24`} inputMode="numeric" value={draft.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} />
        </label>
        <label className="flex flex-col gap-1 max-sm:w-full">
          操作
          <select className={inputClass} value={draft.action ?? ''} onChange={(e) => set({ action: (e.target.value || undefined) as HistoryAction | undefined })}>
            <option value="">すべて</option>
            {HISTORY_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
          </select>
        </label>
        {admin && (
          <label className="flex flex-col gap-1 max-sm:w-full">
            操作した利用者（ID）
            <input className={inputClass} value={draft.user ?? ''} onChange={(e) => set({ user: e.target.value.trim() || undefined })} />
          </label>
        )}
        <label className="flex flex-col gap-1 max-sm:w-full">
          期間（から）
          <input type="date" className={inputClass} value={draft.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />
        </label>
        <label className="flex flex-col gap-1 max-sm:w-full">
          期間（まで）
          <input type="date" className={inputClass} value={draft.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
        </label>
        <button type="submit" className="btn-primary">絞り込む</button>
        <button type="button" className="btn-secondary" onClick={() => { setDraft({}); setFilter({}); setFormError(''); }}>条件を消す</button>
        {formError && <p role="alert" className="w-full text-red-700">{formError}</p>}
      </form>

      <section className="card p-4" aria-label="履歴">
        {/* 条件が変わったら 1 ページ目から読み直す */}
        <HistoryList key={historyQuery(filter, 1, 50)} filter={filter} showRule perPage={50} />
      </section>
    </div>
  );
};

export default HistoryPage;
