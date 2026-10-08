// 利用量の集計（UI #101）：各ノードの rproxy の GET /rules の stats を RPROXY_UI_USAGE_SECS ごとに取り、前に見た数との差を
// usage_hourly・usage_daily（migration 010）に足す。所有者・ノード／グループ・ラベルは、そのときの UI のルール（forward_rules）か rproxy のルールの印。
// UI を複数動かしても、1 回の集計は DB のロック（GET_LOCK）で 1 つのプロセスだけが行う。サーバ側だけで使う
import { createHash } from 'node:crypto';
import type { PoolConnection } from 'mariadb';
import { Logger } from './lib';
import type { ForwardRule } from './lib';
import { listRules, withNode } from './rproxy';
import type { RproxyRuleStatus } from './rproxy';
import { K8S_PREFIX, loadNodes, targetNodes, toRproxyNode, usageRowNode } from './nodes';
import type { NodesConfig } from './nodes';
import { fromRow, getPool, loadOverrides } from './ruledb';
import { effectiveRule } from './overrides';
import { dayKey, hourKey, usageConfig, usageDelta } from './usage';
import type { UsageCounters } from './usage';

const LOCK_NAME = 'rproxy_ui_usage';

interface UsageState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  lastRun: string | null;
  error: string | null;
  missingTable: boolean;
}

const g = globalThis as unknown as { rproxyUiUsage?: UsageState };
function state(): UsageState {
  return (g.rproxyUiUsage ??= { timer: null, running: false, lastRun: null, error: null, missingTable: false });
}

// 画面に出す集計の状態
export function usageStatus() {
  const cfg = usageConfig();
  const st = state();
  return { ...cfg, lastRun: st.lastRun, error: st.error };
}

// ルールの持ち主と印（集計の行に書く）
export interface Attribution {
  owner: string | null;
  target: string | null;
  origin: string;
  labels: Record<string, string> | null;
}

const keyOf = (protocol: string, addr: string, port: number) => `${protocol.toLowerCase()}|${addr.toLowerCase()}|${port}`;

// ノード → キー → UI のルールの持ち主と印（ノードごとの上書きの待ち受けアドレスも見る）
export async function uiAttributions(db: Pick<PoolConnection, 'query'>, cfg: NodesConfig): Promise<Map<string, Map<string, Attribution>>> {
  const rows = await db.query(`SELECT id, auth_id, ${cfg.configured ? 'target, ' : ''}protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules`);
  const list = Array.isArray(rows) ? rows : [];
  const overrides = cfg.configured ? await loadOverrides(db, list.map((r: any) => Number(r.id))) : new Map();
  const out = new Map<string, Map<string, Attribution>>(cfg.nodes.map((n) => [n.name, new Map()]));
  for (const row of list) {
    let rule: ForwardRule;
    try {
      rule = fromRow(row);
    } catch {
      continue;
    }
    const nodes = cfg.configured ? targetNodes(cfg, String(row.target)) ?? [] : cfg.nodes;
    for (const n of nodes) {
      const eff = effectiveRule(rule, overrides.get(Number(row.id))?.[n.name]);
      out.get(n.name)?.set(keyOf(eff.protocol, eff.srcAddr, eff.srcPort), {
        owner: String(row.auth_id),
        target: cfg.configured ? String(row.target) : null,
        origin: 'dynamic',
        labels: rule.labels && Object.keys(rule.labels).length > 0 ? rule.labels : null,
      });
    }
  }
  return out;
}

// rproxy のルール（UI の DB にないもの）の印。k8s：Kubernetes の rproxy（見るだけのノード）では、ルールの組のルールを ruleset にする
// （Gateway API のリソースから作ったルール。rproxy-gateway の docs/DESIGN-v0.4.x.md 4.）
export function rproxyAttribution(s: RproxyRuleStatus, k8s = false): Attribution {
  const labels = (s as unknown as { labels?: unknown }).labels;
  return {
    owner: null,
    target: null,
    origin: s.origin === 'static' ? 'static' : k8s && typeof s.ruleset === 'string' && s.ruleset !== '' ? 'ruleset' : 'api',
    labels: typeof labels === 'object' && labels !== null && Object.keys(labels).length > 0 ? labels as Record<string, string> : null,
  };
}

