// 利用量の集計表（/usage。#101）：月か日ごとに、所有者（テナント）・ラベル・ノード・ルールでまとめた通信量と CSV。
// 管理者はすべてのルール、利用者は自分のルールだけ（API が絞る）
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, errorDetail } from '@/components/ui';
import { formatBytes, formatCount } from '@/components/dashboard';
import { monthKey } from '@/components/usage';
import type { ReportLine, UsageGroup } from '@/components/usage';
import UsagePanel from '@/components/UsageChart';

interface ReportResponse {
  available: boolean;
  admin?: boolean;
  period?: string;
  group?: UsageGroup;
  lines?: ReportLine[];
  labelKeys?: string[];
  status?: { intervalSecs: number; hourlyDays: number; dailyDays: number; lastRun: string | null; error: string | null };
}

const GROUP_LABELS: Record<string, string> = { owner: '所有者', node: 'ノード', rule: 'ルール' };

const UsagePage: React.FC = () => {
  const [period, setPeriod] = useState(() => monthKey(new Date()));
  const [group, setGroup] = useState<UsageGroup>('owner');
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState('');
  const query = `report=1&period=${encodeURIComponent(period)}&group=${encodeURIComponent(group)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/forward/usage?${query}`);
      if (!res.ok) {
        setError(await errorDetail(res));
        return;
      }
      setData(await res.json() as ReportResponse);
      setError('');
    } catch (err) {
      setError(`読み込めませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, [query]);

  useEffect(() => {
    // load は await の後でだけ state を変える（同期の setState ではない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const groups: UsageGroup[] = ['owner', 'node', 'rule', ...(data?.labelKeys ?? []).map((k) => `label:${k}` as UsageGroup)];
  if (group.startsWith('label:') && !groups.includes(group)) groups.push(group);
  const groupLabel = (g: UsageGroup) => (g.startsWith('label:') ? `ラベル ${g.slice('label:'.length)}` : GROUP_LABELS[g] ?? g);
  const lines = data?.lines ?? [];
  const total = lines.reduce((a, l) => ({ rx: a.rx + l.rx, tx: a.tx + l.tx, connections: a.connections + l.connections }), { rx: 0, tx: 0, connections: 0 });

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>利用量</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">利用量</h1>
      <p className="text-sm text-gray-700">
        UI が rproxy の統計を定期的に取り、ルール・ノードごとに貯めた通信量です（時刻は UTC）。所有者は UI のルールを作った利用者、ラベルはルールの labels（tenant など）です。
        {data?.admin === false ? '自分のルールだけを集計します。' : ''}
      </p>
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}

      <UsagePanel id="usage-chart" title="通信量の推移" />

      <section className="card p-4" aria-labelledby="usage-report">
        <h2 id="usage-report" className="card-title mb-3">集計表</h2>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <label className="text-sm text-gray-900">
            <span className="block mb-1">月</span>
            <input type="month" value={period.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className="border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900 max-lg:min-h-11" />
          </label>
          <label className="text-sm text-gray-900">
            <span className="block mb-1">まとめ方</span>
            <select value={group} onChange={(e) => setGroup(e.target.value as UsageGroup)} className="border border-gray-300 rounded-sm px-2 py-1 bg-white text-gray-900 max-lg:min-h-11" data-testid="usage-group">
              {groups.map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
            </select>
          </label>
          <a href={`/api/forward/usage?${query}&format=csv`} className="btn-secondary" download>CSV をダウンロード</a>
        </div>
        {data && !data.available && <p className="text-sm text-gray-700">利用量を集計していません（DB に db/migrations/010_usage.sql を適用してください）。</p>}
        {data?.available && (
          lines.length === 0 ? <p className="text-sm text-gray-700">この期間の利用量はありません。</p> : (
            <div className="table-scroll">
              <table className="data-table" data-testid="usage-report-table">
                <thead>
                  <tr>
                    <th scope="col">{groupLabel(group)}</th>
                    <th scope="col" className="text-right">rx（受信）</th>
                    <th scope="col" className="text-right">tx（送信）</th>
                    <th scope="col" className="text-right">合計</th>
                    <th scope="col" className="text-right">接続</th>
                    <th scope="col" className="text-right">ルール</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key ?? ''}>
                      <td className="font-mono break-all">{l.key ?? <span className="font-sans text-gray-600">（なし）</span>}</td>
                      <td className="text-right tabular-nums">{formatBytes(l.rx)}</td>
                      <td className="text-right tabular-nums">{formatBytes(l.tx)}</td>
                      <td className="text-right tabular-nums font-semibold">{formatBytes(l.rx + l.tx)}</td>
                      <td className="text-right tabular-nums">{formatCount(l.connections)}</td>
                      <td className="text-right tabular-nums">{l.rules}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className="text-left text-gray-900">合計</th>
                    <td className="text-right tabular-nums">{formatBytes(total.rx)}</td>
                    <td className="text-right tabular-nums">{formatBytes(total.tx)}</td>
                    <td className="text-right tabular-nums font-semibold">{formatBytes(total.rx + total.tx)}</td>
                    <td className="text-right tabular-nums">{formatCount(total.connections)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        )}
        {data?.status && (
          <p className="mt-3 text-xs text-gray-600" data-testid="usage-settings">
            {data.status.intervalSecs === 0
              ? '集計は止めています（RPROXY_UI_USAGE_SECS=0）。'
              : `集計の間隔 ${data.status.intervalSecs} 秒、時間ごとの値は ${data.status.hourlyDays} 日・日ごとの値は ${data.status.dailyDays} 日残します（RPROXY_UI_USAGE_SECS・RPROXY_UI_USAGE_HOURLY_DAYS・RPROXY_UI_USAGE_DAILY_DAYS）。`}
          </p>
        )}
      </section>
    </div>
  );
};

export default UsagePage;
