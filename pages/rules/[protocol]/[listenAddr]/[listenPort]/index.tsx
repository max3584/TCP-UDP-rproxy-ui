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
  multiNode,
  projectRule,
  ruleHref,
  targetChoices,
} from '@/components/dashboard';
import OverrideEditor from '@/components/OverrideEditor';
import { AllowFromBadge, ApiBadge, AutoRefreshToggle, ConfirmDialog, DriftBadge, ErrorBanner, HaWarning, NodeStates, RoleBadge, StateBadge, StaticBadge, errorDetail, postRule, useAutoRefresh, useNodes, useRule } from '@/components/ui';
import Tabs, { tabPanelProps } from '@/components/Tabs';
import { DRIFT_LABELS } from '@/components/drift';
import type { NodeLiveState } from '@/components/lib';
import { OWNED_RULE_MESSAGE, STATIC_RULE_NOTE, ruleErrorText } from '@/components/messages';
import AcmeStatus from '@/components/AcmeStatus';
import { acmeStatusFor } from '@/components/acme';
import HttpSummary from '@/components/HttpSummary';
import HistoryList from '@/components/HistoryList';
import { joinList, translate } from '@/i18n/core';
import { CONDITION_LABELS, asnLabel, conditionProblem, rateLabel, v04Fields } from '@/components/v04';
import type { Condition } from '@/components/v04';

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
        {rule.stats?.targets?.some((t) => t.ejections !== undefined) && <th scope="col">外した回数</th>}
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
              {typeof s?.ejected_until === 'number' && (
                <span className="badge ml-1 bg-amber-100 text-amber-900" title={`受け身のヘルスチェックで ${formatTimestamp(s.ejected_until)} まで外しています`}>外している</span>
              )}
            </td>
            <td>{s?.connections !== undefined ? formatCount(s.connections) : '-'}</td>
            {rule.stats?.targets?.some((x) => x.ejections !== undefined) && <td>{s?.ejections !== undefined ? formatCount(s.ejections) : '-'}</td>}
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
                  // ACME の証明書（rproxy v0.3.21）はファイルを持たない。状態は rproxy のルールの acme
                  <tr key={i} data-testid="acme-certificate">
                    <td>{i + 1}</td>
                    <td colSpan={3} className="break-all">
                      ACME（resolver: <Mono>{c.acme}</Mono>）: <Mono>{(c.domains ?? []).join(', ')}</Mono>
                      <AcmeStatus status={acmeStatusFor(rule.acmeStatus, c)} reported={rule.acmeStatus !== undefined} ruleState={rule.state} />
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

