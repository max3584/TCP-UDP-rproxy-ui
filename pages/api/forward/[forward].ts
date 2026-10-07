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
  planAdd,
  planDelete,
  planModify,
  withNode,
} from '@/components/rproxy';
import { aggregateNodeStates, ruleFromStatus } from '@/components/dashboard';
import { StoredApiRule, apiRuleFromRow, apiRuleFromStatus, mergeExternalRules, shadowedBy } from '@/components/apirules';
import type { ShadowedBy } from '@/components/lib';
import { acmeStatusField } from '@/components/acme';
import { NodesConfig, NodesConfigError, groupOf, loadNodes, membership, nodesInfo, targetNodes, targetsOverlap, toRproxyNode } from '@/components/nodes';
import { needsRecreateOnNode, ruleDrift } from '@/components/drift';
import { NodeOverride, Overrides, effectiveRule, normalizeOverride, overrideFromRow, overrideRow, sameOverrides, settingsOverridesToBody } from '@/components/overrides';
import { haStatus, interfaceAddrs, vipAddrs } from '@/components/ha';
import { FanoutError, NodeResult, Undo, applyToNodes } from '@/components/fanout';
import { FORBIDDEN_MESSAGE, NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE, lockedOutText } from '@/components/messages';
import mariadb, { PoolConnection } from 'mariadb';
import { localizedApi } from '@/i18n/server';
import { rejectCrossSite } from '@/components/apiguard';
import { translate } from '@/i18n/core';
import { Access, RoleConfig, accessOf, nodesAllowed, portsAllowed, roleConfig } from '@/components/roles';
import { toHttpRules, validateHttp } from '@/components/httpspec';
import { exportDoc, extraAddrs, formatDoc, parseDoc, remoteFields, settingsRuleToBody, starttlsFields, toRproxyRule } from '@/components/settingsdoc';
import { HISTORY_ACTIONS, HistoryAction, HistoryEntry, HistoryPage, isDate, ruleChanges } from '@/components/history';
import { haOverview, haSyncStatus, syncNode } from '@/components/hasync';
import { ResendResult, fromRow, getPool, ruleOptions, isNotFound, isPaused, isShadowing, liveRule, loadOverrides, resendOne, toKey, toRproxyPatch } from '@/components/ruledb';
import { V04_KEYS, normalizeV04, v04Of } from '@/components/v04';
import type { RulePlan, V04Key, V04Settings } from '@/components/v04';

const pool = getPool();

// RESEND：1 つのノードに DB の内容を送り直した（#98。node 列にそのノード）
// OVERRIDE：ノードごとの上書きを変えた（node 列にそのノード、内容はそのノードで動かす内容）
type Action = 'ADD' | 'UPDATE' | 'DELETE' | 'RESEND' | 'OVERRIDE';
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

// user（admin 以外）が RPROXY_UI_USER_NODES の外のノードを触ろうとしたら 403（ノードを設定したときだけ）
function checkNodes(actor: Actor, place: Place | RproxyNode[]): void {
  const nodes = Array.isArray(place) ? place : place.target === null ? null : place.nodes;
  if (nodes === null) return;
  if (!nodesAllowed(actor.access, actor.roles, nodes.map((n) => n.name))) {
    throw new HttpError(403, `ノード ${nodes.map((n) => n.name).join(', ')} は管理者だけが触れます（利用者が触れるのは ${(actor.roles.userNodes ?? []).join(', ')}）。`, 'node_not_allowed');
  }
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
    // v0.4 の labels・limits・bandwidth・geoip・outlierDetection（使えるかは rproxy が features で決め、断れば 400 unsupported）
    ...normalizeV04(body, protocol as Protocol, http !== null),
  };
}

// body にある v0.4 の項目（なければ変更の前の値を保つ）
function givenV04(body: any): V04Key[] {
  if (typeof body !== 'object' || body === null) return [];
  return V04_KEYS.filter((k) => body[k === 'outlier_detection' ? 'outlierDetection' : k] !== undefined);
}

const V04_RULE_FIELD: Record<V04Key, keyof V04Settings> = {
  labels: 'labels', limits: 'limits', bandwidth: 'bandwidth', geoip: 'geoip', outlier_detection: 'outlierDetection',
};

