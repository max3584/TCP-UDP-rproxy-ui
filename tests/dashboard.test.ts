// ダッシュボードの集計・整形（components/dashboard.ts）と、ダッシュボード・詳細画面の部品の描画
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForwardRules } from '@/components/lib';
import {
  countsDescription,
  donutGradient,
  emptyCounts,
  filterRules,
  formatBytes,
  formatCount,
  formatDuration,
  hostPort,
  httpRouteRows,
  mergeStaticRules,
  needsAttention,
  parseRuleKey,
  portsLabel,
  ruleApiUrl,
  ruleEditHref,
  ruleFromStatus,
  ruleHref,
  serverErrorPercent,
  statusCountsLabel,
  summarize,
  targetLabel,
  targetPortsLabel,
  tlsBreakdown,
  tlsLabel,
  toRule,
  uptimeSecs,
} from '@/components/dashboard';
import { AllowFromBadge, StateBadge, StaticBadge, TlsBadge } from '@/components/ui';
import type { RproxyRuleStatus } from '@/components/rproxy';

let nextId = 1;
const rule = (over: Partial<ForwardRules> = {}): ForwardRules => ({
  id: nextId++,
  origin: 'dynamic',
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 443,
  srcPortEnd: null,
  distAddr: '10.0.0.5',
  distPort: 8443,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
  tls: { mode: 'passthrough' },
  starttls: null,
  starttlsRequired: true,
  allowFrom: [],
  http: null,
  state: 'running',
  error: null,
  connections: 0,
  stats: { total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0 },
  startedAt: 1_790_000_000,
  resolved: [],
  ...over,
});

const cert = { cert_file: '/c.pem', key_file: '/k.pem' };

const sample: ForwardRules[] = [
  rule({ connections: 2, stats: { total_connections: 10, rx_bytes: 1000, tx_bytes: 2000, tls_failures: 1 } }),
  rule({ srcPort: 587, tls: { mode: 'terminate', certificates: [cert] }, starttls: 'smtp', connections: 1,
    stats: { total_connections: 5, rx_bytes: 24, tx_bytes: 48, tls_failures: 3 } }),
  rule({ srcPort: 8443, tls: { mode: 'sni', routes: [{ server_name: 'mail.example.com', remote_addr: '10.0.0.9', remote_port: 993 }] },
    state: 'failed', error: 'address already in use', connections: 0, stats: { total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0 }, startedAt: null }),
  rule({ protocol: 'udp', srcPort: 50000, srcPortEnd: 50010, distPort: 40000, state: 'missing', connections: null, stats: null, startedAt: null }),
  rule({ protocol: 'udp', srcAddr: '::', srcPort: 5349, tls: { mode: 'terminate', certificates: [cert] }, connections: 4,
    stats: { total_connections: 7, rx_bytes: 1024 * 1024, tx_bytes: 5, tls_failures: 2 } }),
  rule({ protocol: 'udp', srcPort: 53, state: 'unknown', connections: null, stats: null, startedAt: null }),
];

describe('summarize', () => {
  it('counts states and adds up connections and bytes per protocol', () => {
    const s = summarize(sample);
    expect(s.tcp.counts).toEqual({ running: 2, failed: 1, missing: 0, unknown: 0, total: 3 });
    expect(s.udp.counts).toEqual({ running: 1, failed: 0, missing: 1, unknown: 1, total: 3 });
    expect(s.all).toEqual({ running: 3, failed: 1, missing: 1, unknown: 1, total: 6 });
    expect(s.tcp).toMatchObject({ connections: 3, totalConnections: 15, rxBytes: 1024, txBytes: 2048, tlsFailures: 4 });
    // null（missing / unknown）は 0 として足す
    expect(s.udp).toMatchObject({ connections: 4, totalConnections: 7, rxBytes: 1024 * 1024, txBytes: 5, tlsFailures: 2 });
    expect(s.connections).toBe(7);
  });

  it('handles no rules', () => {
    const s = summarize([]);
    expect(s.tcp.counts).toEqual(emptyCounts());
    expect(s.connections).toBe(0);
    expect(s.staticRules).toBe(0);
  });

  it('adds up denied connections (missing from old rproxy counts as 0) and counts static rules', () => {
    const rules = [
      rule({ stats: { total_connections: 1, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, denied: 3 } }),
      rule({ origin: 'static', stats: { total_connections: 1, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, denied: 2 } }),
      rule({ protocol: 'udp', stats: { total_connections: 1, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, denied: 7 } }),
      rule(),
    ];
    const s = summarize(rules);
    expect(s.tcp.denied).toBe(5);
    expect(s.udp.denied).toBe(7);
    expect(s.staticRules).toBe(1);
    expect(s.all.total).toBe(4);
  });
});

