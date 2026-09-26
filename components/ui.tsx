// ダッシュボードと詳細画面で共通の小さな部品（状態のバッジ、エラーのバナー、確認ダイアログ、自動更新）

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ForwardRule, ForwardRules, RuleState } from './lib';
import { RuleKey, STATE_LABELS, ruleApiUrl, tlsLabel } from './dashboard';
import { explainError } from './messages';

const STATE_BADGE: Record<RuleState, string> = {
  running: 'bg-green-100 text-green-800 border border-green-300',
  failed: 'bg-red-100 text-red-800 border border-red-300',
  missing: 'bg-amber-100 text-amber-900 border border-amber-300',
  unknown: 'bg-gray-100 text-gray-700 border border-gray-300',
};

export const StateBadge: React.FC<{ state: RuleState }> = ({ state }) => (
  <span className={`badge ${STATE_BADGE[state]}`}>
    <span aria-hidden="true" className="mr-1">●</span>
    {STATE_LABELS[state]}
    <span className="sr-only">（{state}）</span>
  </span>
);

export const TlsBadge: React.FC<{ rule: Pick<ForwardRule, 'protocol' | 'tls' | 'starttls'> }> = ({ rule }) => {
  const cls = rule.tls.mode === 'passthrough'
    ? 'bg-gray-100 text-gray-700'
    : rule.tls.mode === 'sni' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800';
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`badge ${cls}`}>{tlsLabel(rule)}</span>
      {rule.starttls && <span className="badge bg-indigo-100 text-indigo-800">STARTTLS {rule.starttls}</span>}
    </span>
  );
};

// 固定ルール（rproxy の設定ファイルで管理。画面からは変更・削除できない）
export const StaticBadge: React.FC = () => (
  <span className="badge bg-slate-700 text-white" title="固定ルール（rproxy の設定ファイルで管理）">固定</span>
);

// allow_from で送信元を絞っているルール
export const AllowFromBadge: React.FC<{ allowFrom: string[] }> = ({ allowFrom }) => (
  allowFrom.length === 0 ? null : (
    <span className="badge bg-orange-100 text-orange-900" title={`接続を許可する送信元: ${allowFrom.join(', ')}`}>IP 制限</span>
  )
);

export const ErrorBanner: React.FC<{ message: string; onClose?: () => void }> = ({ message, onClose }) => (
  <div role="alert" className="bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded mb-4 flex justify-between items-start">
    <span className="break-all">{message}</span>
    {onClose && (
      <button type="button" onClick={onClose} className="ml-4 font-bold text-red-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500" aria-label="閉じる">×</button>
    )}
  </div>
);

// <dialog> の showModal() を使う（フォーカスの閉じ込めと Esc で閉じる動作はブラウザに任せる）
export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, children, confirmLabel, busy = false, onConfirm, onCancel }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // 誤って削除しないように、最初はキャンセルにフォーカスを置く
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="p-5">
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-gray-900 mb-2">{title}</h2>
        <div className="text-sm text-gray-800 mb-4">{children}</div>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>キャンセル</button>
          <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy}>{busy ? '処理中…' : confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
};

// 一定間隔で refresh を呼ぶ。タブが隠れている間は止め、表示に戻ったらすぐ 1 回呼ぶ
export function useAutoRefresh(refresh: () => unknown, enabled: boolean, intervalMs = 5000): void {
  const ref = useRef(refresh);
  useEffect(() => {
    ref.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => ref.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        ref.current();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}

export const AutoRefreshToggle: React.FC<{ enabled: boolean; onChange: (v: boolean) => void; lastUpdated: number | null }> = ({ enabled, onChange, lastUpdated }) => (
  <div className="flex items-center gap-3 text-sm text-gray-700">
    <label className="inline-flex items-center gap-2 cursor-pointer whitespace-nowrap">
      <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      自動更新（5 秒ごと）
    </label>
    {lastUpdated !== null && (
      <span className="text-xs text-gray-600 whitespace-nowrap">
        最終更新 {new Date(lastUpdated).toLocaleTimeString('ja-JP')}
      </span>
    )}
  </div>
);

// API の失敗応答の本文から表示用の文字列を作る
export async function errorDetail(res: Response): Promise<string> {
  const body: { error?: string; code?: string } = await res.json().catch(() => ({}));
  const detail = body.error || res.statusText || `HTTP ${res.status}`;
  return explainError(body.code, detail);
}

// 「キャンセル」: 履歴があれば戻り、直接開いた場合は fallback へ移る
export function goBack(router: { back: () => void; push: (url: string) => unknown }, fallback: string): void {
  if (typeof window !== 'undefined' && window.history.length > 1) router.back();
  else void router.push(fallback);
}

// 画面から API へルールを送る。失敗したら表示用のメッセージで Error を投げる
// L7 の設定（http）は送らない（API は受け取らず、変更では DB の値を保つ。UI #34 まで）
export async function postRule(action: 'add' | 'modify' | 'delete', rule: unknown): Promise<void> {
  const body = typeof rule === 'object' && rule !== null && 'http' in rule
    ? Object.fromEntries(Object.entries(rule).filter(([k]) => k !== 'http'))
    : rule;
  const res = await fetch(`/api/forward/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
}

// 詳細画面と変更画面で 1 件のルールを取得する。key が null（router の準備前）の間は何もしない
export function useRule(key: RuleKey | null) {
  const url = key ? ruleApiUrl(key) : null;
  const [rule, setRule] = useState<ForwardRules | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (url === null || inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        setNotFound(true);
        setRule(null);
        return;
      }
      if (!res.ok) {
        setError(res.status === 401
          ? 'サインインしていません。右上の「Sign In」からサインインしてください。'
          : `ルールを取得できませんでした: ${await errorDetail(res)}`);
        return;
      }
      setRule(await res.json() as ForwardRules);
      setNotFound(false);
      setLastUpdated(Date.now());
      setError('');
    } catch (err) {
      setError(`ルールを取得できませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      inFlight.current = false;
    }
  }, [url]);

  useEffect(() => {
    // load は await の後でだけ state を変える（同期の setState ではない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { rule, error, setError, notFound, lastUpdated, load };
}
