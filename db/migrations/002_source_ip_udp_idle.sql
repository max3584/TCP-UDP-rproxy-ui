-- source_ip と udp_idle_secs を追加する。あわせて protocol を小文字に揃える。

ALTER TABLE forward_rules
  ADD COLUMN IF NOT EXISTS source_ip     VARCHAR(16) NOT NULL DEFAULT 'proxy' AFTER dist_port,
  ADD COLUMN IF NOT EXISTS udp_idle_secs INT         NOT NULL DEFAULT 30      AFTER source_ip;

ALTER TABLE forward_rules_log
  ADD COLUMN IF NOT EXISTS source_ip     VARCHAR(16) NOT NULL DEFAULT 'proxy',
  ADD COLUMN IF NOT EXISTS udp_idle_secs INT         NOT NULL DEFAULT 30;

UPDATE forward_rules SET protocol = LOWER(protocol);
UPDATE forward_rules_log SET protocol = LOWER(protocol);
