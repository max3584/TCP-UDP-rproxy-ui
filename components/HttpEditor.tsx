// L7（ルールの http）の編集欄。RuleForm の「L7 (HTTP)」タブで使う（tests/httpeditor.test.ts）。
// 値は親が持ち、変更は onChange で丸ごと返す。検証は httpspec.ts の validateHttp（送信時に親が呼ぶ）

import React, { useState } from 'react';
import {
  HttpRules,
  MIDDLEWARE_KINDS,
  MIDDLEWARE_TEMPLATES,
  MiddlewareSpec,
  RouteSpec,
  ServiceSpec,
  buildMatch,
  checkMatch,
  defaultPriority,
  middlewareKind,
} from './httpspec';

export interface HttpEditorProps {
  value: HttpRules;
  onChange: (value: HttpRules) => void;
  // GET /capabilities の features（取得できなかったときは null。そのときはすべての種類を出す）
  middlewares: readonly string[] | null;
  serviceOptions: readonly string[] | null;
  http3: boolean;
}

const inputClass = 'border border-gray-300 rounded px-2 py-1 w-full bg-white text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const monoInput = `${inputClass} font-mono text-sm`;
const smallButton = 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-2 py-1 rounded text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const removeButton = 'text-red-700 hover:text-red-900 text-sm px-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const labelClass = 'block text-xs font-medium text-gray-800 mb-1';
const boxClass = 'border border-gray-300 rounded p-3 mb-3 bg-white';
const headingClass = 'text-sm font-semibold text-gray-900 mb-2';

// 種類ごとの入力欄（ここにない種類は JSON で編集する）
type FieldType = 'text' | 'number' | 'bool' | 'list' | 'select';
interface FieldDef { key: string; label: string; type: FieldType; options?: string[]; placeholder?: string }
const FIELDS: Record<string, FieldDef[]> = {
  redirect_scheme: [
    { key: 'scheme', label: 'スキーム', type: 'select', options: ['https', 'http'] },
    { key: 'port', label: 'ポート（省略時は既定）', type: 'number' },
    { key: 'permanent', label: '恒久的（301 / 308）', type: 'bool' },
  ],
  redirect_regex: [
    { key: 'regex', label: '正規表現（URL 全体）', type: 'text', placeholder: '^https?://www\\.(.+)$' },
    { key: 'replacement', label: '置き換え後', type: 'text', placeholder: 'https://$1' },
    { key: 'permanent', label: '恒久的（301 / 308）', type: 'bool' },
  ],
  rate_limit: [
    { key: 'average', label: '平均（period あたりの件数）', type: 'number' },
    { key: 'period', label: '期間（例 1s、1m）', type: 'text' },
    { key: 'burst', label: 'バースト', type: 'number' },
    { key: 'source', label: '数える単位（ip か header:名前）', type: 'text' },
  ],
  in_flight: [{ key: 'amount', label: 'クライアント IP ごとの同時リクエスト数', type: 'number' }],
  crowdsec: [
    { key: 'appsec', label: 'AppSec にも問い合わせる', type: 'bool' },
    { key: 'on_error', label: 'CrowdSec に問い合わせできないとき', type: 'select', options: ['allow', 'block'] },
  ],
  ip_allow: [{ key: 'source_range', label: '許可する範囲（CIDR。カンマ区切り）', type: 'list', placeholder: '10.0.0.0/8, 192.168.0.0/16' }],
  strip_prefix: [{ key: 'prefixes', label: '取り除く接頭辞（カンマ区切り）', type: 'list', placeholder: '/api' }],
  add_prefix: [{ key: 'prefix', label: '足す接頭辞', type: 'text', placeholder: '/api' }],
  replace_path: [{ key: 'path', label: '置き換え後のパス', type: 'text', placeholder: '/' }],
  replace_path_regex: [
    { key: 'regex', label: '正規表現（パス）', type: 'text' },
    { key: 'replacement', label: '置き換え後', type: 'text' },
  ],
  respond: [
    { key: 'status', label: '状態コード', type: 'number' },
    { key: 'body', label: '本文', type: 'text' },
    { key: 'content_type', label: 'Content-Type（省略時 text/plain）', type: 'text' },
  ],
  buffering: [{ key: 'max_request_body', label: 'リクエストの本文の上限（バイト）', type: 'number' }],
  retry: [
    { key: 'attempts', label: '回数', type: 'number' },
    { key: 'initial_interval', label: '最初の間隔（例 100ms）', type: 'text' },
  ],
  circuit_breaker: [
    { key: 'failure_percent', label: '失敗の割合（%）', type: 'number' },
    { key: 'window', label: '集計の期間（例 10s）', type: 'text' },
    { key: 'recovery', label: '回復を試すまで（例 30s）', type: 'text' },
  ],
  basic_auth: [{ key: 'users_file', label: '利用者のファイル（htpasswd）', type: 'text' }],
};

