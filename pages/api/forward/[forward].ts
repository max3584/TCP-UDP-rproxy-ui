import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { ForwardRule, Logger, sessionUser } from '@/components/lib';
import mariadb from 'mariadb';

// MariaDBのコネクションプールを作成
const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 1000,
});

// ForwardingRuleインターフェースの定義
interface ForwardRuleDB extends ForwardRule {
  auth_id: string | null;
}

type action = 'ADD' | 'UPDATE' | 'DELETE';

interface ForwardRuleLogDB extends ForwardRule {
  action: action;
}

async function getForwardingRule(id: string): Promise<ForwardRule[]> {
  let conn: mariadb.PoolConnection | null = null;
  let rules: ForwardRule[] = [];
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      'SELECT protocol, src_addr, src_port, dist_addr, dist_port FROM forward_rules WHERE auth_id = ?',
      [id]
    );
    for (const row of rows) {
      rules.push({
        protocol: row.protocol,
        srcAddr: row.src_addr,
        srcPort: row.src_port,
        distAddr: row.dist_addr,
        distPort: row.dist_port
      });
    }
    return rules;
  } catch (err) {
    throw err;
  } finally {
    if (conn) conn.release(); // コネクションをプールに返す
  }
}

async function updateForwardingRuleLog(conn: mariadb.PoolConnection, log: ForwardRuleLogDB): Promise<void> {
  await conn.query(
    'INSERT INTO forward_rules_log (protocol, src_addr, src_port, dist_addr, dist_port, update_action) VALUES (?, ?, ?, ?, ?, ?)',
    [log.protocol, log.srcAddr, log.srcPort, log.distAddr, log.distPort, log.action]
  );
}

// DBにforwarding ruleを追加する関数
async function addForwardingRule(rule: ForwardRuleDB): Promise<void> {
  let conn: mariadb.PoolConnection | null = null;
  const update_log: ForwardRuleLogDB = {
    protocol: rule.protocol,
    srcAddr: rule.srcAddr,
    srcPort: rule.srcPort,
    distAddr: rule.distAddr,
    distPort: rule.distPort,
    action: 'ADD',
  };
  try {
    conn = await pool.getConnection();
    await conn.query(
      'INSERT INTO forward_rules (auth_id, src_addr, src_port, dist_addr, dist_port) VALUES (?, ?, ?, ?, ?)',
      [rule.auth_id, rule.srcAddr, rule.srcPort, rule.distAddr, rule.distPort]
    );
    updateForwardingRuleLog(conn, update_log);
  } catch (err) {
    throw err;
  } finally {
    if (conn) conn.release(); // コネクションをプールに返す
  }
}

