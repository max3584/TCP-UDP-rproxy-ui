-- UI が固定ルールに重ねた分（overlay）の正しい形（UI #197）。書くのも読むのも UI だけ（rproxy は読まない）。
-- 014 の rproxy_rule_overlays は rproxy が persist: true のトークンの分だけを書く表で、UI のトークン（persist: false）の分は入らず、
-- rproxy を再起動すると消える。UI はこの表を正として、rproxy にない・違う重ねる分を「ずれ」に出し、送り直す（act / stb の自動の送り直しも）。
-- 固定ルールはノードごと（各ノードの設定ファイル）なので重ねる分もノードごと。node は UI のノードの名前（RPROXY_UI_NODES を使わない 1 台は 'default'）。
-- 表を足すだけ（ほかの表は変えない）。適用しないと UI は重ねる分を足す・直す・外すことを断る（rproxy に送る前に。ずれの表示は空）。
-- UI の DB ユーザーへの権限（db/migrate.mjs の APP_GRANTS と同じ。ユーザーとホストは読み替える）:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rule_overlays TO 'rproxy_ui'@'10.0.0.%';

CREATE TABLE IF NOT EXISTS forward_rule_overlays (
  node        VARCHAR(32)  NOT NULL DEFAULT 'default' COMMENT 'ノードの名前（1 台なら default）',
  protocol    VARCHAR(3)   NOT NULL COMMENT '固定ルールのキー',
  listen_addr VARCHAR(45)  NOT NULL,
  listen_port INT UNSIGNED NOT NULL,
  spec        JSON         NOT NULL COMMENT 'PUT /rules/{key}/overlay の本文（rproxy が答えた形）',
  created_by  VARCHAR(255) NULL COMMENT '作った UI の利用者（auth_id）。直せる人を決める',
  created_by_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '作った人が管理者だったか（送り直す前に持ち主として確かめ直すか）',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by  VARCHAR(255) NULL COMMENT '最後に直した UI の利用者（auth_id）',
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (node, protocol, listen_addr, listen_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
