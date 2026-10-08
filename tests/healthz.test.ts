import { describe, expect, it } from 'vitest';
import handler from '@/pages/api/healthz';

function call(method: string) {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status: (s: number) => { out.status = s; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  };
  handler({ method } as never, res as never);
  return out;
}

describe('GET /api/healthz', () => {
  it('answers {ok: true} without a session and says nothing else', () => {
    const r = call('GET');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
  it('refuses other methods', () => {
    expect(call('POST').status).toBe(405);
  });
});
