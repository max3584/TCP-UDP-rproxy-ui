// ルールの詳細の、ACME の証明書 1 件の状態（rproxy のルールの acme。取得待ち・有効・更新中・失敗、期限・更新の予定・次の試み・最後の誤り）。
// まだ取れていない・保存した証明書が切れているときは、自己署名の仮の証明書を返していることをはっきり出す
import React from 'react';
import type { RuleState } from './lib';
import { ACME_STATE_LABELS, AcmeCertStatus, AcmeState, servesStandIn } from './acme';
import { formatIsoTime } from './dashboard';
import { ACME_UNSUPPORTED_NOTE } from './messages';

const STATE_CLASS: Record<AcmeState, string> = {
  valid: 'bg-green-100 text-green-900',
  renewing: 'bg-blue-100 text-blue-900',
  pending: 'bg-amber-100 text-amber-900',
  error: 'bg-red-100 text-red-900',
};

export const AcmeStateBadge: React.FC<{ state: AcmeState }> = ({ state }) => (
  <span className={`badge ${STATE_CLASS[state] ?? 'bg-gray-100 text-gray-800'}`} data-testid="acme-state">{ACME_STATE_LABELS[state] ?? state}</span>
);

interface Props {
  // その証明書の状態（rproxy が返さなければ undefined）
  status: AcmeCertStatus | undefined;
  // rproxy がルールの acme を返したか（false なら ACME を知らない古い rproxy）
  reported: boolean;
  // ルールの状態（rproxy で動いていないときは状態を出せない）
  ruleState: RuleState;
  nowMs?: number;
}

const AcmeStatus: React.FC<Props> = ({ status, reported, ruleState, nowMs }) => {
  if (!status) {
    const live = ruleState === 'running' || ruleState === 'failed';
    return (
      <p className="mt-1 text-xs text-gray-700" data-testid="acme-status-none">
        {live && !reported
          ? <span className="text-amber-900" data-testid="acme-note">{ACME_UNSUPPORTED_NOTE}</span>
          : '証明書の状態は、ルールが rproxy で動いているときに出ます。'}
      </p>
    );
  }
  const standIn = servesStandIn(status, nowMs);
  return (
    <div className="mt-1 space-y-1 text-xs" data-testid="acme-status">
      <div className="flex flex-wrap items-center gap-2">
        <AcmeStateBadge state={status.state} />
        {standIn && (
          <span className="badge bg-amber-100 text-amber-900 border border-amber-300" data-testid="acme-stand-in">仮の証明書</span>
        )}
      </div>
      {standIn && (
        <p className="text-amber-900">
          まだ証明書を取れていない（または保存した証明書の期限が切れている）ため、rproxy が自己署名の仮の証明書（rproxy ACME placeholder）を返しています。クライアントには証明書の警告が出ます。
        </p>
      )}
      <dl className="grid grid-cols-1 sm:grid-cols-[9rem_1fr] gap-x-3 text-gray-900">
        {status.not_after && (<><dt className="text-gray-600">期限</dt><dd className="font-mono">{formatIsoTime(status.not_after)}</dd></>)}
        {status.renew_at && (<><dt className="text-gray-600">更新の予定</dt><dd className="font-mono">{formatIsoTime(status.renew_at)}</dd></>)}
        {status.next_attempt && (<><dt className="text-gray-600">次の試み</dt><dd className="font-mono">{formatIsoTime(status.next_attempt)}</dd></>)}
        {status.error && (<><dt className="text-gray-600">最後の誤り</dt><dd className="text-red-800 break-all" data-testid="acme-error">{status.error}</dd></>)}
      </dl>
      {status.state === 'error' && !standIn && (
        <p className="text-gray-700">更新に失敗しても、それまでの証明書を期限まで使い続けます（rproxy は 1 分から最大 6 時間の間をあけて再試行します）。</p>
      )}
    </div>
  );
};

export default AcmeStatus;
