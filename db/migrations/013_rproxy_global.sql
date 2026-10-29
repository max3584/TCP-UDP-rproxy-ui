-- rproxy-api が制御 API（PATCH /config/global）で入れた global の値を保存するテーブル（rproxy-api v0.4.19 の #342、UI #169）。
-- 書くのは rproxy だけ。ノードごとに 1 行（spec は API で入れた値だけを設定ファイルの global の形の JSON で持つ）。
-- 列は rproxy-api の docs/API.md の「global の設定の API」と同じ。node は rproxy の RPROXY_NODE_NAME（rproxy_rules と同じ）。
-- 適用しなくても rproxy は動く（API の値を保存しないだけ。PATCH /config/global の答えが persisted: false になり、再起動で消える）。
-- UI は値を rproxy の API（GET / PATCH /config/global）で読み書きし、このテーブルは読まない。
-- 適用したら、複数の rproxy ではノードごとのビューを db/node-view.mjs で作り直す（ノードのデータベースに rproxy_global のビューができる）。
-- rproxy の DB ユーザーへの権限（1 台の環境。ユーザーとホストは読み替える）:
--   GRANT SELECT, INSERT, UPDATE ON rproxy.rproxy_global TO 'rproxy'@'127.0.0.1';
-- UI の DB ユーザーには読み取りだけ:
--   GRANT SELECT ON rproxy.rproxy_global TO 'rproxy_ui'@'10.0.0.%';

CREATE TABLE IF NOT EXISTS rproxy_global (
  node         VARCHAR(255) NOT NULL,   -- どの rproxy の値か（RPROXY_NODE_NAME、既定はホスト名）
  spec         JSON         NOT NULL,   -- API で入れた値（設定ファイルの global と同じ形）
  spec_version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by   VARCHAR(255) NOT NULL,   -- トークンの名前
  updated_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (node)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
