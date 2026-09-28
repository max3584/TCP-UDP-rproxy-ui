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
  RproxyRule,
  RproxyRuleKey,
  RproxyRulePatch,
  RproxyRuleStatus,
  addRule,
  deleteRule,
  getRule,
  listRules,
  modifyRule,
} from '@/components/rproxy';
import { mergeStaticRules, ruleFromStatus } from '@/components/dashboard';
import { FORBIDDEN_MESSAGE, NO_ROLE_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE } from '@/components/messages';
import mariadb, { PoolConnection } from 'mariadb';
import { Access, RoleConfig, accessOf, portsAllowed, roleConfig } from '@/components/roles';
import { toHttpRules, validateHttp } from '@/components/httpspec';
import { ExportFormat, exportDoc, extraAddrs, formatDoc, parseDoc, remoteFields, settingsRuleToBody, starttlsFields, toRproxyRule } from '@/components/settingsdoc';
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

type Action = 'ADD' | 'UPDATE' | 'DELETE';
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
  if (errors.length > 0) throw invalid(errors.join(' '));
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

type Undo = () => Promise<unknown>;

// DB の変更 → rproxy への反映 → COMMIT の順に行う。rproxy が失敗したら ROLLBACK する。
// rproxy に反映した後で COMMIT だけが失敗した場合は、undo で rproxy 側を元に戻す。
async function withTransaction(logger: AppLogger, fn: (conn: PoolConnection) => Promise<Undo>): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const undo = await fn(conn);
    try {
      await conn.commit();
    } catch (err) {
      logger.error(`COMMIT に失敗したため rproxy の変更を取り消します: ${err}`);
      await undo().catch((e) => logger.error(`rproxy の変更を取り消せませんでした（DB と rproxy が食い違っています）: ${e}`));
      throw err;
    }
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
  }, extraAddrs(rule));
}

