// L7（ルールの http）の編集欄。RuleForm の「L7 (HTTP)」タブで使う（tests/httpeditor.test.ts）。
// 値は親が持ち、変更は onChange で丸ごと返す。検証は httpspec.ts の validateHttp（送信時に親が呼ぶ）

import React, { useState } from 'react';
import { BALANCES, type Balance } from './lib';
import type { HttpOutlierSpec } from './v04';
import { BALANCE_LABELS } from './dashboard';
import { BALANCE_HELP } from './targets';
import { FILE_OWNER_NOTE } from './messages';
import {
  HttpOption,
  HttpRules,
  MIDDLEWARE_KINDS,
  MIDDLEWARE_TEMPLATES,
  MiddlewareSpec,
  REDIRECT_STATUSES,
  RouteSpec,
  SERVER_MIDDLEWARES,
  ServerSpec,
  ServiceSpec,
  ServiceTlsSpec,
  UPSTREAM_PROTOCOLS,
  UPSTREAM_PROTOCOL_LABELS,
  UpstreamProtocol,
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
  // features.http_options（Gateway API 向けの項目。features を取得できなかったときは null。そのときはすべて出す）
  httpOptions: readonly string[] | null;
  http3: boolean;
}

// rproxy が使えると言う項目か（null は分からない＝出す）
const supports = (list: readonly string[] | null, name: string) => list === null || list.includes(name);

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const monoInput = `${inputClass} font-mono text-sm`;
const smallButton = 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-2 py-1 rounded-sm text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';
const removeButton = 'text-red-700 hover:text-red-900 text-sm px-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';
const labelClass = 'block text-xs font-medium text-gray-800 mb-1';
const boxClass = 'border border-gray-300 rounded-sm p-3 mb-3 bg-white';
const headingClass = 'text-sm font-semibold text-gray-900 mb-2';

// 種類ごとの入力欄（ここにない種類は JSON で編集する）
type FieldType = 'text' | 'number' | 'bool' | 'list' | 'numlist' | 'select' | 'status';
// option は features.http_options の名前（その rproxy が使えるときだけ編集できる項目）
interface FieldDef { key: string; label: string; type: FieldType; options?: string[]; placeholder?: string; option?: HttpOption }

