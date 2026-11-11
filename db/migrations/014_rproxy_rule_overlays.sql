-- rproxy-api が設定ファイルの固定ルール（origin: static）の待ち受けに API で重ねる分（overlay）を保存するテーブル
-- （rproxy-api v0.4.23 の #397、UI #193）。
-- 書くのは rproxy だけ（persist: true のトークンで作った重ねる分と、一度書いたもの）。固定ルールのキーごとに 1 行。
-- 列は rproxy-api の docs/API.md の「固定ルールの待ち受けに重ねる分」と同じ。node は rproxy の RPROXY_NODE_NAME（rproxy_rules と同じ）。
-- 適用しなくても rproxy は動く（重ねる分を保存しないだけ。PUT …/overlay の答えが persisted: false になり、再起動で消える）。
-- UI は重ねる分を rproxy の API（GET / PUT / DELETE /rules/{key}/overlay）で読み書きし、このテーブルは読まない。
-- 適用したら、複数の rproxy ではノードごとのビューを db/node-view.mjs で作り直す（ノードのデータベースに rproxy_rule_overlays のビューができる）。
-- rproxy の DB ユーザーへの権限（1 台の環境。ユーザーとホストは読み替える）:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.rproxy_rule_overlays TO 'rproxy'@'127.0.0.1';
-- UI の DB ユーザーには権限は要らない（UI は重ねる分を rproxy の API で読み書きし、このテーブルを読まない）。

CREATE TABLE IF NOT EXISTS rproxy_rule_overlays (
  node         VARCHAR(255) NOT NULL,   -- どの rproxy の重ねる分か（RPROXY_NODE_NAME、既定はホスト名。rproxy_rules と同じ）
  protocol     VARCHAR(8)   NOT NULL,   -- 固定ルールのキー
  listen_addr  VARCHAR(45)  NOT NULL,
  listen_port  INT UNSIGNED NOT NULL,
  spec         JSON         NOT NULL,   -- PUT /rules/{key}/overlay の本文
  spec_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by   VARCHAR(255) NOT NULL,   -- 最初に作ったトークンの名前
  created_at   DATETIME(3)  NOT NULL,
  updated_by   VARCHAR(255) NOT NULL,   -- 最後に直したトークンの名前
  updated_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (node, protocol, listen_addr, listen_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