// forward_rules の行（src_port_end と options を含む）をルールにする
function fromRow(row: any): ForwardRule {
  const opts = parseOptions(row.options);
  return {
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
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RproxyError && err.code === 'not_found';
}

async function insertLog(conn: PoolConnection, authId: string, rule: ForwardRule, action: Action): Promise<void> {
  await conn.query(
    'INSERT INTO forward_rules_log (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [authId, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule), action]
  );
}

// rproxy の固定ルール（origin: static）なら返す。ないか、固定ルールでないか、問い合わせできなければ null
async function findStaticRule(key: RproxyRuleKey, logger: AppLogger): Promise<RproxyRuleStatus | null> {
  try {
    const status = await getRule(key);
    return status.origin === 'static' ? status : null;
  } catch (err) {
    if (!isNotFound(err)) logger.warn(`rproxy に固定ルールか問い合わせできません: ${err}`);
    return null;
  }
}

// 固定ルールは rproxy の設定ファイルで管理している（rproxy も PATCH / DELETE を 409 static で拒否する）
function staticRuleError(): HttpError {
  return new HttpError(409, 'このルールは rproxy の固定ルールです。', 'static');
}

// 自分のルール（admin ならだれのルールでも）を行ロックして取得する。なければ 404（rproxy の固定ルールなら 409 static）
async function lockOwnRule(conn: PoolConnection, actor: Actor, key: ForwardRule, logger: AppLogger): Promise<ForwardRule> {
  const owner = ownerClause(actor);
  const rows = await conn.query(
    `SELECT src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ? FOR UPDATE`,
    [...owner.params, key.protocol, key.srcAddr, key.srcPort]
  );
  if (rows.length === 0) {
    if (await findStaticRule(toKey(key), logger)) throw staticRuleError();
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  return fromRow({ ...rows[0], protocol: key.protocol, src_addr: key.srcAddr, src_port: key.srcPort });
}

// DB のルールに rproxy の稼働情報を付ける。status が undefined なら rproxy にない（missing）、
// live が false なら rproxy に問い合わせできなかった（unknown）
function withLiveState(id: number, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined, owner?: string): ForwardRules {
  return {
    id: id,
    origin: 'dynamic',
    ...rule,
    ...(owner !== undefined ? { owner: owner } : {}),
    state: !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
  };
}

// withStatic: rproxy の固定ルール（DB にない）も読み取り専用の行として足す（dashboard）。
// list は自分のルールだけ。admin はすべての利用者のルール（owner 付き）
async function listForwardingRules(actor: Actor, logger: AppLogger, withStatic: boolean): Promise<DashboardData> {
  const admin = actor.access === 'admin';
  const rows = await pool.query(
    `SELECT id, auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${admin ? '' : ' WHERE auth_id = ?'} ORDER BY id`,
    admin ? [] : [actor.id]
  );

  let live: Map<string, RproxyRuleStatus> | null = null;
  let statuses: RproxyRuleStatus[] = [];
  let rproxyError: string | null = null;
  try {
    statuses = await listRules();
    live = new Map(statuses.map((r) => [ruleKeyString(r.protocol, r.listen_addr, r.listen_port), r]));
  } catch (err) {
    logger.warn(`rproxy からルールの状態を取得できません: ${err}`);
    rproxyError = err instanceof Error ? err.message : String(err);
    if (err instanceof RproxyError && err.status === 403) rproxyError = `${FORBIDDEN_MESSAGE}（詳細: ${rproxyError}）`;
    if (err instanceof RproxyError && err.status === 401) rproxyError = `${RPROXY_UNAUTHORIZED_MESSAGE}（詳細: ${rproxyError}）`;
  }

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

// owner：ルールの所有者（既定は操作した利用者。admin が巻き戻し・置き換えで作り直すときは元の所有者）
async function addForwardingRule(actor: Actor, rule: ForwardRule, logger: AppLogger, owner: string = actor.id): Promise<void> {
  checkPorts(actor, rule);
  const authId = actor.id;
  await withTransaction(logger, async (conn) => {
    await conn.query(
      'INSERT INTO forward_rules (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [owner, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
    );
    await insertLog(conn, authId, rule, 'ADD');
    await addRule(toRproxyRule(rule));
    return () => deleteRule(toKey(rule));
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

async function editForwardingRule(actor: Actor, rule: ForwardRule, given: Given, logger: AppLogger): Promise<void> {
  const { range: rangeGiven, allowFrom: allowFromGiven, http: httpGiven, crowdsec: crowdsecGiven } = given;
  const owner = ownerClause(actor);
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, rule, logger);
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
      sourceIp: current.sourceIp,
      srcPortEnd: current.srcPortEnd,
      allowFrom: allowFromGiven ? rule.allowFrom : current.allowFrom,
      crowdsec: crowdsecGiven ? rule.crowdsec : current.crowdsec,
      http: http,
      ...balancing,
      ...(http !== null || balancing.targets.length > 0 ? { distAddr: '', distPort: 0 } : {}),
      extraListenAddrs: given.extraListenAddrs ? extraAddrs(rule) : extraAddrs(current),
    };
    try {
      // 範囲が DB の値になったので、転送先ポートと routes の範囲をもう一度確かめる
      const count = portCount(updated.srcPort, updated.srcPortEnd, updated.distPort);
      checkTls(updated.protocol, updated.tls, updated.starttls, count, updated.http !== null);
      checkBalancing(updated.protocol, updated, count);
    } catch (err) {
      throw fromTlsError(err);
    }
    await conn.query(
      `UPDATE forward_rules SET dist_addr = ?, dist_port = ?, udp_idle_secs = ?, options = ? WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ?`,
      [updated.distAddr, updated.distPort, updated.udpIdleSecs, options(updated), ...owner.params, updated.protocol, updated.srcAddr, updated.srcPort]
    );
    // 履歴の auth_id は操作した利用者（admin がほかの人のルールを変えたときは admin）
    await insertLog(conn, actor.id, updated, 'UPDATE');
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
}

async function deleteForwardingRule(actor: Actor, key: ForwardRule, logger: AppLogger): Promise<void> {
  const owner = ownerClause(actor);
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, actor, key, logger);
    await conn.query(
      `DELETE FROM forward_rules WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ?`,
      [...owner.params, key.protocol, key.srcAddr, key.srcPort]
    );
    await insertLog(conn, actor.id, current, 'DELETE');
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
async function replaceForwardingRule(actor: Actor, rule: ForwardRule, logger: AppLogger): Promise<'modified' | 'recreated'> {
  const owner = ownerClause(actor);
  const rows = await pool.query(
    `SELECT auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE ${owner.sql}protocol = ? AND src_addr = ? AND src_port = ?`,
    [...owner.params, rule.protocol, rule.srcAddr, rule.srcPort]
  );
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  const current = fromRow(rows[0]);
  const ownerId = String(rows[0].auth_id);
  if (!needsRecreate(current, rule)) {
    await editForwardingRule(actor, rule, ALL_GIVEN, logger);
    return 'modified';
  }
  await deleteForwardingRule(actor, rule, logger);
  try {
    await addForwardingRule(actor, rule, logger, ownerId);
  } catch (err) {
    // 作れなかったら元のルールを戻す
    await addForwardingRule(actor, current, logger, ownerId)
      .catch((e) => logger.error(`置き換えに失敗し、元のルールも戻せませんでした（DB と rproxy から消えています）: ${e}`));
    throw err;
  }
  return 'recreated';
}

function errorText(err: unknown): string {
  if (err instanceof HttpError || err instanceof RproxyError || err instanceof TlsError) return err.message;
  if (isDuplicateEntry(err)) return '同じプロトコル・アドレス・ポートのルールが既に存在します。';
  return err instanceof Error ? err.message : String(err);
}

// ---- エクスポート / インポート（#60） ----

// GET /api/forward/export?format=yaml|json[&owner=]。利用者は自分のルール、admin はすべて（owner で絞れる）
async function exportRules(actor: Actor, query: NextApiRequest['query']): Promise<{ body: string; format: ExportFormat; count: number }> {
  const format: ExportFormat = queryString(query.format) === 'json' ? 'json' : 'yaml';
  const ownerFilter = actor.access === 'admin' ? queryString(query.owner) : actor.id;
  const rows = await pool.query(
    `SELECT protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules${ownerFilter ? ' WHERE auth_id = ?' : ''} ORDER BY protocol, src_addr, src_port`,
    ownerFilter ? [ownerFilter] : []
  );
  const rules: ForwardRule[] = rows.map(fromRow);
  const header = `rproxy のルール（TCP-UDP-rproxy-ui からエクスポート。${new Date().toISOString()}、${rules.length} 件）\nrproxy の設定ファイル（RPROXY_CONFIG）と同じ形。UI の「インポート」で読み込める`;
  return { body: formatDoc(exportDoc(rules), format, header), format: format, count: rules.length };
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
async function inspectImport(actor: Actor, text: unknown, logger: AppLogger): Promise<{ items: ImportItem[]; ignoredGlobal: boolean }> {
  if (typeof text !== 'string' || text.trim() === '') throw invalid('読み込む内容（YAML / JSON）がありません。');
  let doc;
  try {
    doc = parseDoc(text);
  } catch (err) {
    throw fromTlsError(err);
  }
  if (doc.rules.length > MAX_IMPORT_RULES) throw invalid(`一度に読み込めるルールは ${MAX_IMPORT_RULES} 件までです。`);

  const rows = await pool.query('SELECT auth_id, protocol, src_addr, src_port FROM forward_rules');
  const owners = new Map<string, string>(rows.map((r: any): [string, string] => [ruleKeyString(r.protocol, r.src_addr, Number(r.src_port)), String(r.auth_id)]));
  let statics: Set<string> | null = null;
  try {
    statics = new Set((await listRules()).filter((r) => r.origin === 'static').map((r) => ruleKeyString(r.protocol, r.listen_addr, r.listen_port)));
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
async function importRules(actor: Actor, body: any, logger: AppLogger) {
  const { items, ignoredGlobal } = await inspectImport(actor, body?.text, logger);
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
        await addForwardingRule(actor, item.rule, logger);
        results.push({ index: item.index, key: item.key, result: 'added' });
      } else {
        await replaceForwardingRule(actor, item.rule, logger);
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
  return {
    sql: '(l.auth_id = ? OR EXISTS (SELECT 1 FROM forward_rules r WHERE r.auth_id = ? AND r.protocol = l.protocol AND r.src_addr = l.src_addr AND r.src_port = l.src_port))',
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
  const user = queryString(query.user);
  if (user && actor.access === 'admin') {
    where.push('l.auth_id = ?');
    params.push(user);
  }
  const action = queryString(query.action).toUpperCase();
  if (action) {
    if (!HISTORY_ACTIONS.includes(action as HistoryAction)) throw invalid('action は ADD / UPDATE / DELETE のどれかです。');
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
    `SELECT ${LOG_SELECT} FROM forward_rules_log l${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage]
  );

  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    const rule = logRule(row);
    const act = String(row.update_action) as HistoryAction;
    let changes: string[] = [];
    if (act === 'UPDATE' && rule !== null) {
      // 同じルールの 1 つ前の版（差分を作るためだけに読む）
      const prev = await pool.query(
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
      rule: rule,
      changes: changes,
      revertible: rule !== null,
    });
  }
  return { entries: entries, total: total, page: page, perPage: perPage };
}

// POST /api/forward/revert {id}：履歴の版の内容に戻す（あれば置き換え、削除されていれば作り直す）。巻き戻しも履歴に残る
async function revertToVersion(actor: Actor, body: any, logger: AppLogger): Promise<{ result: 'added' | 'modified' | 'recreated' }> {
  const id = body?.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw invalid('履歴の id を指定してください。');
  const scope = historyScope(actor);
  const rows = await pool.query(
    `SELECT ${LOG_SELECT} FROM forward_rules_log l WHERE ${scope.sql ? `${scope.sql} AND ` : ''}l.id = ?`,
    [...scope.params, id]
  );
  if (rows.length === 0) throw new HttpError(404, '履歴が見つかりません。', 'not_found');
  const rule = logRule(rows[0]);
  if (rule === null) throw invalid('この履歴の内容は読めないため、巻き戻せません。');
  if (await findStaticRule(toKey(rule), logger)) throw staticRuleError();

  const current = await pool.query(
    'SELECT auth_id FROM forward_rules WHERE protocol = ? AND src_addr = ? AND src_port = ?',
    [rule.protocol, rule.srcAddr, rule.srcPort]
  );
  if (current.length === 0) {
    await addForwardingRule(actor, rule, logger);
    return { result: 'added' };
  }
  if (actor.access !== 'admin' && String(current[0].auth_id) !== actor.id) {
    throw new HttpError(403, '同じキーのルールをほかの利用者が使っているため、巻き戻せません。', 'forbidden_owner');
  }
  return { result: await replaceForwardingRule(actor, rule, logger) };
}

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as any).errno === 1062 || (err as any).code === 'ER_DUP_ENTRY');
}

function sendError(res: NextApiResponse, err: unknown, logger: AppLogger) {
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
  const actor: Actor = { id: id, access: access, roles: roles };

  try {
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
      res.setHeader('Content-Type', out.format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rproxy-rules-${date}.${out.format === 'json' ? 'json' : 'yaml'}"`);
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
        await addForwardingRule(actor, parseRule(req.body, false), logger);
        logger.info('Forwarding rule added successfully');
        return res.status(200).json({ message: 'Forwarding rule added successfully' });
      } else if (query === 'modify') {
        await editForwardingRule(actor, parseRule(req.body, false, true), {
          range: hasRangeEnd(req.body),
          allowFrom: hasAllowFrom(req.body),
          http: hasHttp(req.body),
          crowdsec: hasCrowdsec(req.body),
          targets: hasTargets(req.body),
          extraListenAddrs: hasExtraListenAddrs(req.body),
        }, logger);
        logger.info('Forwarding rule modified successfully');
        return res.status(200).json({ message: 'Forwarding rule modified successfully' });
      } else if (query === 'import') {
        const out = await importRules(actor, req.body, logger);
        return res.status(200).json(out);
      } else if (query === 'revert') {
        const out = await revertToVersion(actor, req.body, logger);
        logger.info(`Reverted to history ${req.body?.id} (${out.result})`);
        return res.status(200).json(out);
      } else if (query === 'delete') {
        await deleteForwardingRule(actor, parseRule(req.body, true), logger);
        logger.info('Forwarding rule deleted successfully');
        return res.status(200).json({ message: 'Forwarding rule deleted successfully' });
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  } catch (err) {
    return sendError(res, err, logger);
  }
}