describe('static rules', () => {
  const status = (over: Partial<RproxyRuleStatus> = {}): RproxyRuleStatus => ({
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, listen_port_end: null, remote_addr: '127.0.0.1', remote_port: 3001,
    source_ip: 'proxy', udp_idle_secs: 30, starttls: null, starttls_required: true, allow_from: ['172.16.0.0/16'],
    tls: { mode: 'sni', routes: [{ server_name: 'dashboard.proxy.home', remote_addr: '127.0.0.1', remote_port: 3001 }], unmatched: 'reject' },
    state: 'running', error: null, resolved: [], connections: 0, origin: 'static', ...over,
  });

  it('builds a read-only row from the rproxy response', () => {
    const r = ruleFromStatus(status({ stats: { total_connections: 2, rx_bytes: 1, tx_bytes: 1, tls_failures: 0, denied: 1 }, started_at: 1_790_000_000 }), -1);
    expect(r).toMatchObject({
      id: -1, origin: 'static', protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '127.0.0.1', distPort: 3001,
      allowFrom: ['172.16.0.0/16'], tls: { mode: 'sni', unmatched: 'reject' }, starttls: null, starttlsRequired: true,
      stats: { denied: 1 }, startedAt: 1_790_000_000,
    });
    // 範囲ルール・古い rproxy（stats / started_at / allow_from なし）
    const old = ruleFromStatus(status({ listen_port_end: 450, allow_from: undefined, tls: { mode: 'passthrough' } }), -2);
    expect(old).toMatchObject({ srcPortEnd: 450, allowFrom: [], stats: null, startedAt: null, tls: { mode: 'passthrough' } });
  });

  it('appends static rules after the own rules with negative ids and skips dynamic rules of other users', () => {
    const own = [rule({ id: 10, srcPort: 80 })];
    const merged = mergeStaticRules(own, [
      status({ listen_port: 80, origin: 'dynamic' }),
      status({ protocol: 'udp', listen_port: 53, origin: 'dynamic' }),
      status(),
      status({ listen_addr: '::', listen_port: 8443 }),
      // 古い rproxy（origin なし）は固定ルールとして扱わない
      status({ listen_port: 9000, origin: undefined }),
    ]);
    expect(merged.map((r) => [r.id, r.origin, r.srcAddr, r.srcPort])).toEqual([
      [10, 'dynamic', '0.0.0.0', 80], [-1, 'static', '0.0.0.0', 443], [-2, 'static', '::', 8443],
    ]);
    // 集計にも入る
    expect(summarize(merged).all.total).toBe(3);
    expect(summarize(merged).staticRules).toBe(2);
  });

  it('does not add a static rule twice when the key is already listed', () => {
    const own = [rule({ id: 1, srcPort: 443 })];
    expect(mergeStaticRules(own, [status()]).map((r) => r.id)).toEqual([1]);
    expect(mergeStaticRules([], [])).toEqual([]);
  });
});

