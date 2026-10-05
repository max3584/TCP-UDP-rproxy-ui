import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { isIP } from 'net';
import {
  DEFAULT_UDP_IDLE_SECS,
  DashboardData,
  ForwardRule,
  ForwardRules,
  HttpSpec,
  Logger,
  GroupHa,
  HaStatus,
  NodeLiveState,
  NodeSummary,
  Protocol,
  SOURCE_IPS,
  SourceIp,
  TCP_ONLY_SOURCE_IPS,
  sessionUser,
} from '@/components/lib';
import {
  DEFAULT_TLS,
  TlsError,
  checkTls,
  NO_BALANCING,
  checkBalancing,
  normalizeAllowFrom,
  normalizeBalance,
  normalizeCrowdsec,
  normalizeEnabled,
  normalizeExtraListenAddrs,
  normalizeHealthCheck,
  normalizeTargets,
  normalizeHttp,
  normalizeStartTls,
  normalizeStartTlsRequired,
  normalizeTls,
  optionsJson,
  parseOptions,
  portCount,
} from '@/components/tls';
import {
  RproxyError,
  RproxyNode,
  RproxyRule,
  RproxyRuleKey,
  RproxyRulePatch,
  RproxyRuleStatus,
  addRule,
  deleteRule,
  getInterfaces,
  getRule,
  listRules,
  modifyRule,
  withNode,
} from '@/components/rproxy';
import { aggregateNodeStates, mergeStaticRules, ruleFromStatus } from '@/components/dashboard';
import { NodesConfig, NodesConfigError, groupOf, loadNodes, membership, nodesInfo, targetNodes, targetsOverlap, toRproxyNode } from '@/components/nodes';
import { needsRecreateOnNode, ruleDrift } from '@/components/drift';
import { haStatus, interfaceAddrs, vipAddrs } from '@/components/ha';
import { FanoutError, NodeResult, Undo, applyToNodes } from '@/components/fanout';
import { FORBIDDEN_MESSAGE, NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE } from '@/components/messages';
import mariadb, { PoolConnection } from 'mariadb';
import { localizedApi } from '@/i18n/server';
import { translate } from '@/i18n/core';
import { Access, RoleConfig, accessOf, portsAllowed, roleConfig } from '@/components/roles';
import { toHttpRules, validateHttp } from '@/components/httpspec';
import { exportDoc, extraAddrs, formatDoc, parseDoc, remoteFields, settingsRuleToBody, starttlsFields, toRproxyRule } from '@/components/settingsdoc';
import { HISTORY_ACTIONS, HistoryAction, HistoryEntry, HistoryPage, isDate, ruleChanges } from '@/components/history';

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

// next dev はファイルを変えるたびにこのモジュールを読み直すので、プールを使い回さないと
// 古いプールの接続が DB に残り続ける（Too many connections になる）
const globalForPool = globalThis as unknown as { rproxyPool?: ReturnType<typeof createPool> };
const pool = process.env.NODE_ENV === 'development'
  ? (globalForPool.rproxyPool ??= createPool())
  : createPool();

// RESEND：1 つのノードに DB の内容を送り直した（#98。node 列にそのノード）
type Action = 'ADD' | 'UPDATE' | 'DELETE' | 'RESEND';
type AppLogger = ReturnType<typeof Logger>;

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string) {
    super(message);
  }
}

// 操作する利用者。admin はすべての利用者のルールを扱える（WHERE に auth_id を付けない）
interface Actor {
  id: string;
  access: Access;
  roles: RoleConfig;
  // ノードとグループ（RPROXY_UI_NODES。なければ RPROXY_API_URL の 1 台）
  cfg: NodesConfig;
}

// ルールの置き場所（#98）。target は DB の target 列の値で、RPROXY_UI_NODES がなければ null（列を使わない）。
// nodes は変更を送るノード（グループなら全員）
interface Place {
  target: string | null;
  nodes: RproxyNode[];
}

function placeOf(cfg: NodesConfig, target: string | null): Place {
  if (!cfg.configured || target === null) return { target: null, nodes: cfg.nodes.map(toRproxyNode) };
  const nodes = targetNodes(cfg, target);
  if (!nodes) throw new HttpError(400, `ノード／グループ ${target} は設定にありません。`, 'unknown_target');
  return { target: target, nodes: nodes.map(toRproxyNode) };
}

// WHERE のキーの条件（ノードを設定していれば target も）
function keyWhere(place: Place, key: { protocol: string; srcAddr: string; srcPort: number }, alias = ''): { sql: string; params: unknown[] } {
  const base = `${alias}protocol = ? AND ${alias}src_addr = ? AND ${alias}src_port = ?`;
  return place.target === null
    ? { sql: base, params: [key.protocol, key.srcAddr, key.srcPort] }
    : { sql: `${alias}target = ? AND ${base}`, params: [place.target, key.protocol, key.srcAddr, key.srcPort] };
}

// body / query の target（ノードかグループの名前）。ノードを設定していなければ無視する。
// 書いてあれば設定にある名前でなければ 400。なければ undefined
function requestedTarget(cfg: NodesConfig, value: unknown): string | undefined {
  if (!cfg.configured) return undefined;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || targetNodes(cfg, value) === null) {
    throw new HttpError(400, `ノード／グループ ${String(value)} は設定にありません。`, 'unknown_target');
  }
  return value;
}

// 追加（とインポート）の置き場所。target がなければ default_target、それもなければ 400
function placeForAdd(cfg: NodesConfig, value: unknown): Place {
  if (!cfg.configured) return placeOf(cfg, null);
  const target = requestedTarget(cfg, value) ?? cfg.defaultTarget;
  if (target === null) throw new HttpError(400, 'ルールを置くノードかグループ（target）を指定してください。', 'target_required');
  return placeOf(cfg, target);
}

// 既にあるルールの置き場所。target がなければ DB で探し、同じキーが複数のノード／グループにあれば 400
async function placeForKey(actor: Actor, key: { protocol: string; srcAddr: string; srcPort: number }, value: unknown): Promise<Place> {
  const cfg = actor.cfg;
  if (!cfg.configured) return placeOf(cfg, null);
  const given = requestedTarget(cfg, value);
  if (given !== undefined) return placeOf(cfg, given);
  const owner = ownerClause(actor);
  const rows = await pool.query(
    `SELECT target FROM forward_rules WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ?`,
    [...owner.params, key.protocol, key.srcAddr, key.srcPort]
  );
  if (rows.length > 1) throw new HttpError(400, '同じキーのルールが複数のノード／グループにあります。target を指定してください。', 'target_required');
  if (rows.length === 1) return placeOf(cfg, String(rows[0].target));
  // DB にない（固定ルールかもしれない）：既定の置き場所で rproxy に問い合わせる
  return placeOf(cfg, cfg.defaultTarget ?? cfg.nodes[0].name);
}

// SELECT / UPDATE / DELETE の WHERE に付ける所有者の条件
function ownerClause(actor: Actor): { sql: string; params: string[] } {
  return actor.access === 'admin' ? { sql: '', params: [] } : { sql: 'auth_id = ? AND ', params: [actor.id] };
}

// user（admin 以外）が RPROXY_UI_USER_PORTS の外の待ち受けポートを使おうとしたら 403
function checkPorts(actor: Actor, rule: ForwardRule): void {
  const last = rule.srcPortEnd ?? rule.srcPort;
  if (!portsAllowed(actor.access, actor.roles, rule.srcPort, last)) {
    const [lo, hi] = actor.roles.userPorts ?? [1, 65535];
    const ports = last !== rule.srcPort ? `${rule.srcPort}-${last}` : `${rule.srcPort}`;
    throw new HttpError(403, `待ち受けポート ${ports} は管理者だけが使えます（利用者が使えるのは ${lo}-${hi}）。`, 'port_not_allowed');
  }
}

const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// IPv6 は rproxy の応答と突き合わせられるように圧縮表記に揃える
function normalizeAddr(addr: string): string {
  if (isIP(addr) === 6) {
    return new URL(`http://[${addr}]`).hostname.slice(1, -1);
  }
  return addr;
}

function ruleKeyString(protocol: string, addr: string, port: number): string {
  return `${protocol.toLowerCase()}|${normalizeAddr(addr)}|${port}`;
}

