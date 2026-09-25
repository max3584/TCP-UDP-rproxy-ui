import { describe, expect, it } from 'vitest';
import { listenOptions, reservedClash, type InterfacesInfo } from '@/components/listen';
import { explainError } from '@/components/messages';

const info: InterfacesInfo = {
  interfaces: [
    { name: 'lo', addr: '127.0.0.1', family: 'ipv4', loopback: true, link_local: false },
    { name: 'lo', addr: '::1', family: 'ipv6', loopback: true, link_local: false },
    { name: 'ens18', addr: '172.16.5.1', family: 'ipv4', loopback: false, link_local: false },
    { name: 'ens18', addr: 'fe80::1', family: 'ipv6', loopback: false, link_local: true },
    { name: 'ens19', addr: '2001:db8::5', family: 'ipv6', loopback: false, link_local: false },
  ],
  reserved: [{ protocol: 'tcp', addr: '127.0.0.1', port: 8081, purpose: 'control API' }],
};

describe('listenOptions', () => {
  it('offers the wildcards first, then interfaces with loopback last and no link-local', () => {
    expect(listenOptions(info).map((o) => o.value)).toEqual(['0.0.0.0', '::', '172.16.5.1', '2001:db8::5', '127.0.0.1', '::1']);
    expect(listenOptions(info)[2].label).toBe('ens18 — 172.16.5.1');
    expect(listenOptions(info)[4].label).toContain('ループバック');
  });

  it('still offers the wildcards without interface data', () => {
    expect(listenOptions(null).map((o) => o.value)).toEqual(['0.0.0.0', '::']);
  });
});

describe('reservedClash', () => {
  const r = info.reserved;
  it.each([
    ['same address and port', 'tcp', '127.0.0.1', 8081, null, true],
    ['wildcard listen', 'tcp', '0.0.0.0', 8081, null, true],
    ['IPv6 wildcard', 'tcp', '::', 8081, null, true],
    ['range covering the port', 'tcp', '0.0.0.0', 8000, 9000, true],
    ['other address', 'tcp', '172.16.5.1', 8081, null, false],
    ['other port', 'tcp', '127.0.0.1', 8082, null, false],
    ['udp is not the control API', 'udp', '0.0.0.0', 8081, null, false],
    ['empty port', 'tcp', '0.0.0.0', '', null, false],
  ] as const)('%s', (_name, protocol, addr, port, end, expected) => {
    expect(reservedClash(r, protocol, addr, port, end) !== null).toBe(expected);
  });
});

describe('explainError', () => {
  it('explains known codes and keeps the detail', () => {
    const msg = explainError('resolve_failed', 'box.home:25: failed to lookup address information');
    expect(msg).toContain('名前解決できませんでした');
    expect(msg).toContain('box.home:25');
  });

  it('explains privileged ports separately from ports in use', () => {
    expect(explainError('bind_failed', '127.0.0.2:25: Permission denied (os error 13)')).toContain('1024 未満のポート');
    expect(explainError('bind_failed', '0.0.0.0:8080: Address already in use (os error 98)')).toContain('ほかのプログラム');
  });

  it('falls back to the detail and code', () => {
    expect(explainError('weird', 'boom')).toBe('boom (weird)');
    expect(explainError(undefined, 'boom')).toBe('boom');
  });
});
