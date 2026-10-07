// RuleForm の「制限・GeoIP」タブ（v0.4：ラベル・L4 の制限・帯域の上限・GeoIP・受け身のヘルスチェック）。
// rproxy が features で使えると言う項目だけ編集でき、使えない項目に値があれば読み取り専用で出してそのまま残す
import React from 'react';
import type { Protocol } from './lib';
import { MAX_LABELS, V04_LABELS, v04Fields } from './v04';
import type { V04Key, V04Settings } from './v04';
import type { RateRow, V04Form } from './v04form';

export interface LimitsEditorProps {
  value: V04Form;
  onChange: (v: V04Form) => void;
  protocol: Protocol;
  l7: boolean;
  // 編集できる項目（GET /capabilities の features）
  available: Record<V04Key, boolean>;
  // 編集を始めたときの値（使えない項目を読み取り専用で出す）
  current: V04Settings;
  error: string;
}

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const monoInput = `${inputClass} font-mono`;
const labelClass = 'block text-xs font-medium text-gray-800 mb-1';
const helpClass = 'mt-1 text-xs text-gray-600';
const headingClass = 'text-sm font-semibold text-gray-900 mb-1';
const smallButton = 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-2 py-1 rounded-sm text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11';
const removeButton = 'shrink-0 whitespace-nowrap text-red-700 hover:text-red-900 text-sm px-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';

// 使えない項目の説明（値があれば読み取り専用で残す）
const Unavailable: React.FC<{ field: V04Key; current: V04Settings }> = ({ field, current }) => {
  const value = v04Fields(current)[field];
  return (
    <div className="text-xs text-gray-700" data-testid={`v04-unavailable-${field}`}>
      {value !== undefined ? (
        <>
          <p className="rounded-sm border border-amber-300 bg-amber-50 text-amber-900 px-2 py-1">
            この rproxy では使えないため編集できません（設定はそのまま保ちます。rproxy-api v0.4 以降が必要です）。
          </p>
          <pre className="mt-1 font-mono whitespace-pre-wrap break-all bg-gray-50 text-gray-900 border border-gray-200 rounded-sm p-2">{JSON.stringify(value, null, 2)}</pre>
        </>
      ) : (
        <p>この rproxy では使えません（rproxy-api v0.4 以降で、GET /capabilities の features が対応しているとき）。</p>
      )}
    </div>
  );
};

const Field: React.FC<{ id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; mono?: boolean }> = ({ id, label, value, onChange, placeholder, help, mono }) => (
  <div>
    <label htmlFor={id} className={labelClass}>{label}</label>
    <input id={id} type="text" inputMode={mono ? undefined : 'numeric'} value={value} onChange={(e) => onChange(e.target.value)}
      className={mono ? monoInput : inputClass} placeholder={placeholder} aria-describedby={help ? `${id}-help` : undefined} />
    {help && <p id={`${id}-help`} className={helpClass}>{help}</p>}
  </div>
);

const RateFields: React.FC<{ id: string; label: string; value: RateRow; onChange: (v: RateRow) => void }> = ({ id, label, value, onChange }) => (
  <fieldset className="sm:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
    <legend className={labelClass}>{label}</legend>
    <Field id={`${id}-average`} label="平均（回）" value={value.average} onChange={(v) => onChange({ ...value, average: v })} placeholder="10" />
    <Field id={`${id}-period`} label="期間（既定 1s）" value={value.period} onChange={(v) => onChange({ ...value, period: v })} placeholder="1s" mono />
    <Field id={`${id}-burst`} label="バースト（既定は平均）" value={value.burst} onChange={(v) => onChange({ ...value, burst: v })} placeholder="20" />
  </fieldset>
);

