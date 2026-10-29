// L7（ルールの http）の読み取り専用の表示。ルールの詳細画面で使う（tests/httpspec.test.ts）

import React from 'react';
import type { HttpServerStats, HttpSpec } from './lib';
import { capUsageLabel } from './targets';
import { TargetFullBadge } from './ui';
import { MIDDLEWARE_KINDS, UPSTREAM_PROTOCOL_LABELS, defaultPriority, middlewareKind, toHttpRules } from './httpspec';
import type { ServerSpec, ServiceTlsSpec } from './httpspec';
import { joinList, translate } from '@/i18n/core';

const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="font-mono">{children}</span>;

// ミドルウェアの設定を 1 行で（{"average":5,"period":"1m"} → average: 5, period: 1m）
function configLabel(config: Record<string, unknown>): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

// 転送先 1 件（URL か状態コード、重み、転送先だけのミドルウェア）
function serverLabel(srv: ServerSpec): string {
  const head = srv.status !== undefined ? translate(`状態コード ${srv.status} で答える`) : srv.url ?? '';
  const weight = srv.weight !== undefined && srv.weight !== 1 ? translate(`（重み ${srv.weight}）`) : '';
  const mws = (srv.middlewares ?? []).length > 0 ? translate(`（ミドルウェア ${(srv.middlewares ?? []).join(' → ')}）`) : '';
  return `${head}${weight}${mws}`;
}

// 転送先の状態（rproxy の stats.http.services.<名前>[]）を探す。rproxy は状態コードの転送先を出さないので、
// 状態コードの転送先を除いた位置で引く（同じ URL の転送先が複数あっても取り違えない）。数が合わなければ null
export function serverStatus(servers: ServerSpec[], stats: HttpServerStats[] | undefined, index: number): HttpServerStats | null {
  if (!stats || stats.length === 0 || servers[index] === undefined || servers[index].status !== undefined) return null;
  const urlServers = servers.filter((x) => x.status === undefined);
  if (stats.length !== urlServers.length) return null;
  return stats[servers.slice(0, index).filter((x) => x.status === undefined).length] ?? null;
}

// 転送先の同時に処理する上限と今の数（#341。上限がなければ何も出さない）
// aggregate（ノードが 2 つ以上のルールの「全体」）では上限はノードごとなので、合計の処理中の数とは並べず上限だけ出す
const ServerCap: React.FC<{ srv: ServerSpec; live: HttpServerStats | null; aggregate: boolean }> = ({ srv, live, aggregate }) => {
  const max = srv.max_connections ?? live?.max_connections;
  if (max === undefined) return null;
  return (
    <span className="font-sans text-gray-700" data-testid="http-server-cap">
      {!aggregate && live?.in_flight !== undefined
        ? translate(`（処理中 ${capUsageLabel(live.in_flight, max)}）`)
        : aggregate ? translate(`（上限 ${max.toLocaleString('en-US')}・ノードごと）`) : translate(`（上限 ${max.toLocaleString('en-US')}）`)}
      {!aggregate && live?.full === true && <TargetFullBadge />}
    </span>
  );
};

// サービスの転送先の TLS の要約
function serviceTlsLabel(t: ServiceTlsSpec): string {
  const parts: string[] = [];
  if (t.server_name) parts.push(translate(`サーバ名 ${t.server_name}`));
  if (t.ca_file) parts.push(translate(`CA ${t.ca_file}`));
  if (t.subject_alt_names && t.subject_alt_names.length > 0) parts.push(translate(`SAN ${t.subject_alt_names.join(', ')}`));
  if (t.cert_file) parts.push(translate(`クライアント証明書 ${t.cert_file}`));
  if (t.chain_file) parts.push(translate(`中間 CA ${t.chain_file}`));
  if (t.insecure_skip_verify) parts.push(translate('証明書を確かめない'));
  return parts.length > 0 ? joinList(parts) : translate('既定');
}

