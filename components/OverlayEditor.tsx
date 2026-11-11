// 固定ルール（設定ファイルのルール）に API で重ねる分（rproxy-api v0.4.23 の #397、UI #193）。ルールの詳細画面の 1 つの欄。
// 設定ファイルの分は詳細画面のほかの欄（L7・TLS）に読み取り専用で出し、ここでは重ねる分だけを見て・直して・外す。
// rproxy が features.static_overlay を返すノードでだけ出す。保存は GET の ETag を付けた丸ごとの置き換え（412 は読み直し）

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ForwardRules, TlsRoute } from './lib';
import { DEFAULT_BALANCE, routeNames } from './lib';
import type { CapabilityFeatures } from './rproxy';
import HttpEditor from './HttpEditor';
import HttpSummary from './HttpSummary';
import { RouteTargetsEditor } from './TargetsEditor';
import { ROUTE_SOURCE_IP_LABELS, RouteRow, buildRouteSpec, routeRow, routeRowAtL4, routeSourceIpChoicesFor } from './RuleForm';
import { HttpRules, cleanHttp, toHttpRules, validateHttp } from './httpspec';
import { firstRow } from './targets';
import {
  OVERLAY_KIND_LABELS,
  OVERLAY_REASON_LABELS,
  OverlaySpec,
  OverlayView,
  SecretItems,
  fileNames,
  forwardingIdentityProblems,
  isEmptyOverlay,
  overlayConflicts,
  overlaySpecOf,
} from './overlay';
import { ConfirmDialog, ErrorBanner, errorDetail } from './ui';
import { formatTimestamp, hostPort } from './dashboard';

interface OverlayInfo {
  available: boolean;
  features: CapabilityFeatures | null;
  overlay: OverlayView | null;
  etag: string | null;
  canEdit: boolean;
  editReason?: string;
  editCode?: string;
  secretItems: SecretItems;
  shape: { http: boolean; tlsRoutes: boolean };
  node?: string;
}

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const smallButton = 'bg-gray-200 hover:bg-gray-300 text-gray-800 px-2 py-1 rounded-sm text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';
const removeButton = 'text-red-700 hover:text-red-900 text-sm px-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';

// 重ねる分の http（ルート・サービス・ミドルウェアだけ）を編集欄の値に
function httpForm(spec: OverlaySpec): HttpRules {
  const h = spec.http ?? {};
  return toHttpRules({ routes: h.routes ?? [], services: h.services ?? {}, middlewares: h.middlewares ?? {} });
}

// 編集欄の値から送る形に（空の項目は省く）
function buildSpec(http: HttpRules | null, routes: RouteRow[] | null, ctx: Parameters<typeof buildRouteSpec>[1]): OverlaySpec {
  const out: OverlaySpec = {};
  if (http !== null) {
    const clean = cleanHttp(http) as { routes?: unknown[]; services?: Record<string, unknown>; middlewares?: Record<string, unknown> };
    out.http = {
      ...((clean.routes ?? []).length > 0 ? { routes: clean.routes as never } : {}),
      ...(clean.services && Object.keys(clean.services).length > 0 ? { services: clean.services as never } : {}),
      ...(clean.middlewares && Object.keys(clean.middlewares).length > 0 ? { middlewares: clean.middlewares as never } : {}),
    };
  }
  if (routes !== null && routes.length > 0) out.tls = { routes: routes.map((r) => buildRouteSpec(r, ctx) as TlsRoute) };
  return overlaySpecOf(out);
}

// 画面で先に確かめる（rproxy と API route も確かめる）
export function overlayProblems(rule: ForwardRules, spec: OverlaySpec): string[] {
  const out: string[] = [];
  for (const c of overlayConflicts(fileNames(rule), spec)) out.push(`${OVERLAY_KIND_LABELS[c.kind] ?? c.kind} ${c.name}: ${c.reason}（設定ファイルにある名前は使えません）`);
  if (spec.http) {
    const file = toHttpRules(rule.http);
    const merged: HttpRules = {
      ...file,
      routes: [...file.routes, ...(spec.http.routes ?? [])],
      services: { ...(file.services ?? {}), ...(spec.http.services ?? {}) },
      middlewares: { ...(file.middlewares ?? {}), ...(spec.http.middlewares ?? {}) },
    };
    const own = new Set(validateHttp(file));
    out.push(...validateHttp(merged).filter((e) => !own.has(e)));
    out.push(...forwardingIdentityProblems(spec.http.middlewares));
  }
  for (const r of spec.tls?.routes ?? []) {
    if (routeNames(r).every((n) => n.trim() === '')) out.push('サーバ名ごとの転送先にサーバ名を書いてください。');
  }
  return out;
}

