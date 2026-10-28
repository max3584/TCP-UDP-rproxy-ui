import { describe, expect, it } from 'vitest';
import { nodeVersionProblem } from '@/components/nodeversion';

describe('nodeVersionProblem (CVE-2026-111497)', () => {
  it('accepts the fixed releases and later', () => {
    for (const v of ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.23.0', 'v26.12.1', 'v26.13.0', 'v27.0.0']) {
      expect(nodeVersionProblem(v), v).toBeUndefined();
    }
  });

  it('warns about releases without the fix', () => {
    for (const v of ['v22.19.0', 'v22.23.3', 'v23.11.0', 'v24.12.0', 'v24.22.0', 'v25.9.0', 'v26.12.0', 'v20.19.0']) {
      expect(nodeVersionProblem(v), v).toMatch(/CVE-2026-111497/);
    }
    expect(nodeVersionProblem('v24.22.0')).toContain('24.22.1');
  });

  it('ignores a version it cannot read', () => {
    expect(nodeVersionProblem('unknown')).toBeUndefined();
  });
});
