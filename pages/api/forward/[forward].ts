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

// 入力を検証して正規化する。delete ではキー（protocol, srcAddr, srcPort）だけを使う
function parseRule(body: any, keyOnly: boolean): ForwardRule {
  try {
    return parseRuleInner(body, keyOnly);
  } catch (err) {
    throw fromTlsError(err);
  }
}

function parseRuleInner(body: any, keyOnly: boolean): ForwardRule {
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
  };
  if (keyOnly) return rule;

  const distAddr = typeof body.distAddr === 'string' ? body.distAddr.trim() : '';
  if (isIP(distAddr) === 0 && !HOSTNAME_PATTERN.test(distAddr)) {
    throw invalid('Destination Address には IP アドレスかホスト名を指定してください。');
  }
  if (!isPort(body.distPort)) throw invalid('ポート番号は1から65535の範囲で指定してください。');

  const sourceIp = body.sourceIp ?? 'proxy';
  if (!SOURCE_IPS.includes(sourceIp)) throw invalid('source_ip の指定が不正です。');
  if (protocol === 'udp' && TCP_ONLY_SOURCE_IPS.includes(sourceIp)) {
    throw invalid(`${sourceIp} は TCP でのみ使えます。`);
  }
  if (sourceIp === 'transparent' && isIP(srcAddr) !== 4) {
    throw invalid('transparent は IPv4 でのみ使えます。');
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
  const count = portCount(body.srcPort, srcPortEnd, body.distPort);

  const tls = normalizeTls(body.tls);
  const starttls = normalizeStartTls(body.starttls);
  const starttlsRequired = normalizeStartTlsRequired(body.starttlsRequired, starttls);
  checkTls(protocol as Protocol, tls, starttls, count);

  return {
    ...rule,
    srcPortEnd: srcPortEnd,
    distAddr: distAddr,
    distPort: body.distPort,
    sourceIp: sourceIp as SourceIp,
    udpIdleSecs: udpIdleSecs,
    tls: tls,
    starttls: starttls,
    starttlsRequired: starttlsRequired,
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

function toRproxyRule(rule: ForwardRule): RproxyRule {
  return {
    protocol: rule.protocol,
    listen_addr: rule.srcAddr,
    listen_port: rule.srcPort,
    ...(rule.srcPortEnd !== null ? { listen_port_end: rule.srcPortEnd } : {}),
    remote_addr: rule.distAddr,
    remote_port: rule.distPort,
    source_ip: rule.sourceIp,
    udp_idle_secs: rule.udpIdleSecs,
    tls: rule.tls,
    ...starttlsFields(rule),
  };
}

// PATCH では tls を毎回付けて TLS の設定を丸ごと置き換える（範囲と source_ip は変えられないので送らない）
function toRproxyPatch(rule: ForwardRule): RproxyRulePatch {
  return {
    remote_addr: rule.distAddr,
    remote_port: rule.distPort,
    ...(rule.protocol === 'udp' ? { udp_idle_secs: rule.udpIdleSecs } : {}),
    tls: rule.tls,
    ...starttlsFields(rule),
  };
}

function options(rule: ForwardRule): string | null {
  return optionsJson(rule.tls, rule.starttls, rule.starttlsRequired);
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

// 自分のルールを行ロックして取得する。なければ 404
async function lockOwnRule(conn: PoolConnection, authId: string, key: ForwardRule): Promise<ForwardRule> {
  const rows = await conn.query(
    'SELECT src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ? FOR UPDATE',
    [authId, key.protocol, key.srcAddr, key.srcPort]
  );
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  return fromRow({ ...rows[0], protocol: key.protocol, src_addr: key.srcAddr, src_port: key.srcPort });
}

// DB のルールに rproxy の稼働情報を付ける。status が undefined なら rproxy にない（missing）、
// live が false なら rproxy に問い合わせできなかった（unknown）
function withLiveState(id: number, rule: ForwardRule, live: boolean, status: RproxyRuleStatus | undefined): ForwardRules {
  return {
    id: id,
    ...rule,
    state: !live ? 'unknown' : status ? status.state : 'missing',
    error: status?.error ?? null,
    connections: status?.connections ?? null,
    stats: status?.stats ?? null,
    startedAt: status?.started_at ?? null,
    resolved: status?.resolved ?? [],
  };
}

async function listForwardingRules(authId: string, logger: AppLogger): Promise<DashboardData> {
  const rows = await pool.query(
    'SELECT id, protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options FROM forward_rules WHERE auth_id = ? ORDER BY id',
    [authId]
  );

  let live: Map<string, RproxyRuleStatus> | null = null;
  let rproxyError: string | null = null;
  try {
    const status = await listRules();
    live = new Map(status.map((r) => [ruleKeyString(r.protocol, r.listen_addr, r.listen_port), r]));
  } catch (err) {
    logger.warn(`rproxy からルールの状態を取得できません: ${err}`);
    rproxyError = err instanceof Error ? err.message : String(err);
  }

  const rules = rows.map((row: any): ForwardRules => {
    const rule = fromRow(row);
    return withLiveState(Number(row.id), rule, live !== null, live?.get(ruleKeyString(rule.protocol, rule.srcAddr, rule.srcPort)));
  });
  return { reachable: live !== null, rproxyError: rproxyError, rules: rules };
}

function queryString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// GET /api/forward/rule?protocol=&addr=&port= の 1 件。自分のルールでなければ 404
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
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
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

async function editForwardingRule(authId: string, rule: ForwardRule, rangeGiven: boolean, logger: AppLogger): Promise<void> {
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, authId, rule);
    // ポート範囲は変更できない（API の制約）。指定があれば DB の値と同じでなければならない
    if (rangeGiven && rule.srcPortEnd !== current.srcPortEnd) {
      throw new HttpError(400, 'ポート範囲は変更できません。削除してから作り直してください。', 'unsupported');
    }
    // source_ip は変更できないので DB の値を使う
    const updated: ForwardRule = { ...rule, sourceIp: current.sourceIp, srcPortEnd: current.srcPortEnd };
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
    // 元の転送先と TLS の設定に戻す
    return () => modifyRule(toKey(current), toRproxyPatch(current));
  });
}

async function deleteForwardingRule(authId: string, key: ForwardRule, logger: AppLogger): Promise<void> {
  await withTransaction(logger, async (conn) => {
    const current = await lockOwnRule(conn, authId, key);
    await conn.query(
      'DELETE FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
      [authId, key.protocol, key.srcAddr, key.srcPort]
    );
    await insertLog(conn, authId, current, 'DELETE');
    try {
      await deleteRule(toKey(key));
    } catch (err) {
      // rproxy 側に既にないなら削除済みとして扱う
      if (!isNotFound(err)) throw err;
      return async () => undefined;
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
      const data = await listForwardingRules(id, logger);
      return res.status(200).json(data.rules);
    }
    if (req.method === 'GET' && query === 'dashboard') {
      const data = await listForwardingRules(id, logger);
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
        await editForwardingRule(id, parseRule(req.body, false), hasRangeEnd(req.body), logger);
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