function toKey(rule: ForwardRule): RproxyRuleKey {
  return { protocol: rule.protocol, listen_addr: rule.srcAddr, listen_port: rule.srcPort };
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function invalid(message: string): HttpError {
  return new HttpError(400, message, 'invalid');
}

function fromTlsError(err: unknown): unknown {
  return err instanceof TlsError ? new HttpError(400, err.message, err.code) : err;
}

// 入力を検証して正規化する。delete ではキー（protocol, srcAddr, srcPort）だけを使う。
// forModify: 転送先（distAddr / distPort）がなくてもよい（L7 のルールの変更。あるべきかは editForwardingRule が DB の値で決める）
function parseRule(body: any, keyOnly: boolean, forModify = false): ForwardRule {
  try {
    return parseRuleInner(body, keyOnly, forModify);
  } catch (err) {
    throw fromTlsError(err);
  }
}

// 転送先が空か（L7 のルールには転送先がない）
function noRemote(body: any): boolean {
  const addr = typeof body.distAddr === 'string' ? body.distAddr.trim() : body.distAddr;
  return (addr === undefined || addr === null || addr === '')
    && (body.distPort === undefined || body.distPort === null || body.distPort === 0);
}

function parseRuleInner(body: any, keyOnly: boolean, forModify: boolean): ForwardRule {
  if (typeof body !== 'object' || body === null) throw invalid('リクエストの形式が不正です。');

  const protocol = typeof body.protocol === 'string' ? body.protocol.toLowerCase() : '';
  if (protocol !== 'tcp' && protocol !== 'udp') throw invalid('プロトコルは tcp か udp を指定してください。');

  const srcAddr = typeof body.srcAddr === 'string' ? body.srcAddr.trim() : '';
  if (isIP(srcAddr) === 0) throw invalid('Source Address には IP アドレスを指定してください。');
  if (!isPort(body.srcPort)) throw invalid('ポート番号は1から65535の範囲で指定してください。');

  const rule: ForwardRule = {
    protocol: protocol as Protocol,
    srcAddr: normalizeAddr(srcAddr),
    srcPort: body.srcPort,
    srcPortEnd: null,
    distAddr: '',
    distPort: 0,
    sourceIp: 'proxy',
    udpIdleSecs: DEFAULT_UDP_IDLE_SECS,
    tls: { ...DEFAULT_TLS },
    starttls: null,
    starttlsRequired: true,
    allowFrom: [],
    http: null,
    crowdsec: false,
    ...NO_BALANCING,
    extraListenAddrs: [],
  };
  if (keyOnly) return rule;

  // L7（http）のルールは転送先を持たない（転送先は http.services / routes[].to）
  const http = parseHttp(body.http, protocol as Protocol);
  // 宛先を複数にしたルールも remote_addr / remote_port を持たない（転送先は targets）
  const targets = normalizeTargets(body.targets);
  const balance = normalizeBalance(body.balance);
  const healthCheck = normalizeHealthCheck(body.healthCheck);
  if (targets.length > 0 && http !== null) {
    throw invalid('L7（HTTP）のルールでは宛先を複数にできません。L7 タブのサービスで転送先を並べてください。');
  }
  const withoutRemote = http !== null || targets.length > 0 || (forModify && noRemote(body));
  const distAddr = withoutRemote ? '' : typeof body.distAddr === 'string' ? body.distAddr.trim() : '';
  const distPort = withoutRemote ? 0 : body.distPort;
  if (!withoutRemote) {
    if (isIP(distAddr) === 0 && !HOSTNAME_PATTERN.test(distAddr)) {
      throw invalid('Destination Address には IP アドレスかホスト名を指定してください。');
    }
    if (!isPort(distPort)) throw invalid('ポート番号は1から65535の範囲で指定してください。');
  }

  const sourceIp = body.sourceIp ?? 'proxy';
  if (!SOURCE_IPS.includes(sourceIp)) throw invalid('source_ip の指定が不正です。');
  if (protocol === 'udp' && TCP_ONLY_SOURCE_IPS.includes(sourceIp)) {
    throw invalid(`${sourceIp} は TCP でのみ使えます。`);
  }

  const udpIdleSecs = body.udpIdleSecs ?? DEFAULT_UDP_IDLE_SECS;
  if (typeof udpIdleSecs !== 'number' || !Number.isInteger(udpIdleSecs) || udpIdleSecs < 1 || udpIdleSecs > 86400) {
    throw invalid('UDP のアイドルタイムアウトは1から86400秒の範囲で指定してください。');
  }

  // 範囲の終わりが開始と同じなら単一ポートとして扱う（rproxy の応答も null になる）
  let srcPortEnd: number | null = body.srcPortEnd ?? null;
  if (srcPortEnd !== null && !isPort(srcPortEnd)) throw invalid('ポート範囲の終わりは1から65535の範囲で指定してください。');
  if (srcPortEnd === body.srcPort) srcPortEnd = null;
  // 上限（capabilities の max_range_ports）は rproxy が確かめる
  const count = portCount(body.srcPort, srcPortEnd, distPort);

  const tls = normalizeTls(body.tls);
  const starttls = normalizeStartTls(body.starttls);
  const starttlsRequired = normalizeStartTlsRequired(body.starttlsRequired, starttls);
  checkTls(protocol as Protocol, tls, starttls, count, http !== null);
  checkBalancing(protocol as Protocol, { targets: targets, balance: balance, healthCheck: healthCheck }, count);
  const allowFrom = normalizeAllowFrom(body.allowFrom);
  if (http !== null) {
    // rproxy と同じ組み合わせの制限（tcp は parseHttp で確かめた）
    if (tls.mode === 'sni') throw new TlsError('L7（HTTP）は TLS のモードが terminate（HTTPS）か、TLS なし（平文の HTTP）のときだけ使えます。', 'tls_config');
    if (starttls !== null) throw invalid('L7（HTTP）と STARTTLS は組み合わせられません。');
    if (srcPortEnd !== null) throw invalid('L7（HTTP）のルールはポート範囲にできません。');
    if (sourceIp === 'proxy_v1' || sourceIp === 'proxy_v2') throw invalid('L7（HTTP）のルールでは PROXY ヘッダ（proxy_v1 / proxy_v2）を使えません（転送先へは X-Forwarded-For を付けます）。');
  }

  return {
    ...rule,
    srcPortEnd: srcPortEnd,
    distAddr: distAddr,
    distPort: distPort,
    sourceIp: sourceIp as SourceIp,
    udpIdleSecs: udpIdleSecs,
    tls: tls,
    starttls: starttls,
    starttlsRequired: starttlsRequired,
    allowFrom: allowFrom,
    http: http,
    crowdsec: normalizeCrowdsec(body.crowdsec),
    targets: targets,
    balance: balance,
    healthCheck: targets.length > 0 ? healthCheck : null,
    extraListenAddrs: normalizeExtraListenAddrs(body.extraListenAddrs, rule.srcAddr),
    // 画面からの追加では送られない（有効）。インポートの停止中のルールだけ false
    enabled: normalizeEnabled(body.enabled),
  };
}

// body に extraListenAddrs があるか（なければ変更の前の値を保つ）
function hasExtraListenAddrs(body: any): boolean {
  return typeof body === 'object' && body !== null && body.extraListenAddrs !== undefined;
}


// body に targets があるか（なければ変更の前の宛先・振り分け方・ヘルスチェックを保つ）
function hasTargets(body: any): boolean {
  return typeof body === 'object' && body !== null && body.targets !== undefined;
}

// body の http（L7 の設定）。null / 省略なら L4 のルール
function parseHttp(value: unknown, protocol: Protocol): HttpSpec | null {
  const http = normalizeHttp(value);
  if (http === null) return null;
  if (protocol !== 'tcp') throw invalid('L7（HTTP）は TCP のルールでだけ使えます（HTTP/3 は同じルールの http3 で有効にします）。');
  const errors = validateHttp(toHttpRules(http));
  if (errors.length > 0) throw invalid(errors.map((e) => translate(e)).join(' '));
  return http;
}

// body に crowdsec があるか（なければ変更の前の値を保つ）
function hasCrowdsec(body: any): boolean {
  return typeof body === 'object' && body !== null && body.crowdsec !== undefined;
}

// body に http があるか（なければ変更の前の L7 の設定を保つ）
function hasHttp(body: any): boolean {
  return typeof body === 'object' && body !== null && body.http !== undefined;
}

// rproxy への反映の結果。DB だけの変更（停止中のルール）では results は空
interface Applied {
  undo: Undo;
  results: NodeResult[];
}

const DB_ONLY: Applied = { undo: async () => undefined, results: [] };

// 置き場所のノード（グループなら全員）で step を実行する。1 台でも失敗したら、成功したノードを戻して投げる（fanout.ts）
function onNodes(place: Place, logger: AppLogger, step: () => Promise<Undo>): Promise<Applied> {
  return applyToNodes(place.nodes, () => step(), logger);
}

// DB の変更 → rproxy への反映 → COMMIT の順に行う。rproxy が失敗したら ROLLBACK する。
// rproxy に反映した後で COMMIT だけが失敗した場合は、undo で rproxy 側を元に戻す。
async function withTransaction(logger: AppLogger, fn: (conn: PoolConnection) => Promise<Applied>): Promise<NodeResult[]> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { undo, results } = await fn(conn);
    try {
      await conn.commit();
    } catch (err) {
      logger.error(`COMMIT に失敗したため rproxy の変更を取り消します: ${err}`);
      await undo().catch((e) => logger.error(`rproxy の変更を取り消せませんでした（DB と rproxy が食い違っています）: ${e}`));
      throw err;
    }
    return results;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

// PATCH では tls と allow_from を毎回付けて丸ごと置き換える（allow_from の [] はすべて許可に戻す）。
// http のルールは http を付けて L7 の設定も丸ごと置き換える。範囲と source_ip は変えられないので送らない。
// crowdsec は有効なとき、または有効から無効にするとき（wasOn）だけ付ける（古い rproxy は知らない項目を拒否する）。
// 宛先を複数から単一に戻すとき（wasMulti）は targets: [] も付けて、rproxy の宛先の一覧を外す。
// 追加の待ち受けアドレスは、あるとき、またはあったものを外すとき（hadExtra）だけ付ける
function toRproxyPatch(rule: ForwardRule, wasOn = false, wasMulti = false, hadExtra = false): RproxyRulePatch {
  return {
    ...remoteFields(rule),
    ...(wasMulti && rule.http === null && rule.targets.length === 0 ? { targets: [] } : {}),
    ...(rule.protocol === 'udp' ? { udp_idle_secs: rule.udpIdleSecs } : {}),
    tls: rule.tls,
    ...starttlsFields(rule),
    allow_from: rule.allowFrom,
    ...(rule.crowdsec || wasOn ? { crowdsec: rule.crowdsec } : {}),
    ...(extraAddrs(rule).length > 0 || hadExtra ? { extra_listen_addrs: extraAddrs(rule) } : {}),
  };
}

function options(rule: ForwardRule): string | null {
  return optionsJson(rule.tls, rule.starttls, rule.starttlsRequired, rule.allowFrom, rule.http, rule.crowdsec, {
    targets: rule.targets,
    balance: rule.balance,
    healthCheck: rule.healthCheck,
  }, extraAddrs(rule), rule.enabled !== false);
}

// UI で一時停止中か（DB にだけあり、rproxy には作らない）
function isPaused(rule: ForwardRule): boolean {
  return rule.enabled === false;
}

// forward_rules の行（src_port_end と options を含む）をルールにする。target 列を読んだときは target も付ける
function fromRow(row: any): ForwardRule {
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
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RproxyError && err.code === 'not_found';
}

async function insertLog(conn: PoolConnection, authId: string, place: Place, rule: ForwardRule, action: Action, node?: string): Promise<void> {
  if (place.target !== null && node !== undefined) {
    await conn.query(
      'INSERT INTO forward_rules_log (auth_id, target, node, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [authId, place.target, node, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule), action]
    );
    return;
  }
  if (place.target !== null) {
    await conn.query(
      'INSERT INTO forward_rules_log (auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [authId, place.target, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule), action]
    );
    return;
  }
  await conn.query(
    'INSERT INTO forward_rules_log (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [authId, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule), action]
  );
}

// rproxy の固定ルール（origin: static）なら返す。ないか、固定ルールでないか、問い合わせできなければ null。
// ノードがいくつかあれば、どれか 1 台の固定ルールでも返す
async function findStaticRule(key: RproxyRuleKey, place: Place, logger: AppLogger): Promise<RproxyRuleStatus | null> {
  for (const node of place.nodes) {
    try {
      const status = await withNode(node, () => getRule(key));
      if (status.origin === 'static') return status;
    } catch (err) {
      if (!isNotFound(err)) logger.warn(`rproxy に固定ルールか問い合わせできません: ${err}`);
    }
  }
  return null;
}

// 固定ルールは rproxy の設定ファイルで管理している（rproxy も PATCH / DELETE を 409 static で拒否する）
function staticRuleError(): HttpError {
  return new HttpError(409, 'このルールは rproxy の固定ルールです。', 'static');
}

// 自分のルール（admin ならだれのルールでも）を行ロックして取得する。なければ 404（rproxy の固定ルールなら 409 static）
async function lockOwnRule(conn: PoolConnection, actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<ForwardRule> {
  const owner = ownerClause(actor);
  const where = keyWhere(place, key);
  const rows = await conn.query(
    `SELECT src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}${where.sql} FOR UPDATE`,
    [...owner.params, ...where.params]
  );
  if (rows.length === 0) {
    if (await findStaticRule(toKey(key), place, logger)) throw staticRuleError();
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  return fromRow({ ...rows[0], protocol: key.protocol, src_addr: key.srcAddr, src_port: key.srcPort, ...(place.target !== null ? { target: place.target } : {}) });
}

// DB のルールに rproxy の稼働情報を付ける。status が undefined なら rproxy にない（missing）、
// live が false なら rproxy に問い合わせできなかった（unknown）。一時停止中なら paused
function withLiveState(id: number, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined, owner?: string): ForwardRules {
  return {
    id: id,
    origin: 'dynamic',
    ...rule,
    ...(owner !== undefined ? { owner: owner } : {}),
    state: isPaused(rule) ? 'paused' : !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
    ...(Array.isArray(status?.cert_status) ? { certStatus: status.cert_status } : {}),
  };
}

// rproxy の GET /rules の失敗を、画面に出す文にする（トークンの問題は説明を足す）
function liveError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof RproxyError && err.status === 403) message = `${FORBIDDEN_MESSAGE}（詳細: ${message}）`;
  if (err instanceof RproxyError && err.status === 401) message = `${RPROXY_UNAUTHORIZED_MESSAGE}（詳細: ${message}）`;
  return message;
}

// 1 ノードの GET /rules。live が null なら問い合わせできなかった
interface NodeLive {
  node: RproxyNode;
  live: Map<string, RproxyRuleStatus> | null;
  statuses: RproxyRuleStatus[];
  error: string | null;
}

async function fetchNodeLive(node: RproxyNode | null, logger: AppLogger): Promise<Omit<NodeLive, 'node'>> {
  try {
    const statuses = node ? await withNode(node, () => listRules()) : await listRules();
    return { live: new Map(statuses.map((r) => [ruleKeyString(r.protocol, r.listen_addr, r.listen_port), r])), statuses: statuses, error: null };
  } catch (err) {
    logger.warn(`rproxy${node ? `（${node.name}）` : ''} からルールの状態を取得できません: ${err}`);
    return { live: null, statuses: [], error: liveError(err) };
  }
}

// ルールの 1 ノードでの稼働情報（withLiveState と同じ決め方）
function nodeLiveState(node: string, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined): NodeLiveState {
  return {
    node: node,
    state: isPaused(rule) ? 'paused' : !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
    ...(Array.isArray(status?.cert_status) ? { certStatus: status.cert_status } : {}),
    // UI の定義との違い（rproxy にあるときだけ。停止中なのに動いていれば enabled）
    ...(status ? { drift: ruleDrift(rule, status) } : {}),
  };
}

// active_standby のグループがあれば、各ノードの GET /interfaces のアドレス（問い合わせできなければ null）
async function fetchHeld(cfg: NodesConfig, nodes: RproxyNode[], logger: AppLogger): Promise<Map<string, Set<string> | null>> {
  const held = new Map<string, Set<string> | null>();
  if (!cfg.groups.some((g) => g.mode === 'active_standby')) return held;
  await Promise.all(nodes.map(async (node) => {
    try {
      held.set(node.name, interfaceAddrs(await withNode(node, () => getInterfaces())));
    } catch (err) {
      logger.warn(`rproxy（${node.name}）のインターフェースを取得できません（act の判定をしません）: ${err}`);
      held.set(node.name, null);
    }
  }));
  return held;
}

// active_standby のグループのルールなら、VIP を持つノードを act にする（states の role を付け、ルールの ha を返す）
function applyHa(cfg: NodesConfig, target: string | undefined, rule: ForwardRule, states: NodeLiveState[], held: Map<string, Set<string> | null>): HaStatus | undefined {
  const group = target !== undefined ? groupOf(cfg, target) : undefined;
  if (!group || group.mode !== 'active_standby') return undefined;
  const ha = haStatus(vipAddrs(group.vips, rule), group.nodes, held);
  if (!ha) return undefined;
  for (const st of states) {
    const role = ha.roles.get(st.node);
    if (role) st.role = role;
  }
  return ha.status;
}

// ノードを設定したときの 1 行：ノードごとの稼働情報と、その集計（aggregateNodeStates）
function withNodeStates(id: number, rule: ForwardRule, nodes: NodeLiveState[], owner?: string, ha?: HaStatus): ForwardRules {
  const agg = aggregateNodeStates(nodes);
  return {
    id: id,
    origin: 'dynamic',
    ...rule,
    ...(owner !== undefined ? { owner: owner } : {}),
    state: isPaused(rule) ? 'paused' : agg.state,
    error: nodes.length === 0 ? `ノード／グループ ${rule.target ?? ''} は設定にありません。` : agg.error,
    connections: agg.connections,
    stats: agg.stats,
    startedAt: agg.startedAt,
    resolved: agg.resolved,
    ...(agg.certStatus ? { certStatus: agg.certStatus } : {}),
    nodes: nodes,
    ...(ha ? { ha: ha } : {}),
  };
}

// withStatic: rproxy の固定ルール（DB にない）も読み取り専用の行として足す（dashboard）。
// list は自分のルールだけ。admin はすべての利用者のルール（owner 付き）
async function listForwardingRules(actor: Actor, logger: AppLogger, withStatic: boolean): Promise<DashboardData> {
  if (actor.cfg.configured) return listOnNodes(actor, logger, withStatic);
  const admin = actor.access === 'admin';
  const rows = await pool.query(
    `SELECT id, auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${admin ? '' : ' WHERE auth_id = ?'} ORDER BY id`,
    admin ? [] : [actor.id]
  );

  const { live, statuses, error: rproxyError } = await fetchNodeLive(null, logger);

  const rules = rows.map((row: any): ForwardRules => {
    const rule = fromRow(row);
    const status = live?.get(ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort));
    return withLiveState(Number(row.id), rule, live !== null, status, admin ? String(row.auth_id) : undefined);
  });
  return {
    reachable: live !== null,
    rproxyError: rproxyError,
    rules: withStatic ? mergeStaticRules(rules, statuses) : rules,
    ...(admin ? { admin: true } : {}),
  };
}