// services：rproxy の stats.http.services（転送先の状態。動いているときだけ）
const HttpSummary: React.FC<{ http: HttpSpec; services?: Record<string, HttpServerStats[]>; aggregate?: boolean }> = ({ http, services: liveServices, aggregate = false }) => {
  const rules = toHttpRules(http);
  const services = rules.services ?? {};
  const mws = rules.middlewares ?? {};
  // rproxy と同じ順（優先度の大きい順、同じなら書いた順）
  const ordered = rules.routes
    .map((r, i) => ({ r, i, priority: r.priority ?? defaultPriority(r.match) }))
    .sort((a, b) => b.priority - a.priority || a.i - b.i);
  return (
    <div data-testid="http-summary">
      {rules.http3 && <p className="text-sm text-gray-900 mb-2">HTTP/3（QUIC）も受ける</p>}
      <h3 className="text-sm font-semibold text-gray-900 mb-1">ルート（試す順）</h3>
      <div className="table-scroll mb-3">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="text-right">優先度</th>
              <th scope="col">名前</th>
              <th scope="col">条件（match）</th>
              <th scope="col">転送先</th>
              <th scope="col">ミドルウェア</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(({ r, priority }) => (
              <tr key={r.name}>
                <td className="text-right tabular-nums">{priority}{r.priority === undefined && <span className="text-xs text-gray-600">（既定）</span>}</td>
                <td className="font-mono break-all">{r.name}</td>
                <td className="font-mono text-xs break-all">{r.match}</td>
                <td className="font-mono text-xs break-all">
                  {r.service ? `サービス ${r.service}` : r.to ?? <span className="font-sans text-gray-700">ミドルウェアが応答</span>}
                  {r.timeouts && (r.timeouts.request || r.timeouts.backend_request) && (
                    <div className="font-sans text-gray-700" data-testid="http-route-timeouts">
                      {joinList([
                        ...(r.timeouts.request ? [translate(`全体 ${r.timeouts.request}`)] : []),
                        ...(r.timeouts.backend_request ? [translate(`転送先へ 1 回 ${r.timeouts.backend_request}`)] : []),
                      ])}
                    </div>
                  )}
                </td>
                <td className="font-mono text-xs break-all">{(r.middlewares ?? []).join(' → ') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-gray-900 mb-3">
        どれにも一致しないとき: {rules.default?.service ? <Mono>サービス {rules.default.service}</Mono> : `${rules.default?.status ?? 404} を返す`}
      </p>
      {Object.keys(services).length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-gray-900 mb-1">サービス</h3>
          <ul className="text-sm mb-3 space-y-1">
            {Object.entries(services).map(([name, s]) => (
              <li key={name} className="break-all">
                <Mono>{name}</Mono>:{' '}
                <span className="font-mono text-xs break-all">
                  {s.servers.map((srv, k) => (
                    <React.Fragment key={k}>
                      {k > 0 && ', '}
                      {serverLabel(srv)}
                      <ServerCap srv={srv} live={serverStatus(s.servers, liveServices?.[name], k)} aggregate={aggregate} />
                    </React.Fragment>
                  ))}
                </span>
                {s.protocol !== undefined && s.protocol !== 'http1' && <span className="text-xs text-gray-700" data-testid="http-service-protocol">（{UPSTREAM_PROTOCOL_LABELS[s.protocol] ?? s.protocol}）</span>}
                {s.tls && <span className="text-xs text-gray-700 break-all" data-testid="http-service-tls">（転送先の TLS: {serviceTlsLabel(s.tls)}）</span>}
                {s.pass_host_header === false && <span className="text-xs text-gray-700">（Host は転送先の URL）</span>}
                {s.health_check && <span className="text-xs text-gray-700">（ヘルスチェック {s.health_check.path}）</span>}
                {s.sticky && <span className="text-xs text-gray-700">（スティッキー {s.sticky.cookie}）</span>}
                {s.timeouts && <span className="text-xs text-gray-700">（タイムアウト {configLabel(s.timeouts)}）</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {Object.keys(mws).length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-gray-900 mb-1">ミドルウェア</h3>
          <ul className="text-sm space-y-1">
            {Object.entries(mws).map(([name, m]) => {
              const kind = middlewareKind(m);
              return (
                <li key={name}>
                  <Mono>{name}</Mono>: {MIDDLEWARE_KINDS[kind] ?? kind}
                  <span className="font-mono text-xs text-gray-700 break-all">（{configLabel((m[kind] ?? {}) as Record<string, unknown>) || '既定'}）</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};

export default HttpSummary;
