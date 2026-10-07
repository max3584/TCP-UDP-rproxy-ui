-- 利用量の行を持ち主・印ごとに分ける（UI v0.4.0 のセキュリティレビュー M1）。010 を適用した環境に適用する。
-- 010 の主キー (時刻, node, protocol, listen_addr, listen_port) では、同じ日（時）に同じキーのルールの持ち主が変わる
-- （削除してほかの人が作り直した・管理者が付け替えた・ラベルを変えた）と、その日の前の分まで新しい持ち主・印の行になっていた。
-- attr（持ち主・置き場所・origin・ラベルの SHA-256。UI の components/usagecollect.ts の attributionKey）を主キーに足し、
-- 持ち主・印が違えば別の行に足す（前の行の owner・labels は書き換えない）。今ある行の attr は ''（前の持ち主のまま残る）。
-- UI を新しい版にする前に適用する（古い表のままだと集計の INSERT が attr 列がないため失敗し、利用量が増えない）。

ALTER TABLE usage_hourly
  ADD COLUMN attr CHAR(64) NOT NULL DEFAULT '' COMMENT '持ち主・置き場所・origin・ラベルの SHA-256（同じなら同じ行に足す）' AFTER listen_port,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (hour, node, protocol, listen_addr, listen_port, attr);

ALTER TABLE usage_daily
  ADD COLUMN attr CHAR(64) NOT NULL DEFAULT '' COMMENT '持ち主・置き場所・origin・ラベルの SHA-256（同じなら同じ行に足す）' AFTER listen_port,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (day, node, protocol, listen_addr, listen_port, attr);
