import { describe, expect, it } from 'vitest';
import { RPROXY_COLUMNS, nodeViewSql, parseArgs } from '../db/node-view.mjs';
import { NAME_PATTERN } from '@/components/nodes';
import { NAME_PATTERN as VIEW_NAME_PATTERN } from '../db/node-view.mjs';

describe('db/node-view.mjs', () => {
  it('creates the per-node database, a view named forward_rules and a read-only grant', () => {
    const sql = nodeViewSql({ node: 'node1', password: 'pw' });
    expect(sql).toContain('CREATE DATABASE IF NOT EXISTS `rproxy_node_node1`');
    expect(sql).toContain('CREATE OR REPLACE SQL SECURITY DEFINER VIEW `rproxy_node_node1`.`forward_rules` AS');
    expect(sql).toContain('FROM `rproxy`.`forward_rules` r');
    // 自分のノードの行と、自分を含むグループの行（forward_rule_targets）
    expect(sql).toContain("WHERE r.`target` IN (SELECT t.`target` FROM `rproxy`.`forward_rule_targets` t WHERE t.`node` = 'node1');");
    expect(sql).toContain("CREATE USER IF NOT EXISTS 'rproxy_node1'@'127.0.0.1' IDENTIFIED BY 'pw';");
    expect(sql).toContain("GRANT SELECT ON `rproxy_node_node1`.`forward_rules` TO 'rproxy_node1'@'127.0.0.1';");
    expect(sql).not.toMatch(/GRANT .* ON `rproxy`\./);
  });

  it('exposes exactly the columns rproxy-api reads (src/config/db.rs)', () => {
    expect(RPROXY_COLUMNS).toEqual(['protocol', 'src_addr', 'src_port', 'src_port_end', 'dist_addr', 'dist_port', 'source_ip', 'udp_idle_secs', 'options']);
    const select = /SELECT (.*)\n/.exec(nodeViewSql({ node: 'a' }))![1];
    expect(select.split(', ').map((c) => c.replace(/^r\.`|`$/g, ''))).toEqual(RPROXY_COLUMNS);
  });

  it('takes the database, user and host; omits CREATE USER without a password', () => {
    const sql = nodeViewSql({ node: 'b', database: 'ui', viewDatabase: 'rp_b', user: 'rpb', host: '10.0.0.%' });
    expect(sql).toContain('FROM `ui`.`forward_rules` r');
    expect(sql).toContain('`rp_b`.`forward_rules`');
    expect(sql).toContain("TO 'rpb'@'10.0.0.%';");
    expect(sql).not.toContain('CREATE USER');
  });

  it('quotes passwords without backslashes', () => {
    expect(nodeViewSql({ node: 'a', password: "it's" })).toContain("IDENTIFIED BY 'it''s'");
    expect(() => nodeViewSql({ node: 'a', password: 'a\\b' })).toThrow();
  });

  it('rejects unsafe names', () => {
    expect(() => nodeViewSql({ node: 'A' })).toThrow();
    expect(() => nodeViewSql({ node: "a'; DROP TABLE x; --" })).toThrow();
    expect(() => nodeViewSql({ node: 'a', database: 'x`y' })).toThrow();
    expect(() => nodeViewSql({ node: 'a', database: 'same', viewDatabase: 'same' })).toThrow(/別にしてください/);
    expect(() => nodeViewSql({ node: 'a', host: "h' OR 1" })).toThrow();
  });

  it('the node name rule is the same as the config file', () => {
    expect(VIEW_NAME_PATTERN.source).toBe(NAME_PATTERN.source);
  });

  it('parses the command line', () => {
    expect(parseArgs(['n1', '--database', 'ui', '--password', 'x'])).toEqual({ node: 'n1', database: 'ui', password: 'x' });
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['a', '--bogus', '1'])).toThrow(/知らないオプション/);
    expect(() => parseArgs(['a', '--user'])).toThrow();
  });
});
