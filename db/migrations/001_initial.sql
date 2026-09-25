-- 初期状態（source_ip / udp_idle_secs を追加する前）のテーブル定義。
-- 既存の本番テーブルから推定したもの。既にテーブルがある環境では適用不要（CREATE TABLE IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS forward_rules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  auth_id       VARCHAR(255) NOT NULL,
  protocol      VARCHAR(3)   NOT NULL,
  src_addr      VARCHAR(45)  NOT NULL,
  src_port      INT          NOT NULL,
  dist_addr     VARCHAR(253) NOT NULL,
  dist_port     INT          NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_forward_rules_listen (protocol, src_addr, src_port),
  KEY idx_forward_rules_auth_id (auth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS forward_rules_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  protocol      VARCHAR(3)   NOT NULL,
  src_addr      VARCHAR(45)  NOT NULL,
  src_port      INT          NOT NULL,
  dist_addr     VARCHAR(253) NOT NULL,
  dist_port     INT          NOT NULL,
  update_action VARCHAR(8)   NOT NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_forward_rules_log_listen (protocol, src_addr, src_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
