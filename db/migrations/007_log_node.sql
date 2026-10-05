-- 1 つのノードへの送り直し（#98）の履歴に、そのノードの名前を残す（update_action は RESEND）。
-- RPROXY_UI_NODES を使うときに必要（006 のあとに適用する）。1 台の環境では適用しなくても動く。

ALTER TABLE forward_rules_log
  ADD COLUMN IF NOT EXISTS node VARCHAR(32) NULL COMMENT '送り直したノード（RESEND のときだけ）' AFTER target;
