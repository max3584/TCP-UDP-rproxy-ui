// L7（ルールの http）の読み取り専用の表示。ルールの詳細画面で使う（tests/httpspec.test.ts）

import React from 'react';
import type { HttpSpec } from './lib';
import { MIDDLEWARE_KINDS, defaultPriority, middlewareKind, toHttpRules } from './httpspec';

const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="font-mono">{children}</span>;

// ミドルウェアの設定を 1 行で（{"average":5,"period":"1m"} → average: 5, period: 1m）
function configLabel(config: Record<string, unknown>): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
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
      <div className="overflow-x-auto mb-3">
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
                <td className="font-mono">{r.name}</td>
                <td className="font-mono text-xs break-all">{r.match}</td>
                <td className="font-mono text-xs break-all">{r.service ? `サービス ${r.service}` : r.to ?? <span className="font-sans text-gray-700">ミドルウェアが応答</span>}</td>
                <td className="font-mono text-xs">{(r.middlewares ?? []).join(' → ') || '-'}</td>
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
              <li key={name}>
                <Mono>{name}</Mono>:{' '}
                <span className="font-mono text-xs">{s.servers.map((srv) => `${srv.url}${srv.weight !== undefined && srv.weight !== 1 ? `（重み ${srv.weight}）` : ''}`).join(', ')}</span>
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
