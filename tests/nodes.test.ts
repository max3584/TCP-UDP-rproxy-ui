import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NODE,
  NodesConfigError,
  loadNodes,
  membership,
  nodesInfo,
  parseNodesConfig,
  probeNode,
  resetNodesCache,
  targetNodes,
  targetsOverlap,
} from '@/components/nodes';

const tokens: Record<string, string> = { '/t/a': 'token-a\n', '/t/b': 'token-b', '/t/empty': '  \n' };
const readToken = (p: string) => {
  if (!(p in tokens)) throw new Error('ENOENT');
  return tokens[p];
};

const YAML = `
nodes:
  - name: a
    url: http://10.0.0.1:8081/
    token_file: /t/a
  - name: b
    url: unix:/run/rproxy/api.sock
    token_file: /t/b
  - name: c
    url: https://c.example:8443
groups:
  - name: ha
    nodes: [a, b]
    mode: active_standby
  - name: all
    nodes: [c, a]
`;

describe('parseNodesConfig', () => {
  it('reads nodes, groups and tokens (YAML)', () => {
    const cfg = parseNodesConfig(YAML, readToken);
    expect(cfg.configured).toBe(true);
    expect(cfg.nodes).toEqual([
      { name: 'a', url: 'http://10.0.0.1:8081', tokenFile: '/t/a', token: 'token-a' },
      { name: 'b', url: 'unix:/run/rproxy/api.sock', tokenFile: '/t/b', token: 'token-b' },
      { name: 'c', url: 'https://c.example:8443' },
    ]);
    expect(cfg.groups).toEqual([
      { name: 'ha', nodes: ['a', 'b'], mode: 'active_standby', vips: [] },
      { name: 'all', nodes: ['c', 'a'], mode: 'single', vips: [] },
    ]);
    // ノード・グループがいくつかあれば、既定は選ばない
    expect(cfg.defaultTarget).toBeNull();
  });

  it('accepts JSON and default_target', () => {
    const cfg = parseNodesConfig(JSON.stringify({ nodes: [{ name: 'a', url: 'http://a:1' }, { name: 'b', url: 'http://b:1' }], groups: [{ name: 'g', nodes: ['a', 'b'] }], default_target: 'g' }), readToken);
    expect(cfg.defaultTarget).toBe('g');
  });

  it('reads the VIP of an active_standby group (one address or a list; IPv6 compressed)', () => {
    const base = 'nodes: [{name: a, url: "http://a"}, {name: b, url: "http://b"}]\n';
    expect(parseNodesConfig(`${base}groups: [{name: g, nodes: [a, b], mode: active_standby, vip: 192.0.2.10}]`, readToken).groups[0].vips).toEqual(['192.0.2.10']);
    expect(parseNodesConfig(`${base}groups: [{name: g, nodes: [a, b], mode: active_standby, vip: ["192.0.2.10", "2001:db8:0::10"]}]`, readToken).groups[0].vips)
      .toEqual(['192.0.2.10', '2001:db8::10']);
  });

  it('a single node is the default target', () => {
    expect(parseNodesConfig('nodes: [{name: solo, url: "http://x:1"}]', readToken).defaultTarget).toBe('solo');
  });

  const bad: [string, string, RegExp][] = [
    ['not yaml', 'nodes: [', /YAML/],
    ['no nodes', 'groups: []', /nodes にノード/],
    ['unknown top key', 'nodes: [{name: a, url: "http://a"}]\nextra: 1', /知らない項目があります: extra/],
    ['unknown node key', 'nodes: [{name: a, url: "http://a", token: x}]', /nodes\[0\] に知らない項目/],
    ['bad name', 'nodes: [{name: A-1, url: "http://a"}]', /nodes\[0\]\.name/],
    ['long name', `nodes: [{name: ${'a'.repeat(33)}, url: "http://a"}]`, /32 文字/],
    ['bad url', 'nodes: [{name: a, url: "ftp://a"}]', /nodes\[0\]\.url/],
    ['empty unix path', 'nodes: [{name: a, url: "unix:"}]', /url/],
    ['duplicate node', 'nodes: [{name: a, url: "http://a"}, {name: a, url: "http://b"}]', /名前 a が重なって/],
    ['group named like a node', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: a, nodes: [a]}]', /名前 a が重なって/],
    ['missing token file', 'nodes: [{name: a, url: "http://a", token_file: /t/none}]', /token_file（\/t\/none）を読めません/],
    ['empty token file', 'nodes: [{name: a, url: "http://a", token_file: /t/empty}]', /が空です/],
    ['unknown member', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: [a, z]}]', /z は nodes にありません/],
    ['duplicate member', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: [a, a]}]', /2 回/],
    ['empty group', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: []}]', /1 つ以上/],
    ['bad mode', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: [a], mode: hot}]', /mode/],
    ['act/stb with one node', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: [a], mode: active_standby}]', /2 つ以上/],
    ['bad vip', 'nodes: [{name: a, url: "http://a"}, {name: b, url: "http://b"}]\ngroups: [{name: g, nodes: [a, b], mode: active_standby, vip: nope}]', /vip には IP アドレス/],
    ['vip on a single group', 'nodes: [{name: a, url: "http://a"}]\ngroups: [{name: g, nodes: [a], vip: 192.0.2.10}]', /active_standby のグループにだけ/],
    ['unknown default', 'nodes: [{name: a, url: "http://a"}]\ndefault_target: z', /default_target/],
  ];
  it.each(bad)('rejects %s', (_, text, message) => {
    expect(() => parseNodesConfig(text, readToken)).toThrow(NodesConfigError);
    expect(() => parseNodesConfig(text, readToken)).toThrow(message);
  });
});