// ノードを設定したとき：全ノードに GET /rules を聞き、ルールごとに置き場所のノードの状態を付ける。
// reachable はどれか 1 台に聞けたか、rproxyError は聞けなかったノード（「ノード名: 理由」）
async function listOnNodes(actor: Actor, logger: AppLogger, withStatic: boolean): Promise<DashboardData> {
  const cfg = actor.cfg;
  const admin = actor.access === 'admin';
  const rows = await pool.query(
    `SELECT id, auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${admin ? '' : ' WHERE auth_id = ?'} ORDER BY id`,
    admin ? [] : [actor.id]
  );
  const nodes = cfg.nodes.map(toRproxyNode);
  const [lives, held] = await Promise.all([
    Promise.all(nodes.map(async (node): Promise<NodeLive> => ({ node: node, ...(await fetchNodeLive(node, logger)) }))),
    fetchHeld(cfg, nodes, logger),
  ]);
  const byName = new Map(lives.map((l) => [l.node.name, l]));

  const summaries = new Map<string, NodeSummary>(lives.map((l) => [l.node.name, { name: l.node.name, reachable: l.live !== null, error: l.error, rules: 0, failed: 0, drifted: 0 }]));
  // ノードごとに、DB のルールが使っているキー（固定ルールと重なるものは DB のルールを出す）
  const usedKeys = new Map<string, Set<string>>(nodes.map((n) => [n.name, new Set<string>()]));

  const rules = rows.map((row: any): ForwardRules => {
    const rule = fromRow(row);
    const key = ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort);
    const members = targetNodes(cfg, String(row.target)) ?? [];
    const states = members.map((m) => {
      const l = byName.get(m.name)!;
      const st = nodeLiveState(m.name, rule, l.live !== null, l.live?.get(key));
      const sum = summaries.get(m.name)!;
      sum.rules += 1;
      if (st.state === 'failed' || st.state === 'missing') sum.failed += 1;
      if ((st.drift ?? []).length > 0) sum.drifted += 1;
      usedKeys.get(m.name)!.add(key);
      return st;
    });
    const ha = applyHa(cfg, String(row.target), rule, states, held);
    return withNodeStates(Number(row.id), rule, states, admin ? String(row.auth_id) : undefined, ha);
  });

  let out = rules;
  if (withStatic) {
    let next = -1;
    const statics: ForwardRules[] = [];
    for (const l of lives) {
      for (const s of l.statuses) {
        const key = ruleKeyString(s.protocol, s.listen_addr, s.listen_port);
        if (s.origin !== 'static' || usedKeys.get(l.node.name)!.has(key)) continue;
        const r = ruleFromStatus(s, next--);
        statics.push({ ...r, target: l.node.name, nodes: [{ node: l.node.name, state: r.state, error: r.error, connections: r.connections, stats: r.stats, startedAt: r.startedAt, resolved: r.resolved }] });
      }
    }
    out = [...rules, ...statics];
  }
  const down = lives.filter((l) => l.live === null);
  // vip を設定した active_standby のグループの act
  const groups: GroupHa[] = cfg.groups
    .filter((g) => g.mode === 'active_standby' && g.vips.length > 0)
    .map((g) => ({ name: g.name, nodes: [...g.nodes], ...haStatus(g.vips, g.nodes, held)!.status }));
  return {
    reachable: down.length < lives.length,
    rproxyError: down.length === 0 ? null : down.map((l) => `ノード ${l.node.name}: ${l.error}`).join(' / '),
    rules: out,
    ...(admin ? { admin: true } : {}),
    nodes: [...summaries.values()],
    ...(groups.length > 0 ? { groups: groups } : {}),
  };
}

