// ルールの詳細（/rules/{protocol}/{listen_addr（URL エンコード）}/{listen_port}）
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { routeNames } from '@/components/lib';
import type { CertStatus, ForwardRules, HttpStats } from '@/components/lib';
import { healthCheckLabel, targetStatus } from '@/components/targets';
import {
  BALANCE_LABELS,
  CERT_ROLE_LABELS,
  CERT_STATE_LABELS,
  formatIsoTime,
  targetHostPort,
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
  hostPort,
  NO_ROUTE,
  httpRouteCount,
  httpRouteRows,
  serverErrorPercent,
  statusCountsLabel,
  parseRuleKey,
  portsLabel,
  ruleEditHref,
  targetLabel,
  tlsLabel,
  toRule,
  uptimeSecs,
} from '@/components/dashboard';
import { AllowFromBadge, AutoRefreshToggle, ConfirmDialog, ErrorBanner, StateBadge, StaticBadge, postRule, useAutoRefresh, useRule } from '@/components/ui';
import { ACME_UNSUPPORTED_NOTE, STATIC_RULE_NOTE, ruleErrorText } from '@/components/messages';
import HttpSummary from '@/components/HttpSummary';
import HistoryList from '@/components/HistoryList';

// 宛先を複数にしたルールの宛先の一覧（状態と接続数は rproxy が返すときだけ）
const TargetsTable: React.FC<{ rule: ForwardRules }> = ({ rule }) => (
  <div className="mt-3 table-scroll">
  <table className="data-table w-full text-sm" data-testid="targets-table">
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">宛先</th>
        <th scope="col">重み</th>
        <th scope="col">予備</th>
        <th scope="col">状態</th>
        <th scope="col">接続数</th>
      </tr>
    </thead>
    <tbody>
      {rule.targets.map((t, i) => {
        const s = targetStatus(rule.targets, rule.stats?.targets, i);
        return (
          <tr key={`${t.addr}:${t.port}:${i}`}>
            <td>{i + 1}</td>
            <td className="font-mono break-all">{targetHostPort(t, rule)}</td>
            <td>{rule.balance === 'failover' ? '-' : t.weight ?? 1}</td>
            <td>{t.backup ? '予備' : ''}</td>
            <td>
              {s?.up === undefined || s === null
                ? '-'
                : s.up
                  ? <span className="badge bg-green-100 text-green-800">稼働</span>
                  : <span className="badge bg-red-100 text-red-800">停止</span>}
            </td>
            <td>{s?.connections !== undefined ? formatCount(s.connections) : '-'}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
  </div>
);

const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
  <section className="card p-4" aria-labelledby={id}>
    <h2 id={id} className="card-title mb-3">{title}</h2>
    {children}
  </section>
);

// 項目名と値の組（値が空なら「-」）
const Fields: React.FC<{ items: [string, React.ReactNode][] }> = ({ items }) => (
  <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-4 gap-y-1 text-sm">
    {items.map(([label, value]) => (
      <div key={label} className="contents">
        <dt className="text-gray-600">{label}</dt>
        <dd className="text-gray-900 break-all mb-1 sm:mb-0">{value === undefined || value === null || value === '' ? '-' : value}</dd>
      </div>
    ))}
  </dl>
);

const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="font-mono">{children}</span>;

const path = (p: string | undefined) => (p ? <Mono>{p}</Mono> : null);

// ミドルウェアの名前ごとの数（"limit-login 3, rl 1"）
const byMiddleware = (counts: Record<string, number>) =>
  Object.entries(counts).map(([name, n]) => `${name} ${formatCount(n)}`).join(', ');

// L7（http）のルールのリクエストの数（rproxy の stats.http）
// 証明書の期限（rproxy の cert_status）。expiring は琥珀、expired は赤
const CERT_STATE_CLASS = { ok: 'bg-green-100 text-green-900', expiring: 'bg-amber-100 text-amber-900', expired: 'bg-red-100 text-red-900' } as const;

const CertStatusSection: React.FC<{ certs: CertStatus[] }> = ({ certs }) => (
  <Section id="section-cert-status" title="証明書の期限">
    <div className="table-scroll">
    <table className="data-table" data-testid="cert-status">
      <thead>
        <tr><th>種類</th><th>ファイル</th><th>期限</th><th>残り</th><th>状態</th></tr>
      </thead>
      <tbody>
        {certs.map((c) => (
          <tr key={`${c.role}|${c.file}`}>
            <td>{CERT_ROLE_LABELS[c.role] ?? c.role}</td>
            <td className="font-mono break-all">{c.file}</td>
            <td className="font-mono whitespace-nowrap">{formatIsoTime(c.not_after)}</td>
            <td>{c.days_left < 0 ? `${-c.days_left} 日前に期限切れ` : `${c.days_left} 日`}</td>
            <td><span className={`badge ${CERT_STATE_CLASS[c.state] ?? 'bg-gray-100 text-gray-800'}`}>{CERT_STATE_LABELS[c.state] ?? c.state}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
    {certs.some((c) => c.state === 'expired' && c.role === 'certificate') && (
      <p className="text-xs text-red-800 mt-2">
        期限切れのサーバ証明書は使われていません（すべて切れるとルールは失敗になり、待ち受けを閉じます）。証明書のファイルが更新されると、rproxy が自動で読み直して元に戻します。
      </p>
    )}
  </Section>
);

const HttpStatsSection: React.FC<{ http: HttpStats }> = ({ http }) => {
  const rows = httpRouteRows(http);
  const pct = serverErrorPercent(http.requests, http.by_status['5xx'] ?? 0);
  return (
    <Section id="section-http-stats" title="HTTP のリクエスト（開始してからの累計）">
      <Fields items={[
        ['リクエスト', formatCount(http.requests)],
        ['状態コード', statusCountsLabel(http.by_status)],
        ['5xx の割合', pct === null ? null : `${pct}%`],
        ['制限で断った数', formatCount(http.limited ?? 0)],
        ['CrowdSec で断った数', formatCount(http.blocked ?? 0)],
      ]} />
      {rows.length > 0 && (
        <div className="mt-4 table-scroll">
          <h3 className="text-sm font-semibold text-gray-800 mb-1">ルートごと</h3>
          <table className="data-table" data-testid="http-routes">
            <thead>
              <tr>
                <th scope="col">ルート</th>
                <th scope="col" className="text-right">リクエスト</th>
                <th scope="col">状態コード</th>
                <th scope="col">制限（rate_limit / in_flight）</th>
                <th scope="col">遮断（crowdsec）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="font-mono break-all">{r.name === NO_ROUTE ? <span className="font-sans text-gray-600">（どのルートにも一致しない）</span> : r.name}</td>
                  <td className="text-right tabular-nums">{formatCount(r.requests)}</td>
                  <td className="tabular-nums whitespace-nowrap">{statusCountsLabel(r.byStatus)}</td>
                  <td className="tabular-nums">{r.limited > 0 ? byMiddleware(r.limitedBy) : '-'}</td>
                  <td className="tabular-nums">{r.blocked > 0 ? byMiddleware(r.blockedBy) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-600">
        応答を送り終えた（またはクライアントが切断した）ときに数えます。制限・遮断で断ったリクエストは 4xx にも含まれます。
      </p>
    </Section>
  );
};

const TlsSection: React.FC<{ rule: ForwardRules }> = ({ rule }) => {
  const tls = rule.tls;
  const count = rule.srcPortEnd === null ? 1 : rule.srcPortEnd - rule.srcPort + 1;
  return (
    <Section id="section-tls" title={rule.protocol === 'udp' ? 'DTLS' : 'TLS'}>
      <Fields items={[['モード', `${tlsLabel(rule)}（${tls.mode}）`]]} />

      {tls.routes && tls.routes.length > 0 && (
        <div className="mt-4 table-scroll">
          <h3 className="text-sm font-semibold text-gray-800 mb-1">サーバ名ごとの転送先</h3>
          <table className="data-table">
            <thead><tr><th scope="col">サーバ名</th><th scope="col">転送先</th></tr></thead>
            <tbody>
              {tls.routes.map((r, i) => (
                <tr key={i} data-testid="tls-route">
                  <td className="font-mono break-all">
                    {routeNames(r).map((n) => <div key={n}>{n}</div>)}
                  </td>
                  <td className="font-mono break-all">
                    {hostPort(r.remote_addr, portsLabel(r.remote_port, count > 1 ? r.remote_port + count - 1 : null))}
                    {r.passthrough && (
                      <span className="badge ml-2 bg-indigo-100 text-indigo-900" title="rproxy で TLS を終端せずに、ClientHello ごと転送先へ流す（証明書は転送先のもの）">
                        終端しない（passthrough）
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rule.protocol === 'tcp' && rule.http === null && (
            <div className="mt-2">
              <Fields items={[['どのサーバ名にも一致しない接続', tls.unmatched === 'reject'
                ? <span className="font-semibold text-red-800">切断する（unmatched: reject）</span>
                : '基本の転送先へ送る（unmatched: default）']]} />
            </div>
          )}
        </div>
      )}

      {tls.certificates && tls.certificates.length > 0 && (
        <div className="mt-4 table-scroll">
          <h3 className="text-sm font-semibold text-gray-800 mb-1">証明書</h3>
          <table className="data-table">
            <thead><tr><th scope="col">#</th><th scope="col">サーバ証明書</th><th scope="col">中間 CA</th><th scope="col">秘密鍵</th></tr></thead>
            <tbody>
              {tls.certificates.map((c, i) => (
                c.acme !== undefined ? (
                  // ACME の証明書（v0.3）はファイルを持たない
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td colSpan={3} className="break-all">
                      ACME（resolver: <Mono>{c.acme}</Mono>）: <Mono>{(c.domains ?? []).join(', ')}</Mono>
                      <p className="mt-1 text-xs text-amber-900" data-testid="acme-note">{ACME_UNSUPPORTED_NOTE}</p>
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="font-mono break-all">{c.cert_file}</td>
                    <td className="font-mono break-all">{c.chain_file ?? <span className="font-sans text-gray-600">（なし）</span>}</td>
                    <td className="font-mono break-all">{c.key_file}</td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tls.mode === 'terminate' && (
        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">クライアント証明書の検証（mTLS）</h3>
            <Fields items={[
              ['モード', tls.client_auth?.mode ?? 'none'],
              ['CA（ルート）', path(tls.client_auth?.ca_file)],
              ['中間 CA', path(tls.client_auth?.chain_file)],
            ]} />
          </div>
          {rule.protocol === 'tcp' && <Fields items={[['ALPN', tls.alpn?.join(', ')]]} />}
          {tls.options && (
            <Fields items={[
              ['TLS の最小バージョン', tls.options.min_version],
              ['暗号スイート', tls.options.cipher_suites?.join(', ')],
            ]} />
          )}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">転送先への{rule.protocol === 'udp' ? ' DTLS' : ' TLS'}</h3>
            {tls.upstream?.tls ? (
              <Fields items={[
                ['再暗号化', 'する'],
                ['検証するサーバ名', tls.upstream.server_name ?? '（転送先のホスト名）'],
                ['CA', tls.upstream.ca_file ? path(tls.upstream.ca_file) : '（Mozilla のルート証明書）'],
                ['証明書の検証', tls.upstream.insecure_skip_verify ? <span className="text-red-700 font-semibold">しない（テスト用）</span> : 'する'],
                ['クライアント証明書', path(tls.upstream.cert_file)],
                ['その中間 CA', path(tls.upstream.chain_file)],
                ['その秘密鍵', path(tls.upstream.key_file)],
              ]} />
            ) : (
              <p className="text-sm text-gray-700">再暗号化しない（転送先へは平文）</p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
};

const RuleDetailPage: React.FC = () => {
  const router = useRouter();
  const key = useMemo(() => (router.isReady ? parseRuleKey(router.query) : null), [router.isReady, router.query]);
  const { rule, error, setError, notFound, lastUpdated, load } = useRule(key);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingPause, setConfirmingPause] = useState(false);
  const [switching, setSwitching] = useState(false);
  useAutoRefresh(load, autoRefresh && rule !== null && !confirming && !confirmingPause);

  // 一時停止（DB に残したまま rproxy から外す）と再開
  const handlePauseResume = async (action: 'pause' | 'resume') => {
    if (!rule) return;
    setSwitching(true);
    try {
      await postRule(action, toRule(rule));
      setConfirmingPause(false);
      await load();
    } catch (err) {
      setError(`ルールの${action === 'pause' ? '停止' : '再開'}に失敗しました: ${err instanceof Error ? err.message : err}`);
      setConfirmingPause(false);
    } finally {
      setSwitching(false);
    }
  };

  const handleDelete = async () => {
    if (!rule) return;
    setDeleting(true);
    try {
      await postRule('delete', toRule(rule));
      await router.push('/');
    } catch (err) {
      setError(`ルールの削除に失敗しました: ${err instanceof Error ? err.message : err}`);
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  if (router.isReady && key === null) {
    return <ErrorBanner message="URL が正しくありません（/rules/{tcp|udp}/{待ち受けアドレス}/{ポート}）。" />;
  }

  const title = key ? `${key.protocol.toUpperCase()} ${hostPort(key.addr, rule ? portsLabel(rule.srcPort, rule.srcPortEnd) : key.port)}` : 'ルール';
  const now = lastUpdated ?? 0;
  const live = rule !== null && rule.state !== 'unknown' && rule.state !== 'missing';

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>ルールの詳細</span>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900 font-mono break-all mr-auto">{title}</h1>
        {rule && <AutoRefreshToggle enabled={autoRefresh} onChange={setAutoRefresh} lastUpdated={lastUpdated} />}
        {rule && key && rule.origin === 'static' && (
          <p className="inline-flex flex-wrap items-center gap-2 text-sm text-gray-800" data-testid="static-note">
            <StaticBadge />
            {STATIC_RULE_NOTE}
          </p>
        )}
        {rule && key && rule.origin !== 'static' && (
          <div className="flex flex-wrap gap-2">
            <Link href={ruleEditHref(key)} className="btn-primary">編集</Link>
            {rule.state === 'paused'
              ? <button type="button" className="btn-secondary" disabled={switching} onClick={() => void handlePauseResume('resume')}>{switching ? '再開中…' : '再開'}</button>
              : <button type="button" className="btn-secondary" onClick={() => setConfirmingPause(true)}>一時停止</button>}
            <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>削除</button>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {notFound && (
        <div className="card p-4 text-gray-900">
          <p>このルールは見つかりません（削除されたか、ほかの利用者のルールです）。</p>
          <Link href="/" className="link">ダッシュボードへ戻る</Link>
        </div>
      )}
      {!rule && !notFound && !error && <p className="text-gray-700">読み込み中…</p>}

      {rule && (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Section id="section-overview" title="概要">
              <Fields items={[
                ['状態', <StateBadge key="s" state={rule.state} />],
                ['エラー', rule.error ? <span className="text-red-800">{ruleErrorText(rule.error)}</span> : rule.state === 'missing'
                  ? <span className="text-amber-900">rproxy でこのルールが動いていません（編集して保存すると作り直します）。</span>
                  : rule.state === 'unknown' ? <span className="text-gray-700">rproxy に接続できないため、稼働状態がわかりません。</span>
                  : rule.state === 'paused' ? <span className="text-gray-700">一時停止中です（設定は残したまま、rproxy では動かしていません。「再開」でこの内容のまま動かします）。</span> : null],
                ['開始時刻', formatTimestamp(rule.startedAt)],
                ['稼働時間', formatDuration(uptimeSecs(rule.startedAt, now))],
                // 管理者（rproxy-admin）が見るときだけ付く
                ...(rule.owner !== undefined ? [['所有者（Keycloak の ID）', <Mono key="o">{rule.owner}</Mono>] as [string, React.ReactNode]] : []),
              ]} />
            </Section>

            <Section id="section-stats" title="統計（開始してからの累計）">
              <Fields items={[
                [rule.protocol === 'udp' ? '現在のセッション' : '現在の接続', live ? formatCount(rule.connections) : null],
                ['累計の接続', rule.stats ? formatCount(rule.stats.total_connections) : null],
                ['rx（受信）', rule.stats ? formatBytes(rule.stats.rx_bytes) : null],
                ['tx（送信）', rule.stats ? formatBytes(rule.stats.tx_bytes) : null],
                ['TLS 失敗', rule.stats ? formatCount(rule.stats.tls_failures) : null],
                ['拒否した接続', rule.stats ? formatCount(rule.stats.denied ?? 0) : null],
                // 古い rproxy は dropped を返さないので、そのときは出さない
                ...(rule.protocol === 'udp' && typeof rule.stats?.dropped === 'number'
                  ? [['捨てたデータグラム', formatCount(rule.stats.dropped)] as [string, React.ReactNode]]
                  : []),
              ]} />
              <p className="mt-2 text-xs text-gray-600">
                rx はクライアント → 転送先、tx は転送先 → クライアントのバイト数です。
                拒否した接続は、許可する送信元（allow_from）の範囲外か、どのサーバ名にも一致しない（unmatched: reject）ため切断した接続です。
                {rule.protocol === 'udp' && '捨てたデータグラムは、rproxy が転送できずに捨てた数です（セッションの待ち行列があふれた・送信に失敗した など。カーネルの受信バッファで捨てられたものは含まない）。'}
              </p>
            </Section>

            <Section id="section-listen" title="待ち受け">
              <Fields items={[
                ['プロトコル', rule.protocol.toUpperCase()],
                ['アドレス', <Mono key="a">{rule.srcAddr}</Mono>],
                ...((rule.extraListenAddrs ?? []).length > 0 ? [['追加の待ち受けアドレス', (
                  <span key="x" data-testid="extra-listen-addrs">
                    {(rule.extraListenAddrs ?? []).map((x) => <Mono key={x}>{x} </Mono>)}
                  </span>
                )] as [string, React.ReactNode]] : []),
                [rule.srcPortEnd === null ? 'ポート' : 'ポート範囲', <Mono key="p">{portsLabel(rule.srcPort, rule.srcPortEnd)}</Mono>],
                ...(rule.srcPortEnd !== null ? [['ポート数', `${rule.srcPortEnd - rule.srcPort + 1}`] as [string, React.ReactNode]] : []),
              ]} />
            </Section>

            <Section id="section-target" title="転送先">
              {rule.http !== null ? (
                // L7 のルールは転送先を持たない（http.services に書く）。中身は下の「L7 (HTTP)」
                <>
                  <Fields items={[
                    ['転送先', targetLabel(rule)],
                    ['ルート', `${httpRouteCount(rule.http)} 件`],
                  ]} />
                  <p className="mt-2 text-xs text-gray-600" data-testid="http-note">
                    HTTP のリクエストごとに、下の「L7 (HTTP)」のルートとサービスで振り分けます。{rule.origin === 'static' ? '固定ルールなので、rproxy の設定ファイルで変更してください。' : '変更は「編集」の「L7 (HTTP)」タブで行います。'}
                  </p>
                </>
              ) : rule.targets.length > 0 ? (
                <>
                  <Fields items={[
                    ['振り分け方', BALANCE_LABELS[rule.balance]],
                    ['宛先の数', `${rule.targets.length} 件`],
                    ['ヘルスチェック', healthCheckLabel(rule.healthCheck)],
                    ['解決したアドレス', rule.resolved.length > 0
                      ? <ul key="r" className="font-mono">{rule.resolved.map((a) => <li key={a}>{a}</li>)}</ul>
                      : live ? 'まだ名前解決できていません' : null],
                  ]} />
                  <TargetsTable rule={rule} />
                </>
              ) : (
                <Fields items={[
                  ['転送先', <Mono key="t">{targetLabel(rule)}</Mono>],
                  ['解決したアドレス', rule.resolved.length > 0
                    ? <ul key="r" className="font-mono">{rule.resolved.map((a) => <li key={a}>{a}</li>)}</ul>
                    : live ? 'まだ名前解決できていません' : null],
                ]} />
              )}
            </Section>
          </div>

          {rule.http !== null && (
            <Section id="section-http" title="L7 (HTTP)">
              <HttpSummary http={rule.http} />
            </Section>
          )}

          {rule.stats?.http && <HttpStatsSection http={rule.stats.http} />}

          <TlsSection rule={rule} />

          {rule.certStatus && rule.certStatus.length > 0 && <CertStatusSection certs={rule.certStatus} />}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Section id="section-starttls" title="STARTTLS">
              {rule.starttls ? (
                <Fields items={[
                  ['プロトコル', rule.starttls],
                  ['必須', rule.starttlsRequired ? 'はい' : 'いいえ（STARTTLS をしないクライアントも平文のまま通す）'],
                ]} />
              ) : <p className="text-sm text-gray-700">使わない</p>}
            </Section>

            <Section id="section-advanced" title="詳細">
              <Fields items={[
                ['送信元 IP の扱い', <Mono key="s">{rule.sourceIp}</Mono>],
                ...(rule.protocol === 'udp' ? [['UDP のアイドルタイムアウト', `${rule.udpIdleSecs} 秒`] as [string, React.ReactNode]] : []),
                ['接続を許可する送信元', rule.allowFrom.length > 0
                  ? (
                    <div key="af" data-testid="allow-from">
                      <AllowFromBadge allowFrom={rule.allowFrom} />
                      <ul className="font-mono mt-1">{rule.allowFrom.map((c) => <li key={c}>{c}</li>)}</ul>
                    </div>
                  )
                  : 'すべて許可'],
                ['CrowdSec（L4）', rule.crowdsec ? '判定に入っている接続元を切る' : '使わない'],
              ]} />
            </Section>
          </div>
        </>
      )}

      {/* 変更の履歴（#61）。固定ルールは DB にないので履歴もない */}
      {key && !(rule && rule.origin === 'static') && (
        <Section id="section-history" title="変更の履歴">
          <HistoryList filter={{ protocol: key.protocol, addr: key.addr, port: key.port }} onReverted={() => void load()} />
        </Section>
      )}

      <ConfirmDialog
        open={confirmingPause}
        title="ルールを一時停止しますか？"
        confirmLabel="一時停止する"
        busy={switching}
        onConfirm={() => void handlePauseResume('pause')}
        onCancel={() => setConfirmingPause(false)}
      >
        <p>
          <span className="font-mono break-all">{title}</span> の転送を止めます。既存の接続は切断されます。設定は残り、「再開」でそのまま動かせます。
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming}
        title="ルールを削除しますか？"
        confirmLabel="削除する"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          <span className="font-mono break-all">{title}</span> の転送を止めて、ルールを削除します。既存の接続は切断されます。
        </p>
      </ConfirmDialog>
    </div>
  );
};

export default RuleDetailPage;
