-- 複数の rproxy（ノード）とグループ（#98）。
-- forward_rules / forward_rules_log に、ルールを置くノードかグループの名前（target）を足す。
-- 既存の行は 'default'（RPROXY_UI_NODES を使わない 1 台の名前）になる。キーは (target, protocol, src_addr, src_port)。
-- forward_rule_targets は「ノード → そのノードが読む target（自分と、自分を含むグループ）」の表で、
-- UI が RPROXY_UI_NODES の内容に合わせて書き直す。ノードごとのビュー（db/node-view.mjs）がこの表で絞り込む。
-- RPROXY_UI_NODES を使わない（1 台の）環境では適用しなくても動く（UI は target 列を使わない）。適用しても動きは変わらない。

ALTER TABLE forward_rules
  ADD COLUMN IF NOT EXISTS target VARCHAR(32) NOT NULL DEFAULT 'default' COMMENT 'ノードかグループの名前（RPROXY_UI_NODES）' AFTER auth_id;
ALTER TABLE forward_rules
  DROP INDEX IF EXISTS uq_forward_rules_listen;
ALTER TABLE forward_rules
  ADD UNIQUE KEY IF NOT EXISTS uq_forward_rules_target_listen (target, protocol, src_addr, src_port);

ALTER TABLE forward_rules_log
  ADD COLUMN IF NOT EXISTS target VARCHAR(32) NOT NULL DEFAULT 'default' AFTER auth_id;

CREATE TABLE IF NOT EXISTS forward_rule_targets (
  node   VARCHAR(32) NOT NULL COMMENT 'ノードの名前',
  target VARCHAR(32) NOT NULL COMMENT 'そのノードが読む target（ノード自身か、ノードを含むグループ）',
  PRIMARY KEY (node, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
