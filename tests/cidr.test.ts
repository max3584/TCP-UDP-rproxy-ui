// allow_from の CIDR の検証（components/cidr.ts）と、options 列・unmatched の検証（components/tls.ts）
import { describe, expect, it } from 'vitest';
import { MAX_ALLOW_FROM, checkAllowFrom, formatIpv6, parseCidr, splitAllowFromText } from '@/components/cidr';
import { TlsError, checkTls, normalizeAllowFrom, normalizeTls, optionsJson, parseOptions } from '@/components/tls';

const value = (s: string) => {
  const r = parseCidr(s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('parseCidr', () => {
  // rproxy-api の src/cidr.rs の parses_and_normalizes と同じ例
  it.each([
    ['10.1.2.3', '10.1.2.3/32'],
    ['172.16.9.9/16', '172.16.0.0/16'],
    ['fd00::1/8', 'fd00::/8'],
    ['::ffff:10.0.0.1', '10.0.0.1/32'],
    ['0.0.0.0/0', '0.0.0.0/0'],
    [' 192.168.1.0/24 ', '192.168.1.0/24'],
    ['::/0', '::/0'],
    ['::1', '::1/128'],
    ['[fd00::]/8', 'fd00::/8'],
    ['[2001:db8::1]', '2001:db8::1/128'],
    ['2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1/128'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1/128'],
    ['2001:db8::/32', '2001:db8::/32'],
    ['fe80::1:2:3:4/64', 'fe80::/64'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0/128'],
    ['::ffff:0a00:0001/32', '10.0.0.1/32'],
    ['64:ff9b::192.0.2.1', '64:ff9b::c000:201/128'],
    ['10.0.0.0/08', '10.0.0.0/8'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(value(input)).toBe(expected);
  });

  it.each([
    '', 'host.example', '10.0.0.0/33', 'fd00::/129', '10.0.0.0/x', '10.0.0.0/', '10.0.0.0/-1', '10.0.0.0/+8',
    '256.0.0.1', '10.0.0', '10.0.0.1.2', '010.0.0.1', '1:2:3:4:5:6:7:8:9', '1::2::3', ':1::2', '12345::', 'fe80::1%eth0',
    '10.0.0.0/8/8', '::ffff:10.0.0.0/104',
  ])('rejects %j', (input) => {
    const r = parseCidr(input);
    expect(r.ok).toBe(false);
  });

  it('explains a too long prefix separately', () => {
    const r = parseCidr('10.0.0.0/33');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('/33 が長すぎます（IPv4 は 32 まで）');
    const r6 = parseCidr('fd00::/129');
    if (!r6.ok) expect(r6.error).toContain('IPv6 は 128 まで');
    const bad = parseCidr('host.example');
    if (!bad.ok) expect(bad.error).toBe('CIDR か IP アドレスの形式ではありません: host.example');
  });

  it('formats IPv6 like RFC 5952 (the longest run of two or more zero groups, the first on a tie)', () => {
    const bytes = (groups: number[]) => groups.flatMap((g) => [g >> 8, g & 0xff]);
    expect(formatIpv6(bytes([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]))).toBe('2001:db8::1:0:0:1');
    expect(formatIpv6(bytes([0x2001, 0xdb8, 0, 1, 1, 1, 1, 1]))).toBe('2001:db8:0:1:1:1:1:1');
    expect(formatIpv6(bytes([1, 0, 0, 2, 0, 0, 0, 3]))).toBe('1:0:0:2::3');
    expect(formatIpv6(bytes([0, 0, 0, 0, 0, 0, 0, 0]))).toBe('::');
  });
});

describe('allow_from lists', () => {
  it('splits the textarea into one entry per line and ignores blank lines', () => {
    expect(splitAllowFromText(' 10.0.0.1 \r\n\n  fd00::/8\n')).toEqual(['10.0.0.1', 'fd00::/8']);
    expect(splitAllowFromText('')).toEqual([]);
  });

  it(`accepts at most ${MAX_ALLOW_FROM} entries`, () => {
    const many = Array.from({ length: 65 }, (_, i) => `10.0.0.${i}`);
    const r = checkAllowFrom(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('接続を許可する送信元は 64 件までです（65 件あります）。');
    const ok = checkAllowFrom(many.slice(0, 64));
    expect(ok.ok && ok.value.length).toBe(64);
  });

  it('reports the first invalid entry', () => {
    const r = checkAllowFrom(['10.0.0.1', 'nope', '10.0.0.0/40']);
    expect(r).toEqual({ ok: false, error: 'CIDR か IP アドレスの形式ではありません: nope' });
  });

  it('normalizeAllowFrom checks the shape and throws invalid', () => {
    expect(normalizeAllowFrom(undefined)).toEqual([]);
    expect(normalizeAllowFrom(null)).toEqual([]);
    expect(normalizeAllowFrom(['10.0.0.5', '172.16.9.9/16'])).toEqual(['10.0.0.5/32', '172.16.0.0/16']);
    for (const bad of ['10.0.0.5', [1], ['x'], { a: 1 }]) {
      expect(() => normalizeAllowFrom(bad)).toThrow(TlsError);
      try {
        normalizeAllowFrom(bad);
      } catch (err) {
        expect((err as TlsError).code).toBe('invalid');
      }
    }
  });
});

describe('options JSON with allow_from', () => {
  it('omits allow_from when empty and stores NULL for the defaults', () => {
    expect(optionsJson({ mode: 'passthrough' }, null, true)).toBeNull();
    expect(optionsJson({ mode: 'passthrough' }, null, true, [])).toBeNull();
    expect(JSON.parse(optionsJson({ mode: 'sni' }, null, true, [])!)).toEqual({ tls: { mode: 'sni' }, starttls: null, starttls_required: true });
  });

  it('stores allow_from even for a passthrough rule, with the four keys rproxy reads', () => {
    const json = optionsJson({ mode: 'passthrough' }, null, true, ['172.16.0.0/16'])!;
    expect(JSON.parse(json)).toEqual({ tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: ['172.16.0.0/16'] });
    expect(Object.keys(JSON.parse(json))).toEqual(['tls', 'starttls', 'starttls_required', 'allow_from']);
  });

  it('reads allow_from back (string or object) and rejects unknown keys like rproxy', () => {
    const stored = { tls: { mode: 'passthrough' }, starttls: null, starttls_required: true, allow_from: ['10.0.0.5/32', 'fd00::/8'] };
    expect(parseOptions(JSON.stringify(stored)).allowFrom).toEqual(['10.0.0.5/32', 'fd00::/8']);
    expect(parseOptions(stored).allowFrom).toEqual(['10.0.0.5/32', 'fd00::/8']);
    // 古い行（allow_from なし）と NULL
    expect(parseOptions(JSON.stringify({ tls: { mode: 'sni' }, starttls: null, starttls_required: true })).allowFrom).toEqual([]);
    expect(parseOptions(null)).toEqual({ tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [] });
    expect(() => parseOptions(JSON.stringify({ ...stored, extra: 1 }))).toThrow(/不明な項目/);
  });
});

describe('tls.unmatched', () => {
  const route = { server_name: 'dashboard.proxy.home', remote_addr: '127.0.0.1', remote_port: 3001 };
  const cert = { cert_file: '/c.pem', key_file: '/k.pem' };
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as TlsError).code;
    }
  };

  it('keeps reject, drops the default and rejects other values', () => {
    expect(normalizeTls({ mode: 'sni', routes: [route], unmatched: 'reject' })).toEqual({ mode: 'sni', routes: [route], unmatched: 'reject' });
    expect(normalizeTls({ mode: 'sni', routes: [route], unmatched: 'default' })).toEqual({ mode: 'sni', routes: [route] });
    expect(code(() => normalizeTls({ mode: 'sni', unmatched: 'drop' }))).toBe('invalid');
  });

  it('allows reject only for tcp sni / terminate with at least one route', () => {
    expect(code(() => checkTls('tcp', { mode: 'sni', routes: [route], unmatched: 'reject' }, null, 1))).toBeNull();
    expect(code(() => checkTls('tcp', { mode: 'terminate', certificates: [cert], routes: [route], unmatched: 'reject' }, null, 1))).toBeNull();
    expect(code(() => checkTls('tcp', { mode: 'sni', unmatched: 'reject' }, null, 1))).toBe('tls_config');
    expect(code(() => checkTls('tcp', { mode: 'passthrough', unmatched: 'reject' }, null, 1))).toBe('tls_config');
    expect(code(() => checkTls('udp', { mode: 'terminate', certificates: [cert], routes: [route], unmatched: 'reject' }, null, 1))).toBe('tls_config');
    // default（省略）ならどのモードでもよい
    expect(code(() => checkTls('tcp', { mode: 'passthrough' }, null, 1))).toBeNull();
  });

  it('reads the full tls object rproxy returns (all default fields included)', () => {
    const fromRproxy = {
      mode: 'terminate', routes: [route], certificates: [cert],
      client_auth: { mode: 'none', ca_file: null }, alpn: [],
      upstream: { tls: false, server_name: null, ca_file: null, insecure_skip_verify: false, cert_file: null, key_file: null },
      unmatched: 'reject',
    };
    expect(normalizeTls(fromRproxy)).toEqual({ mode: 'terminate', routes: [route], certificates: [cert], unmatched: 'reject' });
  });
});
