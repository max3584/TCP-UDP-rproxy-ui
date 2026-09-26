// ルールの詳細（/rules/{protocol}/{listen_addr（URL エンコード）}/{listen_port}）
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ForwardRules } from '@/components/lib';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
  hostPort,
  httpRouteCount,
  parseRuleKey,
  portsLabel,
  ruleEditHref,
  targetLabel,
  tlsLabel,
  toRule,
  uptimeSecs,
} from '@/components/dashboard';
import { AllowFromBadge, AutoRefreshToggle, ConfirmDialog, ErrorBanner, StateBadge, StaticBadge, postRule, useAutoRefresh, useRule } from '@/components/ui';
import { STATIC_RULE_NOTE } from '@/components/messages';

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

const TlsSection: React.FC<{ rule: ForwardRules }> = ({ rule }) => {
  const tls = rule.tls;
  const count = rule.srcPortEnd === null ? 1 : rule.srcPortEnd - rule.srcPort + 1;
  return (
    <Section id="section-tls" title={rule.protocol === 'udp' ? 'DTLS' : 'TLS'}>
      <Fields items={[['モード', `${tlsLabel(rule)}（${tls.mode}）`]]} />

      {tls.routes && tls.routes.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <h3 className="text-sm font-semibold text-gray-800 mb-1">サーバ名ごとの転送先</h3>
          <table className="data-table">
            <thead><tr><th scope="col">サーバ名</th><th scope="col">転送先</th></tr></thead>
            <tbody>
              {tls.routes.map((r) => (
                <tr key={r.server_name}>
                  <td className="font-mono">{r.server_name}</td>
                  <td className="font-mono">{hostPort(r.remote_addr, portsLabel(r.remote_port, count > 1 ? r.remote_port + count - 1 : null))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rule.protocol === 'tcp' && (
            <div className="mt-2">
              <Fields items={[['どのサーバ名にも一致しない接続', tls.unmatched === 'reject'
                ? <span className="font-semibold text-red-800">切断する（unmatched: reject）</span>
                : '基本の転送先へ送る（unmatched: default）']]} />
            </div>
          )}
        </div>
      )}

      {tls.certificates && tls.certificates.length > 0 && (
        <div className="mt-4 overflow-x-auto">
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
  useAutoRefresh(load, autoRefresh && rule !== null && !confirming);

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
          <p className="inline-flex items-center gap-2 text-sm text-gray-800" data-testid="static-note">
            <StaticBadge />
            {STATIC_RULE_NOTE}
          </p>
        )}
        {rule && key && rule.origin !== 'static' && (
          <div className="flex gap-2">
            <Link href={ruleEditHref(key)} className="btn-primary">編集</Link>
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
                ['エラー', rule.error ? <span className="text-red-800">{rule.error}</span> : rule.state === 'missing'
                  ? <span className="text-amber-900">rproxy でこのルールが動いていません（編集して保存すると作り直します）。</span>
                  : rule.state === 'unknown' ? <span className="text-gray-700">rproxy に接続できないため、稼働状態がわかりません。</span> : null],
                ['開始時刻', formatTimestamp(rule.startedAt)],
                ['稼働時間', formatDuration(uptimeSecs(rule.startedAt, now))],
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
              ]} />
              <p className="mt-2 text-xs text-gray-600">
                rx はクライアント → 転送先、tx は転送先 → クライアントのバイト数です。
                拒否した接続は、許可する送信元（allow_from）の範囲外か、どのサーバ名にも一致しない（unmatched: reject）ため切断した接続です。
              </p>
            </Section>

            <Section id="section-listen" title="待ち受け">
              <Fields items={[
                ['プロトコル', rule.protocol.toUpperCase()],
                ['アドレス', <Mono key="a">{rule.srcAddr}</Mono>],
                [rule.srcPortEnd === null ? 'ポート' : 'ポート範囲', <Mono key="p">{portsLabel(rule.srcPort, rule.srcPortEnd)}</Mono>],
                ...(rule.srcPortEnd !== null ? [['ポート数', `${rule.srcPortEnd - rule.srcPort + 1}`] as [string, React.ReactNode]] : []),
              ]} />
            </Section>

            <Section id="section-target" title="転送先">
              {rule.http !== null ? (
                // L7 のルールは転送先を持たない（http.services に書く）。中身の表示・編集は UI #34
                <>
                  <Fields items={[
                    ['転送先', targetLabel(rule)],
                    ['ルート', `${httpRouteCount(rule.http)} 件`],
                  ]} />
                  <p className="mt-2 text-xs text-gray-600" data-testid="http-note">
                    HTTP のリクエストごとに、L7 の設定（http）のルートとサービスで振り分けます。L7 の設定はこの画面ではまだ編集できません（今後対応）。rproxy の設定ファイルか制御 API で変更してください。
                  </p>
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

          <TlsSection rule={rule} />

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
              ]} />
            </Section>
          </div>
        </>
      )}

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