// リダイレクトの状態コード（#226。permanent より優先する）
const REDIRECT_STATUS_FIELD: FieldDef = { key: 'status', label: '状態コード（指定すると「恒久的」より優先）', type: 'status', option: 'redirect_status' };
const FIELDS: Record<string, FieldDef[]> = {
  redirect_scheme: [
    { key: 'scheme', label: 'スキーム', type: 'select', options: ['https', 'http'] },
    { key: 'port', label: 'ポート（省略時は既定）', type: 'number' },
    { key: 'permanent', label: '恒久的（301 / 308）', type: 'bool' },
    REDIRECT_STATUS_FIELD,
  ],
  redirect_regex: [
    { key: 'regex', label: '正規表現（URL 全体）', type: 'text', placeholder: '^https?://www\\.(.+)$' },
    { key: 'replacement', label: '置き換え後', type: 'text', placeholder: 'https://$1' },
    { key: 'permanent', label: '恒久的（301 / 308）', type: 'bool' },
    REDIRECT_STATUS_FIELD,
  ],
  rate_limit: [
    { key: 'average', label: '平均（period あたりの件数）', type: 'number' },
    { key: 'period', label: '期間（例 1s、1m）', type: 'text' },
    { key: 'burst', label: 'バースト', type: 'number' },
    { key: 'source', label: '数える単位（ip か header:名前）', type: 'text' },
  ],
  in_flight: [{ key: 'amount', label: 'クライアント IP ごとの同時リクエスト数', type: 'number' }],
  // v0.4（#168）。国のリストには rproxy の global.geoip.country_db、AS のリストには asn_db が要る
  geoip: [
    { key: 'allow_countries', label: '許可する国（ISO 3166-1 alpha-2。カンマ区切り）', type: 'list', placeholder: 'JP, US' },
    { key: 'deny_countries', label: '拒否する国（カンマ区切り）', type: 'list' },
    { key: 'allow_asns', label: '許可する AS の番号（カンマ区切り）', type: 'numlist' },
    { key: 'deny_asns', label: '拒否する AS の番号（カンマ区切り）', type: 'numlist', placeholder: '64496' },
    { key: 'unknown', label: '判定できないとき', type: 'select', options: ['allow', 'deny'] },
  ],
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
    { key: 'status', label: 'この状態コードでも送り直す（カンマ区切り。例 500, 502-504）', type: 'list', placeholder: '500, 502-504', option: 'retry_status' },
  ],
  circuit_breaker: [
    { key: 'failure_percent', label: '失敗の割合（%）', type: 'number' },
    { key: 'window', label: '集計の期間（例 10s）', type: 'text' },
    { key: 'recovery', label: '回復を試すまで（例 30s）', type: 'text' },
  ],
  basic_auth: [
    { key: 'users_file', label: '利用者のファイル（htpasswd）', type: 'text', placeholder: '/etc/rproxy/htpasswd' },
    { key: 'realm', label: 'realm（省略時 rproxy）', type: 'text', placeholder: 'rproxy' },
    { key: 'user_header', label: '利用者の名前を渡すヘッダ（任意）', type: 'text', placeholder: 'X-Forwarded-User' },
    { key: 'keep_authorization', label: 'Authorization を転送先に渡す', type: 'bool' },
  ],
  // Gateway API 向け（#228・#230）
  replace_host: [{ key: 'host', label: '転送先へ送る Host（host か host:port）', type: 'text', placeholder: 'app.example.com' }],
  cors: [
    { key: 'allow_origins', label: '許可するオリジン（カンマ区切り。* や https://*.example.com も可）', type: 'list', placeholder: 'https://www.example.com' },
    { key: 'allow_methods', label: '許可するメソッド（カンマ区切り。* も可）', type: 'list', placeholder: 'GET, POST' },
    { key: 'allow_headers', label: '許可するリクエストのヘッダ（カンマ区切り）', type: 'list', placeholder: 'X-Requested-With' },
    { key: 'expose_headers', label: 'ブラウザに見せる応答のヘッダ（カンマ区切り）', type: 'list' },
    { key: 'max_age', label: 'プリフライトを覚える秒数（max_age）', type: 'number', placeholder: '3600' },
    { key: 'allow_credentials', label: 'クッキーなどの資格情報を許す（allow_credentials）', type: 'bool' },
  ],
};

// 使えない項目に値があるときの読み取り専用の表示（消さずにそのまま送る）
const Preserved: React.FC<{ label: string; value: unknown }> = ({ label, value }) => (
  <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-sm px-2 py-1 mt-1 break-all" data-testid="http-preserved">
    {label}: <span className="font-mono">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
    （この rproxy では使えないので編集できません。そのまま残して送ります）
  </p>
);

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

// ルートの時間の上限の 1 項目を変える（空欄は省き、どちらもなければ timeouts ごと省く）
function routeTimeouts(r: RouteSpec, key: 'request' | 'backend_request', raw: string): RouteSpec['timeouts'] {
  const next = { ...r.timeouts, [key]: raw.trim() || undefined };
  if (next.request === undefined) delete next.request;
  if (next.backend_request === undefined) delete next.backend_request;
  return Object.keys(next).length > 0 ? next : undefined;
}

