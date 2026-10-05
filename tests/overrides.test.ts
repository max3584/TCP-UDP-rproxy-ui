import { describe, expect, it } from 'vitest';
import {
  effectiveRule, formatTargetsText, normalizeOverride, overrideFromRow, overrideRow, parseTargetsText, sameOverrides,
  settingsOverridesToBody, toSettingsOverride,
} from '@/components/overrides';
import { nodesAllowed, roleConfig } from '@/components/roles';
import type { ForwardRule } from '@/components/lib';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: 'backend.example.com', distPort: 8443,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: ['10.0.0.0/8'],
  http: null, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null, extraListenAddrs: [],
};

describe('normalizeOverride', () => {
  it('normalizes addresses, destinations and allow_from; empty is null', () => {
    expect(normalizeOverride({}, base)).toBeNull();
    expect(normalizeOverride(null, base)).toBeNull();
    expect(normalizeOverride({ srcAddr: '2001:DB8:0::1', allowFrom: ['192.0.2.5'], distAddr: '192.0.2.10', distPort: 443 }, base))
      .toEqual({ srcAddr: '2001:db8::1', allowFrom: ['192.0.2.5/32'], distAddr: '192.0.2.10', distPort: 443 });
    expect(normalizeOverride({ targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80 }], balance: 'failover' }, base))
      .toEqual({ targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80 }], balance: 'failover', healthCheck: null });
    expect(normalizeOverride({ enabled: false }, base)).toEqual({ enabled: false });
  });

  it('rejects what cannot be overridden', () => {
    expect(() => normalizeOverride({ tls: { mode: 'sni' } }, base)).toThrow(/上書きできない項目/);
    expect(() => normalizeOverride({ srcAddr: 'host.example' }, base)).toThrow(/IP アドレス/);
    expect(() => normalizeOverride({ distAddr: '192.0.2.1' }, base)).toThrow(/ポート/);
    expect(() => normalizeOverride({ distAddr: '192.0.2.1', distPort: 1, targets: [{ addr: '192.0.2.2', port: 1 }] }, base)).toThrow(/どちらか一方/);
    expect(() => normalizeOverride({ distAddr: '192.0.2.1', distPort: 1 }, { ...base, http: { routes: [] } })).toThrow(/L7/);
    expect(() => normalizeOverride({ enabled: 'no' }, base)).toThrow(/enabled/);
    expect(normalizeOverride({ enabled: true }, base)).toBeNull();
    expect(() => normalizeOverride({ srcAddr: '192.0.2.1', extraListenAddrs: ['192.0.2.1'] }, base)).toThrow(/同じ/);
  });
});

describe('effectiveRule', () => {
  it('overlays the node\'s values on the group rule', () => {
    expect(effectiveRule(base, undefined)).toBe(base);
    const single = effectiveRule({ ...base, distAddr: '', distPort: 0, targets: [{ addr: '192.0.2.1', port: 80 }, { addr: '192.0.2.2', port: 80 }] }, { distAddr: '192.0.2.9', distPort: 81 });
    expect(single).toMatchObject({ distAddr: '192.0.2.9', distPort: 81, targets: [], balance: 'round_robin' });
    const multi = effectiveRule(base, { targets: [{ addr: '192.0.2.1', port: 80 }], balance: 'least_conn', srcAddr: '192.0.2.50', allowFrom: [], enabled: false });
    expect(multi).toMatchObject({ distAddr: '', distPort: 0, balance: 'least_conn', srcAddr: '192.0.2.50', allowFrom: [], enabled: false });
  });
});

describe('DB rows (the per-node view merges options with JSON_MERGE_PATCH)', () => {
  it('round-trips through the row and builds a merge patch', () => {
    const cases = [
      { srcAddr: '192.0.2.50' },
      { distAddr: '192.0.2.9', distPort: 81, allowFrom: [] },
      { targets: [{ addr: '192.0.2.1', port: 80, weight: 2 }], balance: 'least_conn' as const, healthCheck: { interval: '5s' }, extraListenAddrs: ['::'] },
      { enabled: false as const },
    ];
    for (const ov of cases) {
      const row = overrideRow(ov);
      const back = overrideFromRow({ ...row, options: row.options });
      expect(effectiveRule(base, back)).toEqual(effectiveRule(base, ov));
    }
    // 1 つの転送先にするときは、グループの targets を消す差分
    expect(JSON.parse(overrideRow({ distAddr: '192.0.2.9', distPort: 81 }).options!)).toEqual({ targets: null, balance: null, health_check: null });
    expect(overrideRow({ srcAddr: '192.0.2.50' })).toEqual({ src_addr: '192.0.2.50', dist_addr: null, dist_port: null, options: null });
    // mariadb は JSON 列をオブジェクトで返すこともある
    expect(overrideFromRow({ options: { enabled: false } })).toEqual({ enabled: false });
  });

  it('compares override sets', () => {
    expect(sameOverrides({ a: { srcAddr: '192.0.2.1' } }, { a: { srcAddr: '192.0.2.1' } })).toBe(true);
    expect(sameOverrides({ a: { srcAddr: '192.0.2.1' } }, {})).toBe(false);
    expect(sameOverrides(undefined, {})).toBe(true);
  });
});

describe('export form', () => {
  it('round-trips through the settings names', () => {
    const ov = { srcAddr: '192.0.2.50', distAddr: '192.0.2.9', distPort: 81, allowFrom: ['10.0.0.0/8'], enabled: false as const };
    const settings = toSettingsOverride(ov);
    expect(settings).toEqual({ listen_addr: '192.0.2.50', remote_addr: '192.0.2.9', remote_port: 81, allow_from: ['10.0.0.0/8'], enabled: false });
    const body = settingsOverridesToBody({ n1: settings });
    expect(normalizeOverride(body.n1, base)).toEqual(ov);
    expect(() => settingsOverridesToBody({ n1: { tls: {} } })).toThrow(/上書きできない項目/);
    expect(() => settingsOverridesToBody([])).toThrow();
  });

  it('targets text', () => {
    const targets = parseTargetsText('192.0.2.1:80\n[2001:db8::2]:80 3 backup\n');
    expect(targets).toEqual([{ addr: '192.0.2.1', port: 80 }, { addr: '2001:db8::2', port: 80, weight: 3, backup: true }]);
    expect(formatTargetsText(targets)).toBe('192.0.2.1:80\n[2001:db8::2]:80 3 backup');
    expect(() => parseTargetsText('nope')).toThrow();
    expect(() => parseTargetsText('192.0.2.1:80 heavy')).toThrow();
  });
});

describe('RPROXY_UI_USER_NODES', () => {
  it('limits users to listed nodes; groups need all their nodes; admins unaffected', () => {
    const cfg = roleConfig({ RPROXY_UI_USER_NODES: 'n1, n2' });
    expect(cfg.userNodes).toEqual(['n1', 'n2']);
    expect(nodesAllowed('user', cfg, ['n1'])).toBe(true);
    expect(nodesAllowed('user', cfg, ['n1', 'n3'])).toBe(false);
    expect(nodesAllowed('admin', cfg, ['n3'])).toBe(true);
    expect(nodesAllowed('user', roleConfig({}), ['n3'])).toBe(true);
    expect(roleConfig({}).userNodes).toBeNull();
    expect(() => roleConfig({ RPROXY_UI_USER_NODES: 'Bad-Name' })).toThrow();
  });
});
