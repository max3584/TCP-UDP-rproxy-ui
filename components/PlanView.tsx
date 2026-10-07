// 変更前の差分（rproxy v0.4 の ?dry_run=true、#169）の表示。保存・削除の前に、ノードごとに rproxy で何が変わるかを出す
import React from 'react';
import { PLAN_ACTION_LABELS, PLAN_CHANGE_LABELS, diffValue } from './v04';
import type { RulePlan } from './v04';
import { explainError } from './messages';

export interface PlanResult {
  node: string;
  plan?: RulePlan;
  error?: string;
  code?: string;
}

// POST /api/forward/plan の応答
export interface PlanResponse {
  action: string;
  results: PlanResult[];
}

const CHANGE_CLASS: Record<RulePlan['change'], string> = {
  none: 'bg-gray-100 text-gray-800',
  in_place: 'bg-green-100 text-green-900',
  recreate: 'bg-amber-100 text-amber-900',
};

const PlanView: React.FC<{ plan: PlanResponse; onClose?: () => void }> = ({ plan, onClose }) => {
  const many = plan.results.length > 1;
  return (
    <section className="rounded-sm border border-blue-200 bg-blue-50 p-3 text-sm text-gray-900" aria-labelledby="plan-heading" data-testid="plan-view">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h3 id="plan-heading" className="font-semibold text-gray-900 mr-auto">保存したときの rproxy の変化（まだ何も変えていません）</h3>
        {onClose && <button type="button" className="btn-secondary" onClick={onClose}>閉じる</button>}
      </div>
      {plan.results.length === 0 && <p>聞けるノードがありません。</p>}
      {plan.results.map((r) => (
        <div key={r.node} className="mb-3 last:mb-0" data-testid="plan-node">
          {many && <h4 className="font-mono font-semibold text-gray-900">{r.node}</h4>}
          {r.error !== undefined ? (
            <p className="text-red-800">{explainError(r.code, r.error)}</p>
          ) : !r.plan ? (
            <p className="text-gray-700">このノードでは停止中のため、rproxy には聞いていません（再開するときにこの内容で作ります）。</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{r.plan.rule}</span>
                <span className="badge bg-white text-gray-900 border border-gray-300">{PLAN_ACTION_LABELS[r.plan.action] ?? r.plan.action}</span>
                <span className={`badge ${CHANGE_CLASS[r.plan.change] ?? 'bg-gray-100 text-gray-800'}`} data-testid="plan-change">{PLAN_CHANGE_LABELS[r.plan.change] ?? r.plan.change}</span>
              </p>
              {r.plan.diff.length > 0 ? (
                <div className="table-scroll mt-2">
                  <table className="data-table text-xs" data-testid="plan-diff">
                    <thead>
                      <tr><th scope="col">項目</th><th scope="col">今</th><th scope="col">保存した後</th></tr>
                    </thead>
                    <tbody>
                      {r.plan.diff.map((d) => (
                        <tr key={d.path}>
                          <td className="font-mono break-all">{d.path}</td>
                          <td className="font-mono break-all text-red-900">{diffValue(d.before)}</td>
                          <td className="font-mono break-all text-green-900">{diffValue(d.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : r.plan.action !== 'delete' && <p className="mt-1 text-gray-700">違いはありません。</p>}
              {r.plan.warnings.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-amber-900">
                  {r.plan.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
};

export default PlanView;