describe('L7 (http) rules', () => {
  // rproxy-api の docs/DESIGN-v0.3.md の例（設定ファイルの固定ルール。remote_addr / remote_port は "" / 0 で返る）
  const http = {
    routes: [
      { name: 'gitlab-login', match: 'Host(`gitlab.example.com`) && Path(`/users/sign_in`)', service: 'gitlab' },
      { name: 'gitlab', match: 'Host(`gitlab.example.com`)', service: 'gitlab' },
    ],
    services: { gitlab: { servers: [{ url: 'http://10.0.0.20:80' }] } },
  };
  const status: RproxyRuleStatus = {
    protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, listen_port_end: null, remote_addr: '', remote_port: 0,
    source_ip: 'proxy', udp_idle_secs: 30, starttls: null, starttls_required: true, allow_from: [],
    tls: { mode: 'terminate', certificates: [{ acme: 'letsencrypt', domains: ['gitlab.example.com'] }], options: { min_version: '1.2' } },
    http: http,
    state: 'running', error: null, resolved: [], connections: 0, origin: 'static',
  };

  it('keeps http and the ACME certificate on a static row', () => {
    const r = ruleFromStatus(status, -1);
    expect(r).toMatchObject({ origin: 'static', distAddr: '', distPort: 0, http: http });
    expect(r.tls).toEqual({ mode: 'terminate', certificates: [{ acme: 'letsencrypt', domains: ['gitlab.example.com'] }], options: { min_version: '1.2' } });
    // http のない応答・remote_addr を省いた応答
    expect(ruleFromStatus({ ...status, http: undefined }, -1).http).toBeNull();
    expect(ruleFromStatus({ ...status, remote_addr: undefined, remote_port: undefined }, -1)).toMatchObject({ distAddr: '', distPort: 0 });
  });

  it('shows L7 (HTTP) and the route count instead of an empty target', () => {
    expect(targetLabel(ruleFromStatus(status, -1))).toBe('L7 (HTTP) ・ルート 2 件');
    expect(targetLabel(rule({ http: {} }))).toBe('L7 (HTTP) ・ルート 0 件');
    expect(targetLabel(rule())).toBe('10.0.0.5:8443');
    expect(targetLabel(rule({ distAddr: '2001:db8::5', srcPortEnd: 444 }))).toBe('[2001:db8::5]:8443-8444');
  });

  // rproxy v0.3.1 の stats.http（docs/API.md の例に、rate_limit と crowdsec で断った数を足したもの）
  const httpStats = {
    requests: 10,
    by_status: { '2xx': 6, '4xx': 3, '5xx': 1 },
    routes: {
      '(none)': { requests: 1, by_status: { '4xx': 1 } },
      'gitlab-login': { requests: 3, by_status: { '2xx': 1, '4xx': 2 }, limited: { 'rate-limit-login': 1 }, blocked: { crowdsec: 1 } },
      gitlab: { requests: 6, by_status: { '2xx': 5, '5xx': 1 } },
    },
    limited: 1,
    blocked: 1,
  };
  const withStats = (): RproxyRuleStatus => ({
    ...status, stats: { total_connections: 4, rx_bytes: 100, tx_bytes: 200, tls_failures: 0, denied: 0, http: httpStats },
  });

  it('carries stats.http through and sums it per protocol', () => {
    const r = ruleFromStatus(withStats(), -1);
    expect(r.stats?.http).toEqual(httpStats);
    const s = summarize([r, rule({ srcPort: 80 }), ruleFromStatus({ ...status, listen_port: 8443 }, -2)]).tcp;
    expect(s).toMatchObject({ httpRules: 2, httpRequests: 10, http5xx: 1, httpLimited: 1, httpBlocked: 1 });
    // stats.http を返さない古い rproxy
    expect(summarize([ruleFromStatus(status, -1)]).tcp).toMatchObject({ httpRules: 1, httpRequests: 0, http5xx: 0 });
    expect(summarize([rule()]).tcp.httpRules).toBe(0);
  });

  it('lists routes by requests with the unmatched ones last', () => {
    const rows = httpRouteRows(httpStats);
    expect(rows.map((r) => r.name)).toEqual(['gitlab', 'gitlab-login', '(none)']);
    expect(rows[1]).toMatchObject({ requests: 3, limited: 1, blocked: 1, limitedBy: { 'rate-limit-login': 1 }, blockedBy: { crowdsec: 1 } });
    expect(rows[0]).toMatchObject({ limited: 0, blocked: 0, limitedBy: {}, blockedBy: {} });
    expect(httpRouteRows({ requests: 0, by_status: {}, routes: {} })).toEqual([]);
  });

  it('formats status classes and the 5xx share', () => {
    expect(statusCountsLabel(httpStats.by_status)).toBe('2xx 6 / 4xx 3 / 5xx 1');
    expect(statusCountsLabel({})).toBe('-');
    expect(serverErrorPercent(10, 1)).toBe(10);
    expect(serverErrorPercent(3, 1)).toBe(33.3);
    expect(serverErrorPercent(0, 0)).toBeNull();
  });

  it('finds http rules by L7 and not by the empty target port', () => {
    const rules = [ruleFromStatus(status, -1), rule({ srcPort: 80, distPort: 8080 })];
    const all = { protocol: 'all' as const, state: 'all' as const, text: '' };
    expect(filterRules(rules, { ...all, text: 'l7' }).map((r) => r.srcPort)).toEqual([443]);
    // 転送先のない http のルールを「:0」で拾わない
    expect(filterRules(rules, { ...all, text: ':0' })).toEqual([]);
  });
});