function queryString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// GET /api/forward/rule?protocol=&addr=&port= の 1 件。自分のルール（admin ならだれのルールでも）か、
// rproxy の固定ルール（だれのものでもない）でなければ 404
async function getForwardingRule(actor: Actor, query: NextApiRequest['query'], logger: AppLogger): Promise<ForwardRules> {
  const protocol = queryString(query.protocol).toLowerCase();
  if (protocol !== 'tcp' && protocol !== 'udp') throw invalid('プロトコルは tcp か udp を指定してください。');
  const addr = queryString(query.addr);
  if (isIP(addr) === 0) throw invalid('addr には IP アドレスを指定してください。');
  const portText = queryString(query.port);
  const port = /^[0-9]+$/.test(portText) ? Number(portText) : NaN;
  if (!isPort(port)) throw invalid('ポート番号は1から65535の範囲で指定してください。');
  const key: RproxyRuleKey = { protocol: protocol as Protocol, listen_addr: normalizeAddr(addr), listen_port: port };
  if (actor.cfg.configured) return getOnNodes(actor, key, query.target, logger);

  const owner = ownerClause(actor);
  const rows = await pool.query(
    `SELECT id, auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ?`,
    [...owner.params, key.protocol, key.listen_addr, key.listen_port]
  );
  if (rows.length === 0) {
    // 固定ルールは DB にない。rproxy の応答だけから作る（ほかの利用者の dynamic なルールは見せない）。
    // rproxy に問い合わせできなければ、その失敗を返す（404 だと固定ルールが消えたように見える）
    let status: RproxyRuleStatus;
    try {
      status = await getRule(key);
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
      throw err;
    }
    if (status.origin !== 'static') throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
    return ruleFromStatus(status, -1);
  }
  const rule = fromRow(rows[0]);

  let live = true;
  let status: RproxyRuleStatus | undefined;
  try {
    status = await getRule(key);
  } catch (err) {
    if (!isNotFound(err)) {
      logger.warn(`rproxy からルールの状態を取得できません: ${err}`);
      live = false;
    }
  }
  return withLiveState(Number(rows[0].id), rule, live, status, actor.access === 'admin' ? String(rows[0].auth_id) : undefined);
}

