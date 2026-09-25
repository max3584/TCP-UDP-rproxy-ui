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
  needsAttention,
  parseRuleKey,
  portsLabel,
  ruleApiUrl,
  ruleEditHref,
  ruleHref,
  summarize,
  targetPortsLabel,
  tlsBreakdown,
  tlsLabel,
  toRule,
  uptimeSecs,
} from '@/components/dashboard';
import { StateBadge, TlsBadge } from '@/components/ui';

let nextId = 1;
const rule = (over: Partial<ForwardRules> = {}): ForwardRules => ({
  id: nextId++,
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
      'distAddr', 'distPort', 'protocol', 'sourceIp', 'srcAddr', 'srcPort', 'srcPortEnd', 'starttls', 'starttlsRequired', 'tls', 'udpIdleSecs',
    ]);
  });
});

describe('badges', () => {
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
