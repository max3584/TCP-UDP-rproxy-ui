// ダッシュボード（Traefik のダッシュボードのように、プロトコルごとのカードと全ルールの表を出す）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { DashboardData, ForwardRules, Protocol, RuleState } from '@/components/lib';
import {
  EMPTY_FILTER,
  ProtocolSummary,
  RULE_STATES,
  RuleFilter,
  STATE_COLORS,
  STATE_LABELS,
  countsDescription,
  donutGradient,
  filterRules,
  formatBytes,
  formatCount,
  formatDuration,
  hostPort,
  needsAttention,
  portsLabel,
  ruleHref,
  ruleKeyOf,
  summarize,
  targetPortsLabel,
  tlsBreakdown,
  uptimeSecs,
} from '@/components/dashboard';
import { AutoRefreshToggle, ErrorBanner, StateBadge, TlsBadge, errorDetail, useAutoRefresh } from '@/components/ui';

const StatTile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> = ({ label, value, sub }) => (
  <div className="card p-4">
    <div className="text-xs font-semibold text-gray-600">{label}</div>
    <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
    {sub && <div className="mt-1 text-xs text-gray-600">{sub}</div>}
  </div>
);

const Donut: React.FC<{ summary: ProtocolSummary }> = ({ summary }) => (
  <div
    role="img"
    aria-label={`${summary.protocol.toUpperCase()} のルール ${summary.counts.total} 件: ${countsDescription(summary.counts)}`}
    className="relative h-28 w-28 shrink-0 rounded-full"
    style={{ background: donutGradient(summary.counts) }}
  >
    <div className="absolute inset-3 rounded-full bg-white text-gray-900 flex flex-col items-center justify-center">
      <span className="text-2xl font-bold leading-none">{summary.counts.total}</span>
      <span className="text-xs text-gray-600">ルール</span>
    </div>
  </div>
);

const Metric: React.FC<{ label: string; value: string; title?: string }> = ({ label, value, title }) => (
  <div title={title}>
    <dt className="text-xs text-gray-600">{label}</dt>
    <dd className="text-base font-semibold text-gray-900 tabular-nums">{value}</dd>
  </div>
);

