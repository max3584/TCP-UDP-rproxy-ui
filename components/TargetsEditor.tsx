// RuleForm の「基本」タブの、宛先を複数にしたときの入力（宛先の一覧・振り分け方・ヘルスチェック）
import React from 'react';
import { BALANCES, Balance, Protocol } from './lib';
import { BALANCE_LABELS } from './dashboard';
import { BALANCE_HELP, EMPTY_ROW, HealthCheckRow, TargetRow, moveRow } from './targets';

interface Props {
  protocol: Protocol;
  rows: TargetRow[];
  onRowsChange: (rows: TargetRow[]) => void;
  balance: Balance;
  onBalanceChange: (balance: Balance) => void;
  healthCheck: HealthCheckRow;
  onHealthCheckChange: (hc: HealthCheckRow) => void;
  // ポート範囲のルールでは各宛先のポートも範囲の分ずれる
  range: boolean;
  // 単一の宛先に戻す（1 件目を残す）
  onSingle: () => void;
  error: string;
}

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const smallButtonClass = 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-2 py-1 rounded-sm text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 max-lg:min-h-11 max-lg:min-w-11';
const removeButtonClass = 'text-red-700 hover:text-red-900 text-sm px-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';
// 幅を決めない入力欄（名前ごとの宛先の 1 行に並べる）
const routeInputClass = 'border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11';
const labelClass = 'block text-sm font-medium text-gray-800 mb-1';
const helpClass = 'mt-1 text-xs text-gray-600';

const toNumber = (value: string): number | '' => (value === '' ? '' : Number(value));