// headers の request / response に add があるか
function headersAdd(config: Record<string, unknown>): boolean {
  return ['request', 'response'].some((k) => {
    const ops = config[k] as Record<string, unknown> | undefined;
    return typeof ops === 'object' && ops !== null && typeof ops.add === 'object' && ops.add !== null && Object.keys(ops.add).length > 0;
  });
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

const TypedConfig: React.FC<{ id: string; fields: FieldDef[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; httpOptions: readonly string[] | null }> = ({ id, fields, value, onChange, httpOptions }) => {
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {fields.map((f) => {
        const fid = `${id}-${f.key}`;
        const v = value[f.key];
        if (f.option && !supports(httpOptions, f.option)) {
          return v === undefined ? null : <div key={f.key} className="sm:col-span-2"><Preserved label={f.label} value={v} /></div>;
        }
        if (f.type === 'status') {
          return (
            <div key={f.key}>
              <label htmlFor={fid} className={labelClass}>{f.label}</label>
              <select id={fid} className={inputClass} value={v === undefined ? '' : String(v)} onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}>
                <option value="">指定しない</option>
                {REDIRECT_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </div>
          );
        }
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
                value={f.type === 'list' || f.type === 'numlist' ? (Array.isArray(v) ? v.join(', ') : '') : v === undefined ? '' : String(v)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (f.type === 'number') set(f.key, raw === '' ? undefined : Number(raw));
                  else if (f.type === 'list') set(f.key, raw.split(',').map((s) => s.trim()).filter((s) => s !== ''));
                  else if (f.type === 'numlist') set(f.key, raw.split(',').map((s) => s.trim().replace(/^AS/i, '')).filter((s) => s !== '').map((s) => (/^[0-9]+$/.test(s) ? Number(s) : s)));
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

// ---- ミラー（#232）：送り先のサービスと、写す割合（percent か fraction） ----

const MirrorConfig: React.FC<{ id: string; value: Record<string, unknown>; services: string[]; onChange: (v: Record<string, unknown>) => void }> = ({ id, value, services, onChange }) => {
  const service = typeof value.service === 'string' ? value.service : '';
  const fraction = (value.fraction ?? null) as { numerator?: number; denominator?: number } | null;
  const mode = fraction !== null ? 'fraction' : value.percent !== undefined ? 'percent' : 'all';
  const num = (raw: string) => (raw === '' ? undefined : Number(raw));
  const base = () => {
    const next = { ...value };
    delete next.percent;
    delete next.fraction;
    return next;
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div>
        <label htmlFor={`${id}-service`} className={labelClass}>写しを送るサービス</label>
        <select id={`${id}-service`} className={inputClass} value={service} onChange={(e) => onChange({ ...value, service: e.target.value })}>
          <option value="">選んでください</option>
          {services.map((n) => <option key={n} value={n}>{n}</option>)}
          {service !== '' && !services.includes(service) && <option value={service}>{service}（ありません）</option>}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-mode`} className={labelClass}>写す割合</label>
        <select id={`${id}-mode`} className={inputClass} value={mode} onChange={(e) => {
          const m = e.target.value;
          if (m === 'all') onChange(base());
          else if (m === 'percent') onChange({ ...base(), percent: 100 });
          else onChange({ ...base(), fraction: { numerator: 1, denominator: 100 } });
        }}>
          <option value="all">すべて</option>
          <option value="percent">百分率（percent）</option>
          <option value="fraction">分数（fraction）</option>
        </select>
      </div>
      {mode === 'percent' && (
        <div>
          <label htmlFor={`${id}-percent`} className={labelClass}>割合（0〜100 %）</label>
          <input id={`${id}-percent`} type="number" min="0" max="100" className={inputClass} value={value.percent === undefined ? '' : String(value.percent)}
            onChange={(e) => onChange({ ...base(), percent: num(e.target.value) })} />
        </div>
      )}
      {mode === 'fraction' && fraction !== null && (
        <div className="flex gap-2 items-end">
          <div>
            <label htmlFor={`${id}-numerator`} className={labelClass}>分子</label>
            <input id={`${id}-numerator`} type="number" min="0" className={inputClass} value={fraction.numerator ?? ''}
              onChange={(e) => onChange({ ...base(), fraction: { ...fraction, numerator: num(e.target.value) } })} />
          </div>
          <span className="pb-1 text-gray-800" aria-hidden="true">/</span>
          <div>
            <label htmlFor={`${id}-denominator`} className={labelClass}>分母</label>
            <input id={`${id}-denominator`} type="number" min="1" className={inputClass} value={fraction.denominator ?? ''} placeholder="100"
              onChange={(e) => onChange({ ...base(), fraction: { ...fraction, denominator: num(e.target.value) } })} />
          </div>
        </div>
      )}
      <p className="sm:col-span-2 text-xs text-gray-600">写しの応答は読み捨て、ミラーの失敗や遅れはクライアントへの応答に影響しません。ルートのミドルウェアでこれより前のものを通った形のリクエストを写します。</p>
    </div>
  );
};

// ---- サービスの転送先への TLS（#236） ----

const TLS_TEXT_FIELDS: { key: keyof ServiceTlsSpec & ('server_name' | 'ca_file' | 'cert_file' | 'key_file' | 'chain_file'); label: string; placeholder: string }[] = [
  { key: 'server_name', label: 'サーバ名（SNI と証明書で確かめる名前。既定は URL のホスト）', placeholder: 'backend.example.com' },
  { key: 'ca_file', label: 'CA ファイル（既定は Mozilla のルート）', placeholder: '/etc/rproxy/backend-ca.crt' },
  { key: 'cert_file', label: 'クライアント証明書', placeholder: '/etc/rproxy/client.crt' },
  { key: 'key_file', label: 'クライアント証明書の秘密鍵', placeholder: '/etc/rproxy/client.key' },
  { key: 'chain_file', label: 'クライアント証明書の中間 CA', placeholder: '/etc/rproxy/client-chain.crt' },
];

const ServiceTlsFields: React.FC<{ id: string; name: string; value: ServiceTlsSpec | undefined; onChange: (v: ServiceTlsSpec | undefined) => void }> = ({ id, name, value, onChange }) => {
  const on = value !== undefined;
  const set = (patch: Partial<ServiceTlsSpec>) => {
    const next: Record<string, unknown> = { ...(value ?? {}), ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0)) delete next[k];
    onChange(next as ServiceTlsSpec);
  };
  return (
    <div className="mt-2" data-testid="service-tls">
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? {} : undefined)} />
        このサービスの https:// の転送先に、専用の TLS の設定を使う（ルールの「転送先の TLS」の代わり）
      </label>
      {on && (
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TLS_TEXT_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`${id}-${f.key}`} className={labelClass}>{f.label}</label>
              <input id={`${id}-${f.key}`} className={monoInput} placeholder={f.placeholder} value={value?.[f.key] ?? ''}
                aria-label={`サービス ${name}: ${f.label}`} onChange={(e) => set({ [f.key]: e.target.value.trim() || undefined })} />
            </div>
          ))}
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-sans`} className={labelClass}>確かめる名前（SAN の DNS 名か URI。カンマ区切り。指定するとサーバ名の代わりに確かめる）</label>
            <input id={`${id}-sans`} className={monoInput} placeholder="backend.example.com, spiffe://example.com/backend" value={(value?.subject_alt_names ?? []).join(', ')}
              aria-label={`サービス ${name}: 確かめる名前（SAN）`}
              onChange={(e) => set({ subject_alt_names: e.target.value.split(',').map((x) => x.trim()).filter((x) => x !== '') })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-800 sm:col-span-2">
            <input type="checkbox" checked={value?.insecure_skip_verify === true} onChange={(e) => set({ insecure_skip_verify: e.target.checked || undefined })} />
            転送先の証明書を確かめない（試験用）
          </label>
          <p className="sm:col-span-2 text-xs text-gray-600">ファイルはルールを作る・変えるときに読みます。http:// の転送先だけのサービスでは使いません。</p>
          <p className="sm:col-span-2 text-xs text-gray-600" data-testid="service-tls-owner-note">{FILE_OWNER_NOTE}</p>
        </div>
      )}
    </div>
  );
};

// ---- 転送先ごとのミドルウェア（#229） ----

const ServerMiddlewares: React.FC<{ service: string; index: number; value: string[]; candidates: string[]; onChange: (v: string[]) => void }> = ({ service, index, value, candidates, onChange }) => {
  const rest = candidates.filter((m) => !value.includes(m));
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs ml-2 mb-1" data-testid="server-middlewares">
      <span className="text-gray-700">この転送先だけのミドルウェア:</span>
      {value.length === 0 && <span className="text-gray-700">なし</span>}
      {value.map((m) => (
        <span key={m} className="inline-flex items-center gap-1 bg-gray-100 text-gray-900 border border-gray-300 rounded-sm px-1 font-mono">
          {m}
          <button type="button" className={removeButton} aria-label={`サービス ${service} の転送先 ${index} から ${m} を外す`} onClick={() => onChange(value.filter((x) => x !== m))}>×</button>
        </span>
      ))}
      {rest.length > 0 && (
        <select aria-label={`サービス ${service} の転送先 ${index} にミドルウェアを足す`} className={`${inputClass} sm:w-auto text-xs`} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
          <option value="">足す…</option>
          {rest.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
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
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 bg-gray-50 border border-gray-200 rounded-sm p-2">
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

// ---- サービスの受け身のヘルスチェック（v0.4 の outlier_detection） ----

const OUTLIER_FIELDS: { key: keyof HttpOutlierSpec; label: string; placeholder: string; duration?: boolean }[] = [
  { key: 'consecutive_5xx', label: '続けて 5xx を返した回数（既定 5、0 で見ない）', placeholder: '5' },
  { key: 'consecutive_gateway_failures', label: '続けて届かなかった回数（502・503・504・接続の失敗。既定 3）', placeholder: '3' },
  { key: 'failure_percent', label: '失敗の割合（%。空欄なら見ない）', placeholder: '50' },
  { key: 'min_requests', label: '割合を見る最小のリクエスト数（既定 20）', placeholder: '20' },
  { key: 'window', label: '割合を数える時間（既定 30s）', placeholder: '30s', duration: true },
  { key: 'ejection_time', label: '最初に外す時間（既定 30s）', placeholder: '30s', duration: true },
  { key: 'max_ejection_time', label: '外す時間の上限（既定 5m）', placeholder: '5m', duration: true },
  { key: 'max_ejected_percent', label: '同時に外せる割合（%、既定 50）', placeholder: '50' },
];

const ServiceOutlierFields: React.FC<{ id: string; name: string; value: HttpOutlierSpec | undefined; onChange: (v: HttpOutlierSpec | undefined) => void }> = ({ id, name, value, onChange }) => {
  const on = value !== undefined;
  const set = (key: keyof HttpOutlierSpec, raw: string, duration: boolean) => {
    const next: Record<string, unknown> = { ...(value ?? {}) };
    const t = raw.trim();
    if (t === '') delete next[key];
    else next[key] = duration || !/^[0-9]+$/.test(t) ? t : Number(t);
    onChange(next as HttpOutlierSpec);
  };
  return (
    <div className="mt-2" data-testid="service-outlier">
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? {} : undefined)} />
        受け身のヘルスチェック（失敗の続いた転送先をしばらく外す）
      </label>
      {on && (
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {OUTLIER_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`${id}-${f.key}`} className={labelClass}>{f.label}</label>
              <input id={`${id}-${f.key}`} className={monoInput} placeholder={f.placeholder} value={value?.[f.key] === undefined ? '' : String(value[f.key])}
                aria-label={`サービス ${name}: ${f.label}`} onChange={(e) => set(f.key, e.target.value, f.duration === true)} />
            </div>
          ))}
          <p className="sm:col-span-2 text-xs text-gray-600">サーキットブレーカー（サービス全体を止める）とは別に、転送先ごとに外します。空欄の項目は rproxy の既定値です。</p>
        </div>
      )}
    </div>
  );
};

// ---- 本体 ----

const HttpEditor: React.FC<HttpEditorProps> = ({ value, onChange, middlewares, serviceOptions, httpOptions, http3 }) => {
  const services = value.services ?? {};
  const mws = value.middlewares ?? {};
  const serviceNames = Object.keys(services);
  const mwNames = Object.keys(mws);
  // 選べるミドルウェアの種類（features.middlewares。使っている種類は残す）
  const kinds = Object.keys(MIDDLEWARE_KINDS).filter((k) => middlewares === null || middlewares.includes(k));
  // 転送先ごとに付けられるミドルウェア（書き換えるだけの種類）
  const serverMwCandidates = mwNames.filter((m) => SERVER_MIDDLEWARES.includes(middlewareKind(mws[m])));

  const setRoutes = (routes: RouteSpec[]) => onChange({ ...value, routes });
  const updateRoute = (i: number, patch: Partial<RouteSpec>) =>
    setRoutes(value.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setServices = (s: Record<string, ServiceSpec>) => onChange({ ...value, services: s });
  const updateService = (name: string, patch: Partial<ServiceSpec>) => setServices({ ...services, [name]: { ...services[name], ...patch } });
  const setMiddlewares = (m: Record<string, MiddlewareSpec>) => onChange({ ...value, middlewares: m });

  // ミラーの送り先のサービスの名前を付け替える
  const mirrorsRenamed = (from: string, to: string): Record<string, MiddlewareSpec> => Object.fromEntries(Object.entries(mws).map(([n, m]) => (
    middlewareKind(m) === 'mirror' && (m.mirror as Record<string, unknown>).service === from ? [n, { mirror: { ...m.mirror, service: to } }] : [n, m])));
  // 転送先ごとのミドルウェアの付け替え・外し
  const serversMapped = (f: (names: string[]) => string[]): Record<string, ServiceSpec> => Object.fromEntries(Object.entries(services).map(([n, svc]) => [n, {
    ...svc,
    servers: svc.servers.map((srv) => {
      if (!srv.middlewares) return srv;
      const next = f(srv.middlewares);
      const out: ServerSpec = { ...srv, middlewares: next };
      if (next.length === 0) delete out.middlewares;
      return out;
    }),
  }]));
  const renameService = (from: string, to: string) => {
    onChange({
      ...value,
      services: renameKey(services, from, to),
      middlewares: mirrorsRenamed(from, to),
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
      services: serversMapped((names) => names.map((m) => (m === from ? to : m))),
      routes: value.routes.map((r) => ({ ...r, middlewares: r.middlewares?.map((m) => (m === from ? to : m)) })),
    });
  };
  const removeMiddleware = (name: string) => {
    const rest = { ...mws };
    delete rest[name];
    onChange({
      ...value,
      middlewares: rest,
      services: serversMapped((names) => names.filter((m) => m !== name)),
      routes: value.routes.map((r) => ({ ...r, middlewares: r.middlewares?.filter((m) => m !== name) })),
    });
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
              <div className="flex flex-wrap gap-2 items-end mb-2">
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
              {supports(httpOptions, 'route_timeouts') ? (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label htmlFor={`${id}-timeout-request`} className={labelClass}>リクエスト全体の時間の上限（空欄・0s は上限なし）</label>
                    <input id={`${id}-timeout-request`} className={monoInput} value={r.timeouts?.request ?? ''} placeholder="10s"
                      onChange={(e) => updateRoute(i, { timeouts: routeTimeouts(r, 'request', e.target.value) })} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-timeout-backend`} className={labelClass}>転送先への 1 回の時間の上限（サービスの応答のタイムアウトの代わり）</label>
                    <input id={`${id}-timeout-backend`} className={monoInput} value={r.timeouts?.backend_request ?? ''} placeholder="5s"
                      onChange={(e) => updateRoute(i, { timeouts: routeTimeouts(r, 'backend_request', e.target.value) })} />
                  </div>
                </div>
              ) : r.timeouts !== undefined && <Preserved label="時間の上限" value={r.timeouts} />}
              <div className="mt-2">
                <span className={labelClass}>ミドルウェア（上から順に働く）</span>
                <ol className="space-y-1">
                  {(r.middlewares ?? []).map((m, k) => (
                    <li key={`${m}-${k}`} className="flex flex-wrap items-center gap-2 text-sm">
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
          // 受け身のヘルスチェック（v0.4、#170）は rproxy が services に outlier_detection を返すときだけ（使っていれば残す）
          const outlierAvailable = (serviceOptions !== null && serviceOptions.includes('outlier_detection')) || s.outlier_detection !== undefined;
          // 固定の状態コードの転送先（#235）
          const statusAvailable = supports(httpOptions, 'server_status');
          return (
            <div key={i} className={boxClass} data-testid="http-service">
              <div className="flex flex-wrap gap-2 items-end mb-2">
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
              {s.servers.map((srv, k) => {
                const setServer = (patch: Partial<ServerSpec>) => updateService(name, { servers: s.servers.map((x, j) => {
                  if (j !== k) return x;
                  const next: ServerSpec = { ...x, ...patch };
                  for (const key of Object.keys(next) as (keyof ServerSpec)[]) if (next[key] === undefined) delete next[key];
                  return next;
                }) });
                const isStatus = srv.status !== undefined;
                                return (
                  <div key={k} className="mb-1" data-testid="http-server">
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                      {(statusAvailable || isStatus) && (
                        <select aria-label={`サービス ${name} の転送先 ${k + 1} の種類`} className={`${inputClass} sm:w-auto shrink-0`} value={isStatus ? 'status' : 'url'} disabled={!statusAvailable}
                          onChange={(e) => setServer(e.target.value === 'status' ? { url: undefined, status: 500, middlewares: undefined } : { status: undefined, url: 'http://' })}>
                          <option value="url">URL</option>
                          <option value="status">状態コードで答える</option>
                        </select>
                      )}
                      {isStatus ? (
                        <input aria-label={`サービス ${name} の転送先 ${k + 1} の状態コード`} type="number" min="100" max="599" className={`${inputClass} sm:max-w-28`} value={srv.status ?? ''} readOnly={!statusAvailable}
                          onChange={(e) => setServer({ status: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      ) : (
                        <input aria-label={`サービス ${name} の転送先 ${k + 1} の URL`} className={monoInput} value={srv.url ?? ''} placeholder="http://10.0.0.20:80"
                          onChange={(e) => setServer({ url: e.target.value.trim() })} />
                      )}
                      <input aria-label={`サービス ${name} の転送先 ${k + 1} の重み`} type="number" min="1" className={`${inputClass} max-w-20 shrink-0`} value={srv.weight ?? 1}
                        onChange={(e) => setServer({ weight: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      <button type="button" className={`${removeButton} whitespace-nowrap`} onClick={() => updateService(name, { servers: s.servers.filter((_, j) => j !== k) })}>削除</button>
                    </div>
                    {!isStatus && (supports(httpOptions, 'server_middlewares')
                      ? serverMwCandidates.length > 0 || (srv.middlewares ?? []).length > 0
                        ? <ServerMiddlewares service={name} index={k + 1} value={srv.middlewares ?? []} candidates={serverMwCandidates} onChange={(v) => setServer({ middlewares: v.length > 0 ? v : undefined })} />
                        : null
                      : srv.middlewares !== undefined && <Preserved label="この転送先だけのミドルウェア" value={srv.middlewares} />)}
                  </div>
                );
              })}
              {statusAvailable && <p className="text-xs text-gray-600 mb-1">「状態コードで答える」は、重みの割合のリクエストに rproxy がその状態コードで答えます（ヘルスチェック・スティッキーの対象外）。</p>}
              <button type="button" className={smallButton} onClick={() => updateService(name, { servers: [...s.servers, { url: 'http://' }] })}>転送先を追加</button>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label className="flex items-center gap-2 text-sm text-gray-800 sm:col-span-3">
                  <input type="checkbox" checked={s.pass_host_header !== false} onChange={(e) => updateService(name, { pass_host_header: e.target.checked ? undefined : false })} />
                  クライアントの Host ヘッダをそのまま送る（外すと転送先の URL のホスト名）
                </label>
                {(serviceOptions === null || serviceOptions.includes('balance') || s.balance !== undefined) && (
                  <div className="sm:col-span-3">
                    <label htmlFor={`${id}-balance`} className={labelClass}>振り分け方</label>
                    <select id={`${id}-balance`} className={inputClass} value={s.balance ?? 'round_robin'}
                      onChange={(e) => updateService(name, { balance: e.target.value === 'round_robin' ? undefined : e.target.value as Balance })}>
                      {BALANCES.map((b) => <option key={b} value={b}>{BALANCE_LABELS[b]}</option>)}
                    </select>
                    <p className="mt-1 text-xs text-gray-600">{BALANCE_HELP[s.balance ?? 'round_robin']}{s.balance === 'failover' ? '（転送先の上から順）' : ''}</p>
                  </div>
                )}
                {supports(serviceOptions, 'protocol') ? (
                  <div className="sm:col-span-3">
                    <label htmlFor={`${id}-protocol`} className={labelClass}>転送先との HTTP の版</label>
                    <select id={`${id}-protocol`} className={inputClass} value={s.protocol ?? 'http1'}
                      onChange={(e) => updateService(name, { protocol: e.target.value === 'http1' ? undefined : e.target.value as UpstreamProtocol })}>
                      {UPSTREAM_PROTOCOLS.map((p) => <option key={p} value={p}>{UPSTREAM_PROTOCOL_LABELS[p]}</option>)}
                    </select>
                    <p className="mt-1 text-xs text-gray-600">gRPC の転送先は h2（TLS）か h2c（平文）にします。トレーラーはそのまま流します。</p>
                  </div>
                ) : s.protocol !== undefined && <div className="sm:col-span-3"><Preserved label="転送先との HTTP の版" value={s.protocol} /></div>}
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
              {supports(serviceOptions, 'tls')
                ? <ServiceTlsFields id={`${id}-tls`} name={name} value={s.tls} onChange={(t) => updateService(name, { tls: t })} />
                : s.tls !== undefined && <Preserved label="転送先の TLS" value={s.tls} />}
              {outlierAvailable && (
                <ServiceOutlierFields id={`${id}-outlier`} name={name} value={s.outlier_detection}
                  onChange={(o) => updateService(name, { outlier_detection: o })} />
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
              <div className="flex flex-wrap gap-2 items-end mb-2">
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
              {kind === 'mirror'
                ? <MirrorConfig id={id} value={config} services={serviceNames} onChange={(v) => setMiddlewares({ ...mws, [name]: { [kind]: v } })} />
                : FIELDS[kind]
                  ? <TypedConfig id={id} fields={FIELDS[kind]} value={config} httpOptions={httpOptions} onChange={(v) => setMiddlewares({ ...mws, [name]: { [kind]: v } })} />
                  : <JsonConfig key={`${name}-${kind}`} id={`${id}-json`} value={config} onChange={(v) => setMiddlewares({ ...mws, [name]: { [kind]: v } })} />}
              {kind === 'basic_auth' && <p className="text-xs text-gray-600 mt-1" data-testid="users-file-owner-note">{FILE_OWNER_NOTE}</p>}
              {kind === 'headers' && (
                <p className="text-xs text-gray-600 mt-1">
                  {supports(httpOptions, 'headers_add')
                    ? '転送先へのヘッダは request、応答のヘッダは response に、set（置き換え）・add（あれば値の後ろに , で足す）・remove（取り除く）を書きます。'
                    : '転送先へのヘッダは request、応答のヘッダは response に、set（置き換え）・remove（取り除く）を書きます。'}
                  {supports(httpOptions, 'headers_add') && <span className="font-mono">{' {"request": {"add": {"X-Env": "prod"}}}'}</span>}
                </p>
              )}
              {kind === 'headers' && !supports(httpOptions, 'headers_add') && headersAdd(config) && (
                <p className="text-amber-900 text-xs mt-1">add（ヘッダを足す）は、この rproxy ではまだ使えません（GET /capabilities の features.http_options に headers_add がありません）。</p>
              )}
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
