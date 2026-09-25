-- forward_rules_log に操作した利用者（IdP の sub）を記録する列を追加する。
-- 既存の行は誰の操作か分からないので NULL のままにする。

ALTER TABLE forward_rules_log
  ADD COLUMN IF NOT EXISTS auth_id VARCHAR(255) NULL COMMENT '操作した利用者（IdP の sub）' AFTER id,
  ADD INDEX IF NOT EXISTS idx_forward_rules_log_auth_id (auth_id);