const TargetsEditor: React.FC<Props> = ({
  protocol, rows, onRowsChange, balance, onBalanceChange, healthCheck, onHealthCheckChange, range, onSingle, error,
}) => {
  const update = (index: number, patch: Partial<TargetRow>) => onRowsChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const hc = (patch: Partial<HealthCheckRow>) => onHealthCheckChange({ ...healthCheck, ...patch });

  return (
    <div className="mb-4" data-testid="targets-editor">
      <fieldset className="mb-3">
        <legend className={labelClass}>宛先{range ? '（ポートは範囲の先頭）' : ''}:</legend>
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="border border-gray-200 rounded-sm p-2 bg-gray-50">
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-sm text-gray-700 w-6" aria-hidden="true">{i + 1}.</span>
                <div className="flex-1 basis-full sm:basis-0 min-w-40">
                  <label htmlFor={`rule-target-addr-${i}`} className="text-xs text-gray-700">アドレス</label>
                  <input
                    id={`rule-target-addr-${i}`}
                    type="text"
                    className={inputClass}
                    value={r.addr}
                    placeholder="例: 10.0.0.11 または db1.internal"
                    aria-label={`宛先 ${i + 1} のアドレス`}
                    onChange={(e) => update(i, { addr: e.target.value.trim() })}
                  />
                </div>
                <div className="w-28">
                  <label htmlFor={`rule-target-port-${i}`} className="text-xs text-gray-700">ポート</label>
                  <input
                    id={`rule-target-port-${i}`}
                    type="number"
                    min="1"
                    max="65535"
                    className={inputClass}
                    value={r.port}
                    aria-label={`宛先 ${i + 1} のポート`}
                    onChange={(e) => update(i, { port: toNumber(e.target.value) })}
                  />
                </div>
                {balance !== 'failover' && (
                  <div className="w-20">
                    <label htmlFor={`rule-target-weight-${i}`} className="text-xs text-gray-700">重み</label>
                    <input
                      id={`rule-target-weight-${i}`}
                      type="number"
                      min="1"
                      max="1000"
                      className={inputClass}
                      value={r.weight}
                      placeholder="1"
                      aria-label={`宛先 ${i + 1} の重み`}
                      onChange={(e) => update(i, { weight: toNumber(e.target.value) })}
                    />
                  </div>
                )}
                <label className="flex items-center gap-1 text-sm text-gray-900 pb-1">
                  <input
                    type="checkbox"
                    checked={r.backup}
                    aria-label={`宛先 ${i + 1} を予備にする`}
                    onChange={(e) => update(i, { backup: e.target.checked })}
                  />
                  予備
                </label>
                <div className="flex gap-1 pb-1">
                  <button type="button" className={smallButtonClass} disabled={i === 0} onClick={() => onRowsChange(moveRow(rows, i, -1))} aria-label={`宛先 ${i + 1} を上へ`}>↑</button>
                  <button type="button" className={smallButtonClass} disabled={i === rows.length - 1} onClick={() => onRowsChange(moveRow(rows, i, 1))} aria-label={`宛先 ${i + 1} を下へ`}>↓</button>
                  <button
                    type="button"
                    className={removeButtonClass}
                    onClick={() => (rows.length <= 1 ? onSingle() : onRowsChange(rows.filter((_, j) => j !== i)))}
                    aria-label={`宛先 ${i + 1} を削除`}
                  >
                    削除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={smallButtonClass} onClick={() => onRowsChange([...rows, { ...EMPTY_ROW }])}>宛先を追加</button>
          <button type="button" className={smallButtonClass} onClick={onSingle}>単一の宛先に戻す</button>
        </div>
        <p className={helpClass}>
          予備の宛先は、予備でない宛先がすべて落ちたときだけ使います。フェイルオーバーでは上の宛先ほど優先します。
        </p>
      </fieldset>

      <div className="mb-3">
        <label htmlFor="rule-balance" className={labelClass}>振り分け方:</label>
        <select id="rule-balance" className={inputClass} value={balance} onChange={(e) => onBalanceChange(e.target.value as Balance)}>
          {BALANCES.map((b) => <option key={b} value={b}>{BALANCE_LABELS[b]}</option>)}
        </select>
        <p className={helpClass}>{BALANCE_HELP[balance]}</p>
      </div>

      <details className="mb-2" open={healthCheck.enabled || undefined}>
        <summary className="cursor-pointer text-sm font-medium text-gray-800">ヘルスチェック</summary>
        <div className="mt-2 pl-2">
          <label className="flex items-center gap-2 text-sm text-gray-900 mb-2">
            <input id="rule-hc-enabled" type="checkbox" checked={healthCheck.enabled} onChange={(e) => hc({ enabled: e.target.checked })} />
            TCP の接続で宛先の生死を定期的に確かめる
          </label>
          {healthCheck.enabled && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label htmlFor="rule-hc-interval" className="text-xs text-gray-700">間隔</label>
                <input id="rule-hc-interval" type="text" className={inputClass} value={healthCheck.interval} placeholder="10s" onChange={(e) => hc({ interval: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rule-hc-timeout" className="text-xs text-gray-700">タイムアウト</label>
                <input id="rule-hc-timeout" type="text" className={inputClass} value={healthCheck.timeout} placeholder="3s" onChange={(e) => hc({ timeout: e.target.value })} />
              </div>
              <div>
                <label htmlFor="rule-hc-port" className="text-xs text-gray-700">確かめるポート{protocol === 'udp' ? '（必須）' : ''}</label>
                <input id="rule-hc-port" type="number" min="1" max="65535" className={inputClass} value={healthCheck.port} placeholder={protocol === 'udp' ? 'TCP のポート' : '各宛先のポート'} onChange={(e) => hc({ port: toNumber(e.target.value) })} />
              </div>
            </div>
          )}
          <p className={helpClass}>
            {protocol === 'udp'
              ? 'UDP は接続がないので、宛先の生死は指定した TCP のポートへの接続で確かめます。フェイルオーバーで落ちた宛先を外すにはヘルスチェックが必要です。'
              : 'ヘルスチェックがなくても、接続に失敗した宛先はしばらく外し、次の宛先で接続し直します。'}
          </p>
        </div>
      </details>

      {error && <p className="text-red-700 text-xs mt-1" role="alert">{error}</p>}
    </div>
  );
};

// TLS のサーバ名ごとの転送先（tls.routes[]）の複数の宛先（rproxy の #234。features.tls_route_targets）。
// editable が false（その rproxy が使えない）なら読み取り専用で出す（値はそのまま送る）
export const RouteTargetsEditor: React.FC<{
  index: number;
  rows: TargetRow[];
  balance: Balance;
  editable: boolean;
  onChange: (rows: TargetRow[], balance: Balance) => void;
  onSingle: () => void;
}> = ({ index, rows, balance, editable, onChange, onSingle }) => {
  const n = index + 1;
  const update = (i: number, patch: Partial<TargetRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)), balance);
  if (!editable) {
    return (
      <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-sm px-2 py-1 mt-1 break-all" data-testid="tls-route-targets-preserved">
        <p>宛先: <span className="font-mono">{joinTargets(rows)}</span> · {BALANCE_LABELS[balance]}</p>
        <p>この rproxy では名前ごとの複数の宛先を使えないので編集できません。そのまま残して送ります。</p>
      </div>
    );
  }
  return (
    <div className="mt-1 ml-0 sm:ml-4 border-l-2 border-gray-200 pl-2" data-testid="tls-route-targets-editor">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1 mb-1">
          <input type="text" className={`${routeInputClass} w-full sm:w-auto sm:flex-1 min-w-0`} value={r.addr} placeholder="アドレス" aria-label={`転送先 ${n} の宛先 ${i + 1} のアドレス`}
            onChange={(e) => update(i, { addr: e.target.value.trim() })} />
          <input type="number" min="1" max="65535" className={`${routeInputClass} w-24`} value={r.port} placeholder="ポート" aria-label={`転送先 ${n} の宛先 ${i + 1} のポート`}
            onChange={(e) => update(i, { port: toNumber(e.target.value) })} />
          {balance !== 'failover' && (
            <input type="number" min="1" max="1000" className={`${routeInputClass} w-20`} value={r.weight} placeholder="重み 1" aria-label={`転送先 ${n} の宛先 ${i + 1} の重み`}
              onChange={(e) => update(i, { weight: toNumber(e.target.value) })} />
          )}
          <label className="flex items-center gap-1 text-sm text-gray-900">
            <input type="checkbox" checked={r.backup} aria-label={`転送先 ${n} の宛先 ${i + 1} を予備にする`} onChange={(e) => update(i, { backup: e.target.checked })} />
            予備
          </label>
          <button type="button" className={`${removeButtonClass} whitespace-nowrap`} aria-label={`転送先 ${n} の宛先 ${i + 1} を削除`}
            onClick={() => (rows.length <= 1 ? onSingle() : onChange(rows.filter((_, j) => j !== i), balance))}>削除</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={smallButtonClass} onClick={() => onChange([...rows, { ...EMPTY_ROW }], balance)}>宛先を追加</button>
        <label htmlFor={`rule-tls-route-balance-${index}`} className="text-xs text-gray-700">振り分け方</label>
        <select id={`rule-tls-route-balance-${index}`} className={routeInputClass} value={balance} onChange={(e) => onChange(rows, e.target.value as Balance)}>
          {BALANCES.map((b) => <option key={b} value={b}>{BALANCE_LABELS[b]}</option>)}
        </select>
        <button type="button" className={smallButtonClass} onClick={onSingle}>単一の宛先に戻す</button>
      </div>
      <p className={helpClass}>{BALANCE_HELP[balance]} つながらない宛先は次の宛先へ移り、しばらく外します。</p>
    </div>
  );
};

function joinTargets(rows: TargetRow[]): string {
  return rows.map((r) => `${r.addr}:${r.port}${r.weight !== '' ? `×${r.weight}` : ''}${r.backup ? '(backup)' : ''}`).join(', ');
}

export default TargetsEditor;
