import { describe, expect, it } from 'vitest';
import { transparentHint } from '@/components/sourceip';

describe('transparentHint', () => {
  it('explains the prerequisites once transparent is chosen', () => {
    const h = transparentHint({ sourceIp: 'transparent', transparentAvailable: true, listenIsIPv6: false });
    expect(h?.kind).toBe('selected');
    expect(h?.message).toContain('--transparent-clients');
  });

  it('keeps explaining a transparent rule even if rproxy lost the capability (edit screen)', () => {
    expect(transparentHint({ sourceIp: 'transparent', transparentAvailable: false, listenIsIPv6: false })?.kind).toBe('selected');
  });

  it('says why transparent is missing when rproxy lacks CAP_NET_ADMIN', () => {
    const h = transparentHint({ sourceIp: 'proxy', transparentAvailable: false, listenIsIPv6: false });
    expect(h?.kind).toBe('unavailable');
    expect(h?.message).toContain('CAP_NET_ADMIN');
  });

  it('says transparent is IPv4 only for an IPv6 listen address', () => {
    expect(transparentHint({ sourceIp: 'proxy', transparentAvailable: true, listenIsIPv6: true })?.kind).toBe('ipv6');
  });

  it('says nothing when transparent is available, or when capabilities are unknown', () => {
    expect(transparentHint({ sourceIp: 'proxy', transparentAvailable: true, listenIsIPv6: false })).toBeNull();
    expect(transparentHint({ sourceIp: 'proxy_v2', transparentAvailable: null, listenIsIPv6: true })).toBeNull();
  });
});
