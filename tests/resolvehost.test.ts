// 名前解決の上限（#197 のレビュー。応答のない DNS で利用者の確かめ・送り直しが止まらない）。DNS はモック
import { describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup, default: { lookup } }));

import { checkDestinations, resolveHost } from '@/components/usertargets';

describe('resolveHost', () => {
  it('answers addresses without asking DNS for a literal, and from DNS for a name', async () => {
    expect(await resolveHost('10.0.0.5')).toEqual(['10.0.0.5']);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce([{ address: '10.0.0.6', family: 4 }]);
    expect(await resolveHost('wiki.example.com')).toEqual(['10.0.0.6']);
  });

  it('gives up after the timeout, and the destination is refused as unresolvable', async () => {
    lookup.mockImplementation(() => new Promise(() => undefined));
    await expect(resolveHost('slow.example.com', 20)).rejects.toThrow('20ms');
    const refused = await checkDestinations([{ where: 'http.services.s', host: 'slow.example.com', ports: [80, 80] }], null,
      { resolve: (h) => resolveHost(h, 20), protectedAddrs: [] });
    expect(refused.map((r) => r.reason)).toEqual([expect.stringContaining('名前解決できません')]);
  });
});
