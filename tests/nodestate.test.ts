import { describe, expect, it } from 'vitest';
import { aggregateNodeStates, multiNode, parseRuleKey, ruleApiUrl, ruleEditHref, ruleHref, ruleKeyOf, sumStats, targetChoices } from '@/components/dashboard';
import type { NodeLiveState } from '@/components/lib';

const live = (node: string, extra: Partial<NodeLiveState> = {}): NodeLiveState => ({
  node, state: 'running', error: null, connections: 1, stats: null, startedAt: 100, resolved: [], ...extra,
});

describe('aggregateNodeStates', () => {
  it('the worst state wins (failed > missing > unknown > running)', () => {
    expect(aggregateNodeStates([live('a'), live('b')]).state).toBe('running');
    expect(aggregateNodeStates([live('a'), live('b', { state: 'unknown' })]).state).toBe('unknown');
    expect(aggregateNodeStates([live('a', { state: 'missing' }), live('b', { state: 'unknown' })]).state).toBe('missing');
    expect(aggregateNodeStates([live('a', { state: 'missing' }), live('b', { state: 'failed' })]).state).toBe('failed');
    expect(aggregateNodeStates([live('a', { state: 'paused' })]).state).toBe('paused');
    expect(aggregateNodeStates([]).state).toBe('unknown');
  });

  it('a single node keeps its own error; several are prefixed with the node', () => {
    expect(aggregateNodeStates([live('a', { error: 'boom' })]).error).toBe('boom');
    expect(aggregateNodeStates([live('a', { error: 'x' }), live('b'), live('c', { error: 'y' })]).error).toBe('a: x / c: y');
  });

  it('sums connections and stats, keeps the earliest start and all resolved addresses', () => {
    const agg = aggregateNodeStates([
      live('a', { connections: 2, startedAt: 300, resolved: ['192.0.2.1:80'], stats: { total_connections: 5, rx_bytes: 10, tx_bytes: 20, tls_failures: 1, http: { requests: 3, by_status: { '2xx': 3 }, routes: { r: { requests: 3, by_status: { '2xx': 3 } } } } } }),
      live('b', { connections: null, startedAt: 200, resolved: ['192.0.2.1:80', '192.0.2.2:80'], stats: { total_connections: 1, rx_bytes: 1, tx_bytes: 2, tls_failures: 0, denied: 4, http: { requests: 2, by_status: { '5xx': 2 }, routes: { r: { requests: 2, by_status: { '5xx': 2 } } } } } }),
    ]);
    expect(agg.connections).toBe(2);
    expect(agg.startedAt).toBe(200);
    expect(agg.resolved).toEqual(['192.0.2.1:80', '192.0.2.2:80']);
    expect(agg.stats).toEqual({
      total_connections: 6, rx_bytes: 11, tx_bytes: 22, tls_failures: 1, denied: 4,
      http: { requests: 5, by_status: { '2xx': 3, '5xx': 2 }, routes: { r: { requests: 5, by_status: { '2xx': 3, '5xx': 2 } } } },
    });
  });

  it('per-target stats: counters add up, weight and port stay, up if any node sees it up', () => {
    const s = sumStats([
      { total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, targets: [{ addr: '192.0.2.1', port: 80, weight: 2, up: false, connections: 1 }] },
      { total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, targets: [{ addr: '192.0.2.1', port: 80, weight: 2, up: true, connections: 3 }] },
    ]);
    expect(s?.targets).toEqual([{ addr: '192.0.2.1', port: 80, weight: 2, up: true, connections: 4 }]);
    expect(sumStats([null, null])).toBeNull();
  });
});

describe('rule URLs with a target', () => {
  it('carry ?target= only when the rule has one', () => {
    const key = ruleKeyOf({ protocol: 'tcp', srcAddr: '::1', srcPort: 443, target: 'ha' });
    expect(ruleHref(key)).toBe('/rules/tcp/%3A%3A1/443?target=ha');
    expect(ruleEditHref(key)).toBe('/rules/tcp/%3A%3A1/443/edit?target=ha');
    expect(ruleApiUrl(key)).toBe('/api/forward/rule?protocol=tcp&addr=%3A%3A1&port=443&target=ha');
    expect(ruleHref(ruleKeyOf({ protocol: 'udp', srcAddr: '0.0.0.0', srcPort: 53 }))).toBe('/rules/udp/0.0.0.0/53');
    expect(parseRuleKey({ protocol: 'tcp', listenAddr: '::1', listenPort: '443', target: 'ha' })).toEqual(key);
  });
});

describe('node choices', () => {
  const info = { configured: true, nodes: [{ name: 'a' }, { name: 'b' }], groups: [{ name: 'ha', mode: 'active_standby' as const, nodes: ['a', 'b'] }], defaultTarget: null };
  it('lists groups then nodes; a single node shows nothing', () => {
    expect(targetChoices(info).map((c) => c.value)).toEqual(['ha', 'a', 'b']);
    expect(targetChoices(info)[0].label).toBe('ha（act/stb: a, b）');
    expect(multiNode(info)).toBe(true);
    expect(multiNode({ nodes: [{ name: 'default' }] })).toBe(false);
    expect(multiNode(null)).toBe(false);
  });
});