// ノードを設定したときの 1 件：置き場所のノードごとに GET /rules/{key} を聞く。
// DB になければ、その置き場所（target がなければ既定）のノードの固定ルール
async function getOnNodes(actor: Actor, key: RproxyRuleKey, target: string | string[] | undefined, logger: AppLogger): Promise<ForwardRules> {
  const ruleKey = { protocol: key.protocol, srcAddr: key.listen_addr, srcPort: key.listen_port };
  const place = await placeForKey(actor, ruleKey, queryString(target) || undefined);
  const owner = ownerClause(actor);
  const where = keyWhere(place, ruleKey);
  const rows = await pool.query(
    `SELECT id, auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}${where.sql}`,
    [...owner.params, ...where.params]
  );
  if (rows.length === 0) {
    // 固定ルールはノードごと（DB にない）。最初に見つかったノードのもの
    let unreachable: unknown = null;
    for (const node of place.nodes) {
      try {
        const status = await withNode(node, () => getRule(key));
        if (status.origin !== 'static') continue;
        const r = ruleFromStatus(status, -1);
        return { ...r, target: node.name, nodes: [{ node: node.name, state: r.state, error: r.error, connections: r.connections, stats: r.stats, startedAt: r.startedAt, resolved: r.resolved }] };
      } catch (err) {
        if (!isNotFound(err)) unreachable = err;
      }
    }
    if (unreachable !== null) throw unreachable;
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  const rule = fromRow(rows[0]);
  const held = place.target !== null && groupOf(actor.cfg, place.target)?.mode === 'active_standby'
    ? await fetchHeld(actor.cfg, place.nodes, logger) : new Map<string, Set<string> | null>();
  const states = await Promise.all(place.nodes.map(async (node) => {
    try {
      return nodeLiveState(node.name, rule, true, await withNode(node, () => getRule(key)));
    } catch (err) {
      if (isNotFound(err)) return nodeLiveState(node.name, rule, true, undefined);
      logger.warn(`rproxy（${node.name}）からルールの状態を取得できません: ${err}`);
      return nodeLiveState(node.name, rule, false, undefined);
    }
  }));
  const ha = applyHa(actor.cfg, place.target ?? undefined, rule, states, held);
  return withNodeStates(Number(rows[0].id), rule, states, actor.access === 'admin' ? String(rows[0].auth_id) : undefined, ha);
}

// ほかのノード／グループに同じキーのルールがあり、ノードが重なるなら 409（そのノードで待ち受けがぶつかる）
async function checkOverlap(actor: Actor, place: Place, rule: ForwardRule): Promise<void> {
  if (place.target === null) return;
  const rows = await pool.query(
    'SELECT target FROM forward_rules WHERE protocol = ? AND src_addr = ? AND src_port = ? AND target <> ?',
    [rule.protocol, rule.srcAddr, rule.srcPort, place.target]
  );
  const clash = rows.find((r: any) => targetsOverlap(actor.cfg, place.target!, String(r.target)));
  if (clash) {
    throw new HttpError(409, `同じキーのルールが ${String(clash.target)} にあり、${place.target} とノードが重なります。`, 'target_conflict');
  }
}

// owner：ルールの所有者（既定は操作した利用者。admin が巻き戻し・置き換えで作り直すときは元の所有者）
async function addForwardingRule(actor: Actor, place: Place, rule: ForwardRule, logger: AppLogger, owner: string = actor.id): Promise<NodeResult[]> {
  checkPorts(actor, rule);
  await checkOverlap(actor, place, rule);
  const authId = actor.id;
  return withTransaction(logger, async (conn) => {
    if (place.target !== null) {
      await conn.query(
        'INSERT INTO forward_rules (auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [owner, place.target, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
      );
    } else {
      await conn.query(
        'INSERT INTO forward_rules (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [owner, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
      );
    }
    await insertLog(conn, authId, place, rule, 'ADD');
    // 停止中のまま作る（インポートの停止中のルール）なら DB だけ
    if (isPaused(rule)) return DB_ONLY;
    return onNodes(place, logger, async () => {
      await addRule(toRproxyRule(rule));
      return () => deleteRule(toKey(rule));
    });
  });
}

// body に srcPortEnd があるか（範囲を変えようとしていないか確かめるため）
function hasRangeEnd(body: any): boolean {
  return typeof body === 'object' && body !== null && body.srcPortEnd !== undefined;
}

// body に allowFrom があるか（なければ変更の前の値を保つ）
function hasAllowFrom(body: any): boolean {
  return typeof body === 'object' && body !== null && body.allowFrom !== undefined;
}

// given：body にその項目があったか（なければ DB の値を保つ）
interface Given {
  range: boolean;
  allowFrom: boolean;
  http: boolean;
  crowdsec: boolean;
  targets: boolean;
  extraListenAddrs: boolean;
}

async function editForwardingRule(actor: Actor, place: Place, rule: ForwardRule, given: Given, logger: AppLogger): Promise<NodeResult[]> {
  const { range: rangeGiven, allowFrom: allowFromGiven, http: httpGiven, crowdsec: crowdsecGiven } = given;
  const owner = ownerClause(actor);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, rule, logger);
    checkPorts(actor, current);
    // ポート範囲は変更できない（API の制約）。指定があれば DB の値と同じでなければならない
    if (rangeGiven && rule.srcPortEnd !== current.srcPortEnd) {
      throw new HttpError(400, 'ポート範囲は変更できません。削除してから作り直してください。', 'unsupported');
    }
    // http の指定がなければ DB の L7 の設定を保つ。L4 と L7 の切り替えは rproxy が PATCH で受け付けないので作り直す
    const http = httpGiven ? rule.http : current.http;
    if ((current.http === null) !== (http === null)) {
      throw new HttpError(400, current.http === null
        ? 'L4 のルールを L7（HTTP）に変えることはできません。削除してから作り直してください。'
        : 'L7（HTTP）のルールを L4 に戻すことはできません。削除してから作り直してください。', 'unsupported');
    }
    // 宛先（複数）の指定がなければ DB の値を保つ
    const balancing = given.targets
      ? { targets: rule.targets, balance: rule.balance, healthCheck: rule.healthCheck }
      : { targets: current.targets, balance: current.balance, healthCheck: current.healthCheck };
    // L7 でもなく宛先が複数でもないルールには転送先が必須
    if (http === null && balancing.targets.length === 0 && rule.distAddr === '') {
      throw invalid('Destination Address には IP アドレスかホスト名を指定してください。');
    }
    // source_ip は変更できないので DB の値を使う。allow_from は指定があるときだけ置き換える
    const updated: ForwardRule = {
      ...rule,
      ...(current.target !== undefined ? { target: current.target } : {}),
      sourceIp: current.sourceIp,
      srcPortEnd: current.srcPortEnd,
      allowFrom: allowFromGiven ? rule.allowFrom : current.allowFrom,
      crowdsec: crowdsecGiven ? rule.crowdsec : current.crowdsec,
      http: http,
      ...balancing,
      ...(http !== null || balancing.targets.length > 0 ? { distAddr: '', distPort: 0 } : {}),
      extraListenAddrs: given.extraListenAddrs ? extraAddrs(rule) : extraAddrs(current),
      // 停止・再開は pause / resume だけで変える（変更では今の状態を保つ）
      enabled: current.enabled !== false,
    };
    try {
      // 範囲が DB の値になったので、転送先ポートと routes の範囲をもう一度確かめる
      const count = portCount(updated.srcPort, updated.srcPortEnd, updated.distPort);
      checkTls(updated.protocol, updated.tls, updated.starttls, count, updated.http !== null);
      checkBalancing(updated.protocol, updated, count);
    } catch (err) {
      throw fromTlsError(err);
    }
    const where = keyWhere(place, updated);
    await conn.query(
      `UPDATE forward_rules SET dist_addr = ?, dist_port = ?, udp_idle_secs = ?, options = ? WHERE ${owner.sql}${where.sql}`,
      [updated.distAddr, updated.distPort, updated.udpIdleSecs, options(updated), ...owner.params, ...where.params]
    );
    // 履歴の auth_id は操作した利用者（admin がほかの人のルールを変えたときは admin）
    await insertLog(conn, actor.id, place, updated, 'UPDATE');
    // 停止中のルールは DB だけを変える（再開のときにこの内容で作る）
    if (isPaused(current)) return DB_ONLY;
    return onNodes(place, logger, async () => {
      try {
        await modifyRule(toKey(updated), toRproxyPatch(updated, current.crowdsec, current.targets.length > 0, extraAddrs(current).length > 0));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        // rproxy にないルール（missing）は作り直す
        logger.warn('rproxy にルールがないため、変更後の内容で作り直します');
        await addRule(toRproxyRule(updated));
        return () => deleteRule(toKey(updated));
      }
      // 元の転送先・TLS の設定・allow_from に戻す
      return () => modifyRule(toKey(current), toRproxyPatch(current, updated.crowdsec, updated.targets.length > 0, extraAddrs(updated).length > 0));
    });
  });
}

async function deleteForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const where = keyWhere(place, key);
    await conn.query(
      `DELETE FROM forward_rules WHERE ${owner.sql}${where.sql}`,
      [...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, current, 'DELETE');
    // 停止中のルールは rproxy にないので DB だけ
    if (isPaused(current)) return DB_ONLY;
    return onNodes(place, logger, async () => {
      try {
        await deleteRule(toKey(key));
      } catch (err) {
        // rproxy 側に既にないなら削除済みとして扱う
        if (isNotFound(err)) return async () => undefined;
        // 同じキーの固定ルールが動いている（DB の行が固定ルールに隠れている）：DB の行だけを消す
        if (err instanceof RproxyError && err.code === 'static') {
          logger.warn('同じキーの固定ルールがあるため、DB のルールだけを削除します');
          return async () => undefined;
        }
        throw err;
      }
      return () => addRule(toRproxyRule(current));
    });
  });
}

// ---- 一時停止と再開 ----

// 一時停止：DB に残したまま options に enabled: false を付け、rproxy から削除する（rproxy は起動時にもその行を作らない）
async function pauseForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    checkPorts(actor, current);
    if (isPaused(current)) throw new HttpError(409, 'このルールは既に停止中です。', 'already_paused');
    const paused: ForwardRule = { ...current, enabled: false };
    const where = keyWhere(place, key);
    await conn.query(
      `UPDATE forward_rules SET options = ? WHERE ${owner.sql}${where.sql}`,
      [options(paused), ...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, paused, 'UPDATE');
    return onNodes(place, logger, async () => {
      try {
        await deleteRule(toKey(current));
      } catch (err) {
        // rproxy に既にない（missing）なら止まっているのと同じ
        if (isNotFound(err)) return async () => undefined;
        throw err;
      }
      return () => addRule(toRproxyRule(current));
    });
  });
}

// 再開：enabled の印を外し、DB の内容で rproxy に作る
async function resumeForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    checkPorts(actor, current);
    if (!isPaused(current)) throw new HttpError(409, 'このルールは停止中ではありません。', 'not_paused');
    const resumed: ForwardRule = { ...current, enabled: true };
    const where = keyWhere(place, key);
    await conn.query(
      `UPDATE forward_rules SET options = ? WHERE ${owner.sql}${where.sql}`,
      [options(resumed), ...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, resumed, 'UPDATE');
    return onNodes(place, logger, async () => {
      await addRule(toRproxyRule(resumed));
      return () => deleteRule(toKey(resumed));
    });
  });
}

// ---- 置き換え（インポートの「置き換える」と巻き戻しで使う） ----

// PATCH では変えられない違い（rproxy と同じ制約）があれば、削除して作り直す
function needsRecreate(current: ForwardRule, next: ForwardRule): boolean {
  return current.sourceIp !== next.sourceIp
    || current.srcPortEnd !== next.srcPortEnd
    || (current.http === null) !== (next.http === null);
}

