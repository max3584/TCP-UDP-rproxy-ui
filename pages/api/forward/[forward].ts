import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { isIP } from 'net';
import {
  DEFAULT_UDP_IDLE_SECS,
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
  RproxyError,
  RproxyRuleKey,
  RproxyRuleStatus,
  addRule,
  deleteRule,
  listRules,
  modifyRule,
} from '@/components/rproxy';
import mariadb, { PoolConnection } from 'mariadb';

// MariaDBのコネクションプールを作成
const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 10,
});

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

// 入力を検証して正規化する。delete ではキー（protocol, srcAddr, srcPort）だけを使う
function parseRule(body: any, keyOnly: boolean): ForwardRule {
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
    distAddr: '',
    distPort: 0,
    sourceIp: 'proxy',
    udpIdleSecs: DEFAULT_UDP_IDLE_SECS,
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

  return {
    ...rule,
    distAddr: distAddr,
    distPort: body.distPort,
    sourceIp: sourceIp as SourceIp,
    udpIdleSecs: udpIdleSecs,
  };
}

async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

async function insertLog(conn: PoolConnection, rule: ForwardRule, action: Action): Promise<void> {
  await conn.query(
    'INSERT INTO forward_rules_log (protocol, src_addr, src_port, dist_addr, dist_port, source_ip, udp_idle_secs, update_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [rule.protocol, rule.srcAddr, rule.srcPort, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs, action]
  );
}

// 自分のルールを行ロックして取得する。なければ 404
async function lockOwnRule(conn: PoolConnection, authId: string, key: ForwardRule): Promise<ForwardRule> {
  const rows = await conn.query(
    'SELECT dist_addr, dist_port, source_ip, udp_idle_secs FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ? FOR UPDATE',
    [authId, key.protocol, key.srcAddr, key.srcPort]
  );
  if (rows.length === 0) throw new HttpError(404, 'ルールが見つかりません。', 'not_found');
  const row = rows[0];
  return {
    ...key,
    distAddr: row.dist_addr,
    distPort: Number(row.dist_port),
    sourceIp: row.source_ip,
    udpIdleSecs: Number(row.udp_idle_secs),
  };
}

async function listForwardingRules(authId: string, logger: AppLogger): Promise<ForwardRules[]> {
  const rows = await pool.query(
    'SELECT id, protocol, src_addr, src_port, dist_addr, dist_port, source_ip, udp_idle_secs FROM forward_rules WHERE auth_id = ? ORDER BY id',
    [authId]
  );

  let live: Map<string, RproxyRuleStatus> | null = null;
  try {
    const status = await listRules();
    live = new Map(status.map((r) => [ruleKeyString(r.protocol, r.listen_addr, r.listen_port), r]));
  } catch (err) {
    logger.warn(`rproxy からルールの状態を取得できません: ${err}`);
  }

  return rows.map((row: any): ForwardRules => {
    const protocol = String(row.protocol).toLowerCase() as Protocol;
    const srcPort = Number(row.src_port);
    const status = live?.get(ruleKeyString(protocol, row.src_addr, srcPort));
    return {
      id: Number(row.id),
      protocol: protocol,
      srcAddr: row.src_addr,
      srcPort: srcPort,
      distAddr: row.dist_addr,
      distPort: Number(row.dist_port),
      sourceIp: row.source_ip,
      udpIdleSecs: Number(row.udp_idle_secs),
      state: live === null ? 'unknown' : status ? status.state : 'missing',
      error: status?.error ?? null,
      connections: status?.connections ?? null,
    };
  });
}

async function addForwardingRule(authId: string, rule: ForwardRule): Promise<void> {
  await withTransaction(async (conn) => {
    await conn.query(
      'INSERT INTO forward_rules (auth_id, protocol, src_addr, src_port, dist_addr, dist_port, source_ip, udp_idle_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [authId, rule.protocol, rule.srcAddr, rule.srcPort, rule.distAddr, rule.distPort, rule.sourceIp, rule.udpIdleSecs]
    );
    await insertLog(conn, rule, 'ADD');
    await addRule({
      protocol: rule.protocol,
      listen_addr: rule.srcAddr,
      listen_port: rule.srcPort,
      remote_addr: rule.distAddr,
      remote_port: rule.distPort,
      source_ip: rule.sourceIp,
      udp_idle_secs: rule.udpIdleSecs,
    });
  });
}

async function editForwardingRule(authId: string, rule: ForwardRule): Promise<void> {
  await withTransaction(async (conn) => {
    const current = await lockOwnRule(conn, authId, rule);
    // source_ip は変更できないので DB の値を使う
    const updated: ForwardRule = { ...rule, sourceIp: current.sourceIp };
    await conn.query(
      'UPDATE forward_rules SET dist_addr = ?, dist_port = ?, udp_idle_secs = ? WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
      [updated.distAddr, updated.distPort, updated.udpIdleSecs, authId, updated.protocol, updated.srcAddr, updated.srcPort]
    );
    await insertLog(conn, updated, 'UPDATE');
    await modifyRule(toKey(updated), {
      remote_addr: updated.distAddr,
      remote_port: updated.distPort,
      ...(updated.protocol === 'udp' ? { udp_idle_secs: updated.udpIdleSecs } : {}),
    });
  });
}

async function deleteForwardingRule(authId: string, key: ForwardRule): Promise<void> {
  await withTransaction(async (conn) => {
    const current = await lockOwnRule(conn, authId, key);
    await conn.query(
      'DELETE FROM forward_rules WHERE auth_id = ? AND protocol = ? AND src_addr = ? AND src_port = ?',
      [authId, key.protocol, key.srcAddr, key.srcPort]
    );
    await insertLog(conn, current, 'DELETE');
    try {
      await deleteRule(toKey(key));
    } catch (err) {
      // rproxy 側に既にないなら削除済みとして扱う
      if (!(err instanceof RproxyError && err.code === 'not_found')) throw err;
    }
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
      const rules = await listForwardingRules(id, logger);
      return res.status(200).json(rules);
    }

    if (req.method === 'POST') {
      if (query === 'add') {
        await addForwardingRule(id, parseRule(req.body, false));
        logger.info('Forwarding rule added successfully');
        return res.status(200).json({ message: 'Forwarding rule added successfully' });
      } else if (query === 'modify') {
        await editForwardingRule(id, parseRule(req.body, false));
        logger.info('Forwarding rule modified successfully');
        return res.status(200).json({ message: 'Forwarding rule modified successfully' });
      } else if (query === 'delete') {
        await deleteForwardingRule(id, parseRule(req.body, true));
        logger.info('Forwarding rule deleted successfully');
        return res.status(200).json({ message: 'Forwarding rule deleted successfully' });
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  } catch (err) {
    return sendError(res, err, logger);
  }
}
