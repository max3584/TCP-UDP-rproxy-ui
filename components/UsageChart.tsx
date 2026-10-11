// 利用量（#101）の棒グラフ：区切りごと（簡易）か、期間の中のポートごと（詳細）に rx（受信）と tx（送信）を積み上げる。SVG で描き、棒に乗ると値を出し、表でも見られる。
// 色は rx が青、tx が橙（2 色の組み合わせは色覚の違いでも見分けられることを確かめた）。凡例と表があるので色だけには頼らない
import React, { useEffect, useState } from 'react';
import { formatBytes, formatCount } from './dashboard';
import { PORT_BARS, USAGE_RANGES } from './usage';
import type { PortUsage, PortUsageSeries, UsageBucket, UsageRange, UsageSeries } from './usage';
import { localeTag, t, tc } from '@/i18n/core';
import { errorDetail } from './ui';

export const RX_COLOR = '#2a78d6';
export const TX_COLOR = '#eb6834';

const RANGE_LABELS: Record<UsageRange, string> = { '24h': '24 時間', '7d': '7 日', '30d': '30 日', '12m': '12 か月' };
// グラフの上の説明（文ごとに訳すので組み立てない）
const BUCKET_TOTALS: Record<UsageBucket, string> = { hour: '1 時間ごとの合計', day: '1 日ごとの合計', month: '1 か月ごとの合計' };

