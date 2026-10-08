-- rproxy-api が persist: true のトークンで PUT したルールの組（PUT /rulesets/{name}）を保存するテーブル（rproxy-api v0.4.2 の #241）。
-- 書くのは rproxy だけ。1 つの組を 1 行（rules は組のルールの JSON の配列。各要素は POST /rules の本文と同じ形）にする。
-- 列は rproxy-api の docs/API.md の「ルールの組の保存」と同じ。node は rproxy の RPROXY_NODE_NAME（rproxy_rules と同じ）。
-- 適用しなくても rproxy は動く（組を保存しないだけ。persist: true のトークンの組は persisted: false になる）。
-- 適用したら、複数の rproxy ではノードごとのビューを db/node-view.mjs で作り直す（ノードのデータベースに rproxy_rule_sets のビューができる）。
-- rproxy の DB ユーザーへの権限（1 台の環境。ユーザーとホストは読み替える）:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.rproxy_rule_sets TO 'rproxy'@'127.0.0.1';
-- UI の DB ユーザーには読み取りだけ:
--   GRANT SELECT ON rproxy.rproxy_rule_sets TO 'rproxy_ui'@'10.0.0.%';

CREATE TABLE IF NOT EXISTS rproxy_rule_sets (
  node         VARCHAR(255)    NOT NULL,   -- どの rproxy の組か（RPROXY_NODE_NAME、既定はホスト名）
  name         VARCHAR(253)    NOT NULL,   -- 組の名前
  generation   BIGINT UNSIGNED NOT NULL,   -- 呼ぶ側の世代（PUT の本文の generation）
  etag         VARCHAR(64)     NOT NULL,
  owner        VARCHAR(255)    NOT NULL,   -- 組の持ち主のトークンの名前
  rules        JSON            NOT NULL,   -- 組のルール（POST /rules の本文と同じ形の配列）
  spec_version INT UNSIGNED    NOT NULL DEFAULT 1,
  updated_by   VARCHAR(255)    NOT NULL,   -- トークンの名前
  updated_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (node, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
