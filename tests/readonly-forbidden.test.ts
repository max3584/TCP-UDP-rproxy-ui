// 見るだけのノード（Kubernetes の rproxy）の 403（#203）：トークンが読むだけなのは設計どおりなので、
// 「UI のトークンを admin に」（FORBIDDEN_MESSAGE）ではなく「権限が足りないため読めません」とだけ出す
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));

import { liveError } from '@/components/apiguard';
import { FORBIDDEN_MESSAGE, READONLY_NOT_PERMITTED_MESSAGE, RPROXY_UNAUTHORIZED_MESSAGE, explainError } from '@/components/messages';
import { RproxyError } from '@/components/rproxy';
import { translate } from '@/i18n/core';

describe('liveError', () => {
  it('gives read-only nodes the plain message for 403, without advice to change the token', () => {
    const err = new RproxyError('missing scope rules:read', 'forbidden', 403);
    expect(liveError(err, true)).toBe(READONLY_NOT_PERMITTED_MESSAGE);
    expect(liveError(err, true)).not.toContain('admin');
  });

  it('keeps FORBIDDEN_MESSAGE for other nodes', () => {
    const err = new RproxyError('missing scope rules:read', 'forbidden', 403);
    expect(liveError(err)).toBe(`${FORBIDDEN_MESSAGE}（詳細: missing scope rules:read）`);
    expect(liveError(err, false)).toContain(FORBIDDEN_MESSAGE);
  });

  it('read-only nodes still get the other explanations (401, plain errors)', () => {
    expect(liveError(new RproxyError('bad token', 'unauthorized', 401), true)).toBe(`${RPROXY_UNAUTHORIZED_MESSAGE}（詳細: bad token）`);
    expect(liveError(new Error('connect ECONNREFUSED'), true)).toBe('connect ECONNREFUSED');
  });
});

describe('READONLY_NOT_PERMITTED_MESSAGE', () => {
  it('is what readonly_not_permitted explains to, in Japanese and English', () => {
    expect(explainError('readonly_not_permitted', READONLY_NOT_PERMITTED_MESSAGE)).toBe('権限が足りないため読めません。');
    expect(translate(READONLY_NOT_PERMITTED_MESSAGE, 'en')).toBe('Not permitted to read this.');
  });
});