// 名前の付け替え（順番を保つ）
function renameKey<T>(obj: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));
}

function uniqueName(base: string, taken: Record<string, unknown> | string[]): string {
  const names = Array.isArray(taken) ? taken : Object.keys(taken);
  if (!names.includes(base)) return base;
  let i = 2;
  while (names.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

// ---- 1 つのミドルウェアの設定 ----

const JsonConfig: React.FC<{ id: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }> = ({ id, value, onChange }) => {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return (
    <div>
      <label htmlFor={id} className={labelClass}>設定（JSON）</label>
      <textarea
        id={id}
        className={`${monoInput} h-28`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('オブジェクト（{...}）にしてください');
            setError('');
            onChange(parsed);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        aria-invalid={error !== '' || undefined}
      />
      {error && <p className="text-red-700 text-xs mt-1">JSON の誤り: {error}</p>}
    </div>
  );
};

const TypedConfig: React.FC<{ id: string; fields: FieldDef[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }> = ({ id, fields, value, onChange }) => {
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {fields.map((f) => {
        const fid = `${id}-${f.key}`;
        const v = value[f.key];
        if (f.type === 'bool') {
          return (
            <label key={f.key} htmlFor={fid} className="flex items-center gap-2 text-sm text-gray-800">
              <input id={fid} type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />
              {f.label}
            </label>
          );
        }
        return (
          <div key={f.key}>
            <label htmlFor={fid} className={labelClass}>{f.label}</label>
            {f.type === 'select' ? (
              <select id={fid} className={inputClass} value={String(v ?? f.options?.[0] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                id={fid}
                type={f.type === 'number' ? 'number' : 'text'}
                className={f.type === 'number' ? inputClass : monoInput}
                placeholder={f.placeholder}
                value={f.type === 'list' ? (Array.isArray(v) ? v.join(', ') : '') : v === undefined ? '' : String(v)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (f.type === 'number') set(f.key, raw === '' ? undefined : Number(raw));
                  else if (f.type === 'list') set(f.key, raw.split(',').map((s) => s.trim()).filter((s) => s !== ''));
                  else set(f.key, raw);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---- match の組み立て ----

const MatchBuilder: React.FC<{ id: string; onApply: (match: string) => void }> = ({ id, onApply }) => {
  const [hosts, setHosts] = useState('');
  const [prefixes, setPrefixes] = useState('');
  const [methods, setMethods] = useState('');
  const [ips, setIps] = useState('');
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const built = buildMatch({ hosts: split(hosts), pathPrefixes: split(prefixes), methods: split(methods), clientIps: split(ips) });
  const fields: [string, string, string, (v: string) => void, string][] = [
    ['host', 'Host（ホスト名）', hosts, setHosts, 'app.example.com, www.example.com'],
    ['prefix', 'PathPrefix（パスの前方一致）', prefixes, setPrefixes, '/api/, /assets/'],
    ['method', 'Method', methods, setMethods, 'GET, POST'],
    ['ip', 'ClientIP（送信元）', ips, setIps, '10.0.0.0/8'],
  ];
  return (
    <details className="mt-1">
      <summary className="text-xs text-blue-700 cursor-pointer">条件を選んで組み立てる</summary>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 bg-gray-50 border border-gray-200 rounded p-2">
        {fields.map(([key, label, value, setter, ph]) => (
          <div key={key}>
            <label htmlFor={`${id}-${key}`} className={labelClass}>{label}（カンマ区切りでいずれか）</label>
            <input id={`${id}-${key}`} className={monoInput} value={value} placeholder={ph} onChange={(e) => setter(e.target.value)} />
          </div>
        ))}
        <p className="sm:col-span-2 text-xs text-gray-700 font-mono break-all">{built || '（条件を入力してください）'}</p>
        <div className="sm:col-span-2">
          <button type="button" className={smallButton} disabled={built === ''} onClick={() => onApply(built)}>この式を match に入れる</button>
        </div>
      </div>
    </details>
  );
};

// ---- 本体 ----

const HttpEditor: React.FC<HttpEditorProps> = ({ value, onChange, middlewares, serviceOptions, http3 }) => {
  const services = value.services ?? {};
  const mws = value.middlewares ?? {};
  const serviceNames = Object.keys(services);
  const mwNames = Object.keys(mws);
  // 選べるミドルウェアの種類（features.middlewares。使っている種類は残す）
  const kinds = Object.keys(MIDDLEWARE_KINDS).filter((k) => middlewares === null || middlewares.includes(k));

  const setRoutes = (routes: RouteSpec[]) => onChange({ ...value, routes });
  const updateRoute = (i: number, patch: Partial<RouteSpec>) =>
    setRoutes(value.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setServices = (s: Record<string, ServiceSpec>) => onChange({ ...value, services: s });
  const updateService = (name: string, patch: Partial<ServiceSpec>) => setServices({ ...services, [name]: { ...services[name], ...patch } });
  const setMiddlewares = (m: Record<string, MiddlewareSpec>) => onChange({ ...value, middlewares: m });

  const renameService = (from: string, to: string) => {
    onChange({
      ...value,
      services: renameKey(services, from, to),
      routes: value.routes.map((r) => (r.service === from ? { ...r, service: to } : r)),
      default: value.default?.service === from ? { ...value.default, service: to } : value.default,
    });
  };
  const removeService = (name: string) => {
    const rest = { ...services };
    delete rest[name];
    onChange({
      ...value,
      services: rest,
      routes: value.routes.map((r) => (r.service === name ? { ...r, service: undefined } : r)),
      default: value.default?.service === name ? { ...value.default, service: undefined } : value.default,
    });
  };
  const renameMiddleware = (from: string, to: string) => {
    onChange({
      ...value,
      middlewares: renameKey(mws, from, to),
      routes: value.routes.map((r) => ({ ...r, middlewares: r.middlewares?.map((m) => (m === from ? to : m)) })),
    });
  };
  const removeMiddleware = (name: string) => {
    const rest = { ...mws };
    delete rest[name];
    onChange({ ...value, middlewares: rest, routes: value.routes.map((r) => ({ ...r, middlewares: r.middlewares?.filter((m) => m !== name) })) });
  };

  return (
    <div>
      <p className="mb-3 text-xs text-gray-700">
        HTTP のリクエストごとに、<strong>ルート</strong>の条件（match）で転送先を選びます。条件の式は Traefik と同じ書き方です（例 <span className="font-mono">Host(`app.example.com`) &amp;&amp; PathPrefix(`/api/`)</span>）。
        優先度が大きいルールから順に試し、省略時は式の長さが優先度になります。
      </p>

      {http3 && (
        <label className="flex items-center gap-2 text-sm text-gray-800 mb-3">
          <input type="checkbox" checked={value.http3 === true} onChange={(e) => onChange({ ...value, http3: e.target.checked })} />
          HTTP/3（QUIC）も同じポートの UDP で受ける
        </label>
      )}

      <section aria-labelledby="http-routes-heading" className="mb-4">
        <h3 id="http-routes-heading" className={headingClass}>ルート（{value.routes.length} 件）</h3>
        {value.routes.map((r, i) => {
          const id = `http-route-${i}`;
          const matchError = r.match ? checkMatch(r.match) : null;
          const target = r.service !== undefined ? `service:${r.service}` : r.to !== undefined ? 'to' : 'none';
          return (
            <div key={i} className={boxClass} data-testid="http-route">
              <div className="flex gap-2 items-end mb-2">
                <div className="flex-1">
                  <label htmlFor={`${id}-name`} className={labelClass}>名前</label>
                  <input id={`${id}-name`} className={monoInput} value={r.name} onChange={(e) => updateRoute(i, { name: e.target.value.trim() })} />
                </div>
                <div className="w-28">
                  <label htmlFor={`${id}-priority`} className={labelClass}>優先度</label>
                  <input
                    id={`${id}-priority`}
                    type="number"
                    className={inputClass}
                    value={r.priority ?? ''}
                    placeholder={String(defaultPriority(r.match))}
                    onChange={(e) => updateRoute(i, { priority: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                </div>
                <div className="flex gap-1">
                  <button type="button" className={smallButton} aria-label={`ルート ${r.name} を上へ`} onClick={() => setRoutes(move(value.routes, i, -1))}>↑</button>
                  <button type="button" className={smallButton} aria-label={`ルート ${r.name} を下へ`} onClick={() => setRoutes(move(value.routes, i, 1))}>↓</button>
                  <button type="button" className={removeButton} onClick={() => setRoutes(value.routes.filter((_, j) => j !== i))}>削除</button>
                </div>
              </div>
              <label htmlFor={`${id}-match`} className={labelClass}>条件（match）</label>
              <input id={`${id}-match`} className={monoInput} value={r.match} onChange={(e) => updateRoute(i, { match: e.target.value })} aria-invalid={matchError !== null || undefined} />
              {matchError && <p className="text-red-700 text-xs mt-1">{matchError}</p>}
              <MatchBuilder id={`${id}-builder`} onApply={(m) => updateRoute(i, { match: m })} />
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`${id}-target`} className={labelClass}>転送先</label>
                  <select
                    id={`${id}-target`}
                    className={inputClass}
                    value={target}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'to') updateRoute(i, { service: undefined, to: r.to ?? 'http://' });
                      else if (v === 'none') updateRoute(i, { service: undefined, to: undefined });
                      else updateRoute(i, { service: v.slice('service:'.length), to: undefined });
                    }}
                  >
                    {serviceNames.map((s) => <option key={s} value={`service:${s}`}>サービス: {s}</option>)}
                    {r.service !== undefined && !serviceNames.includes(r.service) && <option value={`service:${r.service}`}>サービス: {r.service}（ありません）</option>}
                    <option value="to">URL を直接指定（to）</option>
                    <option value="none">なし（リダイレクト・固定の応答のミドルウェアが答える）</option>
                  </select>
                </div>
                {r.to !== undefined && (
                  <div>
                    <label htmlFor={`${id}-to`} className={labelClass}>転送先の URL</label>
                    <input id={`${id}-to`} className={monoInput} value={r.to} placeholder="http://10.0.0.20:8080" onChange={(e) => updateRoute(i, { to: e.target.value.trim() })} />
                  </div>
                )}
              </div>
              <div className="mt-2">
                <span className={labelClass}>ミドルウェア（上から順に働く）</span>
                <ol className="space-y-1">
                  {(r.middlewares ?? []).map((m, k) => (
                    <li key={`${m}-${k}`} className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-gray-900">{k + 1}. {m}</span>
                      <span className="text-xs text-gray-600">{MIDDLEWARE_KINDS[middlewareKind(mws[m] ?? {})] ?? '（ありません）'}</span>
                      <button type="button" className={smallButton} aria-label={`${m} を上へ`} onClick={() => updateRoute(i, { middlewares: move(r.middlewares ?? [], k, -1) })}>↑</button>
                      <button type="button" className={smallButton} aria-label={`${m} を下へ`} onClick={() => updateRoute(i, { middlewares: move(r.middlewares ?? [], k, 1) })}>↓</button>
                      <button type="button" className={removeButton} onClick={() => updateRoute(i, { middlewares: (r.middlewares ?? []).filter((_, j) => j !== k) })}>外す</button>
                    </li>
                  ))}
                </ol>
                {mwNames.filter((m) => !(r.middlewares ?? []).includes(m)).length > 0 && (
                  <select
                    aria-label={`ルート ${r.name} にミドルウェアを足す`}
                    className={`${inputClass} mt-1 sm:w-auto`}
                    value=""
                    onChange={(e) => e.target.value && updateRoute(i, { middlewares: [...(r.middlewares ?? []), e.target.value] })}
                  >
                    <option value="">ミドルウェアを足す…</option>
                    {mwNames.filter((m) => !(r.middlewares ?? []).includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className={smallButton}
          onClick={() => setRoutes([...value.routes, {
            name: uniqueName('route', value.routes.map((r) => r.name)),
            match: 'PathPrefix(`/`)',
            ...(serviceNames[0] ? { service: serviceNames[0] } : {}),
          }])}
        >
          ルートを追加
        </button>
      </section>

      <section aria-labelledby="http-services-heading" className="mb-4">
        <h3 id="http-services-heading" className={headingClass}>サービス（転送先のまとまり）</h3>
        {Object.entries(services).map(([name, s], i) => {
          const id = `http-service-${i}`;
          const healthAvailable = serviceOptions === null || serviceOptions.includes('health_check') || s.health_check !== undefined;
          const stickyAvailable = serviceOptions === null || serviceOptions.includes('sticky') || s.sticky !== undefined;
          return (
            <div key={i} className={boxClass} data-testid="http-service">
              <div className="flex gap-2 items-end mb-2">
                <div className="flex-1">
                  <label htmlFor={`${id}-name`} className={labelClass}>名前</label>
                  <input
                    id={`${id}-name`}
                    className={monoInput}
                    value={name}
                    onChange={(e) => {
                      const to = e.target.value.trim();
                      if (to !== '' && !(to in services)) renameService(name, to);
                    }}
                  />
                </div>
                <button type="button" className={removeButton} onClick={() => removeService(name)}>削除</button>
              </div>
              <span className={labelClass}>転送先（重みつきで順に振り分ける）</span>
              {s.servers.map((srv, k) => (
                <div key={k} className="flex gap-2 mb-1">
                  <input
                    aria-label={`サービス ${name} の転送先 ${k + 1} の URL`}
                    className={monoInput}
                    value={srv.url}
                    placeholder="http://10.0.0.20:80"
                    onChange={(e) => updateService(name, { servers: s.servers.map((x, j) => (j === k ? { ...x, url: e.target.value.trim() } : x)) })}
                  />
                  <input
                    aria-label={`サービス ${name} の転送先 ${k + 1} の重み`}
                    type="number"
                    min="0"
                    className={`${inputClass} w-20`}
                    value={srv.weight ?? 1}
                    onChange={(e) => updateService(name, { servers: s.servers.map((x, j) => (j === k ? { ...x, weight: e.target.value === '' ? undefined : Number(e.target.value) } : x)) })}
                  />
                  <button type="button" className={removeButton} onClick={() => updateService(name, { servers: s.servers.filter((_, j) => j !== k) })}>削除</button>
                </div>
              ))}
              <button type="button" className={smallButton} onClick={() => updateService(name, { servers: [...s.servers, { url: 'http://' }] })}>転送先を追加</button>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="flex items-center gap-2 text-sm text-gray-800 sm:col-span-3">
                  <input type="checkbox" checked={s.pass_host_header !== false} onChange={(e) => updateService(name, { pass_host_header: e.target.checked ? undefined : false })} />
                  クライアントの Host ヘッダをそのまま送る（外すと転送先の URL のホスト名）
                </label>
                <div>
                  <label htmlFor={`${id}-connect`} className={labelClass}>接続のタイムアウト（既定 5s）</label>
                  <input id={`${id}-connect`} className={monoInput} value={s.timeouts?.connect ?? ''} placeholder="5s"
                    onChange={(e) => updateService(name, { timeouts: { ...s.timeouts, connect: e.target.value.trim() || undefined } })} />
                </div>
                <div>
                  <label htmlFor={`${id}-response`} className={labelClass}>応答のタイムアウト（既定 60s）</label>
                  <input id={`${id}-response`} className={monoInput} value={s.timeouts?.response ?? ''} placeholder="60s"
                    onChange={(e) => updateService(name, { timeouts: { ...s.timeouts, response: e.target.value.trim() || undefined } })} />
                </div>
              </div>
              {healthAvailable && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <label htmlFor={`${id}-hc-path`} className={labelClass}>ヘルスチェックのパス（空欄なら行わない）</label>
                    <input id={`${id}-hc-path`} className={monoInput} value={s.health_check?.path ?? ''} placeholder="/healthz"
                      onChange={(e) => updateService(name, { health_check: e.target.value.trim() ? { ...s.health_check, path: e.target.value.trim() } : undefined })} />
                  </div>
                  {s.health_check && (
                    <>
                      <div>
                        <label htmlFor={`${id}-hc-interval`} className={labelClass}>間隔</label>
                        <input id={`${id}-hc-interval`} className={monoInput} value={s.health_check.interval ?? ''} placeholder="10s"
                          onChange={(e) => updateService(name, { health_check: { ...s.health_check!, interval: e.target.value.trim() || undefined } })} />
                      </div>
                      <div>
                        <label htmlFor={`${id}-hc-timeout`} className={labelClass}>タイムアウト</label>
                        <input id={`${id}-hc-timeout`} className={monoInput} value={s.health_check.timeout ?? ''} placeholder="3s"
                          onChange={(e) => updateService(name, { health_check: { ...s.health_check!, timeout: e.target.value.trim() || undefined } })} />
                      </div>
                    </>
                  )}
                </div>
              )}
              {stickyAvailable && (
                <div className="mt-2">
                  <label htmlFor={`${id}-sticky`} className={labelClass}>スティッキーセッションのクッキー名（空欄なら使わない）</label>
                  <input id={`${id}-sticky`} className={monoInput} value={s.sticky?.cookie ?? ''} placeholder="rproxy_app"
                    onChange={(e) => updateService(name, { sticky: e.target.value.trim() ? { cookie: e.target.value.trim() } : undefined })} />
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className={smallButton} onClick={() => setServices({ ...services, [uniqueName('backend', services)]: { servers: [{ url: 'http://' }] } })}>
          サービスを追加
        </button>
      </section>

      <section aria-labelledby="http-middlewares-heading" className="mb-4">
        <h3 id="http-middlewares-heading" className={headingClass}>ミドルウェア</h3>
        {Object.entries(mws).map(([name, m], i) => {
          const id = `http-mw-${i}`;
          const kind = middlewareKind(m);
          const config = (m[kind] ?? {}) as Record<string, unknown>;
          const unavailable = middlewares !== null && !middlewares.includes(kind);
          return (
            <div key={i} className={boxClass} data-testid="http-middleware">
              <div className="flex gap-2 items-end mb-2">
                <div className="flex-1">
                  <label htmlFor={`${id}-name`} className={labelClass}>名前</label>
                  <input
                    id={`${id}-name`}
                    className={monoInput}
                    value={name}
                    onChange={(e) => {
                      const to = e.target.value.trim();
                      if (to !== '' && !(to in mws)) renameMiddleware(name, to);
                    }}
                  />
                </div>
                <div className="flex-1">
                  <label htmlFor={`${id}-kind`} className={labelClass}>種類</label>
                  <select
                    id={`${id}-kind`}
                    className={inputClass}
                    value={kind}
                    onChange={(e) => setMiddlewares({ ...mws, [name]: { [e.target.value]: { ...(MIDDLEWARE_TEMPLATES[e.target.value] ?? {}) } } })}
                  >
                    {(kinds.includes(kind) ? kinds : [kind, ...kinds]).map((k) => <option key={k} value={k}>{MIDDLEWARE_KINDS[k] ?? k}（{k}）</option>)}
                  </select>
                </div>
                <button type="button" className={removeButton} onClick={() => removeMiddleware(name)}>削除</button>
              </div>
              {unavailable && <p className="text-amber-900 text-xs mb-2">この種類は、この rproxy ではまだ使えません（GET /capabilities の features.middlewares にありません）。</p>}
              {FIELDS[kind]
                ? <TypedConfig id={id} fields={FIELDS[kind]} value={config} onChange={(v) => setMiddlewares({ ...mws, [name]: { [kind]: v } })} />
                : <JsonConfig key={`${name}-${kind}`} id={`${id}-json`} value={config} onChange={(v) => setMiddlewares({ ...mws, [name]: { [kind]: v } })} />}
            </div>
          );
        })}
        {kinds.length > 0 && (
          <select
            aria-label="ミドルウェアを追加"
            className={`${inputClass} sm:w-auto`}
            value=""
            onChange={(e) => {
              const kind = e.target.value;
              if (!kind) return;
              setMiddlewares({ ...mws, [uniqueName(kind.replace(/_/g, '-'), mws)]: { [kind]: { ...(MIDDLEWARE_TEMPLATES[kind] ?? {}) } } });
            }}
          >
            <option value="">ミドルウェアを追加…</option>
            {kinds.map((k) => <option key={k} value={k}>{MIDDLEWARE_KINDS[k]}（{k}）</option>)}
          </select>
        )}
      </section>

      <section aria-labelledby="http-default-heading">
        <h3 id="http-default-heading" className={headingClass}>どのルートにも一致しないとき</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label htmlFor="http-default-service" className={labelClass}>サービス</label>
            <select
              id="http-default-service"
              className={inputClass}
              value={value.default?.service ?? ''}
              onChange={(e) => onChange({ ...value, default: { ...value.default, service: e.target.value || undefined } })}
            >
              <option value="">なし（状態コードを返す）</option>
              {serviceNames.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {!value.default?.service && (
            <div>
              <label htmlFor="http-default-status" className={labelClass}>状態コード（既定 404）</label>
              <input
                id="http-default-status"
                type="number"
                className={inputClass}
                value={value.default?.status ?? ''}
                placeholder="404"
                onChange={(e) => onChange({ ...value, default: { ...value.default, status: e.target.value === '' ? undefined : Number(e.target.value) } })}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default HttpEditor;