const ALL_GIVEN: Given = { range: true, allowFrom: true, http: true, crowdsec: true, targets: true, extraListenAddrs: true };

// 同じキーのルール（自分の。admin ならだれのでも）を rule の内容で丸ごと置き換える。所有者は変えない
async function replaceForwardingRule(actor: Actor, place: Place, rule: ForwardRule, logger: AppLogger): Promise<'modified' | 'recreated'> {
  const owner = ownerClause(actor);
  const where = keyWhere(place, rule);
  const rows = await pool.query(
    `SELECT auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}${where.sql}`,
    [...owner.params, ...where.params]
  );
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  const current = fromRow(rows[0]);
  const ownerId = String(rows[0].auth_id);
  if (!needsRecreate(current, rule)) {
    await editForwardingRule(actor, place, rule, ALL_GIVEN, logger);
    return 'modified';
  }
  // 置き換え（インポート・巻き戻し）でも停止・再開の状態は今のまま
  rule = { ...rule, enabled: current.enabled !== false };
  await deleteForwardingRule(actor, place, rule, logger);
  try {
    await addForwardingRule(actor, place, rule, logger, ownerId);
  } catch (err) {
    // 作れなかったら元のルールを戻す
    await addForwardingRule(actor, place, current, logger, ownerId)
      .catch((e) => logger.error(`置き換えに失敗し、元のルールも戻せませんでした（DB と rproxy から消えています）: ${e}`));
    throw err;
  }
  return 'recreated';
}

function errorText(err: unknown): string {
  if (err instanceof HttpError || err instanceof RproxyError || err instanceof TlsError || err instanceof FanoutError) return err.message;
  if (isDuplicateEntry(err)) return '同じプロトコル・アドレス・ポートのルールが既に存在します。';
  return err instanceof Error ? err.message : String(err);
}

// ---- エクスポート / インポート（#60） ----

// GET /api/forward/export[?owner=]。JSON（format: rproxy-ui-export）。利用者は自分のルール、admin はすべて（owner で絞れる）
// ノードを設定していれば ?target= でそのノード／グループのルールだけにできる
async function exportRules(actor: Actor, query: NextApiRequest['query']): Promise<{ body: string; count: number }> {
  const ownerFilter = actor.access === 'admin' ? queryString(query.owner) : actor.id;
  const target = requestedTarget(actor.cfg, queryString(query.target));
  const where: string[] = [];
  const params: string[] = [];
  if (ownerFilter) {
    where.push('auth_id = ?');
    params.push(ownerFilter);
  }
  if (target !== undefined) {
    where.push('target = ?');
    params.push(target);
  }
  const rows = await pool.query(
    `SELECT protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY protocol, src_addr, src_port`,
    params
  );
  const rules: ForwardRule[] = rows.map(fromRow);
  return { body: formatDoc(exportDoc(rules, new Date().toISOString())), count: rules.length };
}

type ImportStatus = 'new' | 'exists' | 'error';

interface ImportItem {
  index: number;
  // protocol|listen_addr|listen_port（読めなければ null）
  key: string | null;
  status: ImportStatus;
  message?: string;
  rule?: ForwardRule;
}

const MAX_IMPORT_RULES = 1000;

// 読み込むルールを 1 件ずつ検証し、DB の今のルールと突き合わせる（まだ何も変えない）
async function inspectImport(actor: Actor, place: Place, text: unknown, logger: AppLogger): Promise<{ items: ImportItem[]; ignoredGlobal: boolean }> {
  if (typeof text !== 'string' || text.trim() === '') throw invalid('読み込む内容（YAML / JSON）がありません。');
  let doc;
  try {
    doc = parseDoc(text);
  } catch (err) {
    throw fromTlsError(err);
  }
  if (doc.rules.length > MAX_IMPORT_RULES) throw invalid(`一度に読み込めるルールは ${MAX_IMPORT_RULES} 件までです。`);

  // ノードを設定していれば、置き場所（target）が同じルールだけと突き合わせる
  const rows = place.target === null
    ? await pool.query('SELECT auth_id, protocol, src_addr, src_port FROM forward_rules')
    : await pool.query('SELECT auth_id, protocol, src_addr, src_port FROM forward_rules WHERE target = ?', [place.target]);
  const owners = new Map<string, string>(rows.map((r: any): [string, string] => [ruleKeyString(r.protocol, r.src_addr, Number(r.src_port)), String(r.auth_id)]));
  let statics: Set<string> | null = null;
  try {
    const lists = place.target === null
      ? [await listRules()]
      : await Promise.all(place.nodes.map((n) => withNode(n, () => listRules())));
    statics = new Set(lists.flat().filter((r) => r.origin === 'static').map((r) => ruleKeyString(r.protocol, r.listen_addr, r.listen_port)));
  } catch (err) {
    logger.warn(`rproxy に固定ルールを問い合わせできません（固定ルールとの重なりは実行のときに rproxy が確かめます）: ${err}`);
  }

  const seen = new Set<string>();
  const items = doc.rules.map((value, index): ImportItem => {
    let rule: ForwardRule;
    try {
      rule = parseRule(settingsRuleToBody(value), false);
      checkPorts(actor, rule);
    } catch (err) {
      const v = value as Record<string, unknown> | null;
      const key = v && typeof v === 'object' && typeof v.protocol === 'string' && typeof v.listen_addr === 'string' && typeof v.listen_port === 'number'
        ? ruleKeyString(v.protocol, v.listen_addr, v.listen_port) : null;
      return { index: index, key: key, status: 'error', message: errorText(fromTlsError(err)) };
    }
    const key = ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort);
    if (seen.has(key)) return { index: index, key: key, status: 'error', message: '同じキー（プロトコル・アドレス・ポート）のルールが、読み込む内容の中に 2 つあります。' };
    seen.add(key);
    if (statics?.has(key)) return { index: index, key: key, status: 'error', message: '同じキーの rproxy の固定ルールがあります（固定ルールは rproxy の設定ファイルで管理します）。' };
    const owner = owners.get(key);
    if (owner === undefined) return { index: index, key: key, status: 'new', rule: rule };
    if (actor.access !== 'admin' && owner !== actor.id) {
      return { index: index, key: key, status: 'error', message: '同じキーのルールをほかの利用者が使っています。' };
    }
    return { index: index, key: key, status: 'exists', rule: rule };
  });
  return { items: items, ignoredGlobal: doc.ignoredGlobal };
}

type ImportResult = 'added' | 'replaced' | 'skipped' | 'error';

// POST /api/forward/import {text, dryRun?, replace?: [key, ...]}。
// dryRun なら検証の結果だけを返す。実行では 1 件ずつ別のトランザクションで追加・置き換えし、途中で失敗しても成功した分は残す
// ノードを設定していれば body.target（なければ default_target）のノード／グループに読み込む
async function importRules(actor: Actor, body: any, logger: AppLogger) {
  const place = placeForAdd(actor.cfg, body?.target);
  const { items, ignoredGlobal } = await inspectImport(actor, place, body?.text, logger);
  const strip = (i: ImportItem) => ({ index: i.index, key: i.key, status: i.status, ...(i.message ? { message: i.message } : {}) });
  if (body?.dryRun === true) return { ignoredGlobal: ignoredGlobal, items: items.map(strip) };

  const replace = new Set<string>(Array.isArray(body?.replace) ? body.replace.filter((k: unknown): k is string => typeof k === 'string') : []);
  const results: { index: number; key: string | null; result: ImportResult; message?: string }[] = [];
  for (const item of items) {
    if (item.status === 'error' || !item.rule) {
      results.push({ index: item.index, key: item.key, result: 'error', ...(item.message ? { message: item.message } : {}) });
      continue;
    }
    if (item.status === 'exists' && !replace.has(item.key ?? '')) {
      results.push({ index: item.index, key: item.key, result: 'skipped' });
      continue;
    }
    try {
      if (item.status === 'new') {
        await addForwardingRule(actor, place, item.rule, logger);
        results.push({ index: item.index, key: item.key, result: 'added' });
      } else {
        await replaceForwardingRule(actor, place, item.rule, logger);
        results.push({ index: item.index, key: item.key, result: 'replaced' });
      }
    } catch (err) {
      logger.warn(`インポートの ${item.index + 1} 件目（${item.key}）に失敗しました: ${errorText(err)}`);
      results.push({ index: item.index, key: item.key, result: 'error', message: errorText(err) });
    }
  }
  const count = (r: ImportResult) => results.filter((x) => x.result === r).length;
  logger.info(`インポート: 追加 ${count('added')} 件、置き換え ${count('replaced')} 件、スキップ ${count('skipped')} 件、失敗 ${count('error')} 件`);
  return { ignoredGlobal: ignoredGlobal, results: results };
}

// ---- 履歴と巻き戻し（#61） ----

