// UI と rproxy-api の版の組み合わせ（#106）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KNOWN_RPROXY_MINOR,
  MIN_RPROXY_VERSION,
  compareVersions,
  issueLevel,
  parseVersion,
  versionIssues,
  versionLabel,
  versionStatus,
  type NodeVersion,
} from '@/components/version';

const mocks = vi.hoisted(() => ({ getCapabilities: vi.fn() }));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getCapabilities: mocks.getCapabilities,
}));

import { checkVersions, logVersions, versionLogLine, versionsView } from '@/components/versioncheck';
import { currentNode } from '@/components/rproxy';
import type { NodesConfig } from '@/components/nodes';

describe('parseVersion / compareVersions', () => {
  it('reads x.y.z with or without v and a pre-release suffix', () => {
    expect(parseVersion('0.3.18')).toEqual([0, 3, 18]);
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.4.0-rc.1')).toEqual([0, 4, 0]);
    expect(parseVersion(' 0.3.5 ')).toEqual([0, 3, 5]);
  });

  it('rejects anything else', () => {
    for (const v of [undefined, null, 3, '', '0.3', 'abc', '0.3.x', '1.2.3.4']) expect(parseVersion(v)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions([0, 3, 10], [0, 3, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 3, 5], [0, 3, 5])).toBe(0);
    expect(compareVersions([0, 2, 99], [0, 3, 0])).toBeLessThan(0);
    expect(compareVersions([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
  });
});

describe('versionStatus', () => {
  it('the minimum and anything newer within the known minor is ok', () => {
    expect(versionStatus(MIN_RPROXY_VERSION, true)).toBe('ok');
    expect(versionStatus('0.3.18', true)).toBe('ok');
    expect(versionStatus('0.3.99', true)).toBe('ok');
  });

  it('older than the minimum', () => {
    expect(versionStatus('0.3.4', true)).toBe('old');
    expect(versionStatus('0.2.3', true)).toBe('old');
  });

  it('no version (rproxy-api before v0.3.18) or an unreadable one is unknown', () => {
    expect(versionStatus(undefined, true)).toBe('unknown');
    expect(versionStatus(null, true)).toBe('unknown');
    expect(versionStatus('dev', true)).toBe('unknown');
  });

  it('a newer minor or major than the UI knows', () => {
    expect(KNOWN_RPROXY_MINOR).toBe('0.4');
    expect(versionStatus('0.5.0', true)).toBe('newer');
    expect(versionStatus('1.0.0', true)).toBe('newer');
  });

  it('unreachable wins over everything', () => {
    expect(versionStatus('0.3.18', false)).toBe('unreachable');
  });

  it('takes other limits', () => {
    expect(versionStatus('0.3.17', true, '0.3.18')).toBe('old');
    expect(versionStatus('0.4.2', true, '0.3.5', '0.4')).toBe('ok');
  });
});

describe('versionIssues / issueLevel / versionLabel', () => {
  const node = (name: string, status: NodeVersion['status']): NodeVersion => ({ name: name, version: null, reachable: status !== 'unreachable', status: status });

  it('warns about old and unknown, only informs about newer, ignores ok and unreachable', () => {
    expect(issueLevel([node('a', 'ok'), node('b', 'unreachable')])).toBeNull();
    expect(issueLevel([node('a', 'ok'), node('b', 'newer')])).toBe('info');
    expect(issueLevel([node('a', 'newer'), node('b', 'unknown')])).toBe('warning');
    expect(issueLevel([node('a', 'old')])).toBe('warning');
    expect(versionIssues([node('a', 'ok'), node('b', 'old'), node('c', 'unreachable'), node('d', 'newer')]).map((n) => n.name)).toEqual(['b', 'd']);
  });

  it('labels with a v, or null when unknown', () => {
    expect(versionLabel('0.3.18')).toBe('v0.3.18');
    expect(versionLabel('v0.3.18')).toBe('v0.3.18');
    expect(versionLabel(null)).toBeNull();
    expect(versionLabel('dev')).toBeNull();
  });
});

describe('checkVersions', () => {
  beforeEach(() => {
    mocks.getCapabilities.mockReset();
  });

  const config: NodesConfig = {
    configured: true,
    nodes: [{ name: 'n1', url: 'http://192.0.2.1:8080', token: 't1' }, { name: 'n2', url: 'unix:/run/rproxy/api.sock' }, { name: 'n3', url: 'http://192.0.2.3:8080' }],
    groups: [],
    defaultTarget: null,
  };

  it('asks every node, each with its own connection', async () => {
    mocks.getCapabilities.mockImplementation(async () => {
      const name = currentNode()?.name;
      if (name === 'n1') return { source_ip: [], version: '0.3.18' };
      if (name === 'n2') return { source_ip: [] };
      throw new Error('connect ECONNREFUSED');
    });
    const nodes = await checkVersions(config);
    expect(nodes).toEqual([
      { name: 'n1', version: '0.3.18', reachable: true, status: 'ok' },
      { name: 'n2', version: null, reachable: true, status: 'unknown' },
      { name: 'n3', version: null, reachable: false, status: 'unreachable', error: 'connect ECONNREFUSED' },
    ]);
    const view = await versionsView(config);
    expect(view.minimum).toBe(MIN_RPROXY_VERSION);
    expect(view.nodes[2]).toEqual({ name: 'n3', version: null, reachable: false, status: 'unreachable' });
  });

  it('without RPROXY_UI_NODES asks RPROXY_API_URL as the default node', async () => {
    mocks.getCapabilities.mockImplementation(async () => ({ source_ip: [], version: currentNode() ? 'wrong' : '0.3.4' }));
    const nodes = await checkVersions({ configured: false, nodes: [{ name: 'default', url: '' }], groups: [], defaultTarget: 'default' });
    expect(nodes).toEqual([{ name: 'default', version: '0.3.4', reachable: true, status: 'old' }]);
  });

  it('log lines: info when fine, warn when old / unknown / unreachable', () => {
    expect(versionLogLine({ name: 'a', version: '0.3.18', reachable: true, status: 'ok' })).toEqual({ level: 'info', message: 'rproxy-ui: node a: rproxy-api v0.3.18' });
    expect(versionLogLine({ name: 'a', version: '0.3.4', reachable: true, status: 'old' }).level).toBe('warn');
    expect(versionLogLine({ name: 'a', version: null, reachable: true, status: 'unknown' }).level).toBe('warn');
    expect(versionLogLine({ name: 'a', version: '0.4.0', reachable: true, status: 'newer' }).level).toBe('info');
    expect(versionLogLine({ name: 'a', version: null, reachable: false, status: 'unreachable', error: 'boom' }).message).toContain('boom');
  });

  it('logVersions never throws (startup must not stop)', async () => {
    const prev = process.env.RPROXY_UI_NODES;
    process.env.RPROXY_UI_NODES = '/nonexistent/nodes.yaml';
    const log = { info: vi.fn(), warn: vi.fn() };
    try {
      await expect(logVersions(log)).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.RPROXY_UI_NODES; else process.env.RPROXY_UI_NODES = prev;
    }
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not check the rproxy-api versions'));
  });
});
