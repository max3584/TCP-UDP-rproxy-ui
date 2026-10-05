-- グループのルールの、ノードごとの上書き（#98）。RPROXY_UI_NODES を使うときに必要（006・007 のあとに適用する）。
-- 上書きできるのは待ち受けアドレス（src_addr と options の extra_listen_addrs）、転送先（dist_addr / dist_port か、
-- options の targets / balance / health_check）、allow_from、このノードだけの一時停止（options の enabled: false）。
-- options は forward_rules.options に JSON_MERGE_PATCH で重ねる差分（null はキーを消す）。
-- 適用したら、各ノードのビューを db/node-view.mjs で作り直す（ビューがこの表を重ねるようになる）。
-- 1 台の環境では適用しなくても動く。

CREATE TABLE IF NOT EXISTS forward_rule_overrides (
  rule_id   INT UNSIGNED NOT NULL COMMENT 'forward_rules.id',
  node      VARCHAR(32)  NOT NULL COMMENT 'ノードの名前',
  src_addr  VARCHAR(45)  NULL COMMENT '待ち受けアドレス（上書きしなければ NULL）',
  dist_addr VARCHAR(253) NULL COMMENT '転送先（上書きしなければ NULL。複数の宛先にするときは空文字）',
  dist_port INT          NULL,
  options   JSON         NULL COMMENT 'forward_rules.options に重ねる差分',
  PRIMARY KEY (rule_id, node),
  CONSTRAINT fk_forward_rule_overrides_rule FOREIGN KEY (rule_id) REFERENCES forward_rules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