// 集計の行の持ち主と印の組（usage_hourly・usage_daily の主キーの attr。migration 011）。持ち主・置き場所・印が変われば別の行に足す
// （同じ日に別の人が同じキーでルールを作った・管理者が持ち主を付け替えた・ラベルを変えたときに、前の分の持ち主を書き換えない）
export function attributionKey(a: Attribution): string {
  const labels = a.labels ? Object.keys(a.labels).sort().map((k) => [k, a.labels![k]]) : null;
  return createHash('sha256').update(JSON.stringify([a.owner, a.target, a.origin, labels])).digest('hex');
}

function countersOf(s: RproxyRuleStatus): UsageCounters | null {
  if (!s.stats) return null;
  return {
    rx: Number(s.stats.rx_bytes ?? 0),
    tx: Number(s.stats.tx_bytes ?? 0),
    connections: Number(s.stats.total_connections ?? 0),
    countersSince: typeof s.stats.counters_since === 'number' ? s.stats.counters_since : null,
    startedAt: typeof s.started_at === 'number' ? s.started_at : null,
  };
}

// usage_counters.sampled_at（DATETIME(3)、UTC）
function sampledAt(d: Date): string {
  return `${dayKey(d)} ${d.toISOString().slice(11, 23)}`;
}

const toUnix = (v: unknown): number | null => {
  const d = v instanceof Date ? v : typeof v === 'string' ? new Date(`${v.replace(' ', 'T')}Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
};

// 1 つのノードの集計（conn のトランザクションの中で）。足した行の数を返す。
// opts.rowNode：usage_hourly・usage_daily の node（Kubernetes の rproxy の Pod は Gateway のグループにまとめる。既定はノードの名前）。
// opts.k8s：Kubernetes の rproxy（ルールの組のルールの origin を ruleset にする）。usage_counters はどちらも Pod（ノード）ごと
export async function collectNode(
  conn: Pick<PoolConnection, 'query'>, node: string, statuses: RproxyRuleStatus[], attrs: Map<string, Attribution>, now: Date,
  opts: { rowNode?: string; k8s?: boolean } = {},
): Promise<number> {
  const rowNode = opts.rowNode ?? node;
  const prevRows = await conn.query('SELECT protocol, listen_addr, listen_port, counters_since, started_at, rx_bytes, tx_bytes, connections, sampled_at FROM usage_counters WHERE node = ?', [node]);
  const prev = new Map<string, UsageCounters>();
  let lastRunAt: number | null = null;
  for (const r of Array.isArray(prevRows) ? prevRows : []) {
    prev.set(keyOf(String(r.protocol), String(r.listen_addr), Number(r.listen_port)), {
      rx: Number(r.rx_bytes), tx: Number(r.tx_bytes), connections: Number(r.connections),
      countersSince: r.counters_since === null || r.counters_since === undefined ? null : Number(r.counters_since),
      startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    });
    const at = toUnix(r.sampled_at);
    if (at !== null && (lastRunAt === null || at > lastRunAt)) lastRunAt = at;
  }
  const hour = hourKey(now);
  const day = dayKey(now);
  const sampled = sampledAt(now);
  let added = 0;
  const seen: string[] = [];
  for (const s of statuses) {
    const cur = countersOf(s);
    if (!cur) continue;
    const key = keyOf(s.protocol, s.listen_addr, s.listen_port);
    seen.push(key);
    const d = usageDelta(prev.get(key) ?? null, cur, lastRunAt);
    await conn.query(
      'REPLACE INTO usage_counters (node, protocol, listen_addr, listen_port, counters_since, started_at, rx_bytes, tx_bytes, connections, sampled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [node, s.protocol, s.listen_addr, s.listen_port, cur.countersSince ?? null, cur.startedAt ?? null, cur.rx, cur.tx, cur.connections, sampled],
    );
    if (d.rx === 0 && d.tx === 0 && d.connections === 0) continue;
    const a = attrs.get(key) ?? rproxyAttribution(s, opts.k8s === true);
    const labels = a.labels ? JSON.stringify(a.labels) : null;
    const attr = attributionKey(a);
    // 主キーは (時刻, node, キー, attr)。持ち主・印が同じ行にだけ足し、前の行の持ち主・印は書き換えない
    for (const [table, col, at] of [['usage_hourly', 'hour', hour], ['usage_daily', 'day', day]] as const) {
      await conn.query(
        `INSERT INTO ${table} (${col}, node, protocol, listen_addr, listen_port, attr, target, owner, origin, labels, rx_bytes, tx_bytes, connections) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE rx_bytes = rx_bytes + VALUES(rx_bytes), tx_bytes = tx_bytes + VALUES(tx_bytes), connections = connections + VALUES(connections)`,
        [at, rowNode, s.protocol, s.listen_addr, s.listen_port, attr, a.target, a.owner, a.origin, labels, d.rx, d.tx, d.connections],
      );
    }
    added += 1;
  }
  // 消えたルールの基準は捨てる（同じキーで作り直されたら数え始めが変わる）
  const gone = [...prev.keys()].filter((k) => !seen.includes(k));
  for (const k of gone) {
    const [protocol, addr, port] = k.split('|');
    await conn.query('DELETE FROM usage_counters WHERE node = ? AND protocol = ? AND listen_addr = ? AND listen_port = ?', [node, protocol, addr, Number(port)]);
  }
  return added;
}

// 1 回の集計。lock が取れなければ（ほかの UI が集計中）何もしない
export async function runUsageOnce(now: Date = new Date()): Promise<'done' | 'skipped' | 'disabled'> {
  const logger = Logger('info', { action: 'usage' });
  const st = state();
  if (st.running) return 'skipped';
  let cfg: NodesConfig;
  try {
    cfg = loadNodes();
  } catch (err) {
    logger.error(`${err}`);
    return 'disabled';
  }
  const conf = usageConfig();
  st.running = true;
  let conn: PoolConnection | null = null;
  // RELEASE_LOCK に失敗した接続は pool に返さない（名前つきのロックは接続に残り、pool はセッションを戻さないので、
  // ほかの UI の集計が止まり続ける。捨てればロックも消える）
  let lockStuck = false;
  try {
    conn = await getPool().getConnection();
    const got = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
    if (Number(got?.[0]?.got) !== 1) return 'skipped';
    try {
      const attrs = await uiAttributions(conn, cfg);
      const errors: string[] = [];
      for (const n of cfg.nodes) {
        let statuses: RproxyRuleStatus[];
        try {
          statuses = cfg.configured ? await withNode(toRproxyNode(n), () => listRules()) : await listRules();
        } catch (err) {
          errors.push(`${n.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        await conn.beginTransaction();
        try {
          await collectNode(conn, n.name, statuses, attrs.get(n.name) ?? new Map(), now, n.readonly ? { rowNode: usageRowNode(cfg, n.name), k8s: true } : {});
          await conn.commit();
        } catch (err) {
          await conn.rollback().catch(() => undefined);
          throw err;
        }
      }
      // 見なくなった Kubernetes の rproxy の Pod の基準（usage_counters）は 24 時間で消す（Pod の名前は作り直しで変わる）
      await conn.query('DELETE FROM usage_counters WHERE node LIKE ? AND sampled_at < ?', [`${K8S_PREFIX}%`, sampledAt(new Date(now.getTime() - 86_400_000))]);
      // 残す日数を過ぎた行を消す
      await conn.query('DELETE FROM usage_hourly WHERE hour < ?', [hourKey(new Date(now.getTime() - conf.hourlyDays * 86_400_000))]);
      await conn.query('DELETE FROM usage_daily WHERE day < ?', [dayKey(new Date(now.getTime() - conf.dailyDays * 86_400_000))]);
      st.lastRun = now.toISOString();
      st.error = errors.length > 0 ? errors.join(' / ') : null;
      st.missingTable = false;
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch((err) => {
        lockStuck = true;
        logger.warn(`利用量の集計のロックを解放できないため、接続を捨てます: ${err}`);
      });
    }
    return 'done';
  } catch (err) {
    const errno = (err as { errno?: number })?.errno;
    const missing = errno === 1146;
    st.error = missing ? 'usage_* の表がありません（db/migrations/010_usage.sql を適用してください）。'
      // 1054：attr 列がない（011 を適用していない）
      : errno === 1054 ? 'usage_hourly・usage_daily に attr 列がありません（db/migrations/011_usage_attr.sql を適用してください）。'
        : err instanceof Error ? err.message : String(err);
    // 表がないことは 1 回だけログに出す
    if (!missing || !st.missingTable) logger.warn(`利用量の集計に失敗しました: ${err}`);
    st.missingTable = missing;
    return 'skipped';
  } finally {
    if (lockStuck) conn?.destroy();
    else conn?.release();
    st.running = false;
  }
}

// 起動時に 1 回呼ぶ（instrumentation.ts）。RPROXY_UI_USAGE_SECS が 0 なら集計しない
export function startUsage(): boolean {
  const st = state();
  if (st.timer !== null) return false;
  const secs = usageConfig().intervalSecs;
  if (secs === 0) return false;
  st.timer = setInterval(() => void runUsageOnce(), secs * 1000);
  if (typeof st.timer === 'object' && st.timer && 'unref' in st.timer) st.timer.unref();
  return true;
}
