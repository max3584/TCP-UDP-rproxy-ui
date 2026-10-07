// L7（ルールの http）の読み取り専用の表示。ルールの詳細画面で使う（tests/httpspec.test.ts）

import React from 'react';
import type { HttpSpec } from './lib';
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

const HttpSummary: React.FC<{ http: HttpSpec }> = ({ http }) => {
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
                <span className="font-mono text-xs break-all">{s.servers.map(serverLabel).join(', ')}</span>
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
