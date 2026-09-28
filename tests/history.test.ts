import { describe, expect, it } from 'vitest';
import { DEFAULT_BALANCE, ForwardRule } from '@/components/lib';
import { historyQuery, isDate, ruleChanges } from '@/components/history';

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.1', distPort: 80,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true,
  allowFrom: [], http: null, crowdsec: false, targets: [], balance: DEFAULT_BALANCE, healthCheck: null, extraListenAddrs: [],
};

describe('ruleChanges', () => {
  it('describes what changed between two versions', () => {
    expect(ruleChanges(base, base)).toEqual([]);
    expect(ruleChanges(null, base)).toEqual([]);
    expect(ruleChanges(base, {
      ...base,
      distPort: 8080,
      tls: { mode: 'terminate', certificates: [{ cert_file: '/c', key_file: '/k' }] },
      allowFrom: ['10.0.0.0/8'],
      crowdsec: true,
      extraListenAddrs: ['::'],
    })).toEqual([
      '転送先: 10.0.0.1:80 → 10.0.0.1:8080',
      'TLS のモード: passthrough → terminate',
      '接続を許可する送信元: すべて → 10.0.0.0/8',
      'CrowdSec: 無効 → 有効',
      '追加の待ち受けアドレス: （なし） → ::',
    ]);
    expect(ruleChanges(base, { ...base, tls: { mode: 'passthrough', alpn: ['h2'] } })).toEqual(['TLS の設定を変更']);
  });

  it('shows targets, balance and L7 changes', () => {
    const multi = { ...base, distAddr: '', distPort: 0, targets: [{ addr: 'a', port: 1 }, { addr: 'b', port: 2 }] };
    expect(ruleChanges(base, multi)).toEqual(['転送先: 10.0.0.1:80 → a:1, b:2（round_robin）']);
    expect(ruleChanges(multi, { ...multi, targets: [{ addr: 'a', port: 1, weight: 3 }, { addr: 'b', port: 2 }] })).toEqual(['宛先の重み・予備を変更']);
    expect(ruleChanges(multi, { ...multi, balance: 'failover' })).toEqual(['転送先: a:1, b:2（round_robin） → a:1, b:2（failover）']);
    const l7 = { ...base, distAddr: '', distPort: 0, http: { routes: [] } };
    expect(ruleChanges(l7, { ...l7, http: { routes: [{ name: 'x' }] } })).toEqual(['L7 の設定を変更']);
  });
});

describe('history helpers', () => {
  it('checks dates and builds the query string', () => {
    expect(isDate('2026-09-28')).toBe(true);
    expect(isDate('2026-9-28')).toBe(false);
    expect(isDate('2026-13-40')).toBe(false);
    expect(historyQuery({ protocol: 'tcp', port: 443, user: '' }, 2, 50)).toBe('protocol=tcp&port=443&page=2&per_page=50');
  });
});