// 変更の後の v0.4 の項目：body にあるものは body の値（null・{} なら外す）、ないものは今の値
function mergeV04(current: V04Settings, next: V04Settings, given: V04Key[]): V04Settings {
  const out: V04Settings = { ...v04Of(current) };
  for (const k of given) {
    const f = V04_RULE_FIELD[k];
    const v = next[f];
    if (v === undefined) delete out[f];
    else (out as Record<string, unknown>)[f] = v;
  }
  return out;
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
// step はノードを受け取る（ノードごとの上書きを重ねた内容を送るため）
function onNodes(place: Place, logger: AppLogger, step: (node: RproxyNode) => Promise<Undo>): Promise<Applied> {
  return applyToNodes(place.nodes, step, logger);
}

// ロックしたルールの id とノードごとの上書き（ノードを設定していなければ id は null、上書きはなし）
async function lockedExtras(conn: PoolConnection, place: Place, key: { protocol: string; srcAddr: string; srcPort: number }): Promise<{ id: number | null; overrides: Overrides }> {
  if (place.target === null) return { id: null, overrides: {} };
  const where = keyWhere(place, key);
  const rows = await conn.query(`SELECT id FROM forward_rules WHERE ${where.sql}`, where.params);
  if (!Array.isArray(rows) || rows.length === 0) return { id: null, overrides: {} };
  const id = Number(rows[0].id);
  return { id: id, overrides: (await loadOverrides(conn, [id])).get(id) ?? {} };
}

async function writeOverrides(conn: PoolConnection, id: number, overrides: Overrides): Promise<void> {
  for (const [node, ov] of Object.entries(overrides)) {
    const row = overrideRow(ov);
    await conn.query(
      'INSERT INTO forward_rule_overrides (rule_id, node, src_addr, dist_addr, dist_port, options) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE src_addr = VALUES(src_addr), dist_addr = VALUES(dist_addr), dist_port = VALUES(dist_port), options = VALUES(options)',
      [id, node, row.src_addr, row.dist_addr, row.dist_port, row.options]
    );
  }
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

function options(rule: ForwardRule): string | null {
  return ruleOptions(rule);
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

// 同じキーを rproxy では API で作ったルール・ルールの組のルールが使っている（UI のルールは動いていない）。
// UI のルールの操作をそのまま送ると、そのルールを書き換えたり消したりしてしまうので断る（管理者の API のルールを利用者が変えられないように）
function shadowedError(): HttpError {
  return new HttpError(409, '同じキーを rproxy では API で作ったルールかルールの組のルールが使っているため、この UI のルールの変更は rproxy に送れません。', 'shadowed');
}

// そのノード（withNode の中）の今のルールが API のルール・ルールの組のものなら 409 shadowed。今のルール（なければ null）を返す
async function ensureNotShadowed(key: RproxyRuleKey): Promise<RproxyRuleStatus | null> {
  const live = await liveRule(key);
  if (isShadowing(live)) throw shadowedError();
  return live;
}

// 置き場所のどのノードかで、同じキーを API のルール・ルールの組が使っていれば 409 shadowed（作り直し・移動の前に確かめる）
async function ensureNotShadowedOnNodes(place: Place, rule: ForwardRule, overrides: Overrides): Promise<void> {
  for (const node of place.nodes) {
    const eff = effectiveRule(rule, overrides[node.name]);
    if (isPaused(eff)) continue;
    await withNode(node, () => ensureNotShadowed(toKey(eff)));
  }
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

// 同じキーを API のルール・ルールの組が使っているときの印。管理者でなければ作ったトークンの名前とルールの組の名前を見せない
function shadowField(status: RproxyRuleStatus | undefined, admin: boolean): { shadowedBy?: ShadowedBy } {
  const sb = shadowedBy(status);
  if (!sb) return {};
  if (admin) return { shadowedBy: sb };
  return { shadowedBy: { origin: sb.origin, ...(sb.ruleset !== undefined ? { ruleset: '' } : {}) } };
}

// DB のルールに rproxy の稼働情報を付ける。status が undefined なら rproxy にない（missing）、
// live が false なら rproxy に問い合わせできなかった（unknown）。一時停止中なら paused。
// 同じキーを API のルール・ルールの組が使っていれば（shadowedBy）、その稼働情報は管理者にだけ見せる（利用者には missing と印だけ）
function withLiveState(id: number, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined, owner: string | undefined, admin: boolean): ForwardRules {
  if (!admin && isShadowing(status)) {
    return {
      id: id,
      origin: 'dynamic',
      ...rule,
      ...(owner !== undefined ? { owner: owner } : {}),
      state: isPaused(rule) ? 'paused' : 'missing',
      error: null,
      connections: null,
      stats: null,
      startedAt: null,
      resolved: [],
      ...shadowField(status, admin),
    };
  }
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
    ...acmeStatusField(status?.acme),
    ...(Array.isArray(status?.conditions) ? { conditions: status.conditions } : {}),
    // 同じキーを rproxy では API のルール・ルールの組が使っている（UI のルールは動いていない）
    ...shadowField(status, admin),
  };
}

// rproxy の GET /rules の失敗を、画面に出す文にする（トークンの問題は説明を足す）
function liveError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof RproxyError && err.status === 403) message = `${FORBIDDEN_MESSAGE}（詳細: ${message}）`;
  if (err instanceof RproxyError && err.status === 401) message = `${RPROXY_UNAUTHORIZED_MESSAGE}（詳細: ${message}）`;
  if (err instanceof RproxyError && err.status === 429) message = lockedOutText(err.retryAfter);
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
function nodeLiveState(node: string, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined, admin: boolean): NodeLiveState {
  if (!admin && isShadowing(status)) {
    return {
      node: node,
      state: isPaused(rule) ? 'paused' : 'missing',
      error: null,
      connections: null,
      stats: null,
      startedAt: null,
      resolved: [],
      ...shadowField(status, admin),
    };
  }
  return {
    node: node,
    state: isPaused(rule) ? 'paused' : !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
    ...(Array.isArray(status?.cert_status) ? { certStatus: status.cert_status } : {}),
    ...acmeStatusField(status?.acme),
    ...(Array.isArray(status?.conditions) ? { conditions: status.conditions } : {}),
    // 同じキーを rproxy では API のルール・ルールの組が使っている（UI のルールは動いていない）
    ...shadowField(status, admin),
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
    ...(agg.acmeStatus ? { acmeStatus: agg.acmeStatus } : {}),
    ...(agg.conditions ? { conditions: agg.conditions } : {}),
    ...(nodes.find((n) => n.shadowedBy)?.shadowedBy ? { shadowedBy: nodes.find((n) => n.shadowedBy)!.shadowedBy } : {}),
    nodes: nodes,
    ...(ha ? { ha: ha } : {}),
  };
}

// rproxy が保存した API のルール（rproxy_rules。migration 009。rproxy v0.4）。テーブルがない・読めないときは空
async function loadStoredApiRules(logger: AppLogger): Promise<StoredApiRule[]> {
  try {
    const rows = await pool.query('SELECT node, protocol, listen_addr, listen_port, spec, created_by, created_at, updated_by, updated_at FROM rproxy_rules ORDER BY node, protocol, listen_addr, listen_port');
    // 形の崩れた行は飛ばす
    return (Array.isArray(rows) ? rows : []).filter((r: any): r is StoredApiRule => typeof r?.node === 'string' && typeof r?.protocol === 'string'
      && typeof r?.listen_addr === 'string' && Number.isInteger(Number(r?.listen_port)) && r?.spec !== undefined);
  } catch (err) {
    // 1146: テーブルがない（009 を適用していない）。それ以外（権限など）はログに出す
    if ((err as { errno?: number })?.errno !== 1146) logger.warn(`rproxy_rules を読めません（db/migrations/009_rproxy_rules.sql と UI の DB ユーザーの SELECT の権限を確認してください）: ${err}`);
    return [];
  }
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
  // API のルール（rproxy v0.4。UI の DB にない）は管理者のダッシュボードだけ
  const stored = admin && withStatic ? await loadStoredApiRules(logger) : [];

  const rules = rows.map((row: any): ForwardRules => {
    const rule = fromRow(row);
    const status = live?.get(ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort));
    return withLiveState(Number(row.id), rule, live !== null, status, admin ? String(row.auth_id) : undefined, admin);
  });
  return {
    reachable: live !== null,
    rproxyError: rproxyError,
    rules: withStatic ? mergeExternalRules(rules, statuses, { api: admin, stored: stored, live: live !== null }) : rules,
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

  const allOverrides = await loadOverrides(pool, null);
  const lastSync = await lastSyncByNode(cfg);
  for (const [name, at] of lastSync) summaries.get(name)!.lastSync = at;
  const rules = rows.map((row: any): ForwardRules => {
    const ovs = allOverrides.get(Number(row.id)) ?? {};
    const rule: ForwardRule = { ...fromRow(row), ...(Object.keys(ovs).length > 0 ? { overrides: ovs } : {}) };
    const members = targetNodes(cfg, String(row.target)) ?? [];
    const states = members.map((m) => {
      const l = byName.get(m.name)!;
      // そのノードで動かす内容（上書きを重ねたもの）と、その待ち受けのキーで比べる
      const eff = effectiveRule(rule, ovs[m.name]);
      const key = ruleKeyString(eff.protocol, eff.srcAddr, eff.srcPort);
      const st = nodeLiveState(m.name, eff, l.live !== null, l.live?.get(key), admin);
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
    // 固定ルール（だれにでも）と API のルール（管理者だけ。rproxy v0.4）はノードごと（target がそのノード）
    const stored = admin ? await loadStoredApiRules(logger) : [];
    let next = -1;
    const external: ForwardRules[] = [];
    for (const l of lives) {
      const rows = mergeExternalRules([], l.statuses, {
        api: admin, stored: stored.filter((r) => r.node === l.node.name), live: l.live !== null, firstId: next, seenKeys: usedKeys.get(l.node.name)!,
      });
      next -= rows.length;
      for (const r of rows) {
        external.push({ ...r, target: l.node.name, nodes: [{ node: l.node.name, state: r.state, error: r.error, connections: r.connections, stats: r.stats, startedAt: r.startedAt, resolved: r.resolved }] });
      }
    }
    out = [...rules, ...external];
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
    // act/stb の自動の送り直しの状態（このプロセスのもの。#109）
    ...(cfg.groups.some((gr) => gr.mode === 'active_standby') ? { haSync: haSyncStatus() } : {}),
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
      if (isNotFound(err)) {
        // rproxy にない API のルールでも、rproxy_rules に保存してあれば管理者には出す（未登録）
        const stored = actor.access === 'admin' ? await storedApiRule(key, null, logger) : null;
        if (stored) return stored;
        throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
      }
      throw err;
    }
    if (status.origin === 'static') return ruleFromStatus(status, -1);
    // API のルール（UI の DB にない。rproxy v0.4）は管理者だけ
    if (actor.access === 'admin') return apiRuleFromStatus(status, -1);
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
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
  return withLiveState(Number(rows[0].id), rule, live, status, actor.access === 'admin' ? String(rows[0].auth_id) : undefined, actor.access === 'admin');
}

// rproxy_rules の 1 件（rproxy にない API のルール）。node が null なら 1 台の環境（ノードの名前を問わない）
async function storedApiRule(key: RproxyRuleKey, node: string | null, logger: AppLogger, live = true): Promise<ForwardRules | null> {
  const rows = (await loadStoredApiRules(logger)).filter((r) => (node === null || r.node === node)
    && r.protocol.toLowerCase() === key.protocol && normalizeAddr(r.listen_addr) === key.listen_addr && Number(r.listen_port) === key.listen_port);
  return rows.length > 0 ? apiRuleFromRow(rows[0], -1, live ? 'missing' : 'unknown') : null;
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
    // 固定ルール・API のルール（管理者だけ）はノードごと（DB にない）。最初に見つかったノードのもの
    let unreachable: unknown = null;
    const admin = actor.access === 'admin';
    const withNodeState = (r: ForwardRules, node: string): ForwardRules => ({ ...r, target: node, nodes: [{ node: node, state: r.state, error: r.error, connections: r.connections, stats: r.stats, startedAt: r.startedAt, resolved: r.resolved }] });
    for (const node of place.nodes) {
      try {
        const status = await withNode(node, () => getRule(key));
        if (status.origin === 'static') return withNodeState(ruleFromStatus(status, -1), node.name);
        if (admin) return withNodeState(apiRuleFromStatus(status, -1), node.name);
      } catch (err) {
        if (!isNotFound(err)) unreachable = err;
      }
    }
    if (admin) {
      for (const node of place.nodes) {
        const stored = await storedApiRule(key, node.name, logger, unreachable === null);
        if (stored) return withNodeState(stored, node.name);
      }
    }
    if (unreachable !== null) throw unreachable;
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  const ovs = (await loadOverrides(pool, [Number(rows[0].id)])).get(Number(rows[0].id)) ?? {};
  const rule: ForwardRule = { ...fromRow(rows[0]), ...(Object.keys(ovs).length > 0 ? { overrides: ovs } : {}) };
  const held = place.target !== null && groupOf(actor.cfg, place.target)?.mode === 'active_standby'
    ? await fetchHeld(actor.cfg, place.nodes, logger) : new Map<string, Set<string> | null>();
  const admin = actor.access === 'admin';
  const states = await Promise.all(place.nodes.map(async (node) => {
    const eff = effectiveRule(rule, ovs[node.name]);
    try {
      return nodeLiveState(node.name, eff, true, await withNode(node, () => getRule(toKey(eff))), admin);
    } catch (err) {
      if (isNotFound(err)) return nodeLiveState(node.name, eff, true, undefined, admin);
      logger.warn(`rproxy（${node.name}）からルールの状態を取得できません: ${err}`);
      return nodeLiveState(node.name, eff, false, undefined, admin);
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
// overrides：ノードごとの上書き（インポート・コピー・移動。置き場所のノードのものだけ）
async function addForwardingRule(actor: Actor, place: Place, rule: ForwardRule, logger: AppLogger, owner: string = actor.id, overrides: Overrides = {}): Promise<NodeResult[]> {
  checkPorts(actor, rule);
  checkNodes(actor, place);
  await checkOverlap(actor, place, rule);
  const authId = actor.id;
  return withTransaction(logger, async (conn) => {
    if (place.target !== null) {
      const inserted = await conn.query(
        'INSERT INTO forward_rules (auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [owner, place.target, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
      );
      if (Object.keys(overrides).length > 0) await writeOverrides(conn, Number(inserted?.insertId), overrides);
    } else {
      await conn.query(
        'INSERT INTO forward_rules (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [owner, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
      );
    }
    await insertLog(conn, authId, place, rule, 'ADD');
    // 停止中のまま作る（インポートの停止中のルール）なら DB だけ
    if (isPaused(rule)) return DB_ONLY;
    return onNodes(place, logger, async (node) => {
      const eff = effectiveRule(rule, overrides[node.name]);
      // このノードだけ停止中なら作らない
      if (isPaused(eff)) return async () => undefined;
      await addRule(toRproxyRule(eff));
      return () => deleteRule(toKey(eff));
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
  // body にあった v0.4 の項目
  v04?: V04Key[];
}

// 変更の後の内容（DB の今の内容 current と、body の rule・given）。変えられない違いは HttpError
function mergeEdit(current: ForwardRule, rule: ForwardRule, given: Given): ForwardRule {
  const { range: rangeGiven, allowFrom: allowFromGiven, http: httpGiven, crowdsec: crowdsecGiven } = given;
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
  const { labels: _l, limits: _li, bandwidth: _b, geoip: _g, outlierDetection: _o, ...base } = rule;
  void _l; void _li; void _b; void _g; void _o;
  const updated: ForwardRule = {
    ...base,
    ...(current.target !== undefined ? { target: current.target } : {}),
    sourceIp: current.sourceIp,
    srcPortEnd: current.srcPortEnd,
    allowFrom: allowFromGiven ? rule.allowFrom : current.allowFrom,
    crowdsec: crowdsecGiven ? rule.crowdsec : current.crowdsec,
    http: http,
    ...balancing,
    ...(http !== null || balancing.targets.length > 0 ? { distAddr: '', distPort: 0 } : {}),
    extraListenAddrs: given.extraListenAddrs ? extraAddrs(rule) : extraAddrs(current),
    // v0.4 の項目は body にあるものだけ置き換える
    ...mergeV04(current, rule, given.v04 ?? []),
    // 停止・再開は pause / resume だけで変える（変更では今の状態を保つ）
    enabled: current.enabled !== false,
  };
  if (updated.http !== null && updated.outlierDetection) {
    throw invalid('L7（HTTP）のルールでは、ルールの受け身のヘルスチェックは使えません（L7 タブのサービスごとに設定します）。');
  }
  if (updated.protocol === 'tcp' && updated.limits?.per_source?.packets) {
    throw invalid('データグラムの速さ（packets）は UDP のルールでだけ使えます。');
  }
  try {
    // 範囲が DB の値になったので、転送先ポートと routes の範囲をもう一度確かめる
    const count = portCount(updated.srcPort, updated.srcPortEnd, updated.distPort);
    checkTls(updated.protocol, updated.tls, updated.starttls, count, updated.http !== null);
    checkBalancing(updated.protocol, updated, count);
  } catch (err) {
    throw fromTlsError(err);
  }
  return updated;
}

async function editForwardingRule(actor: Actor, place: Place, rule: ForwardRule, given: Given, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  checkNodes(actor, place);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, rule, logger);
    const { overrides: ovs } = await lockedExtras(conn, place, rule);
    checkPorts(actor, current);
    const updated = mergeEdit(current, rule, given);
    const where = keyWhere(place, updated);
    await conn.query(
      `UPDATE forward_rules SET dist_addr = ?, dist_port = ?, udp_idle_secs = ?, options = ? WHERE ${owner.sql}${where.sql}`,
      [updated.distAddr, updated.distPort, updated.udpIdleSecs, options(updated), ...owner.params, ...where.params]
    );
    // 履歴の auth_id は操作した利用者（admin がほかの人のルールを変えたときは admin）
    await insertLog(conn, actor.id, place, updated, 'UPDATE');
    // 停止中のルールは DB だけを変える（再開のときにこの内容で作る）
    if (isPaused(current)) return DB_ONLY;
    return onNodes(place, logger, async (node) => {
      // ノードの上書きを重ねた内容で送る（上書きした項目はグループの変更では変わらない）
      const before = effectiveRule(current, ovs[node.name]);
      const after = effectiveRule(updated, ovs[node.name]);
      if (isPaused(after)) return async () => undefined;
      // 同じキーを API のルール・ルールの組が使っていれば、それを書き換えないように断る
      await ensureNotShadowed(toKey(after));
      try {
        await modifyRule(toKey(after), toRproxyPatch(after, before.crowdsec, before.targets.length > 0, extraAddrs(before).length > 0, before));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        // rproxy にないルール（missing）は作り直す
        logger.warn('rproxy にルールがないため、変更後の内容で作り直します');
        await addRule(toRproxyRule(after));
        return () => deleteRule(toKey(after));
      }
      // 元の転送先・TLS の設定・allow_from に戻す
      return () => modifyRule(toKey(before), toRproxyPatch(before, after.crowdsec, after.targets.length > 0, extraAddrs(after).length > 0, after));
    });
  });
}

async function deleteForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  checkNodes(actor, place);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const { overrides: ovs } = await lockedExtras(conn, place, key);
    const where = keyWhere(place, key);
    // ノードごとの上書きは forward_rule_overrides の外部キー（ON DELETE CASCADE）で一緒に消える
    await conn.query(
      `DELETE FROM forward_rules WHERE ${owner.sql}${where.sql}`,
      [...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, current, 'DELETE');
    // 停止中のルールは rproxy にないので DB だけ
    if (isPaused(current)) return DB_ONLY;
    return onNodes(place, logger, async (node) => {
      const eff = effectiveRule(current, ovs[node.name]);
      if (isPaused(eff)) return async () => undefined;
      // 同じキーを API のルール・ルールの組が使っている（UI のルールは動いていない）：それを消さず、DB の行だけを消す
      if (isShadowing(await liveRule(toKey(eff)))) {
        logger.warn(`ノード ${node.name}: 同じキーを rproxy の API のルール・ルールの組が使っているため、DB のルールだけを削除します`);
        return async () => undefined;
      }
      try {
        await deleteRule(toKey(eff));
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
      return () => addRule(toRproxyRule(eff));
    });
  });
}

// ---- 変更前の差分（rproxy v0.4 の ?dry_run=true、#169） ----

interface PlanResult {
  node: string;
  plan?: RulePlan;
  // rproxy が断った・問い合わせできなかったとき
  error?: string;
  code?: string;
}

// POST /api/forward/plan {action: 'add' | 'modify' | 'delete', ...ルールの本文, target?}：保存したときに rproxy で何が変わるかを、
// 置き場所のノードごとに rproxy の ?dry_run=true で聞く（DB も rproxy も変えない）。変更は DB の今の内容に本文を重ねた内容で聞く。
// rproxy の断り（400 invalid・unsupported など）はノードごとの error にする（features.dry_run が false の rproxy も 400 unsupported）
async function planRule(actor: Actor, body: any, logger: AppLogger): Promise<{ action: string; results: PlanResult[] }> {
  const action = body?.action;
  if (action !== 'add' && action !== 'modify' && action !== 'delete' && action !== 'api-modify') throw invalid('action は add / modify / delete / api-modify のどれかです。');
  const ask = async (place: Place, step: (node: RproxyNode) => Promise<RulePlan | null>): Promise<PlanResult[]> => Promise.all(place.nodes.map(async (node) => {
    try {
      const plan = await withNode(node, () => step(node));
      return plan === null ? { node: node.name } : { node: node.name, plan: plan };
    } catch (err) {
      if (err instanceof HttpError || err instanceof RproxyError) return { node: node.name, error: err instanceof RproxyError ? liveError(err) : err.message, code: err.code };
      throw err;
    }
  }));
  if (action === 'add') {
    const rule = parseRule(body, false);
    const place = placeForAdd(actor.cfg, body?.target);
    checkPorts(actor, rule);
    checkNodes(actor, place);
    return { action: action, results: await ask(place, () => planAdd(toRproxyRule(rule))) };
  }
  if (action === 'api-modify') {
    // API のルール（UI の DB にない）：rproxy の今の内容に本文を重ねた PATCH を聞く
    const node = apiRuleNode(actor, body?.target);
    const rule = parseRule(body, false, true);
    const { rule: current } = await currentApiRule(actor, node, rule);
    const updated = mergeEdit(current, rule, apiGiven(body));
    return { action: action, results: await ask({ target: null, nodes: [node] }, () => planModify(toKey(updated), toRproxyPatch(updated, current.crowdsec, current.targets.length > 0, extraAddrs(current).length > 0, current))) };
  }
  const rule = parseRule(body, action === 'delete', true);
  const place = await placeForKey(actor, rule, body?.target);
  checkNodes(actor, place);
  const conn = await pool.getConnection();
  let current: ForwardRule;
  let ovs: Overrides;
  try {
    current = await lockOwnRule(conn, actor, place, rule, logger);
    ovs = (await lockedExtras(conn, place, rule)).overrides;
  } finally {
    conn.release();
  }
  checkPorts(actor, current);
  if (action === 'delete') {
    return { action: action, results: await ask(place, async (node) => {
      const eff = effectiveRule(current, ovs[node.name]);
      if (isPaused(eff)) return null;
      // API のルール・ルールの組のルール（UI のルールの代わりに動いている）の内容（before）は返さない
      await ensureNotShadowed(toKey(eff));
      return planDelete(toKey(eff));
    }) };
  }
  const updated = mergeEdit(current, rule, {
    range: hasRangeEnd(body), allowFrom: hasAllowFrom(body), http: hasHttp(body), crowdsec: hasCrowdsec(body),
    targets: hasTargets(body), extraListenAddrs: hasExtraListenAddrs(body), v04: givenV04(body),
  });
  return { action: action, results: await ask(place, async (node) => {
    const before = effectiveRule(current, ovs[node.name]);
    const after = effectiveRule(updated, ovs[node.name]);
    // 停止中のルールは rproxy にないので聞けない（再開のときにこの内容で作る）
    if (isPaused(after)) return null;
    await ensureNotShadowed(toKey(after));
    try {
      return await planModify(toKey(after), toRproxyPatch(after, before.crowdsec, before.targets.length > 0, extraAddrs(before).length > 0, before));
    } catch (err) {
      // rproxy にない（missing）なら、保存すると作り直す
      if (isNotFound(err)) return planAdd(toRproxyRule(after));
      throw err;
    }
  }) };
}

// ---- rproxy の API のルール（UI の DB にない。rproxy v0.4、#76） ----

// API のルールを置いているノード。管理者だけ。ノードを設定していれば body.target はノードの名前（グループではない）
function apiRuleNode(actor: Actor, target: unknown): RproxyNode {
  if (actor.access !== 'admin') throw new HttpError(403, 'rproxy の API のルールは管理者だけが変えられます。', 'forbidden_admin');
  if (!actor.cfg.configured) return toRproxyNode(actor.cfg.nodes[0]);
  const node = actor.cfg.nodes.find((n) => n.name === target);
  if (!node) throw new HttpError(400, `API のルールのノード（target）を指定してください（${String(target ?? '')} はノードではありません）。`, 'unknown_node');
  return toRproxyNode(node);
}

// 今の API のルール（固定ルールは 409 static、ルールの組のものは 409 owned、UI のルールなら 409 ui_rule、なければ 404）
async function currentApiRule(actor: Actor, node: RproxyNode, key: ForwardRule): Promise<{ status: RproxyRuleStatus; rule: ForwardRule }> {
  const where = actor.cfg.configured ? { sql: 'target = ? AND protocol = ? AND src_addr = ? AND src_port = ?', params: [node.name, key.protocol, key.srcAddr, key.srcPort] } : { sql: 'protocol = ? AND src_addr = ? AND src_port = ?', params: [key.protocol, key.srcAddr, key.srcPort] };
  const own = await pool.query(`SELECT id FROM forward_rules WHERE ${where.sql}`, where.params);
  if (Array.isArray(own) && own.length > 0) throw new HttpError(409, 'このキーは UI のルールです（UI の変更・削除を使ってください）。', 'ui_rule');
  let status: RproxyRuleStatus;
  try {
    status = await withNode(node, () => getRule(toKey(key)));
  } catch (err) {
    if (isNotFound(err)) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
    throw err;
  }
  if (status.origin === 'static') throw staticRuleError();
  if (typeof status.ruleset === 'string' && status.ruleset !== '') {
    throw new HttpError(409, `このルールは rproxy のルールの組 ${status.ruleset} に属しているため、画面からは変更・削除できません。`, 'owned');
  }
  return { status: status, rule: ruleFromStatus(status, 0) };
}

// rproxy は origin: api のルールの変更を、トークンを問わず rproxy_rules に保存する（rproxy-api #222）。応答が persisted: false のとき
// （DB に書けなかった・RPROXY_DATABASE_URL がないなど）だけ知らせる
const NOT_PERSISTED_MESSAGE = 'rproxy は変更を rproxy_rules に保存できませんでした（rproxy のログの degraded を確かめてください）。rproxy を再起動すると、保存してある前の内容に戻ります。';

// POST /api/forward/api-modify {protocol, srcAddr, srcPort, target?, ...}：API のルールを rproxy の PATCH で変える（UI の DB には書かない。履歴も残らない）。
// body にない項目は今の値を保つ（modify と同じ）。保存されていたルールの変更を rproxy が保存しなかったら warning
async function editApiRule(actor: Actor, body: any): Promise<{ message: string; persisted?: boolean; warning?: string }> {
  const node = apiRuleNode(actor, body?.target);
  const rule = parseRule(body, false, true);
  const { status, rule: current } = await currentApiRule(actor, node, rule);
  const updated = mergeEdit(current, rule, apiGiven(body));
  const res = await withNode(node, () => modifyRule(toKey(updated), toRproxyPatch(updated, current.crowdsec, current.targets.length > 0, extraAddrs(current).length > 0, current)));
  const persisted = typeof res?.persisted === 'boolean' ? res.persisted : undefined;
  return {
    message: 'API rule modified',
    ...(persisted !== undefined ? { persisted: persisted } : {}),
    ...(status.persisted === true && persisted === false ? { warning: NOT_PERSISTED_MESSAGE } : {}),
  };
}

function apiGiven(body: any): Given {
  return {
    range: hasRangeEnd(body), allowFrom: hasAllowFrom(body), http: hasHttp(body), crowdsec: hasCrowdsec(body),
    targets: hasTargets(body), extraListenAddrs: hasExtraListenAddrs(body), v04: givenV04(body),
  };
}

// POST /api/forward/api-delete {protocol, srcAddr, srcPort, target?}：API のルールを rproxy の DELETE で消す
async function deleteApiRule(actor: Actor, body: any): Promise<{ message: string }> {
  const node = apiRuleNode(actor, body?.target);
  const key = parseRule(body, true);
  await currentApiRule(actor, node, key);
  try {
    await withNode(node, () => deleteRule(toKey(key)));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return { message: 'API rule deleted' };
}

// ---- 一時停止と再開 ----

// 一時停止：DB に残したまま options に enabled: false を付け、rproxy から削除する（rproxy は起動時にもその行を作らない）
async function pauseForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  checkNodes(actor, place);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const { overrides: ovs } = await lockedExtras(conn, place, key);
    checkPorts(actor, current);
    if (isPaused(current)) throw new HttpError(409, 'このルールは既に停止中です。', 'already_paused');
    const paused: ForwardRule = { ...current, enabled: false };
    const where = keyWhere(place, key);
    await conn.query(
      `UPDATE forward_rules SET options = ? WHERE ${owner.sql}${where.sql}`,
      [options(paused), ...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, paused, 'UPDATE');
    return onNodes(place, logger, async (node) => {
      const eff = effectiveRule(current, ovs[node.name]);
      if (isPaused(eff)) return async () => undefined;
      // 同じキーを API のルール・ルールの組が使っている（UI のルールは動いていない）：それを消さず、DB の印だけを付ける
      if (isShadowing(await liveRule(toKey(eff)))) {
        logger.warn(`ノード ${node.name}: 同じキーを rproxy の API のルール・ルールの組が使っているため、DB のルールだけを停止にします`);
        return async () => undefined;
      }
      try {
        await deleteRule(toKey(eff));
      } catch (err) {
        // rproxy に既にない（missing）なら止まっているのと同じ
        if (isNotFound(err)) return async () => undefined;
        throw err;
      }
      return () => addRule(toRproxyRule(eff));
    });
  });
}

// 再開：enabled の印を外し、DB の内容で rproxy に作る
async function resumeForwardingRule(actor: Actor, place: Place, key: ForwardRule, logger: AppLogger): Promise<NodeResult[]> {
  const owner = ownerClause(actor);
  checkNodes(actor, place);
  return withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const { overrides: ovs } = await lockedExtras(conn, place, key);
    checkPorts(actor, current);
    if (!isPaused(current)) throw new HttpError(409, 'このルールは停止中ではありません。', 'not_paused');
    const resumed: ForwardRule = { ...current, enabled: true };
    const where = keyWhere(place, key);
    await conn.query(
      `UPDATE forward_rules SET options = ? WHERE ${owner.sql}${where.sql}`,
      [options(resumed), ...owner.params, ...where.params]
    );
    await insertLog(conn, actor.id, place, resumed, 'UPDATE');
    return onNodes(place, logger, async (node) => {
      const eff = effectiveRule(resumed, ovs[node.name]);
      if (isPaused(eff)) return async () => undefined;
      await ensureNotShadowed(toKey(eff));
      await addRule(toRproxyRule(eff));
      return () => deleteRule(toKey(eff));
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

const ALL_GIVEN: Given = { range: true, allowFrom: true, http: true, crowdsec: true, targets: true, extraListenAddrs: true, v04: [...V04_KEYS] };

// 同じキーのルール（自分の。admin ならだれのでも）を rule の内容で丸ごと置き換える。所有者は変えない
// overrides：インポートの上書き（undefined なら今の上書きを保つ）。上書きが変わるときは作り直す
async function replaceForwardingRule(actor: Actor, place: Place, rule: ForwardRule, logger: AppLogger, overrides?: Overrides): Promise<'modified' | 'recreated'> {
  const owner = ownerClause(actor);
  const where = keyWhere(place, rule);
  const rows = await pool.query(
    `SELECT ${place.target !== null ? 'id, ' : ''}auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}${where.sql}`,
    [...owner.params, ...where.params]
  );
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  const current = fromRow(rows[0]);
  const ownerId = String(rows[0].auth_id);
  const currentOverrides = place.target !== null ? (await loadOverrides(pool, [Number(rows[0].id)])).get(Number(rows[0].id)) ?? {} : {};
  const nextOverrides = overrides ?? currentOverrides;
  if (!needsRecreate(current, rule) && sameOverrides(currentOverrides, nextOverrides)) {
    await editForwardingRule(actor, place, rule, ALL_GIVEN, logger);
    return 'modified';
  }
  // 置き換え（インポート・巻き戻し）でも停止・再開の状態は今のまま
  rule = { ...rule, enabled: current.enabled !== false };
  // 同じキーを API のルール・ルールの組が使っていれば、DB の行を消してから作れずに失う前に断る
  if (!isPaused(current)) await ensureNotShadowedOnNodes(place, current, currentOverrides);
  await deleteForwardingRule(actor, place, rule, logger);
  try {
    await addForwardingRule(actor, place, rule, logger, ownerId, nextOverrides);
  } catch (err) {
    // 作れなかったら元のルールを戻す
    await addForwardingRule(actor, place, current, logger, ownerId, currentOverrides)
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
    `SELECT ${actor.cfg.configured ? 'id, ' : ''}protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY protocol, src_addr, src_port`,
    params
  );
  // ノードを設定していれば、ノードごとの上書きも書き出す（UI のエクスポートだけの項目 overrides）
  const ovs = actor.cfg.configured ? await loadOverrides(pool, rows.map((r: any) => Number(r.id))) : new Map<number, Overrides>();
  const rules: ForwardRule[] = rows.map((r: any) => {
    const o = ovs.get(Number(r.id));
    return { ...fromRow(r), ...(o && Object.keys(o).length > 0 ? { overrides: o } : {}) };
  });
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
  // ノードごとの上書き（UI のエクスポートの overrides。読み込む先がグループのときだけ）
  overrides?: Overrides;
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
    let overrides: Overrides | undefined;
    try {
      const body = settingsRuleToBody(value);
      rule = parseRule(body, false);
      checkPorts(actor, rule);
      if (body.overrides !== undefined) overrides = importOverrides(actor.cfg, place, rule, body.overrides as Record<string, unknown>);
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
    if (owner === undefined) return { index: index, key: key, status: 'new', rule: rule, ...(overrides ? { overrides: overrides } : {}) };
    if (actor.access !== 'admin' && owner !== actor.id) {
      return { index: index, key: key, status: 'error', message: '同じキーのルールをほかの利用者が使っています。' };
    }
    return { index: index, key: key, status: 'exists', rule: rule, ...(overrides ? { overrides: overrides } : {}) };
  });
  return { items: items, ignoredGlobal: doc.ignoredGlobal };
}

// インポートの overrides を確かめる（読み込む先がグループで、そのノードの上書きであること）
function importOverrides(cfg: NodesConfig, place: Place, rule: ForwardRule, raw: Record<string, unknown>): Overrides {
  if (place.target === null || !cfg.groups.some((g) => g.name === place.target)) {
    throw invalid('ノードごとの上書き（overrides）は、グループに読み込むときだけ使えます。');
  }
  const out: Overrides = {};
  for (const [node, value] of Object.entries(raw)) {
    if (!place.nodes.some((n) => n.name === node)) throw invalid(`overrides のノード ${node} は ${place.target} にありません。`);
    const ov = normalizeOverride(value, rule);
    if (ov) out[node] = ov;
  }
  return out;
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
        await addForwardingRule(actor, place, item.rule, logger, actor.id, item.overrides ?? {});
        results.push({ index: item.index, key: item.key, result: 'added' });
      } else {
        await replaceForwardingRule(actor, place, item.rule, logger, item.overrides);
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
    if (!HISTORY_ACTIONS.includes(action as HistoryAction)) throw invalid('action は ADD / UPDATE / DELETE / RESEND / OVERRIDE のどれかです。');
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
          `SELECT ${logSelect(actor.cfg)} FROM forward_rules_log l WHERE l.target = ? AND l.protocol = ? AND l.src_addr = ? AND l.src_port = ? AND l.id < ? AND l.update_action <> 'OVERRIDE' ORDER BY l.id DESC LIMIT 1`,
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
      revertible: rule !== null && act !== 'OVERRIDE',
    });
  }
  return { entries: entries, total: total, page: page, perPage: perPage };
}

// ---- 1 つのノードへの送り直し（#98 の「ずれ」） ----

// POST /api/forward/resend {protocol, srcAddr, srcPort, target?, node}：DB の内容を、置き場所のノードのうち 1 台にだけ送り直す。
// 自分のルール（admin ならだれのでも）だけ。履歴に RESEND（node 列にノード）を残す。
// 送り直しは DB の内容に揃えるだけなので、COMMIT に失敗しても rproxy は戻さない（そのノードは DB と同じ内容のまま）
async function resendToNode(actor: Actor, body: any, logger: AppLogger): Promise<{ node: string; result: ResendResult }> {
  if (!actor.cfg.configured) throw new HttpError(400, '送り直しは、ノードを設定（RPROXY_UI_NODES）したときだけ使えます。', 'unsupported');
  const key = parseRule(body, true);
  const place = await placeForKey(actor, key, body?.target);
  const node = place.nodes.find((n) => n.name === body?.node);
  if (!node) throw new HttpError(400, `ノード ${String(body?.node ?? '')} はこのルールの置き場所にありません。`, 'unknown_node');
  checkNodes(actor, [node]);
  let result: ResendResult = 'unchanged';
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const { overrides: ovs } = await lockedExtras(conn, place, key);
    checkPorts(actor, current);
    const eff = effectiveRule(current, ovs[node.name]);
    await insertLog(conn, actor.id, place, eff, 'RESEND', node.name);
    result = await withNode(node, () => resendOne(eff));
    // 同じキーを API のルール・ルールの組が使っている：何も送っていない（履歴も残さない）
    if (result === 'shadowed') throw shadowedError();
    return { undo: async () => undefined, results: [{ node: node.name, ok: true }] };
  });
  return { node: node.name, result: result };
}

// ---- ノードごとの上書き（#98） ----

type OverrideResult = 'set' | 'cleared' | 'unchanged';

// 1 つのノードの上書きを change で変え、そのノードにだけ反映する（OVERRIDE の履歴）。change は今の上書きから新しい上書きを作る
async function changeOverride(actor: Actor, place: Place, key: ForwardRule, node: RproxyNode, change: (current: ForwardRule, old: NodeOverride | null) => NodeOverride | null, logger: AppLogger): Promise<OverrideResult> {
  let result: OverrideResult = 'unchanged';
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, place, key, logger);
    const { id, overrides: ovs } = await lockedExtras(conn, place, key);
    if (id === null) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
    checkPorts(actor, current);
    const old = ovs[node.name] ?? null;
    const next = change(current, old);
    if (sameOverrides(old ? { n: old } : {}, next ? { n: next } : {})) return DB_ONLY;
    if (next === null) {
      await conn.query('DELETE FROM forward_rule_overrides WHERE rule_id = ? AND node = ?', [id, node.name]);
    } else {
      await writeOverrides(conn, id, { [node.name]: next });
    }
    result = next === null ? 'cleared' : 'set';
    const before = effectiveRule(current, old ?? undefined);
    const after = effectiveRule(current, next ?? undefined);
    await insertLog(conn, actor.id, place, after, 'OVERRIDE', node.name);
    if (isPaused(current)) return DB_ONLY;
    return onNodes({ target: place.target, nodes: [node] }, logger, async () => applyNodeChange(before, after, logger));
  });
  return result;
}

// 1 つのノードの内容を before から after に変える（withNode の中）。戻す undo を返す
async function applyNodeChange(before: ForwardRule, after: ForwardRule, logger: AppLogger): Promise<Undo> {
  const quietDelete = async (r: ForwardRule) => {
    try {
      await deleteRule(toKey(r));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  };
  if (isPaused(before) && isPaused(after)) return async () => undefined;
  // 同じキーを API のルール・ルールの組が使っていれば、それを消したり書き換えたりしない（止めるだけなら DB だけ、ほかは 409 shadowed）
  if (!isPaused(before) && isShadowing(await liveRule(toKey(before)))) {
    if (isPaused(after)) return async () => undefined;
    throw shadowedError();
  }
  if (!isPaused(after) && (isPaused(before) || before.srcAddr !== after.srcAddr)) await ensureNotShadowed(toKey(after));
  if (isPaused(after)) {
    await quietDelete(before);
    return () => addRule(toRproxyRule(before));
  }
  if (isPaused(before)) {
    await addRule(toRproxyRule(after));
    return () => deleteRule(toKey(after));
  }
  // 待ち受けアドレス・送信元 IP の扱い・ポート範囲・L4 / L7 が違えば作り直す（PATCH では変えられない）
  if (before.srcAddr !== after.srcAddr || needsRecreate(before, after)) {
    await quietDelete(before);
    try {
      await addRule(toRproxyRule(after));
    } catch (err) {
      await addRule(toRproxyRule(before)).catch((e) => logger.error(`元の内容に戻せませんでした: ${e}`));
      throw err;
    }
    return async () => {
      await quietDelete(after);
      await addRule(toRproxyRule(before));
    };
  }
  try {
    await modifyRule(toKey(after), toRproxyPatch(after, before.crowdsec, before.targets.length > 0, extraAddrs(before).length > 0, before));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await addRule(toRproxyRule(after));
    return () => deleteRule(toKey(after));
  }
  return () => modifyRule(toKey(before), toRproxyPatch(before, after.crowdsec, after.targets.length > 0, extraAddrs(after).length > 0, after));
}

// グループのルールのノードを決める（ノードを設定し、グループに置いたルールだけ）
async function groupNode(actor: Actor, key: ForwardRule, target: unknown, nodeName: unknown): Promise<{ place: Place; node: RproxyNode }> {
  if (!actor.cfg.configured) throw new HttpError(400, 'ノードごとの設定は、ノードを設定（RPROXY_UI_NODES）したときだけ使えます。', 'unsupported');
  const place = await placeForKey(actor, key, target);
  if (place.target === null || !actor.cfg.groups.some((g) => g.name === place.target)) {
    throw new HttpError(400, 'ノードごとの上書きは、グループに置いたルールだけに使えます。', 'unsupported');
  }
  const node = place.nodes.find((n) => n.name === nodeName);
  if (!node) throw new HttpError(400, `ノード ${String(nodeName ?? '')} はこのルールの置き場所にありません。`, 'unknown_node');
  checkNodes(actor, [node]);
  return { place: place, node: node };
}

// POST /api/forward/override {protocol, srcAddr, srcPort, target?, node, override: {...} | null}
async function setOverride(actor: Actor, body: any, logger: AppLogger): Promise<{ node: string; result: OverrideResult }> {
  const key = parseRule(body, true);
  const { place, node } = await groupNode(actor, key, body?.target, body?.node);
  const result = await changeOverride(actor, place, key, node, (current) => {
    try {
      return normalizeOverride(body?.override, current);
    } catch (err) {
      throw fromTlsError(err);
    }
  }, logger);
  return { node: node.name, result: result };
}

// POST /api/forward/pause-node {node, action: 'pause' | 'resume'}：そのノードのルールをまとめて止める・再開する。
// そのノードに置いたルールはルールごと、グループのルールはそのノードだけ（上書きの enabled: false）。1 件ずつ別のトランザクション
async function pauseNode(actor: Actor, body: any, logger: AppLogger) {
  if (!actor.cfg.configured) throw new HttpError(400, 'ノードごとの停止は、ノードを設定（RPROXY_UI_NODES）したときだけ使えます。', 'unsupported');
  const cfgNode = actor.cfg.nodes.find((n) => n.name === body?.node);
  if (!cfgNode) throw new HttpError(400, `ノード ${String(body?.node ?? '')} は設定にありません。`, 'unknown_node');
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume') throw invalid('action は pause か resume です。');
  const node = toRproxyNode(cfgNode);
  checkNodes(actor, [node]);
  const owner = ownerClause(actor);
  const targets = actor.cfg.groups.filter((g) => g.nodes.includes(node.name)).map((g) => g.name).concat(node.name);
  const rows = await pool.query(
    `SELECT id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}target IN (${targets.map(() => '?').join(', ')}) ORDER BY id`,
    [...owner.params, ...targets]
  );
  const overrides = await loadOverrides(pool, rows.map((r: any) => Number(r.id)));
  const results: { key: string; target: string; result: 'paused' | 'resumed' | 'skipped' | 'error'; message?: string }[] = [];
  for (const row of rows) {
    const rule = fromRow(row);
    const target = String(row.target);
    const label = ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort);
    const place = placeOf(actor.cfg, target);
    const ov = overrides.get(Number(row.id))?.[node.name];
    try {
      if (target === node.name) {
        // このノードだけに置いたルールは、ルールごと止める
        if ((action === 'pause') === isPaused(rule)) {
          results.push({ key: label, target: target, result: 'skipped' });
          continue;
        }
        if (action === 'pause') await pauseForwardingRule(actor, place, rule, logger);
        else await resumeForwardingRule(actor, place, rule, logger);
      } else {
        const pausedHere = ov?.enabled === false;
        if ((action === 'pause') === pausedHere) {
          results.push({ key: label, target: target, result: 'skipped' });
          continue;
        }
        await changeOverride(actor, place, rule, node, (_current, old) => {
          const next: NodeOverride = { ...(old ?? {}) };
          if (action === 'pause') next.enabled = false;
          else delete next.enabled;
          return Object.keys(next).length === 0 ? null : next;
        }, logger);
      }
      results.push({ key: label, target: target, result: action === 'pause' ? 'paused' : 'resumed' });
    } catch (err) {
      logger.warn(`ノード ${node.name} の ${label}（${target}）を${action === 'pause' ? '停止' : '再開'}できませんでした: ${errorText(err)}`);
      results.push({ key: label, target: target, result: 'error', message: errorText(err) });
    }
  }
  return { node: node.name, action: action, results: results };
}

// ---- 別のノード／グループへのコピー・移動（#98） ----

// POST /api/forward/copy {protocol, srcAddr, srcPort, target?, to, move?}：コピーは to に同じルールを作る。
// 移動は to に作ってから元を消す（ノードが重なるときは、先に元を消してから作り、作れなければ元を戻す）。
// 上書きは、to にもあるノードの分だけ引き継ぐ。所有者は変えない。履歴は to の ADD（移動なら元の DELETE も）
async function copyRule(actor: Actor, body: any, logger: AppLogger): Promise<{ result: 'copied' | 'moved'; target: string }> {
  if (!actor.cfg.configured) throw new HttpError(400, 'コピー・移動は、ノードを設定（RPROXY_UI_NODES）したときだけ使えます。', 'unsupported');
  const key = parseRule(body, true);
  const from = await placeForKey(actor, key, body?.target);
  const toName = requestedTarget(actor.cfg, body?.to);
  if (toName === undefined) throw new HttpError(400, 'コピー・移動の先のノードかグループ（to）を指定してください。', 'target_required');
  if (toName === from.target) throw invalid('コピー・移動の先が元と同じです。');
  const to = placeOf(actor.cfg, toName);
  checkNodes(actor, from);
  checkNodes(actor, to);
  const owner = ownerClause(actor);
  const where = keyWhere(from, key);
  const rows = await pool.query(
    `SELECT id, auth_id, target, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}${where.sql}`,
    [...owner.params, ...where.params]
  );
  if (rows.length === 0) {
    if (await findStaticRule(toKey(key), from, logger)) throw staticRuleError();
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  const rule = fromRow(rows[0]);
  const ownerId = String(rows[0].auth_id);
  const allOvs = (await loadOverrides(pool, [Number(rows[0].id)])).get(Number(rows[0].id)) ?? {};
  const toGroup = actor.cfg.groups.some((g) => g.name === toName);
  const keep: Overrides = toGroup
    ? Object.fromEntries(Object.entries(allOvs).filter(([n]) => to.nodes.some((x) => x.name === n)))
    : {};
  // ノードに置くときは、そのノードの上書きをルールの内容にする（ノードのルールは上書きを持たない）
  const placed = !toGroup && allOvs[toName] ? effectiveRule(rule, allOvs[toName]) : rule;
  if (body?.move !== true) {
    await addForwardingRule(actor, to, placed, logger, ownerId, keep);
    return { result: 'copied', target: toName };
  }
  if (targetsOverlap(actor.cfg, from.target!, toName)) {
    if (!isPaused(rule)) await ensureNotShadowedOnNodes(from, rule, allOvs);
    await deleteForwardingRule(actor, from, rule, logger);
    try {
      await addForwardingRule(actor, to, placed, logger, ownerId, keep);
    } catch (err) {
      await addForwardingRule(actor, from, rule, logger, ownerId, allOvs)
        .catch((e) => logger.error(`移動に失敗し、元のルールも戻せませんでした: ${e}`));
      throw err;
    }
  } else {
    await addForwardingRule(actor, to, placed, logger, ownerId, keep);
    try {
      await deleteForwardingRule(actor, from, rule, logger);
    } catch (err) {
      await deleteForwardingRule(actor, to, placed, logger).catch((e) => logger.error(`移動に失敗し、移動先のルールを消せませんでした: ${e}`));
      throw err;
    }
  }
  return { result: 'moved', target: toName };
}

// ノードごとの最後の反映（このノードを含むノード／グループの履歴の最後。送り直し・上書きはそのノードの分だけ）
async function lastSyncByNode(cfg: NodesConfig): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let rows: any[];
  try {
    rows = await pool.query('SELECT target, node, MAX(updated_at) AS at FROM forward_rules_log GROUP BY target, node');
  } catch {
    return out;
  }
  for (const n of cfg.nodes) {
    const mine = new Set(membership(cfg).filter((m) => m.node === n.name).map((m) => m.target));
    let best: string | null = null;
    for (const r of Array.isArray(rows) ? rows : []) {
      const applies = r.node === null || r.node === undefined ? mine.has(String(r.target)) : String(r.node) === n.name;
      if (!applies || r.at === null || r.at === undefined) continue;
      const at = toIso(r.at);
      if (best === null || at > best) best = at;
    }
    if (best !== null) out.set(n.name, best);
  }
  return out;
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
  if (String(rows[0].update_action) === 'OVERRIDE') throw invalid('ノードごとの上書きの履歴は巻き戻せません（ルールの詳細のノードのタブで上書きを直してください）。');
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
    if (err.status === 429) {
      // rproxy v0.4 の api_lockout：UI の送信元が認証の失敗を続けて止められている（UI サーバの設定の問題）
      logger.error('rproxy が UI の送信元を一時的に止めています（429 locked_out）。RPROXY_API_TOKEN・クライアント証明書を確認してください');
      if (err.retryAfter !== undefined) res.setHeader?.('Retry-After', String(err.retryAfter));
      return res.status(502).json({ error: lockedOutText(err.retryAfter), code: 'rproxy_locked_out' });
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
  // ほかのサイトからの変更の要求（CSRF）は、サインインを確かめる前に断る（apiguard.ts）
  if (rejectCrossSite(req, res)) return;
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
      const info = nodesInfo(cfg);
      // RPROXY_UI_USER_NODES で絞った利用者には、使えるノード／グループを添える（画面の選択肢を絞る）
      if (cfg.configured && access !== 'admin' && roles.userNodes !== null) {
        info.allowedTargets = [...cfg.groups.map((g) => g.name), ...cfg.nodes.map((n) => n.name)]
          .filter((t) => nodesAllowed(access, roles, (targetNodes(cfg, t) ?? []).map((n) => n.name)));
      }
      return res.status(200).json(info);
    }
    if (req.method === 'GET' && query === 'ha') {
      // act/stb の画面（failback の確認。#109）：グループごとの act とノードごとの揃い具合。すべての利用者のルールを見るので admin だけ
      if (access !== 'admin') return res.status(403).json({ error: 'act/stb の画面は管理者だけが使えます。', code: 'forbidden_admin' });
      const groups = await haOverview(cfg);
      return res.status(200).json({ groups: groups, haSync: haSyncStatus() });
    }
    if (req.method === 'POST' && query === 'ha-sync') {
      // 1 つのノードを、そのノードを含む active_standby のグループの DB の定義に揃える（failback の前など。admin だけ。履歴は RESEND）
      if (access !== 'admin') return res.status(403).json({ error: 'act/stb の画面は管理者だけが使えます。', code: 'forbidden_admin' });
      const node = typeof req.body?.node === 'string' ? req.body.node : '';
      if (!cfg.configured || !cfg.nodes.some((n) => n.name === node)) throw new HttpError(400, `ノード ${node} は設定にありません。`, 'unknown_node');
      const out = await syncNode(cfg, node, { onlyAuto: false, actor: actor.id, logger: logger });
      return res.status(200).json({ node: node, results: out.results });
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
          v04: givenV04(req.body),
        }, logger);
        logger.info('Forwarding rule modified successfully');
        return res.status(200).json(done(actor, 'Forwarding rule modified successfully', results));
      } else if (query === 'api-modify') {
        const out = await editApiRule(actor, req.body);
        logger.info(`API rule modified${out.warning ? ' (not persisted)' : ''}`);
        return res.status(200).json(out);
      } else if (query === 'api-delete') {
        const out = await deleteApiRule(actor, req.body);
        logger.info('API rule deleted');
        return res.status(200).json(out);
      } else if (query === 'plan') {
        const out = await planRule(actor, req.body, logger);
        return res.status(200).json(out);
      } else if (query === 'import') {
        const out = await importRules(actor, req.body, logger);
        return res.status(200).json(out);
      } else if (query === 'override') {
        const out = await setOverride(actor, req.body, logger);
        logger.info(`Override on node ${out.node} (${out.result})`);
        return res.status(200).json(out);
      } else if (query === 'pause-node') {
        const out = await pauseNode(actor, req.body, logger);
        return res.status(200).json(out);
      } else if (query === 'copy') {
        const out = await copyRule(actor, req.body, logger);
        logger.info(`Rule ${out.result} to ${out.target}`);
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
