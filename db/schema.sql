-- 現在のテーブル定義（MariaDB）。migrations/ をすべて適用した結果と同じ内容に保つこと。
-- rproxy-api が読む列: protocol, src_addr, src_port, src_port_end, dist_addr, dist_port, source_ip, udp_idle_secs, options
-- options は {"tls": ..., "starttls": ..., "starttls_required": ..., "allow_from": [...]} の JSON（allow_from は省略できる）。rproxy は未知のキーを拒否するので、ほかのキーを入れないこと

CREATE TABLE IF NOT EXISTS forward_rules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  auth_id       VARCHAR(255) NOT NULL COMMENT 'IdP（Keycloak）の sub',
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
  UNIQUE KEY uq_forward_rules_listen (protocol, src_addr, src_port),
  KEY idx_forward_rules_auth_id (auth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forward_rules_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  auth_id       VARCHAR(255) NULL COMMENT '操作した利用者（IdP の sub）',
  protocol      VARCHAR(3)   NOT NULL,
  src_addr      VARCHAR(45)  NOT NULL,
  src_port      INT          NOT NULL,
  src_port_end  INT          NULL,
  dist_addr     VARCHAR(253) NOT NULL,
  dist_port     INT          NOT NULL,
  update_action VARCHAR(8)   NOT NULL COMMENT 'ADD / UPDATE / DELETE',
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_ip     VARCHAR(16)  NOT NULL DEFAULT 'proxy',
  udp_idle_secs INT          NOT NULL DEFAULT 30,
  options       JSON         NULL,
  PRIMARY KEY (id),
  KEY idx_forward_rules_log_listen (protocol, src_addr, src_port),
  KEY idx_forward_rules_log_auth_id (auth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
