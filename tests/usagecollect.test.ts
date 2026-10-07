// 利用量の集計のループ（runUsageOnce）。MariaDB と rproxy はモック
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(), query: vi.fn() };
  const pool = { getConnection: vi.fn(), query: vi.fn() };
  return { conn, pool, listRules: vi.fn() };
});

vi.mock('mariadb', () => ({ default: { createPool: () => mocks.pool } }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  listRules: mocks.listRules,
}));

import { runUsageOnce, usageStatus } from '@/components/usagecollect';

const { conn, pool } = mocks;

function sql(impl: (q: string) => unknown) {
  conn.query.mockImplementation(async (q: string) => impl(q));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RPROXY_UI_NODES;
  pool.getConnection.mockResolvedValue(conn);
  conn.rollback.mockResolvedValue(undefined);
  mocks.listRules.mockResolvedValue([]);
  sql((q) => (q.startsWith('SELECT GET_LOCK') ? [{ got: 1 }] : q.startsWith('SELECT') ? [] : { affectedRows: 1 }));
});

describe('runUsageOnce', () => {
  it('returns the connection to the pool after releasing the lock', async () => {
    expect(await runUsageOnce(new Date('2026-10-06T13:00:00Z'))).toBe('done');
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  // セキュリティレビュー L6：RELEASE_LOCK に失敗した接続を pool に返すと、ロックを持ったまま使い回され、ほかの UI の集計が止まる
  it('destroys the connection when RELEASE_LOCK fails', async () => {
    sql((q) => {
      if (q.startsWith('SELECT GET_LOCK')) return [{ got: 1 }];
      if (q.startsWith('SELECT RELEASE_LOCK')) throw new Error('Connection lost');
      return q.startsWith('SELECT') ? [] : { affectedRows: 1 };
    });
    expect(await runUsageOnce(new Date('2026-10-06T13:00:00Z'))).toBe('done');
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
  });

  it('explains a table without the attr column (migration 011)', async () => {
    mocks.listRules.mockResolvedValue([{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, state: 'running', error: null, resolved: [], connections: 0, stats: { total_connections: 1, rx_bytes: 10, tx_bytes: 10, tls_failures: 0, counters_since: 1 } }]);
    sql((q) => {
      if (q.startsWith('SELECT GET_LOCK')) return [{ got: 1 }];
      if (q.startsWith('INSERT INTO usage_hourly')) throw Object.assign(new Error("Unknown column 'attr'"), { errno: 1054 });
      if (q.includes('FROM usage_counters')) return [{ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 80, counters_since: 1, started_at: null, rx_bytes: 0, tx_bytes: 0, connections: 0, sampled_at: '2026-10-06 12:55:00.000' }];
      return q.startsWith('SELECT') ? [] : { affectedRows: 1 };
    });
    expect(await runUsageOnce(new Date('2026-10-06T13:00:00Z'))).toBe('skipped');
    expect(usageStatus().error).toContain('011_usage_attr.sql');
  });
});
