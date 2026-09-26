import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { isIP } from 'net';
import {
  DEFAULT_UDP_IDLE_SECS,
  DashboardData,
  ForwardRule,
  ForwardRules,
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
  normalizeAllowFrom,
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
import { FORBIDDEN_MESSAGE } from '@/components/messages';
import mariadb, { PoolConnection } from 'mariadb';

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
    // フォームではまだ L7 のルールを作れない（UI #34）。変更では DB の値を保つ
    http: null,
  };
  if (keyOnly) return rule;

  const withoutRemote = forModify && noRemote(body);
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
  checkTls(protocol as Protocol, tls, starttls, count);
  const allowFrom = normalizeAllowFrom(body.allowFrom);

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
  };
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

// starttls / starttls_required は STARTTLS を使うときだけ付ける
function starttlsFields(rule: ForwardRule) {
  return rule.starttls !== null ? { starttls: rule.starttls, starttls_required: rule.starttlsRequired } : {};
}

// 転送先。http のルールは remote_addr / remote_port を書かず、http を付ける（書くと rproxy が invalid を返す）
function remoteFields(rule: ForwardRule) {
  return rule.http !== null
    ? { http: rule.http }
    : { remote_addr: rule.distAddr, remote_port: rule.distPort };
}

function toRproxyRule(rule: ForwardRule): RproxyRule {
  return {
    protocol: rule.protocol,
    listen_addr: rule.srcAddr,
    listen_port: rule.srcPort,
    ...(rule.srcPortEnd !== null ? { listen_port_end: rule.srcPortEnd } : {}),
    ...remoteFields(rule),
    source_ip: rule.sourceIp,
    udp_idle_secs: rule.udpIdleSecs,
    tls: rule.tls,
    ...starttlsFields(rule),
    ...(rule.allowFrom.length > 0 ? { allow_from: rule.allowFrom } : {}),
  };
}

// PATCH では tls と allow_from を毎回付けて丸ごと置き換える（allow_from の [] はすべて許可に戻す）。
// http のルールは http を付けて L7 の設定も丸ごと置き換える。範囲と source_ip は変えられないので送らない
function toRproxyPatch(rule: ForwardRule): RproxyRulePatch {
  return {
    ...remoteFields(rule),
    ...(rule.protocol === 'udp' ? { udp_idle_secs: rule.udpIdleSecs } : {}),
    tls: rule.tls,
    ...starttlsFields(rule),
    allow_from: rule.allowFrom,
  };
}

function options(rule: ForwardRule): string | null {
  return optionsJson(rule.tls, rule.starttls, rule.starttlsRequired, rule.allowFrom, rule.http);
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

// 自分のルールを行ロックして取得する。なければ 404（rproxy の固定ルールなら 409 static）
async function lockOwnRule(conn: PoolConnection, authId: string, key: ForwardRule, logger: AppLogger): Promise<ForwardRule> {
  const rows = await conn.query(
    'SELECT src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ? FOR UPDATE',
    [authId, key.protocol, key.srcAddr, key.srcPort]
  );
  if (rows.length === 0) {
    if (await findStaticRule(toKey(key), logger)) throw staticRuleError();
    throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  }
  return fromRow({ ...rows[0], protocol: key.protocol, src_addr: key.srcAddr, src_port: key.srcPort });
}

// DB のルールに rproxy の稼働情報を付ける。status が undefined なら rproxy にない（missing）、
// live が false なら rproxy に問い合わせできなかった（unknown）
function withLiveState(id: number, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined): ForwardRules {
  return {
    id: id,
    origin: 'dynamic',
    ...rule,
    state: !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
  };
}

// withStatic: rproxy の固定ルール（DB にない）も読み取り専用の行として足す（dashboard）。list は自分のルールだけ
async function listForwardingRules(authId: string, logger: AppLogger, withStatic: boolean): Promise<DashboardData> {
  const rows = await pool.query(
    'SELECT id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE auth_id = ? ORDER BY id',
    [authId]
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
  }

  const rules = rows.map((row: any): ForwardRules => {
    const rule = fromRow(row);
    return withLiveState(Number(row.id), rule, live !== null, live?.get(ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort)));
  });
  return { reachable: live !== null, rproxyError: rproxyError, rules: withStatic ? mergeStaticRules(rules, statuses) : rules };
}

