// act/stb の昇格の前に stb を act（= DB の定義）に揃えておく（#109）。サーバ側だけで使う。
// - 自動の送り直し：active_standby のグループ（auto_resend が false でないもの）のノードを定期的に調べ、
//   ずれ・未登録のルールを送り直す（履歴は RESEND、操作者は system）。startHaSync を起動時（instrumentation.ts）に 1 回呼ぶ
// - 昇格してよいか（nodeReadiness）：keepalived の track_script が GET /api/forward/ha/ready で見る
// - 昇格した直後（notify_master）：syncNode で、そのノードにすぐ送り直す
// UI を複数動かしても、1 回の見回りは DB のロック（GET_LOCK）で 1 つのプロセスだけが行う。状態（失敗の数など）はプロセスごと
import type { PoolConnection } from 'mariadb';
import type { ForwardRule, GroupMode, HaSyncFailure, HaSyncStatus, HaStatus, NodeReadiness, NodeRole } from './lib';
import { Logger } from './lib';
import { NodesConfig, GroupConfig, loadNodes, toRproxyNode } from './nodes';
import { RproxyRuleStatus, getInterfaces, listRules, withNode } from './rproxy';
import { effectiveRule } from './overrides';
import { ruleDrift } from './drift';
import { ResendResult, fromRow, getPool, isPaused, loadOverrides, resendOne, ruleOptions } from './ruledb';
import { haStatus, interfaceAddrs } from './ha';

// 自動の送り直しの履歴の操作者
export const SYSTEM_ACTOR = 'system';
const LOCK_NAME = 'rproxy_ui_ha_sync';

type AppLogger = ReturnType<typeof Logger>;

interface SyncState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastRun: string | null;
  failures: Map<string, HaSyncFailure>;
}

// instrumentation と API route は別々に束ねられるので、状態は globalThis に置く（next dev の読み直しでも 1 つ）
const g = globalThis as unknown as { rproxyUiHaSync?: SyncState };
function state(): SyncState {
  return (g.rproxyUiHaSync ??= { timer: null, running: false, lastRun: null, failures: new Map() });
}

