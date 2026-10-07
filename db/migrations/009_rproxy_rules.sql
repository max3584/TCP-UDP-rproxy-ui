-- rproxy-api が API で作ったルールを保存するテーブル（rproxy-api v0.4 の #144、UI #76）。
-- 書くのは rproxy だけ（トークンに persist: true が付いたトークンで作った・変えた・消したルール）。UI は読むだけで、
-- 変えるときは rproxy の API（PATCH / DELETE）を通す。列は rproxy-api の docs/DESIGN-v0.4.md 11. と同じ。
-- node は rproxy の RPROXY_NODE_NAME（既定はホスト名）。UI の RPROXY_UI_NODES のノードの名前と揃える。
-- 適用したら、複数の rproxy ではノードごとのビューを db/node-view.mjs で作り直す（ノードのデータベースに rproxy_rules のビューができる）。
-- rproxy の DB ユーザーへの権限（1 台の環境。ユーザーとホストは読み替える）:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.rproxy_rules TO 'rproxy'@'127.0.0.1';
-- UI の DB ユーザーには読み取りだけ:
--   GRANT SELECT ON rproxy.rproxy_rules TO 'rproxy_ui'@'10.0.0.%';

CREATE TABLE IF NOT EXISTS rproxy_rules (
  node        VARCHAR(255) NOT NULL,   -- どの rproxy のルールか（RPROXY_NODE_NAME、既定はホスト名）
  protocol    VARCHAR(3)   NOT NULL,
  listen_addr VARCHAR(45)  NOT NULL,
  listen_port INT UNSIGNED NOT NULL,
  spec        JSON         NOT NULL,   -- POST /rules の本文と同じ形（RuleRequest）
  spec_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by  VARCHAR(255) NOT NULL,   -- トークンの名前
  created_at  DATETIME(3)  NOT NULL,
  updated_by  VARCHAR(255) NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (node, protocol, listen_addr, listen_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