describe('tlsBreakdown', () => {
  it('splits terminate into TLS (tcp) and DTLS (udp) and counts STARTTLS and ranges', () => {
    expect(tlsBreakdown(sample)).toEqual({ passthrough: 3, sni: 1, tls: 1, dtls: 1, starttls: 1, ranges: 1 });
  });
});

describe('needsAttention', () => {
  it('lists failed rules before missing ones and leaves the rest out', () => {
    const list = needsAttention([sample[3], sample[0], sample[2], sample[5]]);
    expect(list.map((r) => r.state)).toEqual(['failed', 'missing']);
  });
});

describe('filterRules', () => {
  const all = { protocol: 'all', state: 'all', text: '' } as const;

  it('filters by protocol and state', () => {
    expect(filterRules(sample, { ...all, protocol: 'udp' })).toHaveLength(3);
    expect(filterRules(sample, { ...all, state: 'failed' }).map((r) => r.srcPort)).toEqual([8443]);
    expect(filterRules(sample, { ...all, protocol: 'tcp', state: 'missing' })).toEqual([]);
  });

  it.each([
    ['listen port', '587', [587]],
    ['a port inside a range', '50005', [50000]],
    ['a target port inside a range', '40010', [50000]],
    ['an SNI server name', 'MAIL.example', [8443]],
    ['an SNI route port', '993', [8443]],
    ['a listen address', '::', [5349]],
    ['a target address', '10.0.0.5', [443, 587, 50000, 5349, 53]],
    ['address:port', '0.0.0.0:50000-50010', [50000]],
    ['surrounding blanks', '  587 ', [587]],
  ])('searches %s', (_name, text, ports) => {
    const shown = filterRules(sample.map((r) => (r.srcPort === 8443 ? { ...r, distAddr: '10.0.1.1' } : r)), { ...all, text });
    expect(shown.map((r) => r.srcPort)).toEqual(ports);
  });
});

describe('formatting', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1_258_291, '1.2 MiB'],
    [5 * 1024 ** 3, '5.0 GiB'],
    [3 * 1024 ** 4, '3.0 TiB'],
    [null, '-'],
    [-1, '-'],
  ])('formatBytes(%s) = %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it.each([
    [0, '0秒'],
    [45, '45秒'],
    [60, '1分'],
    [192, '3分 12秒'],
    [3600, '1時間'],
    [7500, '2時間 5分'],
    [86400, '1日'],
    [3 * 86400 + 4 * 3600 + 59, '3日 4時間'],
    [null, '-'],
  ])('formatDuration(%s) = %s', (secs, text) => {
    expect(formatDuration(secs)).toBe(text);
  });

  it('computes uptime from started_at and never goes negative', () => {
    expect(uptimeSecs(1000, 1_060_500)).toBe(60);
    expect(uptimeSecs(2000, 1_000_000)).toBe(0);
    expect(uptimeSecs(null, 1_000_000)).toBeNull();
  });

  it('formats counts, ports and addresses', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(null)).toBe('-');
    expect(portsLabel(8000, 8001)).toBe('8000-8001');
    expect(portsLabel(443, null)).toBe('443');
    expect(targetPortsLabel({ srcPort: 8000, srcPortEnd: 8001, distPort: 9000 })).toBe('9000-9001');
    expect(hostPort('::1', '443')).toBe('[::1]:443');
    expect(hostPort('10.0.0.1', 443)).toBe('10.0.0.1:443');
    expect(tlsLabel({ protocol: 'udp', tls: { mode: 'terminate' } })).toBe('DTLS 終端');
    expect(tlsLabel({ protocol: 'tcp', tls: { mode: 'terminate' } })).toBe('TLS 終端');
  });
});