const LOG_COLUMNS = ['id', 'auth_id', 'protocol', 'src_addr', 'src_port', 'src_port_end', 'dist_addr', 'dist_port', 'source_ip', 'udp_idle_secs', 'options', 'update_action', 'updated_at'];
const LOG_SELECT = LOG_COLUMNS.map((c) => `l.${c}`).join(', ');
// ノードを設定したときは target 列も読む
const logSelect = (cfg: NodesConfig) => (cfg.configured ? `${LOG_SELECT}, l.target, l.node` : LOG_SELECT);

// 古い行・壊れた options でも一覧は出す（内容は null）
function logRule(row: any): ForwardRule | null {
  try {
    return fromRow(row);
  } catch {
    return null;
  }
}

function toIso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

// 利用者が見られる履歴：自分が操作した行と、今自分が持っているルールの行（admin はすべて）
function historyScope(actor: Actor): { sql: string; params: string[] } {
  if (actor.access === 'admin') return { sql: '', params: [] };
  const sameTarget = actor.cfg.configured ? ' AND r.target = l.target' : '';
  return {
    sql: `(l.auth_id = ? OR EXISTS (SELECT 1 FROM forward_rules r WHERE r.auth_id = ? AND r.protocol = l.protocol AND r.src_addr = l.src_addr AND r.src_port = l.src_port${sameTarget}))`,
    params: [actor.id, actor.id],
  };
}

