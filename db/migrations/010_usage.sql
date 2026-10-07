-- 利用量の集計（UI #101）。UI が rproxy の統計（GET /rules の stats）を定期的に取り、差分を時間・日ごとに貯める。
-- 書くのも読むのも UI だけ（rproxy は使わない）。時刻は UTC。古い行は UI が消す（RPROXY_UI_USAGE_HOURLY_DAYS・RPROXY_UI_USAGE_DAILY_DAYS）。
-- 適用しなければ集計しない（UI はほかの機能のまま動く）。UI の DB ユーザーには 3 つの表の読み書きを渡す:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.usage_counters TO 'rproxy_ui'@'10.0.0.%';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.usage_hourly   TO 'rproxy_ui'@'10.0.0.%';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.usage_daily    TO 'rproxy_ui'@'10.0.0.%';

-- ルール・ノードごとの最後に見た数（差分を取るため。counters_since・started_at が変われば数え直したとみなす）
CREATE TABLE IF NOT EXISTS usage_counters (
  node           VARCHAR(255)    NOT NULL,
  protocol       VARCHAR(3)      NOT NULL,
  listen_addr    VARCHAR(45)     NOT NULL,
  listen_port    INT UNSIGNED    NOT NULL,
  counters_since BIGINT          NULL COMMENT 'rproxy の stats.counters_since（v0.4。Unix 秒）',
  started_at     BIGINT          NULL COMMENT 'rproxy の started_at（counters_since がない古い rproxy で使う）',
  rx_bytes       BIGINT UNSIGNED NOT NULL,
  tx_bytes       BIGINT UNSIGNED NOT NULL,
  connections    BIGINT UNSIGNED NOT NULL COMMENT 'stats.total_connections',
  sampled_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (node, protocol, listen_addr, listen_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1 時間ごとの通信量（hour は UTC の時の始まり）。owner・target・labels・origin はそのときのルールの持ち主と印
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour        DATETIME        NOT NULL,
  node        VARCHAR(255)    NOT NULL,
  protocol    VARCHAR(3)      NOT NULL,
  listen_addr VARCHAR(45)     NOT NULL,
  listen_port INT UNSIGNED    NOT NULL,
  target      VARCHAR(32)     NULL COMMENT 'UI のノード／グループ（UI のルールのとき）',
  owner       VARCHAR(255)    NULL COMMENT 'UI のルールの持ち主（Keycloak の sub）',
  origin      VARCHAR(16)     NOT NULL COMMENT 'dynamic（UI）・static・api',
  labels      JSON            NULL,
  rx_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tx_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  connections BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, node, protocol, listen_addr, listen_port),
  KEY usage_hourly_rule (protocol, listen_addr, listen_port, hour),
  KEY usage_hourly_owner (owner, hour)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1 日ごとの通信量（day は UTC の日付）。月ごとはこの表をまとめる
CREATE TABLE IF NOT EXISTS usage_daily (
  day         DATE            NOT NULL,
  node        VARCHAR(255)    NOT NULL,
  protocol    VARCHAR(3)      NOT NULL,
  listen_addr VARCHAR(45)     NOT NULL,
  listen_port INT UNSIGNED    NOT NULL,
  target      VARCHAR(32)     NULL,
  owner       VARCHAR(255)    NULL,
  origin      VARCHAR(16)     NOT NULL,
  labels      JSON            NULL,
  rx_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tx_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  connections BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, node, protocol, listen_addr, listen_port),
  KEY usage_daily_rule (protocol, listen_addr, listen_port, day),
  KEY usage_daily_owner (owner, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