function queryString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// GET /api/forward/rule?protocol=&addr=&port= の 1 件。自分のルールか、rproxy の固定ルール（だれのものでもない）でなければ 404
async function getForwardingRule(authId: string, query: NextApiRequest['query'], logger: AppLogger): Promise<ForwardRules> {
  const protocol = queryString(query.protocol).toLowerCase();
  if (protocol !== 'tcp' && protocol !== 'udp') throw invalid('プロトコルは tcp か udp を指定してください。');
  const addr = queryString(query.addr);
  if (isIP(addr) === 0) throw invalid('addr には IP アドレスを指定してください。');
  const portText = queryString(query.port);
  const port = /^[0-9]+$/.test(portText) ? Number(portText) : NaN;
  if (!isPort(port)) throw invalid('ポート番号は1から65535の範囲で指定してください。');
  const key: RproxyRuleKey = { protocol: protocol as Protocol, listen_addr: normalizeAddr(addr), listen_port: port };

  const rows = await pool.query(
    'SELECT id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
    [authId, key.protocol, key.listen_addr, key.listen_port]
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
  return withLiveState(Number(rows[0].id), rule, live, status);
}

async function addForwardingRule(authId: string, rule: ForwardRule, logger: AppLogger): Promise<void> {
  await withTransaction(logger, async (conn) => {
    await conn.query(
      'INSERT INTO forward_rules (auth_id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [authId, rule.protocol, rule.srcAddr, rule.srcPort, rule.srcPortEnd, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, options(rule)]
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

async function editForwardingRule(authId: string, rule: ForwardRule, rangeGiven: boolean, allowFromGiven: boolean, logger: AppLogger): Promise<void> {
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, authId, rule, logger);
    // ポート範囲は変更できない（API の制約）。指定があれば DB の値と同じでなければならない
    if (rangeGiven && rule.srcPortEnd !== current.srcPortEnd) {
      throw new HttpError(400, 'ポート範囲は変更できません。削除してから作り直してください。', 'unsupported');
    }
    // L7 のルール（http）はフォームで送らないので DB の値を保つ（転送先は持たない）。
    // L7 でないルールには転送先が必須
    if (current.http === null && rule.distAddr === '') {
      throw invalid('Destination Address には IP アドレスかホスト名を指定してください。');
    }
    // source_ip は変更できないので DB の値を使う。allow_from は指定があるときだけ置き換える
    const updated: ForwardRule = {
      ...rule,
      sourceIp: current.sourceIp,
      srcPortEnd: current.srcPortEnd,
      allowFrom: allowFromGiven ? rule.allowFrom : current.allowFrom,
      http: current.http,
      ...(current.http !== null ? { distAddr: '', distPort: 0 } : {}),
    };
    try {
      // 範囲が DB の値になったので、転送先ポートと routes の範囲をもう一度確かめる
      checkTls(updated.protocol, updated.tls, updated.starttls, portCount(updated.srcPort, updated.srcPortEnd, updated.distPort));
    } catch (err) {
      throw fromTlsError(err);
    }
    await conn.query(
      'UPDATE forward_rules SET dist_addr = ?, dist_port = ?, udp_idle_secs = ?, options = ? WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
      [updated.distAddr, updated.distPort, updated.udpIdleSecs, options(updated), authId, updated.protocol, updated.srcAddr, updated.srcPort]
    );
    await insertLog(conn, authId, updated, 'UPDATE');
    try {
      await modifyRule(toKey(updated), toRproxyPatch(updated));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // rproxy にないルール（missing）は作り直す
      logger.warn('rproxy にルールがないため、変更後の内容で作り直します');
      await addRule(toRproxyRule(updated));
      return () => deleteRule(toKey(updated));
    }
    // 元の転送先・TLS の設定・allow_from に戻す
    return () => modifyRule(toKey(current), toRproxyPatch(current));
  });
}

async function deleteForwardingRule(authId: string, key: ForwardRule, logger: AppLogger): Promise<void> {
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, authId, key, logger);
    await conn.query(
      'DELETE FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
      [authId, key.protocol, key.srcAddr, key.srcPort]
    );
    await insertLog(conn, authId, current, 'DELETE');
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

  try {
    if (req.method === 'GET' && query === 'list') {
      const data = await listForwardingRules(id, logger, false);
      return res.status(200).json(data.rules);
    }
    if (req.method === 'GET' && query === 'dashboard') {
      const data = await listForwardingRules(id, logger, true);
      return res.status(200).json(data);
    }
    if (req.method === 'GET' && query === 'rule') {
      // 先に取得してから status を呼ぶ（失敗したら sendError がステータスを決める）
      const rule = await getForwardingRule(id, req.query, logger);
      return res.status(200).json(rule);
    }

    if (req.method === 'POST') {
      if (query === 'add') {
        await addForwardingRule(id, parseRule(req.body, false), logger);
        logger.info('Forwarding rule added successfully');
        return res.status(200).json({ message: 'Forwarding rule added successfully' });
      } else if (query === 'modify') {
        await editForwardingRule(id, parseRule(req.body, false, true), hasRangeEnd(req.body), hasAllowFrom(req.body), logger);
        logger.info('Forwarding rule modified successfully');
        return res.status(200).json({ message: 'Forwarding rule modified successfully' });
      } else if (query === 'delete') {
        await deleteForwardingRule(id, parseRule(req.body, true), logger);
        logger.info('Forwarding rule deleted successfully');
        return res.status(200).json({ message: 'Forwarding rule deleted successfully' });
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  } catch (err) {
    return sendError(res, err, logger);
  }
}
