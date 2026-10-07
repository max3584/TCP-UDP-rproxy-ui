import { describe, expect, it, vi } from 'vitest';
import { bucketStarts, fillSeries, groupUsage, labelKeys, parseGroup, parsePeriod, reportCsv, usageConfig, usageDelta } from '@/components/usage';
import type { UsageRow } from '@/components/usage';
import { niceMax } from '@/components/UsageChart';

vi.mock('@/components/ruledb', () => ({ getPool: vi.fn(), fromRow: vi.fn(), loadOverrides: vi.fn() }));
import { collectNode, rproxyAttribution } from '@/components/usagecollect';

describe('差分の取り方', () => {
  const c = (rx: number, tx: number, connections: number, countersSince?: number | null, startedAt?: number | null) => ({ rx, tx, connections, countersSince, startedAt });
  it('同じ数え始めなら差', () => {
    expect(usageDelta(c(100, 50, 2, 10), c(150, 80, 3, 10))).toEqual({ rx: 50, tx: 30, connections: 1, reset: false });
  });
  it('数え始めが変わった（作り直し・再起動）なら今の数を全部', () => {
    expect(usageDelta(c(100, 50, 2, 10), c(20, 5, 1, 99))).toEqual({ rx: 20, tx: 5, connections: 1, reset: true });
  });
  it('引き継ぎ（handoff）では counters_since が変わらず数も減らないので続けて数える', () => {
    expect(usageDelta(c(100, 50, 2, 10, 1), c(120, 60, 2, 10, 2))).toEqual({ rx: 20, tx: 10, connections: 0, reset: false });
  });
  it('counters_since がない古い rproxy は started_at で見分ける', () => {
    expect(usageDelta(c(100, 0, 0, null, 5), c(150, 0, 0, null, 5)).rx).toBe(50);
    expect(usageDelta(c(100, 0, 0, null, 5), c(30, 0, 0, null, 9))).toMatchObject({ rx: 30, reset: true });
    expect(usageDelta(c(100, 0, 0, null, 5), c(90, 0, 0, null, 5))).toMatchObject({ rx: 90, reset: true });
  });
  it('初めて見るルールは、前回の集計より後に数え始めたときだけ全部足す', () => {
    expect(usageDelta(null, c(100, 10, 1, 500), 400)).toMatchObject({ rx: 100, reset: true });
    expect(usageDelta(null, c(100, 10, 1, 300), 400)).toEqual({ rx: 0, tx: 0, connections: 0, reset: false });
    expect(usageDelta(null, c(100, 10, 1, 300), null).rx).toBe(0);
  });
});

