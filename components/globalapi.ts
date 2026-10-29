// global の設定の API route（pages/api/forward/global.ts）のサーバ側の部分：rproxy の断りを画面に返す形と、ノードへの適用（取り消しを含む）。
// - rproxy の断りのコード（static・restart_only・in_use・protected_file）は、ルールの同じ名前のコード（固定ルールの static など）と区別して global_* にする
// - Unix ソケットだけの項目（rproxy の unix_only。trusted_proxies・access_log・crowdsec など）を TCP から変えようとした 403 は global_unix_only
//   （rproxy の文の「Unix socket」で見分ける。どの項目が Unix ソケットだけかは rproxy の版で変わるので UI は決め打ちしない）。
//   文は UI の説明（ノードの url を unix: にする）に揃える
// - 古い rproxy（GET / PATCH /config/global がない 404）は global_unsupported
// 画面の説明は components/messages.ts の EXPLAIN（global_*）。error は rproxy の文（explainError が「詳細」に付ける）
// - 知らないコード・ステータスは rproxy の文のまま返す（rproxy の版で断りが増えても画面に理由が出るように）
// - rproxy の 401・スコープの不足の 403・429・届かない・5xx（503 を除く）は UI のトークン・設定の問題なので 502
//   （502 crowdsec_unavailable（新しい LAPI が答えない）もコードはそのまま。503 not_loaded・upgrading・shutting_down は 503 のまま）
import { rproxyFailure } from './apiguard';
import { GLOBAL_UNKNOWN_MESSAGE, GLOBAL_UNSUPPORTED_MESSAGE } from './messages';
import { UNIX_ONLY_MESSAGE, formatGlobalValue, globalPatchBody, globalSettingsView, sameValue } from './globalsettings';
import type { GlobalChange, GlobalNodeResult, GlobalSettings } from './globalsettings';
import { RproxyError, getGlobalSettings, patchGlobalSettings } from './rproxy';

export class GlobalRouteError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
    this.name = 'GlobalRouteError';
  }
}

const RENAMED: Record<string, string> = {
  static: 'global_static',
  restart_only: 'global_restart_only',
  in_use: 'global_in_use',
  // アクセスログの場所の制限も含む（ルールのファイルの protected_file と説明を分ける）
  protected_file: 'global_protected_file',
};

export interface Failure {
  status: number;
  error: string;
  code: string;
}

export function globalFailure(err: unknown): Failure {
  if (err instanceof GlobalRouteError) return { status: err.status, error: err.message, code: err.code };
  if (err instanceof RproxyError) {
    if (err.status === 403 && err.code === 'forbidden' && /unix socket/i.test(err.message)) {
      return { status: 403, error: UNIX_ONLY_MESSAGE, code: 'global_unix_only' };
    }
    if (err.status === 404) {
      return { status: 409, error: GLOBAL_UNSUPPORTED_MESSAGE, code: 'global_unsupported' };
    }
    if (err.status === 403 && err.code === 'forbidden') {
      return { status: 502, error: err.message, code: 'global_forbidden' };
    }
    const f = rproxyFailure(err);
    const uiSide = err.status === 0 || err.status === 401 || err.status === 429
      || (err.status >= 500 && err.status !== 503) || err.status < 400;
    return { status: uiSide ? 502 : err.status, error: f.error, code: RENAMED[f.code] ?? f.code };
  }
  return { status: 500, error: err instanceof Error ? err.message : String(err), code: 'internal' };
}