// v0.4 の項目（ラベル・L4 の制限・帯域の上限・GeoIP・受け身のヘルスチェック）。どれもなければ出さない
const V04Section: React.FC<{ rule: ForwardRules }> = ({ rule }) => {
  const v = v04Fields(rule);
  if (Object.keys(v).length === 0) return null;
  const items: [string, React.ReactNode][] = [];
  if (v.labels) {
    items.push(['ラベル', (
      <span key="labels" className="flex flex-wrap gap-1" data-testid="rule-labels">
        {Object.entries(v.labels).map(([k, val]) => <span key={k} className="badge bg-slate-100 text-slate-900 font-mono">{k}={val}</span>)}
      </span>
    )]);
  }
  const l = v.limits;
  if (l) {
    const p = l.per_source;
    if (l.max_connections !== undefined) items.push([rule.protocol === 'udp' ? 'ルール全体の同時セッション数' : 'ルール全体の同時接続数', formatCount(l.max_connections)]);
    if (p?.max_connections !== undefined) items.push([rule.protocol === 'udp' ? '送信元ごとの同時セッション数' : '送信元ごとの同時接続数', formatCount(p.max_connections)]);
    if (p?.new_connections) items.push(['送信元ごとの新しい接続の速さ', <Mono key="nc">{rateLabel(p.new_connections)}</Mono>]);
    if (p?.packets) items.push(['送信元ごとのデータグラムの速さ', <Mono key="pk">{rateLabel(p.packets)}</Mono>]);
    if (p && (p.prefix_v4 !== undefined || p.prefix_v6 !== undefined)) items.push(['送信元をまとめる大きさ', <Mono key="px">/{p.prefix_v4 ?? 32}, /{p.prefix_v6 ?? 64}</Mono>]);
    if (p?.max_sources !== undefined) items.push(['覚える送信元の数', formatCount(p.max_sources)]);
  }
  const b = v.bandwidth;
  if (b) {
    if (b.upload) items.push(['上り（ルール全体）', <Mono key="up">{b.upload}</Mono>]);
    if (b.download) items.push(['下り（ルール全体）', <Mono key="down">{b.download}</Mono>]);
    if (b.burst) items.push(['バースト', <Mono key="burst">{b.burst}</Mono>]);
    if (b.per_source?.upload) items.push(['上り（送信元ごと）', <Mono key="pu">{b.per_source.upload}</Mono>]);
    if (b.per_source?.download) items.push(['下り（送信元ごと）', <Mono key="pd">{b.per_source.download}</Mono>]);
  }
  const g = v.geoip;
  if (g) {
    if (g.allow_countries) items.push(['許可する国', <Mono key="ac">{g.allow_countries.join(', ')}</Mono>]);
    if (g.deny_countries) items.push(['拒否する国', <Mono key="dc">{g.deny_countries.join(', ')}</Mono>]);
    if (g.allow_asns) items.push(['許可する AS', <Mono key="aa">{g.allow_asns.map(asnLabel).join(', ')}</Mono>]);
    if (g.deny_asns) items.push(['拒否する AS', <Mono key="da">{g.deny_asns.map(asnLabel).join(', ')}</Mono>]);
    items.push(['判定できないとき', g.unknown === 'deny' ? '拒否する' : '許可する']);
  }
  const o = v.outlier_detection;
  if (o) {
    items.push(['受け身のヘルスチェック', joinList([
      translate(`続けて ${o.consecutive_failures ?? 1} 回失敗したら外す`),
      translate(`最初に外す時間 ${o.ejection_time ?? '10s'}`),
      ...(o.max_ejection_time ? [translate(`上限 ${o.max_ejection_time}`)] : []),
      ...(o.max_ejected_percent !== undefined ? [translate(`同時に外すのは ${o.max_ejected_percent}% まで`)] : []),
      ...(o.short_lived ? [translate(`${o.short_lived} より短い接続も失敗に数える`)] : []),
    ])]);
  }
  return (
    <Section id="section-v04" title="制限・GeoIP・ラベル">
      <div data-testid="v04-section"><Fields items={items} /></div>
    </Section>
  );
};

const CONDITION_CLASS = (c: Condition) => (conditionProblem(c) ? 'bg-red-100 text-red-900' : 'bg-green-100 text-green-900');

