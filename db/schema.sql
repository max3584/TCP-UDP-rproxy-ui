-- 現在のテーブル定義（MariaDB）。migrations/ をすべて適用した結果と同じ内容に保つこと。
-- rproxy-api が読む列: protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options
-- （複数のノードでは、rproxy はノードごとのデータベースの forward_rules ビューを読む。db/node-view.mjs）
-- options は {"tls": ..., "starttls": ..., "starttls_required": ..., "allow_from": [...]} の JSON（allow_from は省略できる）。rproxy は未知のキーを拒否するので、ほかのキーを入れないこと

CREATE TABLE IF NOT EXISTS forward_rules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  auth_id       VARCHAR(255) NOT NULL COMMENT 'IdP（Keycloak）の sub',
  target        VARCHAR(32)  NOT NULL DEFAULT 'default' COMMENT 'ノードかグループの名前（RPROXY_UI_NODES）',
  protocol      VARCHAR(3)   NOT NULL COMMENT 'tcp / udp（小文字）',
  src_addr      VARCHAR(45)  NOT NULL COMMENT '待ち受け IP アドレス',
  src_port      INT          NOT NULL,
  src_port_end  INT          NULL COMMENT 'ポート範囲の終わり（単一ポートなら NULL）',
  dist_addr     VARCHAR(253) NOT NULL COMMENT '転送先 IP アドレスまたはホスト名',
  dist_port     INT          NOT NULL,
  source_ip     VARCHAR(16)  NOT NULL DEFAULT 'proxy' COMMENT 'proxy / proxy_v1 / proxy_v2 / transparent',
  udp_idle_secs INT          NOT NULL DEFAULT 30,
  options       JSON         NULL COMMENT 'TLS / STARTTLS / allow_from の設定（既定なら NULL）',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_forward_rules_target_listen (target, protocol, src_addr, src_port),
  KEY idx_forward_rules_auth_id (auth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forward_rules_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  auth_id       VARCHAR(255) NULL COMMENT '操作した利用者（IdP の sub）',
  target        VARCHAR(32)  NOT NULL DEFAULT 'default',
  node          VARCHAR(32)  NULL COMMENT '送り直したノード（RESEND のときだけ）',
  protocol      VARCHAR(3)   NOT NULL,
  src_addr      VARCHAR(45)  NOT NULL,
  src_port      INT          NOT NULL,
  src_port_end  INT          NULL,
  dist_addr     VARCHAR(253) NOT NULL,
  dist_port     INT          NOT NULL,
  update_action VARCHAR(8)   NOT NULL COMMENT 'ADD / UPDATE / DELETE / RESEND / OVERRIDE',
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_ip     VARCHAR(16)  NOT NULL DEFAULT 'proxy',
  udp_idle_secs INT          NOT NULL DEFAULT 30,
  options       JSON         NULL,
  PRIMARY KEY (id),
  KEY idx_forward_rules_log_listen (protocol, src_addr, src_port),
  KEY idx_forward_rules_log_auth_id (auth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ノード → そのノードが読む target（自分の名前と、自分を含むグループ）。UI が RPROXY_UI_NODES に合わせて書き直す
CREATE TABLE IF NOT EXISTS forward_rule_targets (
  node   VARCHAR(32) NOT NULL COMMENT 'ノードの名前',
  target VARCHAR(32) NOT NULL COMMENT 'そのノードが読む target（ノード自身か、ノードを含むグループ）',
  PRIMARY KEY (node, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- グループのルールの、ノードごとの上書き（#98）。options は forward_rules.options に JSON_MERGE_PATCH で重ねる差分
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

-- rproxy-api が API で作ったルール（rproxy-api v0.4 の #144）。書くのは rproxy だけで、UI は読むだけ（変えるときは rproxy の API）。
-- 列は rproxy-api の docs/DESIGN-v0.4.md 11. と同じ。node は rproxy の RPROXY_NODE_NAME（UI のノードの名前と揃える）
CREATE TABLE IF NOT EXISTS rproxy_rules (
  node        VARCHAR(255) NOT NULL,   -- どの rproxy のルールか（RPROXY_NODE_NAME、既定はホスト名）
  protocol    VARCHAR(3)   NOT NULL,
  listen_addr VARCHAR(45)  NOT NULL,
  listen_port INT UNSIGNED NOT NULL,
  spec        JSON         NOT NULL,   -- POST /rules の本文と同じ形（RuleRequest）
  spec_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by  VARCHAR(255) NOT NULL,   -- トークンの名前
  created_at  DATETIME(3)  NOT NULL,
  updated_by  VARCHAR(255) NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (node, protocol, listen_addr, listen_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