// GET /api/forward/history?protocol=&addr=&port=&user=&action=&from=&to=&page=&per_page=
async function listHistory(actor: Actor, query: NextApiRequest['query']): Promise<HistoryPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const scope = historyScope(actor);
  if (scope.sql) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  const protocol = queryString(query.protocol).toLowerCase();
  if (protocol) {
    if (protocol !== 'tcp' && protocol !== 'udp') throw invalid('プロトコルは tcp か udp を指定してください。');
    where.push('l.protocol = ?');
    params.push(protocol);
  }
  const addr = queryString(query.addr);
  if (addr) {
    if (isIP(addr) === 0) throw invalid('addr には IP アドレスを指定してください。');
    where.push('l.src_addr = ?');
    params.push(normalizeAddr(addr));
  }
  const portText = queryString(query.port);
  if (portText) {
    const port = /^[0-9]+$/.test(portText) ? Number(portText) : NaN;
    if (!isPort(port)) throw invalid('ポート番号は1から65535の範囲で指定してください。');
    where.push('l.src_port = ?');
    params.push(port);
  }
  const target = requestedTarget(actor.cfg, queryString(query.target));
  if (target !== undefined) {
    where.push('l.target = ?');
    params.push(target);
  }
  const user = queryString(query.user);
  if (user && actor.access === 'admin') {
    where.push('l.auth_id = ?');
    params.push(user);
  }
  const action = queryString(query.action).toUpperCase();
  if (action) {
    if (!HISTORY_ACTIONS.includes(action as HistoryAction)) throw invalid('action は ADD / UPDATE / DELETE / RESEND のどれかです。');
    where.push('l.update_action = ?');
    params.push(action);
  }
  const from = queryString(query.from);
  if (from) {
    if (!isDate(from)) throw invalid('from は YYYY-MM-DD で指定してください。');
    where.push('l.updated_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  const to = queryString(query.to);
  if (to) {
    if (!isDate(to)) throw invalid('to は YYYY-MM-DD で指定してください。');
    where.push('l.updated_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(`${to} 00:00:00`);
  }
  const page = Math.max(1, Number.parseInt(queryString(query.page) || '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(queryString(query.per_page) || '50', 10) || 50));
  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

  const countRows = await pool.query(`SELECT COUNT(*) AS n FROM forward_rules_log l${whereSql}`, params);
  const total = Number(countRows[0]?.n ?? 0);
  const rows = await pool.query(
    `SELECT ${logSelect(actor.cfg)} FROM forward_rules_log l${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage]
  );

  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    const rule = logRule(row);
    const act = String(row.update_action) as HistoryAction;
    let changes: string[] = [];
    if (act === 'UPDATE' && rule !== null) {
      // 同じルールの 1 つ前の版（差分を作るためだけに読む）
      const prev = actor.cfg.configured
        ? await pool.query(
          `SELECT ${logSelect(actor.cfg)} FROM forward_rules_log l WHERE l.target = ? AND l.protocol = ? AND l.src_addr = ? AND l.src_port = ? AND l.id < ? ORDER BY l.id DESC LIMIT 1`,
          [row.target, row.protocol, row.src_addr, row.src_port, row.id]
        )
        : await pool.query(
          `SELECT ${LOG_SELECT} FROM forward_rules_log l WHERE l.protocol = ? AND l.src_addr = ? AND l.src_port = ? AND l.id < ? ORDER BY l.id DESC LIMIT 1`,
          [row.protocol, row.src_addr, row.src_port, row.id]
        );
      changes = prev.length > 0 ? ruleChanges(logRule(prev[0]), rule) : [];
    }
    entries.push({
      id: Number(row.id),
      at: toIso(row.updated_at),
      actor: row.auth_id === null || row.auth_id === undefined ? null : String(row.auth_id),
      action: act,
      protocol: String(row.protocol).toLowerCase(),
      srcAddr: String(row.src_addr),
      srcPort: Number(row.src_port),
      ...(actor.cfg.configured ? { target: String(row.target) } : {}),
      ...(row.node !== null && row.node !== undefined ? { node: String(row.node) } : {}),
      rule: rule,
      changes: changes,
      revertible: rule !== null,
    });
  }
  return { entries: entries, total: total, page: page, perPage: perPage };
}

// ---- 1 つのノードへの送り直し（#98 の「ずれ」） ----

type ResendResult = 'added' | 'modified' | 'recreated' | 'removed' | 'unchanged';

// そのノード（withNode の中）の実際のルールを DB の内容に合わせる。ずれがなければ何もしない
async function resendOne(rule: ForwardRule): Promise<ResendResult> {
  const key = toKey(rule);
  let live: RproxyRuleStatus | null = null;
  try {
    live = await getRule(key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (live?.origin === 'static') throw staticRuleError();
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
  await modifyRule(key, toRproxyPatch(rule, actual.crowdsec, actual.targets.length > 0, (actual.extraListenAddrs ?? []).length > 0));
  return 'modified';
}

// POST /api/forward/resend {protocol, srcAddr, srcPort, target?, node}：DB の内容を、置き場所のノードのうち 1 台にだけ送り直す。
// 自分のルール（admin ならだれのでも）だけ。履歴に RESEND（node 列にノード）を残す。
// 送り直しは DB の内容に揃えるだけなので、COMMIT に失敗しても rproxy は戻さない（そのノードは DB と同じ内容のまま）
async function resendToNode(actor: Actor, body: any, logger: AppLogger): Promise<{ node: string; result: ResendResult }> {
  if (!actor.cfg.configured) throw new HttpError(400, '送り直しは、ノードを設定（RPROXY_UI_NODES）したときだけ使えます。', 'unsupported');
  const key = parseRule(body, true);
  const place = await placeForKey(actor, key, body?.target);
  const node = place.nodes.find((n) => n.name === body?.node);
  if (!node) throw new HttpError(400, `ノード ${String(body?.node ?? '')} はこのルールの置き場所にありません。`, 'unknown_node');
  let result: ResendResult = 'unchanged';
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    checkPorts(actor, current);
    await insertLog(conn, actor.id, place, current, 'RESEND', node.name);
    result = await withNode(node, () => resendOne(current));
    return { undo: async () => undefined, results: [{ node: node.name, ok: true }] };
  });
  return { node: node.name, result: result };
}

// POST /api/forward/revert {id}：履歴の版の内容に戻す（あれば置き換え、削除されていれば作り直す）。巻き戻しも履歴に残る
async function revertToVersion(actor: Actor, body: any, logger: AppLogger): Promise<{ result: 'added' | 'modified' | 'recreated' }> {
  const id = body?.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw invalid('履歴の id を指定してください。');
  const scope = historyScope(actor);
  const rows = await pool.query(
    `SELECT ${logSelect(actor.cfg)} FROM forward_rules_log l WHERE ${scope.sql ? `${scope.sql} AND ` : ''}l.id = ?`,
    [...scope.params, id]
  );
  if (rows.length === 0) throw new HttpError(404, '履歴が見つかりません。', 'not_found');
  const rule = logRule(rows[0]);
  if (rule === null) throw invalid('この履歴の内容は読めないため、巻き戻せません。');
  // 履歴の行の置き場所に戻す（設定から消えたノード／グループなら 400 unknown_target）
  const place = placeOf(actor.cfg, actor.cfg.configured ? String(rows[0].target) : null);
  if (await findStaticRule(toKey(rule), place, logger)) throw staticRuleError();

  const where = keyWhere(place, rule);
  const current = await pool.query(
    `SELECT auth_id FROM forward_rules WHERE ${where.sql}`,
    where.params
  );
  if (current.length === 0) {
    await addForwardingRule(actor, place, rule, logger);
    return { result: 'added' };
  }
  if (actor.access !== 'admin' && String(current[0].auth_id) !== actor.id) {
    throw new HttpError(403, '同じキーのルールをほかの利用者が使っているため、巻き戻せません。', 'forbidden_owner');
  }
  return { result: await replaceForwardingRule(actor, place, rule, logger) };
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as any).errno === 1062 || (err as any).code === 'ER_DUP_ENTRY');
}

function sendError(res: NextApiResponse, err: unknown, logger: AppLogger) {
  if (err instanceof FanoutError) {
    // グループの一部のノードで失敗した：失敗したノードの応答でステータスを決め、ノードごとの結果を付ける
    // （成功したノードは取り消してあり、DB は ROLLBACK 済み）
    logger.error(`ノード ${err.node} で失敗したため、グループの変更を取り消しました`);
    const captured: { status: number; body: any } = { status: 500, body: {} };
    const fake = {
      status(code: number) { captured.status = code; return fake; },
      json(body: unknown) { captured.body = body; return fake; },
    } as unknown as NextApiResponse;
    sendError(fake, err.reason, logger);
    return res.status(captured.status).json({ ...captured.body, error: `ノード ${err.node}: ${captured.body.error}`, nodes: err.results });
  }
  if (err instanceof NodesConfigError) {
    logger.error(`${err.message}`);
    return res.status(500).json({ error: err.message, code: 'nodes_config' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof RproxyError) {
    logger.error(`rproxy error: ${err.code} ${err.message}`);
    if (err.status === 403) {
      // rproxy のトークンのスコープ（rules:read / rules:write）か allow_listen_ports が足りない。
      // 画面では code: forbidden から説明（FORBIDDEN_MESSAGE）を出す
      logger.error('rproxy が UI のトークンを拒否しました（403 forbidden）。RPROXY_API_TOKEN のスコープと allow_listen_ports を確認してください');
    }
    if (err.status === 401) {
      // UI サーバの RPROXY_API_TOKEN が違うか期限切れ。利用者のサインインとは関係ないので code を変える
      logger.error('rproxy が UI のトークンを受け付けませんでした（401 unauthorized）。RPROXY_API_TOKEN を確認してください');
      return res.status(502).json({ error: RPROXY_UNAUTHORIZED_MESSAGE, code: 'rproxy_unauthorized' });
    }
    // rproxy の 401/403 は UI サーバ側の設定の問題なので、利用者には 502 として返す
    const passThrough = err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403;
    return res.status(passThrough ? err.status : 502).json({ error: err.message, code: err.code });
  }
  if (isDuplicateEntry(err)) {
    return res.status(409).json({ error: '同じプロトコル・アドレス・ポートのルールが既に存在します。', code: 'already_exists' });
  }
  logger.error(`Internal error: ${err}`);
  return res.status(500).json({ error: 'Internal Server Error', code: 'internal' });
}

// forward_rule_targets（ノードごとのビューが読む「ノード → target」の表）を設定ファイルに合わせる。
// 設定は UI の起動中は変わらないので、うまくいったら同じ設定では繰り返さない
const syncedConfigs = new WeakSet<NodesConfig>();

async function syncMembership(cfg: NodesConfig, logger: AppLogger): Promise<void> {
  if (!cfg.configured || syncedConfigs.has(cfg)) return;
  const want = membership(cfg);
  const id = (r: { node: string; target: string }) => `${r.node}\u0000${r.target}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const rows = await conn.query('SELECT node, target FROM forward_rule_targets FOR UPDATE');
    const have = new Set((Array.isArray(rows) ? rows : []).map((r: any) => id({ node: String(r.node), target: String(r.target) })));
    const same = have.size === want.length && want.every((r) => have.has(id(r)));
    if (!same) {
      await conn.query('DELETE FROM forward_rule_targets');
      await conn.query(
        `INSERT INTO forward_rule_targets (node, target) VALUES ${want.map(() => '(?, ?)').join(', ')}`,
        want.flatMap((r) => [r.node, r.target])
      );
      logger.info(`forward_rule_targets を設定ファイルに合わせました（${want.length} 行）`);
    }
    // 送り直しの履歴の node 列（007）があるか
    await conn.query('SELECT node FROM forward_rules_log LIMIT 0');
    await conn.commit();
    syncedConfigs.add(cfg);
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw new HttpError(500, `forward_rule_targets を更新できません（db/migrations/006_nodes.sql と 007_log_node.sql を適用し、UI の DB ユーザーに権限を付けてください）: ${err instanceof Error ? err.message : String(err)}`, 'nodes_db');
  } finally {
    conn.release();
  }
}

// 変更の応答。ノードを設定していれば、ノードごとの結果（nodes）も返す
function done(actor: Actor, message: string, results: NodeResult[]) {
  return actor.cfg.configured ? { message: message, nodes: results } : { message: message };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session: sessionUser | null = await getServerSession(req, res, authOptions);
  const query = req.query.forward;

  const id = session?.user?.id;
  if (!session || !id) {
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
  }

  const logger = Logger('info', { auth_id: id, action: query });
  let roles: RoleConfig;
  try {
    roles = roleConfig();
  } catch (err) {
    logger.error(`${err}`);
    return res.status(500).json({ error: 'Internal Server Error', code: 'internal' });
  }
  // ロールはリクエストごとに決め直す（環境変数を変えたら次のリクエストから効く）
  const access = accessOf(session.user.roles ?? [], roles);
  if (access === 'none') {
    return res.status(403).json({ error: NO_ROLE_MESSAGE, code: 'no_role' });
  }

  try {
    const cfg = loadNodes();
    const actor: Actor = { id: id, access: access, roles: roles, cfg: cfg };
    await syncMembership(cfg, logger);

    if (req.method === 'GET' && query === 'nodes') {
      return res.status(200).json(nodesInfo(cfg));
    }
    if (req.method === 'GET' && query === 'list') {
      const data = await listForwardingRules(actor, logger, false);
      return res.status(200).json(data.rules);
    }
    if (req.method === 'GET' && query === 'dashboard') {
      const data = await listForwardingRules(actor, logger, true);
      return res.status(200).json(data);
    }
    if (req.method === 'GET' && query === 'export') {
      const out = await exportRules(actor, req.query);
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rproxy-ui-export-${date}.json"`);
      logger.info(`Exported ${out.count} rules`);
      return res.status(200).send(out.body);
    }
    if (req.method === 'GET' && query === 'history') {
      const page = await listHistory(actor, req.query);
      return res.status(200).json(page);
    }
    if (req.method === 'GET' && query === 'rule') {
      // 先に取得してから status を呼ぶ（失敗したら sendError がステータスを決める）
      const rule = await getForwardingRule(actor, req.query, logger);
      return res.status(200).json(rule);
    }

    if (req.method === 'POST') {
      if (query === 'add') {
        const rule = parseRule(req.body, false);
        const results = await addForwardingRule(actor, placeForAdd(cfg, req.body?.target), rule, logger);
        logger.info('Forwarding rule added successfully');
        return res.status(200).json(done(actor, 'Forwarding rule added successfully', results));
      } else if (query === 'modify') {
        const rule = parseRule(req.body, false, true);
        const results = await editForwardingRule(actor, await placeForKey(actor, rule, req.body?.target), rule, {
          range: hasRangeEnd(req.body),
          allowFrom: hasAllowFrom(req.body),
          http: hasHttp(req.body),
          crowdsec: hasCrowdsec(req.body),
          targets: hasTargets(req.body),
          extraListenAddrs: hasExtraListenAddrs(req.body),
        }, logger);
        logger.info('Forwarding rule modified successfully');
        return res.status(200).json(done(actor, 'Forwarding rule modified successfully', results));
      } else if (query === 'import') {
        const out = await importRules(actor, req.body, logger);
        return res.status(200).json(out);
      } else if (query === 'resend') {
        const out = await resendToNode(actor, req.body, logger);
        logger.info(`Resent to node ${out.node} (${out.result})`);
        return res.status(200).json(out);
      } else if (query === 'revert') {
        const out = await revertToVersion(actor, req.body, logger);
        logger.info(`Reverted to history ${req.body?.id} (${out.result})`);
        return res.status(200).json(out);
      } else if (query === 'pause') {
        const key = parseRule(req.body, true);
        const results = await pauseForwardingRule(actor, await placeForKey(actor, key, req.body?.target), key, logger);
        logger.info('Forwarding rule paused');
        return res.status(200).json(done(actor, 'Forwarding rule paused', results));
      } else if (query === 'resume') {
        const key = parseRule(req.body, true);
        const results = await resumeForwardingRule(actor, await placeForKey(actor, key, req.body?.target), key, logger);
        logger.info('Forwarding rule resumed');
        return res.status(200).json(done(actor, 'Forwarding rule resumed', results));
      } else if (query === 'delete') {
        const key = parseRule(req.body, true);
        const results = await deleteForwardingRule(actor, await placeForKey(actor, key, req.body?.target), key, logger);
        logger.info('Forwarding rule deleted successfully');
        return res.status(200).json(done(actor, 'Forwarding rule deleted successfully', results));
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  } catch (err) {
    return sendError(res, err, logger);
  }
}

// エラーのメッセージは Accept-Language か画面で選んだ言語（cookie）で返す（code は変えない）
export default localizedApi(handler);