// RPROXY_UI_HA_SYNC_SECS（既定 30 秒。0 で止める）
export function haSyncIntervalSecs(env: Record<string, string | undefined> = process.env): number {
  const v = (env.RPROXY_UI_HA_SYNC_SECS ?? '').trim();
  if (v === '') return 30;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

function haGroups(cfg: NodesConfig, onlyAuto: boolean): GroupConfig[] {
  return cfg.configured ? cfg.groups.filter((gr) => gr.mode === 'active_standby' && (!onlyAuto || gr.autoResend)) : [];
}

const keyOf = (r: { protocol: string; srcAddr: string; srcPort: number }) => `${r.protocol}|${r.srcAddr.toLowerCase()}|${r.srcPort}`;

interface Candidate {
  id: number;
  target: string;
  key: string;
}

// そのノードの、グループのルールの揃い具合と、送り直すもの
async function inspectNode(cfg: NodesConfig, node: string, groups: GroupConfig[], logger: AppLogger): Promise<{ readiness: NodeReadiness; todo: Candidate[] }> {
  const targets = groups.filter((gr) => gr.nodes.includes(node)).map((gr) => gr.name);
  const readiness: NodeReadiness = { node: node, ready: true, checked: 0, issues: [] };
  if (targets.length === 0) return { readiness: readiness, todo: [] };
  const pool = getPool();
  const rows = await pool.query(
    `SELECT id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE target IN (${targets.map(() => '?').join(', ')}) ORDER BY id`,
    targets
  );
  const list = Array.isArray(rows) ? rows : [];
  readiness.checked = list.length;
  if (list.length === 0) return { readiness: readiness, todo: [] };
  const cfgNode = cfg.nodes.find((n) => n.name === node)!;
  let live: Map<string, RproxyRuleStatus>;
  try {
    const statuses = await withNode(toRproxyNode(cfgNode), () => listRules());
    live = new Map(statuses.map((s) => [`${String(s.protocol).toLowerCase()}|${s.listen_addr.toLowerCase()}|${s.listen_port}`, s]));
  } catch (err) {
    logger.warn(`ノード ${node} に問い合わせできません（揃っているか確かめられません）: ${err}`);
    const message = err instanceof Error ? err.message : String(err);
    readiness.ready = false;
    readiness.issues = list.map((r: any) => ({ target: String(r.target), key: keyOf(fromRow(r)), state: 'unknown' as const, error: message }));
    return { readiness: readiness, todo: [] };
  }
  const overrides = await loadOverrides(pool, list.map((r: any) => Number(r.id)));
  const todo: Candidate[] = [];
  for (const row of list) {
    const rule = fromRow(row);
    const eff = effectiveRule(rule, overrides.get(Number(row.id))?.[node]);
    const status = live.get(keyOf(eff));
    const base = { target: String(row.target), key: keyOf(rule) };
    let issue: NodeReadiness['issues'][number] | null = null;
    if (isPaused(eff)) {
      if (status) issue = { ...base, state: 'drift', fields: ['enabled'] };
    } else if (!status) {
      issue = { ...base, state: 'missing' };
    } else {
      const fields = ruleDrift(eff, status);
      if (fields.length > 0) issue = { ...base, state: 'drift', fields: fields };
    }
    if (issue) {
      readiness.issues.push(issue);
      todo.push({ id: Number(row.id), target: base.target, key: base.key });
    }
  }
  readiness.ready = readiness.issues.length === 0;
  return { readiness: readiness, todo: todo };
}

// 昇格してよいか：そのノードを含む active_standby のグループのルールが、すべてそのノードで DB の定義どおりに動いているか
export async function nodeReadiness(cfg: NodesConfig, node: string, logger: AppLogger = Logger('info', { action: 'ha-ready' })): Promise<NodeReadiness> {
  return (await inspectNode(cfg, node, haGroups(cfg, false), logger)).readiness;
}

export interface SyncResult {
  target: string;
  key: string;
  result: ResendResult | 'error';
  error?: string;
}

// 1 件を送り直す（ルールの行をロックしてから。変わっていなければ履歴を残さない）
async function resendLocked(cfg: NodesConfig, cand: Candidate, node: string, actor: string): Promise<ResendResult> {
  const conn: PoolConnection = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const rows = await conn.query(
      'SELECT id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE id = ? FOR UPDATE',
      [cand.id]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.rollback();
      return 'unchanged';
    }
    const ov = (await loadOverrides(conn, [cand.id])).get(cand.id)?.[node];
    const eff: ForwardRule = effectiveRule(fromRow(rows[0]), ov);
    const cfgNode = cfg.nodes.find((n) => n.name === node)!;
    const result = await withNode(toRproxyNode(cfgNode), () => resendOne(eff));
    if (result === 'unchanged') {
      await conn.rollback();
      return result;
    }
    await conn.query(
      'INSERT INTO forward_rules_log (auth_id, target, node, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actor, String(rows[0].target), node, eff.protocol, eff.srcAddr, eff.srcPort, eff.srcPortEnd, eff.distAddr, eff.distPort, eff.sourceIp, eff.udpIdleSecs, ruleOptions(eff), 'RESEND']
    );
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

// そのノードのずれ・未登録を送り直す。onlyAuto なら auto_resend のグループだけ（自動の見回り）。
// 失敗はプロセスの状態に数える（成功したら消す）
export async function syncNode(cfg: NodesConfig, node: string, opts: { onlyAuto: boolean; actor?: string; logger?: AppLogger }): Promise<{ readiness: NodeReadiness; results: SyncResult[] }> {
  const logger = opts.logger ?? Logger('info', { action: 'ha-sync' });
  const { readiness, todo } = await inspectNode(cfg, node, haGroups(cfg, opts.onlyAuto), logger);
  const failures = state().failures;
  const results: SyncResult[] = [];
  for (const cand of todo) {
    const fkey = `${node}|${cand.target}|${cand.key}`;
    try {
      const result = await resendLocked(cfg, cand, node, opts.actor ?? SYSTEM_ACTOR);
      results.push({ target: cand.target, key: cand.key, result: result });
      failures.delete(fkey);
      if (result !== 'unchanged') logger.info(`ノード ${node} に ${cand.key}（${cand.target}）を送り直しました（${result}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const prev = failures.get(fkey);
      failures.set(fkey, { node: node, target: cand.target, key: cand.key, count: (prev?.count ?? 0) + 1, error: message, since: prev?.since ?? new Date().toISOString() });
      logger.warn(`ノード ${node} に ${cand.key}（${cand.target}）を送り直せませんでした: ${message}`);
      results.push({ target: cand.target, key: cand.key, result: 'error', error: message });
    }
  }
  return { readiness: readiness, results: results };
}

// 1 回の見回り。UI を複数動かしていても、DB のロックを取れたプロセスだけが行う（取れなければ何もしない）
export async function runHaSyncOnce(logger: AppLogger = Logger('info', { action: 'ha-sync' })): Promise<'done' | 'skipped' | 'disabled'> {
  const st = state();
  if (st.running) return 'skipped';
  let cfg: NodesConfig;
  try {
    cfg = loadNodes();
  } catch (err) {
    logger.error(`${err}`);
    return 'disabled';
  }
  const groups = haGroups(cfg, true);
  if (groups.length === 0) return 'disabled';
  st.running = true;
  let lock: PoolConnection | null = null;
  try {
    lock = await getPool().getConnection();
    const got = await lock.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
    if (Number(got?.[0]?.got) !== 1) return 'skipped';
    try {
      const nodes = [...new Set(groups.flatMap((gr) => gr.nodes))];
      for (const node of nodes) await syncNode(cfg, node, { onlyAuto: true, logger: logger });
      st.lastRun = new Date().toISOString();
    } finally {
      await lock.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
    }
    return 'done';
  } catch (err) {
    logger.warn(`act/stb の自動の送り直しで失敗しました: ${err}`);
    return 'skipped';
  } finally {
    lock?.release();
    st.running = false;
  }
}

// 起動時に 1 回呼ぶ（instrumentation.ts）。プロセスで 1 つの見回りだけを動かす（2 回目以降は何もしない）
export function startHaSync(): boolean {
  const st = state();
  if (st.timer !== null) return false;
  const secs = haSyncIntervalSecs();
  if (secs <= 0) return false;
  st.timer = setInterval(() => void runHaSyncOnce(), secs * 1000);
  if (typeof st.timer === 'object' && st.timer && 'unref' in st.timer) st.timer.unref();
  return true;
}

// テストのため
export function stopHaSync(): void {
  const st = state();
  if (st.timer !== null) clearInterval(st.timer);
  st.timer = null;
  st.failures.clear();
  st.lastRun = null;
}

export function haSyncStatus(): HaSyncStatus {
  const st = state();
  return {
    intervalSecs: haSyncIntervalSecs(),
    lastRun: st.lastRun,
    failures: [...st.failures.values()].sort((a, b) => b.count - a.count),
  };
}

export interface HaGroupOverview extends Partial<HaStatus> {
  name: string;
  mode: GroupMode;
  nodes: string[];
  vips: string[];
  autoResend: boolean;
  roles: Record<string, NodeRole>;
  readiness: NodeReadiness[];
}

// act/stb の画面（failback の確認）：グループごとの act（vip があれば GET /interfaces）と、ノードごとの揃い具合
export async function haOverview(cfg: NodesConfig): Promise<HaGroupOverview[]> {
  const logger = Logger('info', { action: 'ha-overview' });
  const groups = haGroups(cfg, false);
  const nodes = [...new Set(groups.flatMap((gr) => gr.nodes))];
  const held = new Map<string, Set<string> | null>();
  const ready = new Map<string, NodeReadiness>();
  await Promise.all(nodes.map(async (n) => {
    const cfgNode = cfg.nodes.find((x) => x.name === n)!;
    try {
      held.set(n, interfaceAddrs(await withNode(toRproxyNode(cfgNode), () => getInterfaces())));
    } catch {
      held.set(n, null);
    }
  }));
  for (const n of nodes) ready.set(n, (await inspectNode(cfg, n, groups, logger)).readiness);
  return groups.map((gr) => {
    const ha = gr.vips.length > 0 ? haStatus(gr.vips, gr.nodes, held) : null;
    return {
      name: gr.name,
      mode: gr.mode,
      nodes: [...gr.nodes],
      vips: [...gr.vips],
      autoResend: gr.autoResend,
      ...(ha ? ha.status : {}),
      roles: ha ? Object.fromEntries(ha.roles) : {},
      readiness: gr.nodes.map((n) => ready.get(n)!),
    };
  });
}