// 適用の相手の 1 ノード（run はそのノードに送る。withNode か、ノードを設定していなければそのまま）
export interface ApplyNode {
  name: string;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ノードごとの結果：applied（効いた）・refused（rproxy が断った。何も変わっていない）・
// unknown（時間切れ・届かないで、読み直しても効いたか分からない）
type Outcome = 'applied' | 'refused' | 'unknown';

interface NodeState {
  node: string;
  outcome: Outcome;
  changes: GlobalChange[];
  applied: string[];
  settings: GlobalSettings | null;
  failure?: Failure;
  undone?: boolean;
}

function patchResult(raw: unknown): { changes: GlobalChange[]; applied: string[]; settings: GlobalSettings | null } {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    changes: Array.isArray(r.changes) ? (r.changes as GlobalChange[]).filter((c) => typeof c?.item === 'string') : [],
    applied: Array.isArray(r.applied) ? (r.applied as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    settings: r.dry_run === true ? null : globalSettingsView(raw),
  };
}

async function readSettings(n: ApplyNode): Promise<GlobalSettings> {
  const s = globalSettingsView(await n.run(() => getGlobalSettings()));
  if (!s) throw new RproxyError('rproxy の応答を解釈できません。', 'bad_response', 502);
  return s;
}

const apiOf = (s: GlobalSettings, item: string): unknown => s.items[item]?.api_value ?? null;

// 1 ノードに送る。時間切れ（status 0）なら読み直して、送った項目の API の値が前と変わっていれば効いたとみなす。
// 変わっていなければ「分からない」（rproxy はほかの変更の後に並んでいて、後から効かせることがある）
async function applyOne(n: ApplyNode, values: Record<string, unknown>, logger: Logger): Promise<NodeState> {
  const base = { node: n.name, changes: [], applied: [], settings: null };
  let before: GlobalSettings;
  try {
    before = await readSettings(n);
  } catch (err) {
    return { ...base, outcome: 'refused', failure: globalFailure(err) };
  }
  try {
    const r = patchResult(await n.run(() => patchGlobalSettings(globalPatchBody(values), false)));
    return { node: n.name, outcome: 'applied', ...r };
  } catch (err) {
    if (!(err instanceof RproxyError) || err.status !== 0) return { ...base, outcome: 'refused', failure: globalFailure(err) };
    logger.warn(`ノード ${n.name} の PATCH /config/global の答えがありません（${err.message}）。読み直して確かめます`);
    let after: GlobalSettings;
    try {
      after = await readSettings(n);
    } catch {
      return { ...base, outcome: 'unknown', failure: { status: 502, error: GLOBAL_UNKNOWN_MESSAGE, code: 'global_unknown' } };
    }
    const items = Object.keys(values);
    const changed = items.filter((i) => !sameValue(apiOf(after, i), apiOf(before, i)));
    const noop = items.every((i) => sameValue(apiOf(before, i), values[i]));
    if (changed.length === 0 && !noop) {
      return { ...base, settings: after, outcome: 'unknown', failure: { status: 502, error: GLOBAL_UNKNOWN_MESSAGE, code: 'global_unknown' } };
    }
    const changes = changed.map((i) => ({
      item: i, before: before.items[i]?.value ?? null, after: after.items[i]?.value ?? null, api_before: apiOf(before, i), api_after: apiOf(after, i),
    }));
    return { node: n.name, outcome: 'applied', changes: changes, applied: changed, settings: after };
  }
}

// 効かせたノードを戻す：今の API の値がまだ UI が入れた値（api_after）のままの項目だけを前の値（なければ null）にする
// （その間にほかの管理者が変えた値を上書きしない）
async function undoOne(n: ApplyNode, s: NodeState, logger: Logger): Promise<boolean> {
  if (s.changes.length === 0) return true;
  try {
    const now = await readSettings(n);
    const back = Object.fromEntries(s.changes.filter((c) => sameValue(apiOf(now, c.item), c.api_after)).map((c) => [c.item, c.api_before ?? null]));
    const skipped = s.changes.map((c) => c.item).filter((i) => !(i in back));
    if (skipped.length > 0) logger.warn(`ノード ${n.name} の ${skipped.join(', ')} はほかで変わったので戻しません`);
    if (Object.keys(back).length > 0) await n.run(() => patchGlobalSettings(globalPatchBody(back), false));
    return true;
  } catch (err) {
    logger.error(`ノード ${n.name} の global の設定を戻せませんでした（このノードだけ値が違います）: ${err}`);
    return false;
  }
}

export function changeSummary(changes: GlobalChange[]): string {
  return changes.map((c) => `${c.item}: ${formatGlobalValue(c.api_before)} → ${formatGlobalValue(c.api_after)}`).join('; ') || '-';
}

// 全ノードに送る。1 台でも断る・分からなければ、効かせたノードを戻す（ノードが 1 つなら戻すものはない）。
// 答え：ok なら nodes だけ、だめなら最初の断りのステータス・文・コードと nodes（ノードごとの outcome・undone・コード）
export async function applyGlobal(nodes: ApplyNode[], values: Record<string, unknown>, logger: Logger):
  Promise<{ ok: true; nodes: GlobalNodeResult[] } | { ok: false; failure: Failure; node: string; nodes: GlobalNodeResult[] }> {
  const states = await Promise.all(nodes.map((n) => applyOne(n, values, logger)));
  const bad = states.find((s) => s.outcome === 'refused') ?? states.find((s) => s.outcome === 'unknown');
  if (bad && nodes.length > 1) {
    await Promise.all(states.map(async (s, i) => {
      if (s.outcome === 'applied') s.undone = await undoOne(nodes[i], s, logger);
      else if (s.outcome === 'unknown') s.undone = false;
    }));
  }
  const out: GlobalNodeResult[] = states.map((s) => ({
    node: s.node,
    ok: s.outcome === 'applied',
    outcome: s.outcome,
    changes: s.changes,
    applied: s.applied,
    persisted: s.settings?.persisted ?? null,
    ...(s.settings ? { storage: s.settings.storage } : {}),
    ...(s.failure ? { error: s.failure.error, code: s.failure.code } : {}),
    ...(s.undone !== undefined ? { undone: s.undone } : {}),
  }));
  if (!bad) return { ok: true, nodes: out };
  return { ok: false, failure: bad.failure!, node: bad.node, nodes: out };
}
