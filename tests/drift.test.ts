import { describe, expect, it } from 'vitest';
import { canon, needsRecreateOnNode, ruleDrift } from '@/components/drift';
import { haStatus, interfaceAddrs, isSpecificAddr, vipAddrs } from '@/components/ha';
import { toRproxyRule } from '@/components/settingsdoc';
import type { ForwardRule } from '@/components/lib';
import type { RproxyRuleStatus } from '@/components/rproxy';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: 'backend.example.com', distPort: 8443,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [],
  http: null, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null, extraListenAddrs: [],
};

// rproxy の応答の形：送った内容に、既定値の項目と稼働情報が付く
function live(rule: ForwardRule, patch: Partial<RproxyRuleStatus> = {}): RproxyRuleStatus {
  return {
    listen_port_end: null, starttls: null, allow_from: [], crowdsec: false, udp_idle_secs: 30,
    ...toRproxyRule(rule),
    tls: { ...rule.tls, ...(rule.tls.mode === 'terminate' ? { alpn: rule.tls.alpn ?? [], client_auth: rule.tls.client_auth ?? { mode: 'none' } } : {}) },
    state: 'running', error: null, resolved: ['192.0.2.1:8443'], connections: 3,
    stats: { total_connections: 9, rx_bytes: 1, tx_bytes: 2, tls_failures: 0 }, started_at: 100, origin: 'dynamic',
    ...patch,
  } as RproxyRuleStatus;
}

describe('ruleDrift', () => {
  it('no drift when the node runs what the UI stored (defaults and runtime fields ignored)', () => {
    expect(ruleDrift(base, live(base))).toEqual([]);
    const tls: ForwardRule = { ...base, tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }] }, allowFrom: ['10.0.0.0/8', '192.0.2.5/32'], extraListenAddrs: ['::'] };
    expect(ruleDrift(tls, live(tls, { allow_from: ['192.0.2.5/32', '10.0.0.0/8'] }))).toEqual([]);
    const multi: ForwardRule = { ...base, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80, weight: 2 }], balance: 'least_conn' };
    expect(ruleDrift(multi, live(multi, { remote_addr: '', remote_port: 0 }))).toEqual([]);
  });

  it('rproxy\'s full TLS response (every field with its default) is not drift', () => {
    const full = {
      mode: 'passthrough', routes: [], certificates: [], client_auth: { mode: 'none', ca_file: null, chain_file: null }, alpn: [],
      upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, chain_file: null, key_file: null },
      unmatched: 'default',
    };
    expect(ruleDrift(base, live(base, { tls: full as never }))).toEqual([]);
    const term: ForwardRule = { ...base, tls: { mode: 'terminate', certificates: [{ cert_file: '/c.pem', key_file: '/k.pem' }] } };
    expect(ruleDrift(term, live(term, { tls: { ...full, mode: 'terminate', certificates: [{ cert_file: '/c.pem', chain_file: null, key_file: '/k.pem' }] } as never }))).toEqual([]);
  });

  it('lists the fields that differ', () => {
    expect(ruleDrift(base, live(base, { remote_port: 9443 }))).toEqual(['remote']);
    expect(ruleDrift(base, live(base, { allow_from: ['10.0.0.0/8'] }))).toEqual(['allow_from']);
    expect(ruleDrift(base, live(base, { tls: { mode: 'sni' } }))).toEqual(['tls']);
    expect(ruleDrift(base, live(base, { source_ip: 'proxy_v2', crowdsec: true }))).toEqual(['source_ip', 'crowdsec']);
    expect(ruleDrift(base, live(base, { extra_listen_addrs: ['::'] }))).toEqual(['extra_listen_addrs']);
    const udp: ForwardRule = { ...base, protocol: 'udp' };
    expect(ruleDrift(udp, live(udp, { udp_idle_secs: 60 }))).toEqual(['udp_idle_secs']);
    const multi: ForwardRule = { ...base, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80 }] };
    expect(ruleDrift(multi, live(base))).toEqual(['targets']);
    expect(ruleDrift(multi, live(multi, { remote_addr: '', remote_port: 0, balance: 'failover' }))).toEqual(['targets']);
  });

  it('a paused rule running on the node is drift (enabled)', () => {
    expect(ruleDrift({ ...base, enabled: false }, live(base))).toEqual(['enabled']);
  });

  it('PATCH cannot fix source_ip, the port range or L4 / L7', () => {
    expect(needsRecreateOnNode(base, live(base, { remote_port: 1 }))).toBe(false);
    expect(needsRecreateOnNode(base, live(base, { source_ip: 'proxy_v2' }))).toBe(true);
    expect(needsRecreateOnNode(base, live(base, { listen_port_end: 445 }))).toBe(true);
    expect(needsRecreateOnNode(base, live(base, { http: { routes: [] } as never }))).toBe(true);
  });

  it('canon drops empty values and sorts keys', () => {
    expect(canon({ b: [], a: { x: null, y: false }, c: 1 })).toEqual({ c: 1 });
    expect(JSON.stringify(canon({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });
});

describe('active / standby', () => {
  const held = (m: Record<string, string[] | null>) => new Map(Object.entries(m).map(([k, v]) => [k, v === null ? null : new Set(v)]));

  it('the group VIP wins; otherwise a specific listen address', () => {
    expect(vipAddrs(['192.0.2.10'], { srcAddr: '198.51.100.1' })).toEqual(['192.0.2.10']);
    expect(vipAddrs([], { srcAddr: '198.51.100.1', extraListenAddrs: ['::', '2001:DB8::1'] })).toEqual(['198.51.100.1', '2001:db8::1']);
    expect(vipAddrs([], { srcAddr: '0.0.0.0' })).toEqual([]);
    expect(isSpecificAddr('127.0.0.1')).toBe(false);
    expect(isSpecificAddr('::1')).toBe(false);
  });

  it('the node holding the VIP is act', () => {
    const out = haStatus(['192.0.2.10'], ['a', 'b'], held({ a: ['10.0.0.1'], b: ['10.0.0.2', '192.0.2.10'] }))!;
    expect(out.status).toEqual({ addrs: ['192.0.2.10'], active: ['b'], warning: null });
    expect([...out.roles]).toEqual([['a', 'standby'], ['b', 'active']]);
  });

  it('warns when nobody or several nodes hold it', () => {
    expect(haStatus(['192.0.2.10'], ['a', 'b'], held({ a: [], b: [] }))!.status.warning).toBe('none');
    expect(haStatus(['192.0.2.10'], ['a', 'b'], held({ a: ['192.0.2.10'], b: ['192.0.2.10'] }))!.status).toMatchObject({ warning: 'split', active: ['a', 'b'] });
    // 問い合わせできないノードがあれば「だれも持っていない」とは言わない
    const partial = haStatus(['192.0.2.10'], ['a', 'b'], held({ a: [], b: null }))!;
    expect(partial.status.warning).toBeNull();
    expect(partial.roles.has('b')).toBe(false);
    expect(haStatus([], ['a'], held({ a: [] }))).toBeNull();
  });

  it('reads addresses from GET /interfaces', () => {
    expect([...interfaceAddrs({ interfaces: [{ addr: '192.0.2.10' }, { addr: 'FE80::1' }] })]).toEqual(['192.0.2.10', 'fe80::1']);
    expect(interfaceAddrs(null).size).toBe(0);
  });
});