async function deleteForwardingRule(rule: ForwardRuleDB): Promise<void> {
  let conn: mariadb.PoolConnection | null = null;
  const update_log: ForwardRuleLogDB = {
    protocol: rule.protocol,
    srcAddr: rule.srcAddr,
    srcPort: rule.srcPort,
    distAddr: rule.distAddr,
    distPort: rule.distPort,
    action: 'DELETE',
  };
  try {
    conn = await pool.getConnection();
    await conn.query(
      'DELETE FROM forward_rules WHERE auth_id = ? AND src_addr = ? AND src_port = ?',
      [rule.auth_id, rule.srcAddr, rule.srcPort]
    );
    updateForwardingRuleLog(conn, update_log);
  } catch (err) {
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

async function editForwardingRule(rule: ForwardRuleDB): Promise<void> {
  let conn: mariadb.PoolConnection | null = null;
  let update_log: ForwardRuleLogDB = {
    protocol: rule.protocol,
    srcAddr: rule.srcAddr,
    srcPort: rule.srcPort,
    distAddr: rule.distAddr,
    distPort: rule.distPort,
    action: 'UPDATE',
  };
  try {
    conn = await pool.getConnection();
    await conn.query(
      'UPDATE forward_rules SET dist_addr = ?, dist_port = ? WHERE auth_id = ? AND src_addr = ? AND src_port = ?',
      [rule.distAddr, rule.distPort, rule.auth_id, rule.srcAddr, rule.srcPort]
    );
    updateForwardingRuleLog(conn, update_log);
  } catch (err) {
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

function validation(rule: ForwardRule): boolean {
  return (
    typeof rule.srcAddr !== 'string' ||
    typeof rule.srcPort !== 'number' ||
    typeof rule.distAddr !== 'string' ||
    typeof rule.distPort !== 'number' ||
    rule.srcPort <= 0 ||
    rule.distPort <= 0
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {

  // sessionを取得
  const session: sessionUser = await getServerSession(req, res, authOptions) || null;

  // query data from the request
  let query = req.query.forward;

  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  } else if (req.method === 'POST') {
    
    let id = session.user.id;
    if (typeof id === null || typeof id === undefined) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const logger = Logger('info', { auth_id: id, action: query});

    try {
      if (query === 'add') {
        let t: any = req.body;
        const rule: ForwardRule = {
          protocol: t.protocol,
          srcAddr: t.srcAddr,
          srcPort: t.srcPort,
          distAddr: t.distAddr,
          distPort: t.distPort
        };
        // データのバリデーションを行うことを推奨
        // 例: srcPortとdistPortが正の整数かを確認する
        if (validation(rule)) {
          logger.error('Invalid input data');
          return res.status(400).json({ error: 'Invalid input data' });
        }

        const insertRule: ForwardRuleDB = {
          auth_id: id as string,
          protocol: rule.protocol,
          srcAddr: rule.srcAddr,
          srcPort: rule.srcPort,
          distAddr: rule.distAddr,
          distPort: rule.distPort
        };

        // Forwarding ruleをDBに追加
        await addForwardingRule(insertRule);

        // 成功レスポンスを返す
        logger.info('Forwarding rule added successfully');
        res.status(200).json({ message: 'Forwarding rule added successfully' });
      } else if (query === 'delete') {
        // ルールを削除する処理
        let t: any = req.body;
        let rule: ForwardRule = {
          protocol: t.protocol,
          srcAddr: t.srcAddr,
          srcPort: t.srcPort,
          distAddr: t.distAddr,
          distPort: t.distPort
        };

        if (validation(rule)) {
          logger.error('Invalid input data');
          return res.status(400).json({ error: 'Invalid input data' });
        }

        const deleteRule: ForwardRuleDB = {
          auth_id: id as string,
          protocol: rule.protocol,
          srcAddr: rule.srcAddr,
          srcPort: rule.srcPort,
          distAddr: rule.distAddr,
          distPort: rule.distPort
        };

        await deleteForwardingRule(deleteRule);

        logger.info('Forwarding rule deleted successfully');
        res.status(200).json({ message: 'Forwarding rule deleted successfully' });
      } else if (query === 'modify') {
        // ルールを変更する処理
        let t: any = req.body;
        let rule: ForwardRule = {
          protocol: t.protocol,
          srcAddr: t.srcAddr,
          srcPort: t.srcPort,
          distAddr: t.distAddr,
          distPort: t.distPort
        };
        
        if (validation(rule)) {
          logger.error('Invalid input data');
          return res.status(400).json({ error: 'Invalid input data' });
        }

        const modifyRule: ForwardRuleDB = {
          auth_id: id as string,
          protocol: rule.protocol,
          srcAddr: rule.srcAddr,
          srcPort: rule.srcPort,
          distAddr: rule.distAddr,
          distPort: rule.distPort
        };

        await editForwardingRule(modifyRule);

        logger.info('Forwarding rule modified successfully');
        res.status(200).json({ message: 'Forwarding rule modified successfully' });
      }
    } catch (error) {
      logger.error(`Error adding forwarding rule:${error}`);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  } else if (req.method === 'GET') {
    let id = session.user?.id;
    if (typeof id === null) {
      return res.status(401).json({ error: 'Unauthorized' });
    } else if (query === 'list') {
      // Forwarding ruleを取得
      const rules: Array<ForwardRule> = await getForwardingRule(id as string);
      res.status(200).json(rules);
    } else {
      res.status(405).json({ error: 'Method Not Allowed' });
    }
  } else {
    res.status(405).json({ error: 'Method Not Allowed' });
  }

}
