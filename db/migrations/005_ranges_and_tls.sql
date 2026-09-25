-- ポート範囲（src_port_end）と TLS / STARTTLS の設定（options）を追加する。
-- options は {"tls": ..., "starttls": ..., "starttls_required": ...} の JSON（rproxy は未知のキーを拒否する）。
-- 既定（passthrough で STARTTLS なし）のルールは NULL。既存の行は単一ポート・既定のままになる。
-- MariaDB の JSON は LONGTEXT の別名で、json_valid の CHECK 制約が付く。

ALTER TABLE forward_rules
  ADD COLUMN IF NOT EXISTS src_port_end INT  NULL COMMENT 'ポート範囲の終わり（単一ポートなら NULL）' AFTER src_port,
  ADD COLUMN IF NOT EXISTS options      JSON NULL COMMENT 'TLS / STARTTLS の設定（既定なら NULL）'   AFTER udp_idle_secs;

ALTER TABLE forward_rules_log
  ADD COLUMN IF NOT EXISTS src_port_end INT  NULL AFTER src_port,
  ADD COLUMN IF NOT EXISTS options      JSON NULL AFTER udp_idle_secs;