describe('donut', () => {
  it('draws one conic-gradient segment per non-empty state', () => {
    const counts = { running: 2, failed: 1, missing: 1, unknown: 0, total: 4 };
    expect(donutGradient(counts)).toBe('conic-gradient(#16a34a 0% 50%, #dc2626 50% 75%, #f59e0b 75% 100%)');
    expect(countsDescription(counts)).toBe('稼働中 2、失敗 1、未登録 1');
  });

  it('is gray when there are no rules', () => {
    expect(donutGradient(emptyCounts())).toBe('conic-gradient(#9ca3af 0 100%)');
    expect(countsDescription(emptyCounts())).toBe('ルールはありません');
  });
});

describe('rule URLs', () => {
  it('URL-encodes an IPv6 listen address and reads it back', () => {
    const key = { protocol: 'udp' as const, addr: '2001:db8::1', port: 5349 };
    expect(ruleHref(key)).toBe('/rules/udp/2001%3Adb8%3A%3A1/5349');
    expect(ruleEditHref(key)).toBe('/rules/udp/2001%3Adb8%3A%3A1/5349/edit');
    expect(ruleApiUrl(key)).toBe('/api/forward/rule?protocol=udp&addr=2001%3Adb8%3A%3A1&port=5349');
    // Next.js は query をデコードして渡す
    expect(parseRuleKey({ protocol: 'udp', listenAddr: decodeURIComponent('2001%3Adb8%3A%3A1'), listenPort: '5349' })).toEqual(key);
  });

  it.each([
    [{ protocol: 'sctp', listenAddr: '::', listenPort: '1' }],
    [{ protocol: 'tcp', listenAddr: '::', listenPort: '0' }],
    [{ protocol: 'tcp', listenAddr: '::', listenPort: '65536' }],
    [{ protocol: 'tcp', listenAddr: '::', listenPort: '1e3' }],
    [{ protocol: 'tcp', listenPort: '80' }],
    [{ protocol: ['tcp'], listenAddr: '::', listenPort: '80' }],
  ])('rejects a malformed key %j', (query) => {
    expect(parseRuleKey(query)).toBeNull();
  });

  it('accepts an upper-case protocol', () => {
    expect(parseRuleKey({ protocol: 'TCP', listenAddr: '0.0.0.0', listenPort: '80' })).toEqual({ protocol: 'tcp', addr: '0.0.0.0', port: 80 });
  });
});

describe('toRule', () => {
  it('drops the live state before sending a rule back to the API', () => {
    const r = toRule(sample[0]);
    expect(Object.keys(r).sort()).toEqual([
      'allowFrom', 'distAddr', 'distPort', 'http', 'protocol', 'sourceIp', 'srcAddr', 'srcPort', 'srcPortEnd', 'starttls', 'starttlsRequired', 'tls', 'udpIdleSecs',
    ]);
  });
});

describe('badges', () => {
  it('marks static rules and rules with allow_from', () => {
    expect(renderToStaticMarkup(createElement(StaticBadge))).toMatch(/class="badge bg-slate-700 text-white"[^>]*>固定</);
    const allow = renderToStaticMarkup(createElement(AllowFromBadge, { allowFrom: ['10.0.0.0/8', 'fd00::/8'] }));
    expect(allow).toContain('IP 制限');
    expect(allow).toContain('title="接続を許可する送信元: 10.0.0.0/8, fd00::/8"');
    expect(allow).toMatch(/class="badge bg-orange-100 text-orange-900"/);
    expect(renderToStaticMarkup(createElement(AllowFromBadge, { allowFrom: [] }))).toBe('');
  });

  it('shows the state with text and an explicit text colour', () => {
    const html = renderToStaticMarkup(createElement(StateBadge, { state: 'missing' }));
    expect(html).toContain('未登録');
    expect(html).toMatch(/class="badge [^"]*text-amber-900/);
  });

  it('shows DTLS and STARTTLS', () => {
    expect(renderToStaticMarkup(createElement(TlsBadge, { rule: sample[4] }))).toContain('DTLS 終端');
    expect(renderToStaticMarkup(createElement(TlsBadge, { rule: sample[1] }))).toContain('STARTTLS smtp');
  });
});
