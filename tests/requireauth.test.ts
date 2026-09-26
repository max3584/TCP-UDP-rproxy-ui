import { describe, expect, it } from 'vitest';
import { isPublicPath } from '@/components/RequireAuth';

describe('isPublicPath', () => {
  it('lets only the profile page open without signing in', () => {
    expect(isPublicPath('/profile')).toBe(true);
    for (const p of ['/', '/rules/new', '/rules/[protocol]/[listenAddr]/[listenPort]', '/rules/[protocol]/[listenAddr]/[listenPort]/edit']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});