const LimitsEditor: React.FC<LimitsEditorProps> = ({ value, onChange, protocol, l7, available, current, error }) => {
  const set = (patch: Partial<V04Form>) => onChange({ ...value, ...patch });
  const section = 'mb-5 border-b border-gray-200 pb-4';
  return (
    <div data-testid="limits-editor">
      <p className="text-xs text-gray-700 mb-3">
        送信元ごとの接続の制限・帯域・国や AS での許可と拒否・転送先を一時的に外す設定です（rproxy-api v0.4）。空欄の項目は使いません。
        どれも接続を切らずに変えられます。
      </p>

      <section className={section} aria-labelledby="v04-labels-heading">
        <h3 id="v04-labels-heading" className={headingClass}>{V04_LABELS.labels}</h3>
        {available.labels ? (
          <>
            <p className={helpClass} id="v04-labels-help">
              所有者・テナント・サービスなどの印（例 tenant=act）。動きには使わず、rproxy のログ・/metrics と、UI の利用量の集計に使います。最大 {MAX_LABELS} 個。
            </p>
            {value.labels.map((row, i) => (
              <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-1 mt-1" data-testid="label-row">
                <input type="text" value={row.key} className={monoInput} placeholder="tenant" aria-label={`ラベル ${i + 1} のキー`}
                  aria-describedby="v04-labels-help" onChange={(e) => set({ labels: value.labels.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)) })} />
                <input type="text" value={row.value} className={monoInput} placeholder="act" aria-label={`ラベル ${i + 1} の値`}
                  onChange={(e) => set({ labels: value.labels.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })} />
                <button type="button" className={removeButton} aria-label={`ラベル ${i + 1} を削除`}
                  onClick={() => set({ labels: value.labels.filter((_, j) => j !== i) })}>削除</button>
              </div>
            ))}
            {value.labels.length < MAX_LABELS && (
              <button type="button" className={`${smallButton} mt-2`} onClick={() => set({ labels: [...value.labels, { key: '', value: '' }] })}>＋ ラベルを追加</button>
            )}
          </>
        ) : <Unavailable field="labels" current={current} />}
      </section>

      <section className={section} aria-labelledby="v04-limits-heading">
        <h3 id="v04-limits-heading" className={headingClass}>{V04_LABELS.limits}</h3>
        {available.limits ? (
          <>
            <p className={helpClass}>
              超えた接続は、TLS や PROXY ヘッダより前にすぐ閉じます{protocol === 'udp' ? '（UDP はデータグラムを捨て、新しいセッションを作りません）' : ''}。断った数は統計の「制限で断った接続」に出ます。
            </p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field id="v04-max-connections" label={protocol === 'udp' ? 'ルール全体の同時セッション数' : 'ルール全体の同時接続数'} value={value.maxConnections}
                onChange={(v) => set({ maxConnections: v })} placeholder="20000" help="1〜10,000,000" />
              <Field id="v04-source-max-connections" label={protocol === 'udp' ? '送信元ごとの同時セッション数' : '送信元ごとの同時接続数'} value={value.sourceMaxConnections}
                onChange={(v) => set({ sourceMaxConnections: v })} placeholder="8" help="1〜1,000,000" />
              <Field id="v04-max-sources" label="覚える送信元の数（既定 65536）" value={value.maxSources} onChange={(v) => set({ maxSources: v })} placeholder="65536" />
              <RateFields id="v04-new-connections" label={protocol === 'udp' ? '送信元ごとの新しいセッションの速さ' : '送信元ごとの新しい接続の速さ'}
                value={value.newConnections} onChange={(v) => set({ newConnections: v })} />
              {protocol === 'udp' && (
                <RateFields id="v04-packets" label="送信元ごとのデータグラムの速さ（UDP だけ）" value={value.packets} onChange={(v) => set({ packets: v })} />
              )}
              <Field id="v04-prefix-v4" label="送信元をまとめる大きさ（IPv4、既定 32）" value={value.sourcePrefixV4} onChange={(v) => set({ sourcePrefixV4: v })} placeholder="32" />
              <Field id="v04-prefix-v6" label="送信元をまとめる大きさ（IPv6、既定 64）" value={value.sourcePrefixV6} onChange={(v) => set({ sourcePrefixV6: v })} placeholder="64" />
            </div>
          </>
        ) : <Unavailable field="limits" current={current} />}
      </section>

      <section className={section} aria-labelledby="v04-bandwidth-heading">
        <h3 id="v04-bandwidth-heading" className={headingClass}>{V04_LABELS.bandwidth}</h3>
        {available.bandwidth ? (
          <>
            <p className={helpClass}>
              速さは 500kbps・10Mbps・1Gbps のように（ビット毎秒、8kbps〜100Gbps）。上りはクライアント → 転送先、下りは転送先 → クライアント。
              {protocol === 'udp' ? 'UDP は超えた分のデータグラムを捨てます。' : 'TCP は読むのを遅らせて待たせます（捨てません）。'}
            </p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field id="v04-upload" label="ルール全体の上り" value={value.upload} onChange={(v) => set({ upload: v })} placeholder="100Mbps" mono />
              <Field id="v04-download" label="ルール全体の下り" value={value.download} onChange={(v) => set({ download: v })} placeholder="500Mbps" mono />
              <Field id="v04-burst" label="バースト（既定 100ms 分）" value={value.burst} onChange={(v) => set({ burst: v })} placeholder="1MiB" mono help="1KiB〜1GiB" />
              <Field id="v04-source-upload" label="送信元ごとの上り" value={value.sourceUpload} onChange={(v) => set({ sourceUpload: v })} placeholder="2Mbps" mono />
              <Field id="v04-source-download" label="送信元ごとの下り" value={value.sourceDownload} onChange={(v) => set({ sourceDownload: v })} placeholder="10Mbps" mono />
              <Field id="v04-bw-max-sources" label="覚える送信元の数（既定 65536）" value={value.bwMaxSources} onChange={(v) => set({ bwMaxSources: v })} placeholder="65536" />
              <Field id="v04-bw-prefix-v4" label="送信元をまとめる大きさ（IPv4、既定 32）" value={value.bwPrefixV4} onChange={(v) => set({ bwPrefixV4: v })} placeholder="32" />
              <Field id="v04-bw-prefix-v6" label="送信元をまとめる大きさ（IPv6、既定 64）" value={value.bwPrefixV6} onChange={(v) => set({ bwPrefixV6: v })} placeholder="64" />
            </div>
          </>
        ) : <Unavailable field="bandwidth" current={current} />}
      </section>

      <section className={section} aria-labelledby="v04-geoip-heading">
        <h3 id="v04-geoip-heading" className={headingClass}>{V04_LABELS.geoip}</h3>
        {available.geoip ? (
          <>
            <p className={helpClass}>
              国は ISO 3166-1 alpha-2 の 2 文字（JP, US）、AS は番号（64496 か AS64496）をカンマか空白で区切ります。拒否に当たれば断り、許可を書けば許可に当たるものだけを通します。
              国のリストには rproxy の設定ファイルの global.geoip.country_db、AS のリストには asn_db が要ります。
            </p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field id="v04-allow-countries" label="許可する国" value={value.allowCountries} onChange={(v) => set({ allowCountries: v })} placeholder="JP, US" mono />
              <Field id="v04-deny-countries" label="拒否する国" value={value.denyCountries} onChange={(v) => set({ denyCountries: v })} placeholder="" mono />
              <Field id="v04-allow-asns" label="許可する AS" value={value.allowAsns} onChange={(v) => set({ allowAsns: v })} placeholder="" mono />
              <Field id="v04-deny-asns" label="拒否する AS" value={value.denyAsns} onChange={(v) => set({ denyAsns: v })} placeholder="64496" mono />
              <div>
                <label htmlFor="v04-geoip-unknown" className={labelClass}>判定できないとき（データベースにない・私用アドレス）</label>
                <select id="v04-geoip-unknown" className={inputClass} value={value.unknown} onChange={(e) => set({ unknown: e.target.value === 'deny' ? 'deny' : 'allow' })}>
                  <option value="allow">許可する（既定）</option>
                  <option value="deny">拒否する</option>
                </select>
              </div>
            </div>
            {l7 && <p className={helpClass}>L7 のルールでは接続元の IP で判定します。前段のプロキシの後ろでは、L7 タブのミドルウェアの geoip を使ってください。</p>}
          </>
        ) : <Unavailable field="geoip" current={current} />}
      </section>

      <section className="mb-2" aria-labelledby="v04-outlier-heading">
        <h3 id="v04-outlier-heading" className={headingClass}>{V04_LABELS.outlier_detection}</h3>
        {l7 ? (
          <p className="text-xs text-gray-700">L7 のルールでは、L7 (HTTP) タブのサービスごとに設定します。</p>
        ) : available.outlier_detection ? (
          <>
            <p className={helpClass}>
              転送先への接続が続けて失敗したら、その転送先をしばらく外します（外すたびに時間を倍にし、上限で止めます）。宛先が複数のルールで効きます。空欄なら今までどおり（1 回の失敗で 10 秒外す）。
            </p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field id="v04-consecutive-failures" label="続けて失敗した回数（既定 1）" value={value.consecutiveFailures} onChange={(v) => set({ consecutiveFailures: v })} placeholder="3" />
              <Field id="v04-ejection-time" label="最初に外す時間（既定 10s）" value={value.ejectionTime} onChange={(v) => set({ ejectionTime: v })} placeholder="10s" mono />
              <Field id="v04-max-ejection-time" label="外す時間の上限" value={value.maxEjectionTime} onChange={(v) => set({ maxEjectionTime: v })} placeholder="5m" mono />
              <Field id="v04-max-ejected-percent" label="同時に外せる割合（%、既定 100）" value={value.maxEjectedPercent} onChange={(v) => set({ maxEjectedPercent: v })} placeholder="50" />
              <Field id="v04-short-lived" label="短すぎる接続も失敗に数える（既定 0s：数えない）" value={value.shortLived} onChange={(v) => set({ shortLived: v })} placeholder="0s" mono help="0s〜1m" />
            </div>
          </>
        ) : <Unavailable field="outlier_detection" current={current} />}
      </section>

      {error && <p className="text-red-700 text-xs mt-1" role="alert">{error}</p>}
    </div>
  );
};

export default LimitsEditor;