// rproxy の conditions（v0.4、Gateway API の status の形）
const ConditionsSection: React.FC<{ conditions: Condition[] }> = ({ conditions }) => (
  <Section id="section-conditions" title="rproxy の状態（conditions）">
    <div className="table-scroll">
      <table className="data-table" data-testid="conditions">
        <thead><tr><th scope="col">種類</th><th scope="col">状態</th><th scope="col">理由</th><th scope="col">内容</th><th scope="col">変わった時刻</th></tr></thead>
        <tbody>
          {conditions.map((c) => (
            <tr key={c.type}>
              <td>{CONDITION_LABELS[c.type] ?? c.type}</td>
              <td><span className={`badge ${CONDITION_CLASS(c)}`}>{c.status === 'True' ? 'はい' : c.status === 'False' ? 'いいえ' : c.status}</span></td>
              <td className="font-mono">{c.reason}</td>
              <td className="break-all">{c.message || '-'}</td>
              <td className="whitespace-nowrap">{formatTimestamp(c.last_transition)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Section>
);

// rproxy の API で作ったルール（UI の DB にない。rproxy v0.4、#76）の出どころ
const ApiRuleSection: React.FC<{ rule: ForwardRules }> = ({ rule }) => (
  <Section id="section-api-rule" title="rproxy の API のルール">
    <div data-testid="api-rule">
      <Fields items={[
        ['出どころ', <ApiBadge key="b" rule={rule} />],
        ['保存', rule.persisted ? 'rproxy_rules に保存（rproxy を再起動しても残る）' : '保存していない（rproxy を再起動すると消える）'],
        ['作ったトークン', rule.createdBy ? <Mono key="c">{rule.createdBy}</Mono> : null],
        ['作った時刻', rule.createdAt !== undefined ? formatTimestamp(rule.createdAt) : null],
        ...(rule.ruleset ? [['ルールの組', <Mono key="r">{rule.ruleset}</Mono>] as [string, React.ReactNode]] : []),
      ]} />
      <p className="mt-2 text-xs text-gray-600">
        UI の DB にはないルールです。変更・削除は rproxy の API（PATCH / DELETE）で行い、UI の履歴には残りません。
        {rule.ruleset ? '' : '保存されたルールの変更を rproxy が保存するかは、UI のトークンの persist によります（保存しなければ再起動で前の内容に戻ります）。'}
      </p>
    </div>
  </Section>
);

// 「全体」のタブ：ノードごとの値を並べる（act と stb の通信量を比べる）
const NodeCompare: React.FC<{ rule: ForwardRules }> = ({ rule }) => (
  <Section id="section-node-compare" title="ノードごとの比較">
    <div className="table-scroll">
      <table className="data-table" data-testid="node-compare">
        <caption className="sr-only">ノードごとの状態と通信量</caption>
        <thead>
          <tr>
            <th scope="col">ノード</th>
            <th scope="col">状態</th>
            <th scope="col" className="text-right">{rule.protocol === 'udp' ? 'セッション' : '接続中'}</th>
            <th scope="col" className="text-right">累計の接続</th>
            <th scope="col" className="text-right">rx（受信）</th>
            <th scope="col" className="text-right">tx（送信）</th>
            <th scope="col" className="text-right">拒否</th>
            {rule.http !== null && <th scope="col" className="text-right">HTTP リクエスト</th>}
            {rule.http !== null && <th scope="col" className="text-right">5xx</th>}
          </tr>
        </thead>
        <tbody>
          {(rule.nodes ?? []).map((n) => (
            <tr key={n.node}>
              <td className="whitespace-nowrap text-gray-900"><span className="font-mono mr-1">{n.node}</span><RoleBadge role={n.role} /></td>
              <td className="whitespace-nowrap"><StateBadge state={n.state} /> <DriftBadge drift={n.drift} /></td>
              <td className="text-right tabular-nums text-gray-900">{formatCount(n.connections)}</td>
              <td className="text-right tabular-nums text-gray-900">{n.stats ? formatCount(n.stats.total_connections) : '-'}</td>
              <td className="text-right tabular-nums text-gray-900">{n.stats ? formatBytes(n.stats.rx_bytes) : '-'}</td>
              <td className="text-right tabular-nums text-gray-900">{n.stats ? formatBytes(n.stats.tx_bytes) : '-'}</td>
              <td className="text-right tabular-nums text-gray-900">{n.stats ? formatCount(n.stats.denied ?? 0) : '-'}</td>
              {rule.http !== null && <td className="text-right tabular-nums text-gray-900">{n.stats?.http ? formatCount(n.stats.http.requests) : '-'}</td>}
              {rule.http !== null && <td className="text-right tabular-nums text-gray-900">{n.stats?.http ? formatCount(n.stats.http.by_status['5xx'] ?? 0) : '-'}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="text-left text-gray-900">合計</th>
            <td><StateBadge state={rule.state} /></td>
            <td className="text-right tabular-nums text-gray-900">{formatCount(rule.connections)}</td>
            <td className="text-right tabular-nums text-gray-900">{rule.stats ? formatCount(rule.stats.total_connections) : '-'}</td>
            <td className="text-right tabular-nums text-gray-900">{rule.stats ? formatBytes(rule.stats.rx_bytes) : '-'}</td>
            <td className="text-right tabular-nums text-gray-900">{rule.stats ? formatBytes(rule.stats.tx_bytes) : '-'}</td>
            <td className="text-right tabular-nums text-gray-900">{rule.stats ? formatCount(rule.stats.denied ?? 0) : '-'}</td>
            {rule.http !== null && <td className="text-right tabular-nums text-gray-900">{rule.stats?.http ? formatCount(rule.stats.http.requests) : '-'}</td>}
            {rule.http !== null && <td className="text-right tabular-nums text-gray-900">{rule.stats?.http ? formatCount(rule.stats.http.by_status['5xx'] ?? 0) : '-'}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
    {rule.ha && <p className="mt-2 text-xs text-gray-700">act は VIP（<span className="font-mono">{rule.ha.addrs.join(', ')}</span>）を持っているノードです（各ノードの GET /interfaces）。<HaWarning ha={rule.ha} /></p>}
  </Section>
);

// ノードのタブ：UI の定義とこのノードの実際のルールの違いと、送り直し
const DriftSection: React.FC<{ rule: ForwardRules; node: NodeLiveState; busy: boolean; onResend: () => void; notice: string }> = ({ rule, node, busy, onResend, notice }) => {
  const drift = node.drift ?? [];
  const canResend = rule.origin === 'dynamic' && (node.state === 'missing' || drift.length > 0);
  return (
    <Section id="section-drift" title="UI の定義との違い">
      <div data-testid="drift-section" className="space-y-2 text-sm text-gray-900">
        {node.state === 'unknown' ? <p className="text-gray-700">このノードに問い合わせできないため、わかりません。</p>
          : node.state === 'missing' ? <p className="text-amber-900">このノードではルールが動いていません（未登録）。</p>
          : drift.length === 0 ? <p>UI の定義と同じです。</p>
          : (
            <>
              <p className="text-amber-900">このノードで動いているルールが、UI の定義と違います：</p>
              <ul className="list-disc pl-5" data-testid="drift-fields">
                {drift.map((f) => <li key={f}>{DRIFT_LABELS[f]}</li>)}
              </ul>
            </>
          )}
        {canResend && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={onResend}>{busy ? '送り直し中…' : 'このノードに送り直す'}</button>
            <span className="text-xs text-gray-600">このノードだけに UI の定義を送ります（ほかのノードは変えません。履歴に残ります）。</span>
          </div>
        )}
        {notice && <p role="status" className="text-green-800">{notice}</p>}
      </div>
    </Section>
  );
};

const RESEND_RESULTS: Record<string, string> = {
  added: '作り直しました',
  modified: '変更しました',
  recreated: '削除して作り直しました',
  removed: '停止中なので削除しました',
  unchanged: 'ずれはありませんでした',
};

const RuleDetailPage: React.FC = () => {
  const router = useRouter();
  const key = useMemo(() => (router.isReady ? parseRuleKey(router.query) : null), [router.isReady, router.query]);
  const { rule, error, setError, notFound, lastUpdated, load } = useRule(key);
  // ノードが 2 つ以上なら、ノード／グループとノードごとの状態を出す（#98）
  const nodesInfo = useNodes();
  const manyNodes = multiNode(nodesInfo);
  // コピー・移動（#98）
  const [copying, setCopying] = useState(false);
  const [copyTo, setCopyTo] = useState('');
  const [copyMove, setCopyMove] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // ノードが 2 つ以上なら「全体 / ノードごと」のタブ（1 つなら今と同じ見た目）
  const [tab, setTab] = useState('all');
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState('');
  const nodeTabs = manyNodes && rule !== null && (rule.nodes?.length ?? 0) > 0
    ? [{ id: 'all', label: '全体' }, ...(rule.nodes ?? []).map((n) => ({
      id: n.node,
      label: <span className="font-mono">{n.node}</span>,
      badge: (n.drift ?? []).length > 0 || n.state === 'failed' || n.state === 'missing'
        ? <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-600" aria-label="要確認" /> : undefined,
    }))]
    : null;
  // 選んでいたノードがなくなったら「全体」に戻す（描画中に直す）
  if (tab !== 'all' && nodeTabs && !nodeTabs.some((t) => t.id === tab)) setTab('all');
  const view = rule && nodeTabs && tab !== 'all' ? projectRule(rule, tab) ?? rule : rule;
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
      const detail = err instanceof Error ? err.message : String(err);
      setError(action === 'pause' ? `ルールの停止に失敗しました: ${detail}` : `ルールの再開に失敗しました: ${detail}`);
      setConfirmingPause(false);
    } finally {
      setSwitching(false);
    }
  };

  // ほかのノード／グループへのコピー・移動（#98）
  const handleCopy = async () => {
    if (!rule || copyTo === '') return;
    setCopyBusy(true);
    try {
      const res = await fetch('/api/forward/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: rule.protocol, srcAddr: rule.srcAddr, srcPort: rule.srcPort, target: rule.target, to: copyTo, move: copyMove }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      setCopying(false);
      // ノードに置いたときは、そのノードの上書きの待ち受けアドレスになる
      const toGroup = nodesInfo?.groups.some((g) => g.name === copyTo) ?? false;
      const addr = !toGroup ? rule.overrides?.[copyTo]?.srcAddr ?? rule.srcAddr : rule.srcAddr;
      await router.push(ruleHref({ protocol: rule.protocol, addr: addr, port: rule.srcPort, target: copyTo }));
    } catch (err) {
      setError(`${copyMove ? '移動' : 'コピー'}に失敗しました: ${err instanceof Error ? err.message : err}`);
      setCopying(false);
    } finally {
      setCopyBusy(false);
    }
  };

  // このノードだけに UI の定義を送り直す（#98）
  const handleResend = async (node: string) => {
    if (!rule) return;
    setResending(true);
    setResendNotice('');
    try {
      const res = await fetch('/api/forward/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: rule.protocol, srcAddr: rule.srcAddr, srcPort: rule.srcPort, target: rule.target, node: node }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      const out = await res.json() as { result: string };
      setResendNotice(`${node}: ${translate(RESEND_RESULTS[out.result] ?? out.result)}`);
      await load();
    } catch (err) {
      setError(`送り直しに失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      setResending(false);
    }
  };

  const handleDelete = async () => {
    if (!rule) return;
    setDeleting(true);
    try {
      if (rule.origin === 'api') await postRule('api-delete', { protocol: rule.protocol, srcAddr: rule.srcAddr, srcPort: rule.srcPort, target: rule.target });
      else await postRule('delete', toRule(rule));
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
  const live = view !== null && view.state !== 'unknown' && view.state !== 'missing';

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
        {rule && key && rule.origin === 'api' && rule.ruleset && (
          <p className="inline-flex flex-wrap items-center gap-2 text-sm text-gray-800" data-testid="owned-note">
            <ApiBadge rule={rule} />
            {OWNED_RULE_MESSAGE}
          </p>
        )}
        {rule && key && rule.origin === 'api' && !rule.ruleset && (
          <div className="flex flex-wrap gap-2">
            <Link href={ruleEditHref({ ...key, ...(rule.target !== undefined ? { target: rule.target } : {}) })} className="btn-primary">編集</Link>
            <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>削除</button>
          </div>
        )}
        {rule && key && rule.origin === 'dynamic' && (
          <div className="flex flex-wrap gap-2">
            <Link href={ruleEditHref(key)} className="btn-primary">編集</Link>
            {manyNodes && rule.target !== undefined && <button type="button" className="btn-secondary" onClick={() => { setCopyTo(''); setCopyMove(false); setCopying(true); }}>コピー・移動</button>}
            {rule.state === 'paused'
              ? <button type="button" className="btn-secondary" disabled={switching} onClick={() => void handlePauseResume('resume')}>{switching ? '再開中…' : '再開'}</button>
              : <button type="button" className="btn-secondary" onClick={() => setConfirmingPause(true)}>一時停止</button>}
            <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>削除</button>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {notice && <p role="status" className="rounded-sm border border-green-300 bg-green-50 px-4 py-2 text-sm text-green-900">{notice}</p>}
      {notFound && (
        <div className="card p-4 text-gray-900">
          <p>このルールは見つかりません（削除されたか、ほかの利用者のルールです）。</p>
          <Link href="/" className="link">ダッシュボードへ戻る</Link>
        </div>
      )}
      {!rule && !notFound && !error && <p className="text-gray-700">読み込み中…</p>}

      {nodeTabs && <Tabs id="rule-nodes" label="ノード" tabs={nodeTabs} active={tab} onChange={(t) => { setTab(t); setResendNotice(''); }} />}

      {view && rule && (
        <div {...(nodeTabs ? tabPanelProps('rule-nodes', tab) : { className: 'space-y-4' })}>
          {nodeTabs && tab === 'all' && <NodeCompare rule={rule} />}
          {rule.origin === 'api' && <ApiRuleSection rule={rule} />}
          {rule.origin === 'dynamic' && rule.shadowedBy && (
            <p role="status" className="rounded-sm border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900" data-testid="shadowed-note">
              {rule.shadowedBy.ruleset
                ? `同じキーを rproxy ではルールの組 ${rule.shadowedBy.ruleset} のルールが使っているため、この UI のルールは動いていません。`
                : `同じキーを rproxy では API で作ったルール${rule.shadowedBy.createdBy ? `（${rule.shadowedBy.createdBy}）` : ''}が使っているため、この UI のルールは動いていません。`}
              rproxy を再起動すると UI のルールが使われます（rproxy_rules の同じキーの行は使われません）。どちらかを消すか、キーを変えてください。
            </p>
          )}
          {nodeTabs && tab !== 'all' && view.nodes?.[0] && (
            <DriftSection rule={rule} node={view.nodes[0]} busy={resending} onResend={() => void handleResend(tab)} notice={resendNotice} />
          )}
          {nodeTabs && tab !== 'all' && rule.origin === 'dynamic' && nodesInfo?.groups.some((g) => g.name === rule.target) && (
            <OverrideEditor key={`${tab}|${JSON.stringify(rule.overrides?.[tab] ?? null)}`} rule={rule} node={tab}
              onSaved={(m) => { setNotice(m); void load(); }} onError={setError} />
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Section id="section-overview" title="概要">
              <Fields items={[
                ['状態', <StateBadge key="s" state={view.state} />],
                ...(manyNodes && view.target !== undefined ? [
                  ['ノード／グループ', <Mono key="t">{view.target}</Mono>] as [string, React.ReactNode],
                  ...(tab === 'all'
                    ? [['ノードごとの状態', <NodeStates key="n" nodes={view.nodes} />] as [string, React.ReactNode]]
                    : [['役割', view.nodes?.[0]?.role ? <RoleBadge key="r" role={view.nodes[0].role} /> : null] as [string, React.ReactNode]]),
                  ...(rule.ha ? [['act', <span key="ha" className="inline-flex flex-wrap items-center gap-2">
                    <Mono>{rule.ha.active.join(', ') || '-'}</Mono><HaWarning ha={rule.ha} /></span>] as [string, React.ReactNode]] : []),
                ] : []),
                ['エラー', view.error ? <span className="text-red-800">{ruleErrorText(view.error)}</span> : view.state === 'missing'
                  ? <span className="text-amber-900">rproxy でこのルールが動いていません（編集して保存すると作り直します）。</span>
                  : view.state === 'unknown' ? <span className="text-gray-700">rproxy に接続できないため、稼働状態がわかりません。</span>
                  : view.state === 'paused' ? <span className="text-gray-700">一時停止中です（設定は残したまま、rproxy では動かしていません。「再開」でこの内容のまま動かします）。</span> : null],
                ['開始時刻', formatTimestamp(view.startedAt)],
                ['稼働時間', formatDuration(uptimeSecs(view.startedAt, now))],
                // 管理者（rproxy-admin）が見るときだけ付く
                ...(view.owner !== undefined ? [['所有者（Keycloak の ID）', <Mono key="o">{view.owner}</Mono>] as [string, React.ReactNode]] : []),
              ]} />
            </Section>

            <Section id="section-stats" title="統計（開始してからの累計）">
              <Fields items={[
                [view.protocol === 'udp' ? '現在のセッション' : '現在の接続', live ? formatCount(view.connections) : null],
                ['累計の接続', view.stats ? formatCount(view.stats.total_connections) : null],
                ['rx（受信）', view.stats ? formatBytes(view.stats.rx_bytes) : null],
                ['tx（送信）', view.stats ? formatBytes(view.stats.tx_bytes) : null],
                ['TLS 失敗', view.stats ? formatCount(view.stats.tls_failures) : null],
                ['拒否した接続', view.stats ? formatCount(view.stats.denied ?? 0) : null],
                // L4 の制限（v0.4）で断った数。返さない rproxy では出さない
                ...(typeof view.stats?.limited === 'number' ? [['制限で断った接続', formatCount(view.stats.limited)] as [string, React.ReactNode]] : []),
                ...(typeof view.stats?.counters_since === 'number' ? [['数え始め', formatTimestamp(view.stats.counters_since)] as [string, React.ReactNode]] : []),
                // 古い rproxy は dropped を返さないので、そのときは出さない
                ...(view.protocol === 'udp' && typeof view.stats?.dropped === 'number'
                  ? [['捨てたデータグラム', formatCount(view.stats.dropped)] as [string, React.ReactNode]]
                  : []),
              ]} />
              <p className="mt-2 text-xs text-gray-600">
                rx はクライアント → 転送先、tx は転送先 → クライアントのバイト数です。
                拒否した接続は、許可する送信元（allow_from）の範囲外か、どのサーバ名にも一致しない（unmatched: reject）ため切断した接続です。
                {view.protocol === 'udp' && '捨てたデータグラムは、rproxy が転送できずに捨てた数です（セッションの待ち行列があふれた・送信に失敗した など。カーネルの受信バッファで捨てられたものは含まない）。'}
              </p>
            </Section>

            <Section id="section-listen" title="待ち受け">
              <Fields items={[
                ['プロトコル', view.protocol.toUpperCase()],
                ['アドレス', <Mono key="a">{view.srcAddr}</Mono>],
                ...((view.extraListenAddrs ?? []).length > 0 ? [['追加の待ち受けアドレス', (
                  <span key="x" data-testid="extra-listen-addrs">
                    {(view.extraListenAddrs ?? []).map((x) => <Mono key={x}>{x} </Mono>)}
                  </span>
                )] as [string, React.ReactNode]] : []),
                [view.srcPortEnd === null ? 'ポート' : 'ポート範囲', <Mono key="p">{portsLabel(view.srcPort, view.srcPortEnd)}</Mono>],
                ...(view.srcPortEnd !== null ? [['ポート数', `${view.srcPortEnd - view.srcPort + 1}`] as [string, React.ReactNode]] : []),
              ]} />
            </Section>

            <Section id="section-target" title="転送先">
              {view.http !== null ? (
                // L7 のルールは転送先を持たない（http.services に書く）。中身は下の「L7 (HTTP)」
                <>
                  <Fields items={[
                    ['転送先', targetLabel(view)],
                    ['ルート', `${httpRouteCount(view.http)} 件`],
                  ]} />
                  <p className="mt-2 text-xs text-gray-600" data-testid="http-note">
                    HTTP のリクエストごとに、下の「L7 (HTTP)」のルートとサービスで振り分けます。{view.origin === 'static' ? '固定ルールなので、rproxy の設定ファイルで変更してください。' : '変更は「編集」の「L7 (HTTP)」タブで行います。'}
                  </p>
                </>
              ) : view.targets.length > 0 ? (
                <>
                  <Fields items={[
                    ['振り分け方', BALANCE_LABELS[view.balance]],
                    ['宛先の数', `${view.targets.length} 件`],
                    ['ヘルスチェック', healthCheckLabel(view.healthCheck)],
                    ['解決したアドレス', view.resolved.length > 0
                      ? <ul key="r" className="font-mono">{view.resolved.map((a) => <li key={a}>{a}</li>)}</ul>
                      : live ? 'まだ名前解決できていません' : null],
                  ]} />
                  <TargetsTable rule={view} />
                </>
              ) : (
                <Fields items={[
                  ['転送先', <Mono key="t">{targetLabel(view)}</Mono>],
                  ['解決したアドレス', view.resolved.length > 0
                    ? <ul key="r" className="font-mono">{view.resolved.map((a) => <li key={a}>{a}</li>)}</ul>
                    : live ? 'まだ名前解決できていません' : null],
                ]} />
              )}
            </Section>
          </div>

          {view.http !== null && (
            <Section id="section-http" title="L7 (HTTP)">
              <HttpSummary http={view.http} />
            </Section>
          )}

          {view.stats?.http && <HttpStatsSection http={view.stats.http} />}

          <V04Section rule={view} />

          {view.conditions && view.conditions.length > 0 && <ConditionsSection conditions={view.conditions} />}

          <TlsSection rule={view} />

          {view.certStatus && view.certStatus.length > 0 && <CertStatusSection certs={view.certStatus} />}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Section id="section-starttls" title="STARTTLS">
              {view.starttls ? (
                <Fields items={[
                  ['プロトコル', view.starttls],
                  ['必須', view.starttlsRequired ? 'はい' : 'いいえ（STARTTLS をしないクライアントも平文のまま通す）'],
                ]} />
              ) : <p className="text-sm text-gray-700">使わない</p>}
            </Section>

            <Section id="section-advanced" title="詳細">
              <Fields items={[
                ['送信元 IP の扱い', <Mono key="s">{view.sourceIp}</Mono>],
                ...(view.protocol === 'udp' ? [['UDP のアイドルタイムアウト', `${view.udpIdleSecs} 秒`] as [string, React.ReactNode]] : []),
                ['接続を許可する送信元', view.allowFrom.length > 0
                  ? (
                    <div key="af" data-testid="allow-from">
                      <AllowFromBadge allowFrom={view.allowFrom} />
                      <ul className="font-mono mt-1">{view.allowFrom.map((c) => <li key={c}>{c}</li>)}</ul>
                    </div>
                  )
                  : 'すべて許可'],
                ['CrowdSec（L4）', view.crowdsec ? '判定に入っている接続元を切る' : '使わない'],
              ]} />
            </Section>
          </div>
        </div>
      )}

      {/* 変更の履歴（#61）。固定ルールは DB にないので履歴もない */}
      {key && !(rule && rule.origin !== 'dynamic') && (
        <Section id="section-history" title="変更の履歴">
          <HistoryList filter={{ protocol: key.protocol, addr: key.addr, port: key.port, ...((key.target ?? rule?.target) !== undefined ? { target: key.target ?? rule?.target } : {}) }} onReverted={() => void load()} />
        </Section>
      )}

      <ConfirmDialog
        open={copying}
        title="ほかのノード／グループへコピー・移動"
        confirmLabel={copyMove ? '移動する' : 'コピーする'}
        busy={copyBusy}
        onConfirm={() => void handleCopy()}
        onCancel={() => setCopying(false)}
      >
        <label className="block text-sm text-gray-900">
          <span className="block mb-1">先のノード／グループ</span>
          <select className="border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900" value={copyTo} onChange={(e) => setCopyTo(e.target.value)} data-testid="copy-to">
            <option value="">選んでください</option>
            {nodesInfo && targetChoices(nodesInfo).filter((c) => c.value !== rule?.target).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-900">
          <input type="checkbox" checked={copyMove} onChange={(e) => setCopyMove(e.target.checked)} />
          移動する（元のルールを消す）
        </label>
        <p className="mt-2 text-xs text-gray-700">ノードごとの上書きは、先にもあるノードの分だけ引き継ぎます。ノードが重なるときの移動は、元を消してから作るので既存の接続が切れます。</p>
      </ConfirmDialog>
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