// 区切りの名前（画面の言語・その端末の時刻）
export function bucketLabel(bucket: UsageBucket, iso: string, short = false): string {
  const d = new Date(iso);
  const tag = localeTag();
  if (bucket === 'hour') return d.toLocaleString(tag, short ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (bucket === 'day') return d.toLocaleDateString(tag, { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString(tag, { year: short ? undefined : 'numeric', month: 'short', timeZone: 'UTC' });
}

// ポートの名前（表・棒に乗ったとき）
export function portLabel(p: Pick<PortUsage, 'protocol' | 'port'>): string {
  return `${p.protocol.toUpperCase()} ${p.port}`;
}

// 目盛り：1・2・5 × 1024 の累乗のきりのよい上限
export function niceMax(max: number): number {
  if (max <= 0) return 1024;
  const exp = Math.floor(Math.log(max) / Math.log(1024));
  const unit = 1024 ** Math.max(0, exp);
  const v = max / unit;
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 1024].find((s) => s >= v) ?? 1024;
  return step * unit;
}

// グラフの 1 本：tick は横軸の名前、name は棒に乗ったときの名前
export interface Bar {
  key: string;
  tick: string;
  name: string;
  rx: number;
  tx: number;
  connections: number;
}

// ポートごとの棒：多い順に PORT_BARS 本、残りは「その他」の 1 本
export function portBars(ports: PortUsage[]): Bar[] {
  const bars: Bar[] = ports.slice(0, PORT_BARS).map((p) => ({
    key: `${p.protocol}/${p.port}`, tick: String(p.port), name: portLabel(p), rx: p.rx, tx: p.tx, connections: p.connections,
  }));
  const rest = ports.slice(PORT_BARS);
  if (rest.length > 0) {
    bars.push({
      key: 'other', tick: t('その他'), name: t('その他（{count} ポート）', { count: rest.length }),
      rx: rest.reduce((a, p) => a + p.rx, 0), tx: rest.reduce((a, p) => a + p.tx, 0), connections: rest.reduce((a, p) => a + p.connections, 0),
    });
  }
  return bars;
}

function timeBars(series: UsageSeries): Bar[] {
  return series.points.map((p) => ({
    key: p.at, tick: bucketLabel(series.bucket, p.at, true), name: bucketLabel(series.bucket, p.at), rx: p.rx, tx: p.tx, connections: p.connections,
  }));
}

const W = 720;
const H = 200;
const PAD = { left: 64, right: 8, top: 8, bottom: 24 };

const Chart: React.FC<{ bars: Bar[]; title: string; testId: string; everyTick?: boolean }> = ({ bars, title, testId, everyTick = false }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...bars.map((p) => p.rx + p.tx)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, bars.length);
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  // ポートは 1 本ずつ名前を出す（多くても PORT_BARS + 1 本）。時間は 6 つほど
  const tickEvery = everyTick ? 1 : Math.ceil(bars.length / 6);
  const hp: Bar | null = hover !== null ? bars[hover] : null;
  // 上の端だけ丸める（4px）。高さが足りなければ丸めない
  const topBar = (x: number, top: number, h: number) => {
    const r = Math.min(4, barW / 2, h);
    return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`;
  };
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={title} data-testid={testId}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(max * f)} y2={y(max * f)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(max * f) + 4} textAnchor="end" fontSize={11} fill="#4b5563">{formatBytes(max * f)}</text>
          </g>
        ))}
        {bars.map((p, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const rxH = (p.rx / max) * plotH;
          const txH = (p.tx / max) * plotH;
          const base = PAD.top + plotH;
          // 2 つの塊の間は 2px あける（小さすぎる塊は描かない）
          const gap = rxH > 0 && txH > 0 ? 2 : 0;
          return (
            <g key={p.key}>
              {rxH > 0 && (txH > 0
                ? <rect x={x} y={base - rxH} width={barW} height={Math.max(0, rxH)} fill={RX_COLOR} />
                : <path d={topBar(x, base - rxH, rxH)} fill={RX_COLOR} />)}
              {txH > gap && <path d={topBar(x, base - rxH - txH, txH - gap)} fill={TX_COLOR} />}
              {hover === i && <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="#111827" opacity={0.06} />}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH + PAD.bottom} fill="transparent"
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              {i % tickEvery === 0 && (
                <text x={PAD.left + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#4b5563">{p.tick}</text>
              )}
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#9ca3af" strokeWidth={1} />
      </svg>
      {hp && (
        <div className="pointer-events-none absolute top-0 right-0 rounded-sm border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 shadow-xs" data-testid="usage-tooltip">
          <div className="font-semibold">{hp.name}</div>
          <div><span className="inline-block w-2 h-2 mr-1" style={{ background: RX_COLOR }} />rx {formatBytes(hp.rx)}</div>
          <div><span className="inline-block w-2 h-2 mr-1" style={{ background: TX_COLOR }} />tx {formatBytes(hp.tx)}</div>
          <div>接続 {formatCount(hp.connections)}</div>
        </div>
      )}
    </div>
  );
};

type UsageResponse = { available: boolean; by?: 'port'; status?: { intervalSecs: number; lastRun: string | null; error: string | null } }
  & Partial<UsageSeries> & Partial<PortUsageSeries>;

// 利用量のカード（期間の切り替え・簡易／詳細・合計・グラフ・表）。query は /api/forward/usage に足す条件（ルールの指定）。
// 簡易は時間の推移、詳細は期間の中の待ち受けのポートごと（ルールを指定したカードは 1 つのルールなので出さない）
export const UsagePanel: React.FC<{ query?: string; title: string; id: string }> = ({ query = '', title, id }) => {
  const [range, setRange] = useState<UsageRange>('24h');
  const [detail, setDetail] = useState(false);
  const byPort = detail && !query;
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/forward/usage?range=${range}${byPort ? '&by=port' : ''}${query ? `&${query}` : ''}`);
        if (!res.ok) throw new Error(await errorDetail(res));
        const body = await res.json() as UsageResponse;
        if (alive) {
          setData(body);
          setError('');
        }
      } catch (err) {
        if (alive) setError(`利用量を取得できませんでした: ${err instanceof Error ? err.message : err}`);
      }
    };
    void load();
    return () => { alive = false; };
  }, [range, query, byPort]);
  // 切り替えの直後は前の形の応答が残るので、形が合うときだけ出す
  const series = data?.available && !byPort && data.points ? data as UsageSeries : null;
  const ports = data?.available && byPort && data.by === 'port' && data.ports ? data as PortUsageSeries : null;
  const total = series?.total ?? ports?.total;
  const button = (on: boolean) => `px-2 py-1 text-xs max-lg:min-h-11 ${on ? 'bg-blue-700 text-white' : 'bg-white text-gray-800 hover:bg-gray-100'}`;
  return (
    <section className="card p-4" aria-labelledby={id} data-testid="usage-panel">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h2 id={id} className="card-title mr-auto">{title}</h2>
        <div role="group" aria-label="期間" className="inline-flex rounded-sm border border-gray-300 overflow-hidden">
          {USAGE_RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={button(range === r)}>
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        {!query && (
          <div role="group" aria-label="表示" className="inline-flex rounded-sm border border-gray-300 overflow-hidden">
            <button type="button" aria-pressed={!detail} onClick={() => setDetail(false)} className={button(!detail)} title="時間の推移">簡易</button>
            <button type="button" aria-pressed={detail} onClick={() => setDetail(true)} className={button(detail)} title="ポートごと">{tc('詳細', 'usage')}</button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-red-800">{error}</p>}
      {data && !data.available && (
        <p className="text-sm text-gray-700">利用量を集計していません（DB に db/migrations/010_usage.sql を適用すると、UI が rproxy の統計を貯めます）。</p>
      )}
      {data?.status?.intervalSecs === 0 && <p className="text-xs text-gray-700 mb-2">集計は止めています（RPROXY_UI_USAGE_SECS=0）。</p>}
      {data?.status?.error && <p className="text-xs text-amber-900 mb-2">最後の集計の問題: {data.status.error}</p>}
      {total && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-900 mb-2">
          <div><dt className="inline text-gray-600">合計 </dt><dd className="inline font-semibold">{formatBytes(total.rx + total.tx)}</dd></div>
          <div><dt className="inline text-gray-600"><span className="inline-block w-2 h-2 mr-1" style={{ background: RX_COLOR }} />rx（受信） </dt><dd className="inline">{formatBytes(total.rx)}</dd></div>
          <div><dt className="inline text-gray-600"><span className="inline-block w-2 h-2 mr-1" style={{ background: TX_COLOR }} />tx（送信） </dt><dd className="inline">{formatBytes(total.tx)}</dd></div>
          <div><dt className="inline text-gray-600">接続 </dt><dd className="inline">{formatCount(total.connections)}</dd></div>
        </dl>
      )}
      {series && (
        <>
          <p className="text-xs text-gray-600 mb-1" data-testid="usage-bucket">{BUCKET_TOTALS[series.bucket]}</p>
          <Chart bars={timeBars(series)} title={title} testId="usage-chart" />
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-gray-800">表で見る</summary>
            <div className="table-scroll mt-1">
              <table className="data-table text-xs" data-testid="usage-table">
                <thead><tr><th scope="col">期間</th><th scope="col" className="text-right">rx（受信）</th><th scope="col" className="text-right">tx（送信）</th><th scope="col" className="text-right">接続</th></tr></thead>
                <tbody>
                  {series.points.filter((p) => p.rx + p.tx + p.connections > 0).map((p) => (
                    <tr key={p.at}>
                      <td className="whitespace-nowrap">{bucketLabel(series.bucket, p.at)}</td>
                      <td className="text-right tabular-nums">{formatBytes(p.rx)}</td>
                      <td className="text-right tabular-nums">{formatBytes(p.tx)}</td>
                      <td className="text-right tabular-nums">{formatCount(p.connections)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {ports && (
        <>
          <p className="text-xs text-gray-600 mb-1" data-testid="usage-bucket">待ち受けのポートごとの期間の合計（多い順）</p>
          {ports.ports.length === 0
            ? <p className="text-sm text-gray-700">この期間の通信はありません。</p>
            : <Chart bars={portBars(ports.ports)} title={title} testId="usage-port-chart" everyTick />}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-gray-800">表で見る</summary>
            <div className="table-scroll mt-1">
              <table className="data-table text-xs" data-testid="usage-port-table">
                <thead><tr><th scope="col">ポート</th><th scope="col" className="text-right">rx（受信）</th><th scope="col" className="text-right">tx（送信）</th><th scope="col" className="text-right">合計</th><th scope="col" className="text-right">接続</th></tr></thead>
                <tbody>
                  {ports.ports.map((p) => (
                    <tr key={`${p.protocol}/${p.port}`}>
                      <td className="whitespace-nowrap">{portLabel(p)}</td>
                      <td className="text-right tabular-nums">{formatBytes(p.rx)}</td>
                      <td className="text-right tabular-nums">{formatBytes(p.tx)}</td>
                      <td className="text-right tabular-nums">{formatBytes(p.rx + p.tx)}</td>
                      <td className="text-right tabular-nums">{formatCount(p.connections)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {(series || ports) && (
        <p className="mt-1 text-xs text-gray-600">
          UI が rproxy の統計を定期的に取って貯めた値です（rproxy を再起動しても続きます）。時刻は UTC の区切りで集計します。
        </p>
      )}
    </section>
  );
};

export default UsagePanel;