const ProtocolCard: React.FC<{ summary: ProtocolSummary; reachable: boolean }> = ({ summary, reachable }) => {
  const pct = (n: number) => (summary.counts.total === 0 ? 0 : Math.round((n / summary.counts.total) * 100));
  return (
    <section className="card p-4" aria-labelledby={`card-${summary.protocol}`}>
      <h2 id={`card-${summary.protocol}`} className="card-title mb-3">{summary.protocol.toUpperCase()} ルール</h2>
      <div className="flex items-center gap-4">
        <Donut summary={summary} />
        <ul className="text-sm space-y-1 min-w-0">
          {RULE_STATES.map((s) => (
            <li key={s} className="flex items-center gap-2 text-gray-800">
              <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ background: STATE_COLORS[s] }} />
              <span className="w-14">{STATE_LABELS[s]}</span>
              <span className="font-semibold tabular-nums text-gray-900">{summary.counts[s]}</span>
              <span className="text-xs text-gray-600 tabular-nums">{pct(summary.counts[s])}%</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 border-t border-gray-100 pt-3">
        <Metric label={summary.protocol === 'udp' ? 'セッション' : '接続中'} value={reachable ? formatCount(summary.connections) : '-'} />
        <Metric label="累計の接続" value={reachable ? formatCount(summary.totalConnections) : '-'} />
        <Metric label="TLS 失敗" value={reachable ? formatCount(summary.tlsFailures) : '-'} title="TLS / DTLS のハンドシェイクと STARTTLS の失敗" />
        <Metric label="rx（受信）" value={reachable ? formatBytes(summary.rxBytes) : '-'} title="クライアント → 転送先" />
        <Metric label="tx（送信）" value={reachable ? formatBytes(summary.txBytes) : '-'} title="転送先 → クライアント" />
      </dl>
    </section>
  );
};

const TLS_SEGMENTS: { key: 'passthrough' | 'sni' | 'tls' | 'dtls'; label: string; color: string }[] = [
  { key: 'passthrough', label: 'passthrough', color: '#6b7280' },
  { key: 'sni', label: 'SNI 振り分け', color: '#2563eb' },
  { key: 'tls', label: 'TLS 終端', color: '#7c3aed' },
  { key: 'dtls', label: 'DTLS 終端', color: '#db2777' },
];

const TlsCard: React.FC<{ rules: ForwardRules[] }> = ({ rules }) => {
  const b = tlsBreakdown(rules);
  const total = rules.length;
  return (
    <section className="card p-4" aria-labelledby="card-tls">
      <h2 id="card-tls" className="card-title mb-3">TLS / DTLS</h2>
      <div
        className="flex h-3 w-full overflow-hidden rounded bg-gray-200"
        role="img"
        aria-label={TLS_SEGMENTS.map((s) => `${s.label} ${b[s.key]}`).join('、')}
      >
        {total > 0 && TLS_SEGMENTS.map((s) => (b[s.key] > 0 ? (
          <div key={s.key} style={{ width: `${(b[s.key] / total) * 100}%`, background: s.color }} />
        ) : null))}
      </div>
      <ul className="mt-3 text-sm space-y-1">
        {TLS_SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-gray-800">
            <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1">{s.label}</span>
            <span className="font-semibold tabular-nums text-gray-900">{b[s.key]}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3">
        <Metric label="STARTTLS" value={formatCount(b.starttls)} />
        <Metric label="ポート範囲のルール" value={formatCount(b.ranges)} />
      </dl>
    </section>
  );
};

const AttentionCard: React.FC<{ rules: ForwardRules[] }> = ({ rules }) => (
  <section className="card p-4" aria-labelledby="card-attention">
    <h2 id="card-attention" className="card-title mb-3">要確認のルール</h2>
    {rules.length === 0 ? (
      <p className="text-sm text-gray-700">失敗・未登録のルールはありません。</p>
    ) : (
      <ul className="divide-y divide-gray-100">
        {rules.map((r) => (
          <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-2">
            <div className="flex items-center gap-2 shrink-0">
              <StateBadge state={r.state} />
              <span className="badge bg-gray-100 text-gray-800 uppercase">{r.protocol}</span>
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <Link href={ruleHref(ruleKeyOf(r))} className="link font-mono break-all">
                {hostPort(r.srcAddr, portsLabel(r.srcPort, r.srcPortEnd))}
              </Link>
              <span className="text-gray-600"> → </span>
              <span className="font-mono text-gray-800 break-all">{hostPort(r.distAddr, targetPortsLabel(r))}</span>
              <p className="text-xs text-red-800 break-all mt-0.5">
                {r.error ?? (r.state === 'missing' ? 'rproxy でこのルールが動いていません（変更して保存すると作り直します）。' : '')}
              </p>
            </div>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const RulesTable: React.FC<{ rules: ForwardRules[]; now: number }> = ({ rules, now }) => {
  const router = useRouter();
  const [filter, setFilter] = useState<RuleFilter>(EMPTY_FILTER);
  const shown = useMemo(() => filterRules(rules, filter), [rules, filter]);
  const controlClass = 'border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

  return (
    <section className="card" aria-labelledby="card-rules">
      <div className="p-4 flex flex-col lg:flex-row lg:items-end gap-3 border-b border-gray-200">
        <h2 id="card-rules" className="card-title lg:mr-auto">すべてのルール</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-700 flex flex-col gap-1">
            プロトコル
            <select className={controlClass} value={filter.protocol}
              onChange={(e) => setFilter({ ...filter, protocol: e.target.value as Protocol | 'all' })}>
              <option value="all">すべて</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </label>
          <label className="text-xs text-gray-700 flex flex-col gap-1">
            状態
            <select className={controlClass} value={filter.state}
              onChange={(e) => setFilter({ ...filter, state: e.target.value as RuleState | 'all' })}>
              <option value="all">すべて</option>
              {RULE_STATES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-700 flex flex-col gap-1">
            検索（アドレス・ポート・SNI）
            <input type="search" className={`${controlClass} w-56`} value={filter.text} placeholder="例: 10.0.0.5 / 443 / mail.example.com"
              onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
          </label>
          <span className="text-xs text-gray-600 pb-1.5" aria-live="polite">{shown.length} / {rules.length} 件</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption className="sr-only">ルールの一覧。行を選ぶと詳細を開きます</caption>
          <thead>
            <tr>
              <th scope="col">状態</th>
              <th scope="col">プロトコル</th>
              <th scope="col">待ち受け</th>
              <th scope="col">転送先</th>
              <th scope="col">TLS</th>
              <th scope="col" className="text-right">接続数</th>
              <th scope="col" className="text-right">転送量</th>
              <th scope="col">稼働時間</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-gray-700 py-6">
                  {rules.length === 0 ? 'ルールはまだありません。' : '条件に一致するルールはありません。'}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const href = ruleHref(ruleKeyOf(r));
              const routes = r.tls.routes?.length ?? 0;
              return (
                <tr key={r.id} className="cursor-pointer hover:bg-blue-50" onClick={() => router.push(href)}>
                  <td><StateBadge state={r.state} /></td>
                  <td className="uppercase">{r.protocol}</td>
                  <td className="font-mono whitespace-nowrap">
                    <Link href={href} className="link" onClick={(e) => e.stopPropagation()}>
                      {hostPort(r.srcAddr, portsLabel(r.srcPort, r.srcPortEnd))}
                    </Link>
                  </td>
                  <td className="font-mono whitespace-nowrap">
                    {hostPort(r.distAddr, targetPortsLabel(r))}
                    {routes > 0 && <div className="text-xs text-gray-600 font-sans">＋サーバ名ごとの転送先 {routes} 件</div>}
                  </td>
                  <td><TlsBadge rule={r} /></td>
                  <td className="text-right tabular-nums whitespace-nowrap">
                    {formatCount(r.connections)}
                    {r.stats && <div className="text-xs text-gray-600">累計 {formatCount(r.stats.total_connections)}</div>}
                  </td>
                  <td className="text-right tabular-nums whitespace-nowrap text-xs">
                    {r.stats ? (
                      <>
                        <div><span className="text-gray-600">rx</span> {formatBytes(r.stats.rx_bytes)}</div>
                        <div><span className="text-gray-600">tx</span> {formatBytes(r.stats.tx_bytes)}</div>
                      </>
                    ) : '-'}
                  </td>
                  <td className="whitespace-nowrap">{formatDuration(uptimeSecs(r.startedAt, now))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const DashboardPage: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    // 前の取得が終わっていなければ重ねない
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/forward/dashboard');
      if (!res.ok) {
        setError(res.status === 401
          ? 'サインインしていません。右上の「Sign In」からサインインしてください。'
          : `ルールの一覧を取得できませんでした: ${await errorDetail(res)}`);
        return;
      }
      setData(await res.json() as DashboardData);
      setLastUpdated(Date.now());
      setError('');
    } catch (err) {
      setError(`ルールの一覧を取得できませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      inFlight.current = false;
    }
  }, []);

  // 初回の取得と自動更新
  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(load, autoRefresh);

  const rules = useMemo(() => data?.rules ?? [], [data]);
  const summary = useMemo(() => summarize(rules), [rules]);
  const attention = useMemo(() => needsAttention(rules), [rules]);
  const now = lastUpdated ?? 0;
  const reachable = data?.reachable ?? false;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900 whitespace-nowrap mr-auto">ダッシュボード</h1>
        <AutoRefreshToggle enabled={autoRefresh} onChange={setAutoRefresh} lastUpdated={lastUpdated} />
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => void load()}>今すぐ更新</button>
          <Link href="/rules/new" className="btn-primary">新規ルール</Link>
        </div>
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError('')} />}

      {data === null ? (
        !error && <p className="text-gray-700">読み込み中…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="rproxy"
              value={
                <span className={`inline-flex items-center gap-2 ${reachable ? 'text-green-700' : 'text-red-700'}`}>
                  <span aria-hidden="true" className={`inline-block h-3 w-3 rounded-full ${reachable ? 'bg-green-600' : 'bg-red-600'}`} />
                  {reachable ? '接続できます' : '接続できません'}
                </span>
              }
              sub={reachable ? '稼働状態を取得しました' : <span className="break-all">{data.rproxyError ?? '稼働状態を取得できません'}</span>}
            />
            <StatTile label="ルール" value={formatCount(summary.all.total)} sub={`TCP ${summary.tcp.counts.total} / UDP ${summary.udp.counts.total}`} />
            <StatTile label="稼働中" value={<span className="text-green-700">{formatCount(summary.all.running)}</span>}
              sub={`失敗 ${summary.all.failed} / 未登録 ${summary.all.missing} / 不明 ${summary.all.unknown}`} />
            <StatTile label="現在の接続" value={reachable ? formatCount(summary.connections) : '-'} sub="UDP はセッション数" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            <ProtocolCard summary={summary.tcp} reachable={reachable} />
            <ProtocolCard summary={summary.udp} reachable={reachable} />
            <TlsCard rules={rules} />
          </div>

          <AttentionCard rules={attention} />

          <RulesTable rules={rules} now={now} />
        </>
      )}
    </div>
  );
};

export default DashboardPage;
