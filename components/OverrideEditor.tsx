// ルールの詳細のノードのタブの「このノードだけの設定（上書き）」（#98）。グループのルールだけで出す
import React, { useState } from 'react';
import type { Balance, ForwardRules } from './lib';
import { BALANCES } from './lib';
import { NodeOverride, formatTargetsText, parseTargetsText } from './overrides';
import { BALANCE_LABELS, hostPort, targetLabel } from './dashboard';
import { errorDetail } from './ui';

type DestMode = 'group' | 'single' | 'multi';

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const labelClass = 'block text-sm font-medium text-gray-800 mb-1';
const helpClass = 'mt-1 text-xs text-gray-600';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

const OverrideEditor: React.FC<{ rule: ForwardRules; node: string; onSaved: (message: string) => void; onError: (message: string) => void }> = ({ rule, node, onSaved, onError }) => {
  const ov: NodeOverride = rule.overrides?.[node] ?? {};
  const [srcAddr, setSrcAddr] = useState(ov.srcAddr ?? '');
  const [extraText, setExtraText] = useState((ov.extraListenAddrs ?? []).join('\n'));
  const [extraOn, setExtraOn] = useState(ov.extraListenAddrs !== undefined);
  const [destMode, setDestMode] = useState<DestMode>(ov.targets ? 'multi' : ov.distAddr !== undefined ? 'single' : 'group');
  const [distAddr, setDistAddr] = useState(ov.distAddr ?? '');
  const [distPort, setDistPort] = useState<number | ''>(ov.distPort ?? '');
  const [targetsText, setTargetsText] = useState(formatTargetsText(ov.targets ?? []));
  const [balance, setBalance] = useState<Balance>(ov.balance ?? 'round_robin');
  const [allowOn, setAllowOn] = useState(ov.allowFrom !== undefined);
  const [allowText, setAllowText] = useState((ov.allowFrom ?? []).join('\n'));
  const [paused, setPaused] = useState(ov.enabled === false);
  const [busy, setBusy] = useState(false);
  const hasOverride = rule.overrides?.[node] !== undefined;

  const send = async (override: Record<string, unknown> | null) => {
    setBusy(true);
    try {
      const res = await fetch('/api/forward/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: rule.protocol, srcAddr: rule.srcAddr, srcPort: rule.srcPort, target: rule.target, node: node, override: override }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      onSaved(override === null ? '上書きを外しました。' : '上書きを保存し、このノードに反映しました。');
    } catch (err) {
      onError(`上書きを保存できませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const out: Record<string, unknown> = {};
    if (srcAddr.trim() !== '') out.srcAddr = srcAddr.trim();
    if (extraOn) out.extraListenAddrs = lines(extraText);
    try {
      if (destMode === 'single') {
        out.distAddr = distAddr.trim();
        out.distPort = distPort === '' ? 0 : distPort;
      } else if (destMode === 'multi') {
        out.targets = parseTargetsText(targetsText);
        out.balance = balance;
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (allowOn) out.allowFrom = lines(allowText);
    if (paused) out.enabled = false;
    void send(Object.keys(out).length === 0 ? null : out);
  };

  const http = rule.http !== null;
  return (
    <section className="card p-4" aria-labelledby="section-override" data-testid="override-editor">
      <h2 id="section-override" className="card-title mb-1">このノードだけの設定（上書き）</h2>
      <p className="text-xs text-gray-600 mb-3">
        空欄・「グループと同じ」の項目はグループの設定を使います。保存すると、このノードにだけすぐ反映します（ほかのノードは変えません。履歴に残ります）。
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <label htmlFor="ov-src-addr" className={labelClass}>待ち受けアドレス</label>
          <input id="ov-src-addr" className={inputClass} value={srcAddr} placeholder={rule.srcAddr} onChange={(e) => setSrcAddr(e.target.value)} />
          <p className={helpClass}>グループ: <span className="font-mono">{rule.srcAddr}</span></p>
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={extraOn} onChange={(e) => setExtraOn(e.target.checked)} />
            追加の待ち受けアドレスを上書きする
          </label>
          {extraOn && (
            <textarea aria-label="追加の待ち受けアドレス（1 行に 1 件）" className={`${inputClass} mt-1 h-16 font-mono text-xs`} value={extraText} onChange={(e) => setExtraText(e.target.value)} />
          )}
        </div>
        {!http && (
          <div className="md:col-span-2">
            <label htmlFor="ov-dest" className={labelClass}>転送先</label>
            <select id="ov-dest" className={inputClass} value={destMode} onChange={(e) => setDestMode(e.target.value as DestMode)}>
              <option value="group">グループと同じ</option>
              <option value="single">1 つの転送先</option>
              <option value="multi">複数の宛先</option>
            </select>
            <p className={helpClass}>グループ: <span className="font-mono">{targetLabel(rule)}</span></p>
            {destMode === 'single' && (
              <div className="mt-2 flex flex-wrap gap-2">
                <input aria-label="転送先のアドレス" className={`${inputClass} sm:w-64`} value={distAddr} placeholder="192.0.2.10" onChange={(e) => setDistAddr(e.target.value)} />
                <input aria-label="転送先のポート" type="number" min={1} max={65535} className={`${inputClass} sm:w-28`} value={distPort}
                  onChange={(e) => setDistPort(e.target.value === '' ? '' : Number(e.target.value))} />
                {distAddr && distPort !== '' && <span className="self-center text-xs text-gray-700 font-mono">{hostPort(distAddr, distPort)}</span>}
              </div>
            )}
            {destMode === 'multi' && (
              <div className="mt-2 space-y-2">
                <textarea aria-label="宛先（1 行に「アドレス:ポート [重み] [backup]」）" className={`${inputClass} h-20 font-mono text-xs`} value={targetsText}
                  placeholder={'192.0.2.11:443\n192.0.2.12:443 2\n192.0.2.13:443 backup'} onChange={(e) => setTargetsText(e.target.value)} />
                <select aria-label="振り分け方" className={`${inputClass} sm:w-64`} value={balance} onChange={(e) => setBalance(e.target.value as Balance)}>
                  {BALANCES.map((b) => <option key={b} value={b}>{BALANCE_LABELS[b]}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={allowOn} onChange={(e) => setAllowOn(e.target.checked)} />
            接続を許可する送信元を上書きする
          </label>
          {allowOn && (
            <textarea aria-label="接続を許可する送信元（1 行に 1 件。空ならすべて許可）" className={`${inputClass} mt-1 h-16 font-mono text-xs`} value={allowText} onChange={(e) => setAllowText(e.target.value)} />
          )}
          <p className={helpClass}>グループ: {rule.allowFrom.length > 0 ? <span className="font-mono">{rule.allowFrom.join(', ')}</span> : 'すべて許可'}</p>
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            このノードだけ一時停止する
          </label>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '上書きを保存'}</button>
        {hasOverride && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void send(null)}>上書きを外す</button>}
      </div>
    </section>
  );
};

export default OverrideEditor;
