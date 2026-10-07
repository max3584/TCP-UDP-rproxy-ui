// DB の行とルールの変換、プール、1 つのノードへの送り直し（API route と act/stb の自動の送り直し（hasync.ts）で共有する）。サーバ側だけで使う
import mariadb, { PoolConnection } from 'mariadb';
import type { ForwardRule, Protocol } from './lib';
import { optionsJson, parseOptions } from './tls';
import { RproxyError, RproxyRuleKey, RproxyRulePatch, RproxyRuleStatus, addRule, deleteRule, getRule, modifyRule } from './rproxy';
import { extraAddrs, remoteFields, starttlsFields, toRproxyRule } from './settingsdoc';
import { Overrides, overrideFromRow } from './overrides';
import { needsRecreateOnNode, ruleDrift } from './drift';
import { ruleFromStatus } from './dashboard';
import { v04Of, v04PatchFields } from './v04';
import type { V04Settings } from './v04';

// MariaDBのコネクションプールを作成
function createPool() {
  return mariadb.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionLimit: 10,
  });
}

// プロセスで 1 つのプールを使い回す（globalThis に置く）。next dev はファイルを変えるたびにモジュールを読み直し、
// instrumentation（act/stb の自動の送り直し）と API route は別々に束ねられるので、モジュールの変数では共有できない
const globalForPool = globalThis as unknown as { rproxyPool?: ReturnType<typeof createPool> };

export function getPool(): ReturnType<typeof createPool> {
  return (globalForPool.rproxyPool ??= createPool());
}


export function toKey(rule: ForwardRule): RproxyRuleKey {
  return { protocol: rule.protocol, listen_addr: rule.srcAddr, listen_port: rule.srcPort };
}

// PATCH では tls と allow_from を毎回付けて丸ごと置き換える（allow_from の [] はすべて許可に戻す）。
// http のルールは http を付けて L7 の設定も丸ごと置き換える。範囲と source_ip は変えられないので送らない。
// crowdsec は有効なとき、または有効から無効にするとき（wasOn）だけ付ける（古い rproxy は知らない項目を拒否する）。
// 宛先を複数から単一に戻すとき（wasMulti）は targets: [] も付けて、rproxy の宛先の一覧を外す。
// 追加の待ち受けアドレスは、あるとき、またはあったものを外すとき（hadExtra）だけ付ける。
// v0.4 の項目は、あるとき（丸ごと置き換え）と、前（before）にあったものを外すとき（{}）だけ付ける
export function toRproxyPatch(rule: ForwardRule, wasOn = false, wasMulti = false, hadExtra = false, before?: V04Settings): RproxyRulePatch {
  return {
    ...remoteFields(rule),
    ...(wasMulti && rule.http === null && rule.targets.length === 0 ? { targets: [] } : {}),
    ...(rule.protocol === 'udp' ? { udp_idle_secs: rule.udpIdleSecs } : {}),
    tls: rule.tls,
    ...starttlsFields(rule),
    allow_from: rule.allowFrom,
    ...(rule.crowdsec || wasOn ? { crowdsec: rule.crowdsec } : {}),
    ...(extraAddrs(rule).length > 0 || hadExtra ? { extra_listen_addrs: extraAddrs(rule) } : {}),
    ...v04PatchFields(rule, before),
  };
}

// UI で一時停止中か（DB にだけあり、rproxy には作らない）
export function isPaused(rule: ForwardRule): boolean {
  return rule.enabled === false;
}

// forward_rules の行（src_port_end と options を含む）をルールにする。target 列を読んだときは target も付ける
export function fromRow(row: any): ForwardRule {
  const opts = parseOptions(row.options);
  return {
    ...(row.target !== undefined && row.target !== null ? { target: String(row.target) } : {}),
    protocol: String(row.protocol).toLowerCase() as Protocol,
    srcAddr: row.src_addr,
    srcPort: Number(row.src_port),
    srcPortEnd: row.src_port_end === null || row.src_port_end === undefined ? null : Number(row.src_port_end),
    distAddr: row.dist_addr,
    distPort: Number(row.dist_port),
    sourceIp: row.source_ip,
    udpIdleSecs: Number(row.udp_idle_secs),
    tls: opts.tls,
    starttls: opts.starttls,
    starttlsRequired: opts.starttlsRequired,
    allowFrom: opts.allowFrom,
    http: opts.http,
    crowdsec: opts.crowdsec,
    targets: opts.balancing.targets,
    balance: opts.balancing.balance,
    healthCheck: opts.balancing.healthCheck,
    extraListenAddrs: opts.extraListenAddrs,
    enabled: opts.enabled,
    ...opts.v04,
  };
}

export function isNotFound(err: unknown): boolean {
  return err instanceof RproxyError && err.code === 'not_found';
}

// ルールの id → ノード → 上書き
export async function loadOverrides(db: Pick<PoolConnection, 'query'>, ids: number[] | null): Promise<Map<number, Overrides>> {
  const out = new Map<number, Overrides>();
  if (ids !== null && ids.length === 0) return out;
  const rows = ids === null
    ? await db.query('SELECT rule_id, node, src_addr, dist_addr, dist_port, options FROM forward_rule_overrides')
    : await db.query(`SELECT rule_id, node, src_addr, dist_addr, dist_port, options FROM forward_rule_overrides WHERE rule_id IN (${ids.map(() => '?').join(', ')})`, ids);
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = Number(r.rule_id);
    const map = out.get(id) ?? {};
    map[String(r.node)] = overrideFromRow(r);
    out.set(id, map);
  }
  return out;
}

export type ResendResult = 'added' | 'modified' | 'recreated' | 'removed' | 'unchanged';

// そのノード（withNode の中）の実際のルールを DB の内容に合わせる。ずれがなければ何もしない
export async function resendOne(rule: ForwardRule): Promise<ResendResult> {
  const key = toKey(rule);
  let live: RproxyRuleStatus | null = null;
  try {
    live = await getRule(key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (live?.origin === 'static') throw new RproxyError('このルールは rproxy の固定ルールです。', 'static', 409);
  if (isPaused(rule)) {
    if (!live) return 'unchanged';
    await deleteRule(key);
    return 'removed';
  }
  if (!live) {
    await addRule(toRproxyRule(rule));
    return 'added';
  }
  if (ruleDrift(rule, live).length === 0) return 'unchanged';
  if (needsRecreateOnNode(rule, live)) {
    await deleteRule(key);
    await addRule(toRproxyRule(rule));
    return 'recreated';
  }
  const actual = ruleFromStatus(live, 0);
  await modifyRule(key, toRproxyPatch(rule, actual.crowdsec, actual.targets.length > 0, (actual.extraListenAddrs ?? []).length > 0, actual));
  return 'modified';
}

// DB の options 列（API route の options と同じ）
export function ruleOptions(rule: ForwardRule): string | null {
  return optionsJson(rule.tls, rule.starttls, rule.starttlsRequired, rule.allowFrom, rule.http, rule.crowdsec, {
    targets: rule.targets,
    balance: rule.balance,
    healthCheck: rule.healthCheck,
  }, extraAddrs(rule), rule.enabled !== false, v04Of(rule));
}
