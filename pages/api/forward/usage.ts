import { NextApiRequest, NextApiResponse } from 'next';
import { isIP } from 'node:net';
import { Logger } from '@/components/lib';
import { requireRole } from '@/components/apiguard';
import { accessOf, roleConfig } from '@/components/roles';
import { NodesConfigError, loadNodes, normalizeIp, targetNodes } from '@/components/nodes';
import { getPool } from '@/components/ruledb';
import { RANGE_SPECS, bucketKey, bucketStarts, fillSeries, groupUsage, labelKeys, parseGroup, parsePeriod, parseRange, reportCsv } from '@/components/usage';
import type { UsageRow } from '@/components/usage';
import { usageStatus } from '@/components/usagecollect';
import { localizedApi } from '@/i18n/server';

const q = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

class BadRequest extends Error {}

const BUCKET_SQL = {
  hour: "DATE_FORMAT(hour, '%Y-%m-%d %H:00:00')",
  day: "DATE_FORMAT(day, '%Y-%m-%d')",
  month: "DATE_FORMAT(day, '%Y-%m')",
} as const;

// 利用量（#101。usage_hourly・usage_daily）。
// GET /api/forward/usage?range=24h|7d|30d|12m[&protocol=&addr=&port=&target=]：ルールを指定すればそのルール、なければ全体（利用者は自分のルールだけ、
// 管理者はすべて）の棒グラフの値。GET /api/forward/usage?report=1&period=YYYY-MM|YYYY-MM-DD&group=owner|node|rule|label:<キー>[&format=csv]：
// 所有者・ラベルなどでまとめた表（利用者は自分のルールだけ）。表がない（010 を適用していない）ときは available: false
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireRole(req, res);
  if (!session) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed', code: 'method_not_allowed' });
  const admin = accessOf(session.user.roles ?? [], roleConfig()) === 'admin';
  const pool = getPool();
  const status = usageStatus();
  try {
    if (q(req.query.report)) {
      const period = parsePeriod(q(req.query.period));
      if (!period) throw new BadRequest('period は YYYY-MM か YYYY-MM-DD で指定してください。');
      const group = parseGroup(q(req.query.group));
      const rows = await pool.query(
        `SELECT node, protocol, listen_addr, listen_port, target, owner, origin, labels, SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx, SUM(connections) AS connections
           FROM usage_daily WHERE day >= ? AND day < ?${admin ? '' : ' AND owner = ?'}
          GROUP BY node, protocol, listen_addr, listen_port, target, owner, origin, labels`,
        admin ? [period.from, period.to] : [period.from, period.to, session.user.id],
      ) as UsageRow[];
      const lines = groupUsage(rows, group);
      if (q(req.query.format) === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="rproxy-usage-${period.label}-${group.replace(/[^A-Za-z0-9._-]/g, '_')}.csv"`);
        return res.status(200).send(reportCsv(period.label, group, lines));
      }
      return res.status(200).json({ available: true, admin: admin, period: period.label, group: group, lines: lines, labelKeys: labelKeys(rows), status: status });
    }

    const range = parseRange(q(req.query.range));
    const spec = RANGE_SPECS[range];
    const now = new Date();
    const from = bucketKey(spec.bucket === 'month' ? 'day' : spec.bucket, bucketStarts(range, now)[0]);
    const where: string[] = [`${spec.table === 'usage_hourly' ? 'hour' : 'day'} >= ?`];
    const params: unknown[] = [from];
    const protocol = q(req.query.protocol).toLowerCase();
    if (protocol) {
      const addr = q(req.query.addr);
      const port = Number(q(req.query.port));
      if ((protocol !== 'tcp' && protocol !== 'udp') || isIP(addr) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new BadRequest('protocol・addr・port が不正です。');
      }
      where.push('protocol = ? AND listen_addr = ? AND listen_port = ?');
      params.push(protocol, normalizeIp(addr), port);
      const target = q(req.query.target);
      const cfg = loadNodes();
      if (cfg.configured && target) {
        const nodes = targetNodes(cfg, target);
        if (!nodes) throw new BadRequest(`ノード／グループ ${target} は設定にありません。`);
        where.push(`node IN (${nodes.map(() => '?').join(', ')})`);
        params.push(...nodes.map((n) => n.name));
      }
    }
    if (!admin) {
      where.push('owner = ?');
      params.push(session.user.id);
    }
    const rows = await pool.query(
      `SELECT ${BUCKET_SQL[spec.bucket]} AS \`key\`, SUM(rx_bytes) AS rx, SUM(tx_bytes) AS tx, SUM(connections) AS connections FROM ${spec.table} WHERE ${where.join(' AND ')} GROUP BY \`key\``,
      params,
    ) as { key: string; rx: number; tx: number; connections: number }[];
    return res.status(200).json({ available: true, ...fillSeries(range, now, rows), status: status });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message, code: 'invalid' });
    if (err instanceof NodesConfigError) return res.status(500).json({ error: err.message, code: 'nodes_config' });
    if ((err as { errno?: number })?.errno === 1146) return res.status(200).json({ available: false, status: status });
    Logger('info', { action: 'usage' }).error(`usage: ${err}`);
    return res.status(500).json({ error: 'Internal Server Error', code: 'internal' });
  }
}

export default localizedApi(handler);