const OverlayEditor: React.FC<{
  rule: ForwardRules;
  // ノードを設定していればノードの名前（固定ルールはノードごと）
  target?: string;
  admin: boolean;
  cacheCaps?: { maxMemory: number; maxEntries: number };
  onChanged?: () => void;
}> = ({ rule, target, admin, cacheCaps, onChanged }) => {
  const [info, setInfo] = useState<OverlayInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [http, setHttp] = useState<HttpRules | null>(null);
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const query = useMemo(() => new URLSearchParams({
    protocol: rule.protocol, addr: rule.srcAddr, port: String(rule.srcPort), ...(target !== undefined ? { target } : {}),
  }).toString(), [rule.protocol, rule.srcAddr, rule.srcPort, target]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/forward/overlay?${query}`);
      if (!res.ok) {
        setLoadError(`重ねる分を読めませんでした: ${await errorDetail(res)}`);
        return;
      }
      setInfo(await res.json() as OverlayInfo);
      setLoadError('');
    } catch (err) {
      setLoadError(`重ねる分を読めませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, [query]);

  useEffect(() => {
    // load は await の後でだけ state を変える
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loadError) return <ErrorBanner message={loadError} onClose={() => setLoadError('')} />;
  // rproxy が重ねる分を使えない（features.static_overlay がない）ノードでは出さない
  if (info === null || !info.available || (!info.shape.http && !info.shape.tlsRoutes && info.overlay === null)) return null;

  const view = info.overlay;
  const spec = view ? overlaySpecOf(view) : {};
  const features = info.features;
  const routeCtx = {
    protocol: rule.protocol,
    tlsMode: rule.tls.mode,
    l7: false,
    routeSourceIpEditable: features?.route_source_ip === true,
    routeUpstreamEditable: false,
  };

  const startEdit = () => {
    setHttp(info.shape.http ? httpForm(spec) : null);
    setRoutes(info.shape.tlsRoutes ? (spec.tls?.routes ?? []).map(routeRow) : null);
    setProblems([]);
    setError('');
    setNotice('');
    setStale(false);
    setEditing(true);
  };

  const fail = async (res: Response, what: string) => {
    if (res.status === 412) setStale(true);
    setError(`${what}: ${await errorDetail(res)}`);
  };

  const save = async () => {
    const next = buildSpec(http, routes, routeCtx);
    if (isEmptyOverlay(next)) {
      setProblems(['足すものがありません（重ねる分をすべて外すときは「重ねる分を外す」を使ってください）。']);
      return;
    }
    const found = overlayProblems(rule, next);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/forward/overlay-put', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: rule.protocol, addr: rule.srcAddr, port: rule.srcPort, ...(target !== undefined ? { target } : {}), overlay: next, etag: info.etag }),
      });
      if (!res.ok) {
        await fail(res, '重ねる分を保存できませんでした');
        return;
      }
      const out = await res.json() as { warning?: string };
      setNotice(out.warning ?? '重ねる分を保存しました。');
      setEditing(false);
      await load();
      onChanged?.();
    } catch (err) {
      setError(`重ねる分を保存できませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/forward/overlay-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: rule.protocol, addr: rule.srcAddr, port: rule.srcPort, ...(target !== undefined ? { target } : {}), etag: info.etag }),
      });
      if (!res.ok) {
        await fail(res, '重ねる分を外せませんでした');
        return;
      }
      setNotice('重ねる分を外しました。');
      setEditing(false);
      await load();
      onChanged?.();
    } catch (err) {
      setError(`重ねる分を外せませんでした: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const reload = async () => {
    setStale(false);
    setError('');
    setEditing(false);
    await load();
  };

  const updateRoute = (i: number, patch: Partial<RouteRow>) => setRoutes((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const sourceIpChoices = routeSourceIpChoicesFor(rule.protocol);

  return (
    <section className="card p-4" aria-labelledby="section-overlay" data-testid="overlay-section">
      <h2 id="section-overlay" className="card-title mb-3">重ねる分（API で足すルート・サーバ名）</h2>
      <p className="text-xs text-gray-700 mb-3">
        設定ファイルの固定ルールの待ち受けに、{info.shape.http ? 'http のルート・サービス・ミドルウェア' : 'サーバ名ごとの転送先（tls.routes）'}を足せます。設定ファイルの分（上の欄）は変わらず、名前が重なれば設定ファイルが勝ちます。
        {info.node !== undefined && `重ねる分はノードごとです（このノード: ${info.node}。ほかのノードには足しません）。`}
      </p>
      {error && (
        <div role="alert" className="mb-3 rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="overlay-error">
          <p className="break-all">{error}</p>
          {stale && <button type="button" className="btn-secondary mt-2" onClick={() => void reload()}>読み直す</button>}
        </div>
      )}
      {notice && <p role="status" className="mb-3 rounded-sm border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900" data-testid="overlay-notice">{notice}</p>}

      {view === null ? (
        !editing && <p className="text-sm text-gray-700" data-testid="overlay-none">重ねる分はありません。</p>
      ) : (
        <div className="space-y-2 text-sm text-gray-900" data-testid="overlay-status">
          <p>
            {view.state === 'applied'
              ? <span className="badge bg-green-100 text-green-900 border border-green-300" data-testid="overlay-state">効いています</span>
              : <span className="badge bg-red-100 text-red-900 border border-red-300" data-testid="overlay-state">効いていません</span>}
            {view.persisted === false && <span className="ml-2 badge bg-amber-100 text-amber-900 border border-amber-300" data-testid="overlay-not-persisted">DB に保存できていません</span>}
          </p>
          {view.state === 'not_applied' && (
            <p className="text-red-800" data-testid="overlay-not-applied">
              {OVERLAY_REASON_LABELS[view.reason ?? ''] ?? view.reason}。重ねる分は消さずに残してあり、ルールは設定ファイルの分だけで動いています（設定ファイルが戻れば、また効きます）。
              {view.error && <span className="block font-mono text-xs break-all">{view.error}</span>}
            </p>
          )}
          {(view.shadowed ?? []).length > 0 && (
            <div className="rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" data-testid="overlay-shadowed">
              <p>設定ファイルに同じ名前ができたため、次の項目は外れています（設定ファイルのものが使われます）。名前を変えてください。</p>
              <ul className="list-disc pl-5">
                {(view.shadowed ?? []).map((s) => <li key={`${s.kind}:${s.name}`}><span>{OVERLAY_KIND_LABELS[s.kind] ?? s.kind}</span> <span className="font-mono">{s.name}</span>: {s.reason}</li>)}
              </ul>
            </div>
          )}
          <p className="text-xs text-gray-700">
            作成: <span className="font-mono">{view.created_by}</span>（{formatTimestamp(view.created_at)}）・最後の変更: <span className="font-mono">{view.updated_by}</span>（{formatTimestamp(view.updated_at)}）
          </p>
          {!editing && spec.http && (
            <div data-testid="overlay-http-summary">
              <HttpSummary http={{ routes: spec.http.routes ?? [], ...(spec.http.services ? { services: spec.http.services } : {}), ...(spec.http.middlewares ? { middlewares: spec.http.middlewares } : {}) }} />
            </div>
          )}
          {!editing && (spec.tls?.routes ?? []).length > 0 && (
            <ul className="font-mono text-sm" data-testid="overlay-tls-routes">
              {(spec.tls?.routes ?? []).map((r, i) => (
                <li key={i}>{routeNames(r).join(', ')} → {r.targets && r.targets.length > 0 ? r.targets.map((t) => hostPort(t.addr, t.port)).join(', ') : hostPort(r.remote_addr ?? '', r.remote_port ?? 0)}{r.passthrough ? '（終端しない）' : ''}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!info.canEdit && (
        <p className="mt-3 text-xs text-gray-700" data-testid="overlay-readonly">重ねる分は変えられません: {info.editReason}</p>
      )}

      {info.canEdit && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(info.shape.http || info.shape.tlsRoutes) && (
            <button type="button" className="btn-primary" onClick={startEdit} data-testid="overlay-edit">{view === null ? '重ねる分を足す' : '重ねる分を直す'}</button>
          )}
          {view !== null && <button type="button" className="btn-danger" onClick={() => setConfirmRemove(true)} data-testid="overlay-remove">重ねる分を外す</button>}
        </div>
      )}

      {editing && (
        <div className="mt-3" data-testid="overlay-editor">
          {!admin && (
            <p className="mb-3 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-sm px-2 py-1" data-testid="overlay-secret-note">
              設定ファイルのサービス・ミドルウェアのうち「秘密のファイルあり」のもの（クライアントの鍵・OIDC の秘密・users_file を持つか、それを使うもの）は、管理者だけが使えます。
            </p>
          )}
          {http !== null && (
            <HttpEditor
              value={http}
              onChange={setHttp}
              middlewares={features?.middlewares ?? null}
              httpOptions={features?.http_options ?? null}
              serviceOptions={features?.services ?? null}
              http3={false}
              targetCaps={features?.target_max_connections === true}
              streamLimits={features?.http_stream_limits === true}
              filesLocked={!admin}
              cacheCaps={cacheCaps}
              overlayFile={{ http: toHttpRules(rule.http), secrets: info.secretItems, lockSecrets: !admin }}
            />
          )}
          {routes !== null && (
            <fieldset className="mb-3" data-testid="overlay-tls-editor">
              <legend className="text-sm font-semibold text-gray-900 mb-2">サーバ名ごとの転送先（設定ファイルのサーバ名に当たらない名前だけが使います）</legend>
              {routes.map((r, i) => (
                <div key={i} className="border border-gray-300 rounded-sm p-3 mb-2 bg-white" data-testid="overlay-tls-route">
                  <div className="flex flex-wrap gap-2 items-end">
                    <label className="flex-1 text-xs text-gray-800">サーバ名（カンマ区切り）
                      <input className={`${inputClass} font-mono`} value={r.names} onChange={(e) => updateRoute(i, { names: e.target.value })} aria-label={`重ねる転送先 ${i + 1} のサーバ名`} />
                    </label>
                    {r.targets.length === 0 && (
                      <>
                        <label className="text-xs text-gray-800">転送先のアドレス
                          <input className={`${inputClass} font-mono`} value={r.remote_addr} onChange={(e) => updateRoute(i, { remote_addr: e.target.value.trim() })} aria-label={`重ねる転送先 ${i + 1} のアドレス`} />
                        </label>
                        <label className="w-28 text-xs text-gray-800">ポート
                          <input type="number" className={inputClass} value={r.remote_port} onChange={(e) => updateRoute(i, { remote_port: e.target.value === '' ? '' : Number(e.target.value) })} aria-label={`重ねる転送先 ${i + 1} のポート`} />
                        </label>
                        {features?.tls_route_targets === true && (
                          <button type="button" className={smallButton} onClick={() => updateRoute(i, { targets: [firstRow(r.remote_addr, r.remote_port)] })}>宛先を複数にする</button>
                        )}
                      </>
                    )}
                    {rule.tls.mode === 'terminate' && (
                      <label className="flex items-center gap-1 text-sm text-gray-900 whitespace-nowrap">
                        <input type="checkbox" checked={r.passthrough} onChange={(e) => updateRoute(i, { passthrough: e.target.checked })} />
                        終端しない
                      </label>
                    )}
                    {routeCtx.routeSourceIpEditable && routeRowAtL4(r, routeCtx) && (
                      <select className={`${inputClass} sm:w-auto`} value={r.source_ip} aria-label={`重ねる転送先 ${i + 1} の送信元 IP の渡し方`}
                        onChange={(e) => updateRoute(i, { source_ip: e.target.value as RouteRow['source_ip'] })}>
                        <option value="">{`送信元 IP: ルールと同じ（${rule.sourceIp}）`}</option>
                        {sourceIpChoices.map((s) => <option key={s} value={s}>{ROUTE_SOURCE_IP_LABELS[s]}</option>)}
                      </select>
                    )}
                    <button type="button" className={removeButton} onClick={() => setRoutes((rs) => (rs ?? []).filter((_, j) => j !== i))}>削除</button>
                  </div>
                  {r.targets.length > 0 && (
                    <RouteTargetsEditor index={i} rows={r.targets} balance={r.balance} editable={features?.tls_route_targets === true} capsEditable={features?.target_max_connections === true}
                      onChange={(rows, balance) => updateRoute(i, { targets: rows, balance: balance })}
                      onSingle={() => updateRoute(i, { targets: [], balance: DEFAULT_BALANCE, remote_addr: r.targets[0]?.addr ?? '', remote_port: r.targets[0]?.port ?? '' })} />
                  )}
                </div>
              ))}
              <button type="button" className={smallButton} onClick={() => setRoutes((rs) => [...(rs ?? []), { names: '', remote_addr: '', remote_port: '', passthrough: false, targets: [], balance: DEFAULT_BALANCE, source_ip: '', upstream: null }])}>
                ＋ 転送先を追加
              </button>
              <p className="mt-1 text-xs text-gray-600">重ねる分の転送先への TLS は、ルールのもの（設定ファイル）を使います。</p>
            </fieldset>
          )}
          {problems.length > 0 && (
            <ul className="mb-3 list-disc pl-5 text-xs text-red-700" role="alert" data-testid="overlay-problems">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()} data-testid="overlay-save">{busy ? '保存中…' : '重ねる分を保存'}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setEditing(false); setProblems([]); }}>キャンセル</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="重ねる分を外しますか？"
        confirmLabel="外す"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      >
        <p>このルールに重ねたルート・サービス・ミドルウェア・サーバ名をすべて外します。設定ファイルの分はそのまま動きます。</p>
      </ConfirmDialog>
    </section>
  );
};

export default OverlayEditor;