describe('targets', () => {
  const cfg = parseNodesConfig(YAML, readToken);

  it('a node is itself, a group is its members in config order', () => {
    expect(targetNodes(cfg, 'b')?.map((n) => n.name)).toEqual(['b']);
    expect(targetNodes(cfg, 'all')?.map((n) => n.name)).toEqual(['a', 'c']);
    expect(targetNodes(cfg, 'zzz')).toBeNull();
  });

  it('overlap: same target, node in group, groups sharing a node', () => {
    expect(targetsOverlap(cfg, 'a', 'a')).toBe(true);
    expect(targetsOverlap(cfg, 'a', 'ha')).toBe(true);
    expect(targetsOverlap(cfg, 'ha', 'all')).toBe(true);
    expect(targetsOverlap(cfg, 'b', 'c')).toBe(false);
    expect(targetsOverlap(cfg, 'b', 'all')).toBe(false);
  });

  it('membership lists each node and the groups containing it (the per-node view filter)', () => {
    expect(membership(cfg)).toEqual([
      { node: 'a', target: 'a' }, { node: 'a', target: 'ha' }, { node: 'a', target: 'all' },
      { node: 'b', target: 'b' }, { node: 'b', target: 'ha' },
      { node: 'c', target: 'c' }, { node: 'c', target: 'all' },
    ]);
  });

  it('nodesInfo hides URLs and tokens', () => {
    const info = nodesInfo(cfg);
    expect(JSON.stringify(info)).not.toMatch(/token|http|unix/);
    expect(info.nodes).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  it('probeNode picks the first member, the default or the first node', () => {
    expect(probeNode(cfg, 'all')?.name).toBe('a');
    expect(probeNode(cfg, 'c')).toEqual({ name: 'c', url: 'https://c.example:8443' });
    expect(probeNode(cfg, undefined)?.name).toBe('a');
    expect(() => probeNode(cfg, 'zzz')).toThrow(NodesConfigError);
  });
});

describe('loadNodes', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetNodesCache();
  });

  it('without RPROXY_UI_NODES: the single node from RPROXY_API_URL / RPROXY_API_TOKEN', () => {
    delete process.env.RPROXY_UI_NODES;
    process.env.RPROXY_API_URL = 'http://127.0.0.1:8081';
    process.env.RPROXY_API_TOKEN = 'tok';
    const cfg = loadNodes();
    expect(cfg.configured).toBe(false);
    expect(cfg.nodes).toEqual([{ name: DEFAULT_NODE, url: 'http://127.0.0.1:8081', token: 'tok' }]);
    expect(cfg.defaultTarget).toBe(DEFAULT_NODE);
    expect(probeNode(cfg, undefined)).toBeNull();
  });

  it('reads the file and the token files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rproxy-ui-nodes-'));
    writeFileSync(join(dir, 'a.token'), 'secret-a\n');
    writeFileSync(join(dir, 'nodes.yaml'), `nodes:\n  - name: a\n    url: http://a:8081\n    token_file: ${join(dir, 'a.token')}\n`);
    process.env.RPROXY_UI_NODES = join(dir, 'nodes.yaml');
    const cfg = loadNodes();
    expect(cfg.nodes[0].token).toBe('secret-a');
    // 2 回目は同じものを使い回す
    expect(loadNodes()).toBe(cfg);
  });

  it('names the file in errors', () => {
    process.env.RPROXY_UI_NODES = '/nonexistent/nodes.yaml';
    expect(() => loadNodes()).toThrow(/RPROXY_UI_NODES（\/nonexistent\/nodes.yaml）を読めません/);
  });
});