describe('区切りとグラフ', () => {
  const now = new Date('2026-10-06T13:25:00Z');
  it('区切りの始まり', () => {
    const h = bucketStarts('24h', now);
    expect(h).toHaveLength(24);
    expect(h[23].toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(bucketStarts('30d', now)[0].toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(bucketStarts('12m', now).map((d) => d.toISOString().slice(0, 7)).slice(-2)).toEqual(['2026-09', '2026-10']);
  });
  it('ない区切りは 0 で埋め、合計を出す', () => {
    const s = fillSeries('24h', now, [{ key: '2026-10-06 13:00:00', rx: 10, tx: 5, connections: 1 }, { key: '2026-10-06 12:00:00', rx: '7' as unknown as number, tx: 0, connections: 0 }]);
    expect(s.points.at(-1)).toMatchObject({ rx: 10, tx: 5 });
    expect(s.points.at(-2)?.rx).toBe(7);
    expect(s.total).toEqual({ rx: 17, tx: 5, connections: 1 });
    expect(fillSeries('12m', now, [{ key: '2026-10', rx: 1, tx: 1, connections: 0 }]).points.at(-1)?.rx).toBe(1);
  });
  it('目盛りの上限', () => {
    expect(niceMax(0)).toBe(1024);
    expect(niceMax(3 * 1024 ** 2)).toBe(5 * 1024 ** 2);
    expect(niceMax(900)).toBe(1000);
  });
});

describe('所有者・ラベルごとの表と CSV', () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({ node: 'n1', protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, target: 'n1', owner: 'u1', origin: 'dynamic', labels: null, rx: 0, tx: 0, connections: 0, ...over });
  const rows = [
    row({ owner: 'u1', labels: { tenant: 'act' }, rx: 100, tx: 10, connections: 2 }),
    row({ owner: 'u1', listen_port: 80, labels: { tenant: 'act' }, rx: 1, tx: 1 }),
    row({ owner: null, origin: 'api', listen_port: 9000, labels: '{"tenant":"other"}' as unknown as Record<string, string>, rx: 500, tx: 0 }),
    row({ owner: 'u2', node: 'n2', listen_addr: '::', rx: 5, tx: 5 }),
  ];
  it('まとめる', () => {
    expect(groupUsage(rows, 'owner')).toEqual([
      { key: null, rx: 500, tx: 0, connections: 0, rules: 1 },
      { key: 'u1', rx: 101, tx: 11, connections: 2, rules: 2 },
      { key: 'u2', rx: 5, tx: 5, connections: 0, rules: 1 },
    ]);
    expect(groupUsage(rows, 'label:tenant').map((l) => [l.key, l.rx])).toEqual([['other', 500], ['act', 101], [null, 5]]);
    expect(groupUsage(rows, 'rule').map((l) => l.key)).toContain('tcp/[::]:443');
    expect(labelKeys(rows)).toEqual(['tenant']);
    expect(parseGroup('label:tenant')).toBe('label:tenant');
    expect(parseGroup('label:bad key')).toBe('owner');
  });
  it('CSV（式として読まれないように）', () => {
    const csv = reportCsv('2026-10', 'owner', [{ key: '=cmd', rx: 1, tx: 2, connections: 3, rules: 1 }, { key: 'a,b', rx: 0, tx: 0, connections: 0, rules: 1 }]);
    expect(csv.split('\r\n')).toEqual(['period,owner,rx_bytes,tx_bytes,total_bytes,connections,rules', "2026-10,'=cmd,1,2,3,3,1", '2026-10,"a,b",0,0,0,0,1', '']);
  });
  it('期間と設定', () => {
    expect(parsePeriod('2026-12')).toEqual({ kind: 'month', from: '2026-12-01', to: '2027-01-01', label: '2026-12' });
    expect(parsePeriod('2026-02-30')).toBeNull();
    expect(parsePeriod('2026-10-06')?.to).toBe('2026-10-07');
    expect(usageConfig({})).toEqual({ intervalSecs: 300, hourlyDays: 32, dailyDays: 400 });
    expect(usageConfig({ RPROXY_UI_USAGE_SECS: '0', RPROXY_UI_USAGE_HOURLY_DAYS: '7', RPROXY_UI_USAGE_DAILY_DAYS: 'x' })).toEqual({ intervalSecs: 0, hourlyDays: 7, dailyDays: 400 });
    expect(usageConfig({ RPROXY_UI_USAGE_SECS: '5' }).intervalSecs).toBe(30);
  });
});

describe('1 つのノードの集計（collectNode）', () => {
  const status = (port: number, rx: number, since: number, over: Record<string, unknown> = {}) => ({
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: port, state: 'running', error: null, resolved: [], connections: 0,
    stats: { total_connections: 3, rx_bytes: rx, tx_bytes: 10, tls_failures: 0, counters_since: since }, ...over,
  }) as never;

  it('前の数との差を時間・日の表に足し、基準を更新し、消えたルールの基準を捨てる', async () => {
    const calls: [string, unknown[]][] = [];
    const conn = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push([sql, params]);
        if (sql.startsWith('SELECT')) {
          return [
            { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, counters_since: 100, started_at: null, rx_bytes: 1000, tx_bytes: 5, connections: 1, sampled_at: '2026-10-06 13:00:00.000' },
            { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 22, counters_since: 1, started_at: null, rx_bytes: 0, tx_bytes: 0, connections: 0, sampled_at: '2026-10-06 13:00:00.000' },
          ];
        }
        return { affectedRows: 1 };
      }),
    };
    const attrs = new Map([['tcp|0.0.0.0|443', { owner: 'u1', target: 'g', origin: 'dynamic', labels: { tenant: 'act' } }]]);
    const n = await collectNode(conn as never, 'n1', [status(443, 1500, 100), status(8443, 70, 1791292800, { origin: 'api', labels: { tenant: 'x' } })], attrs, new Date('2026-10-06T13:25:30Z'));
    expect(n).toBe(2);
    const hourly = calls.filter(([sql]) => sql.includes('INSERT INTO usage_hourly'));
    expect(hourly[0][1]).toEqual(['2026-10-06 13:00:00', 'n1', 'tcp', '0.0.0.0', 443, 'g', 'u1', 'dynamic', '{"tenant":"act"}', 500, 5, 2]);
    // 前回の集計より後に作られた API のルールは全部足す
    expect(hourly[1][1]).toEqual(['2026-10-06 13:00:00', 'n1', 'tcp', '0.0.0.0', 8443, null, null, 'api', '{"tenant":"x"}', 70, 10, 3]);
    expect(calls.filter(([sql]) => sql.includes('INSERT INTO usage_daily'))[0][1][0]).toBe('2026-10-06');
    expect(calls.find(([sql]) => sql.startsWith('REPLACE INTO usage_counters'))?.[1]).toEqual(['n1', 'tcp', '0.0.0.0', 443, 100, null, 1500, 10, 3, '2026-10-06 13:25:30.000']);
    expect(calls.find(([sql]) => sql.startsWith('DELETE FROM usage_counters'))?.[1]).toEqual(['n1', 'tcp', '0.0.0.0', 22]);
  });

  it('rproxy のルールの印', () => {
    expect(rproxyAttribution({ origin: 'static' } as never)).toEqual({ owner: null, target: null, origin: 'static', labels: null });
  });
});
