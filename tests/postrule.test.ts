import { afterEach, describe, expect, it, vi } from 'vitest';
import { postRule } from '@/components/ui';

describe('postRule', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends http for L7 rules and leaves it out otherwise', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    const http = { routes: [{ name: 'all', match: 'PathPrefix(`/`)', to: 'http://127.0.0.1:8080' }] };
    await postRule('add', { srcPort: 80, http: http });
    await postRule('modify', { srcPort: 81, http: null });
    const bodies = fetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0]).toEqual({ srcPort: 80, http: http });
    expect(bodies[1]).toEqual({ srcPort: 81 });
  });
});
