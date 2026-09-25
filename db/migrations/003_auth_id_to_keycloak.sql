-- auth_id を Auth0 の sub から Keycloak の sub に置き換える（一度だけ実行するテンプレート）。
--
-- 手順:
--   1. Keycloak に利用者を作成（またはインポート）し、Auth0 の sub と Keycloak の sub（UUID）の対応表を用意する。
--      Keycloak の sub は管理コンソールのユーザー詳細の「ID」、または Admin REST API の GET /admin/realms/{realm}/users で取得できる。
--   2. 下の INSERT の VALUES を対応表の内容に書き換える。
--   3. 実行前に forward_rules をバックアップする（mysqldump など）。
--   4. トランザクション内で実行し、最後の確認用 SELECT で未変換の行がないことを確かめてから COMMIT する。
--      未変換の行が残っていれば ROLLBACK して対応表を見直す。
--
-- このファイルはテンプレートなので、そのままでは実行しないこと（VALUES が例のまま）。

START TRANSACTION;

CREATE TEMPORARY TABLE auth_id_map (
  auth0_sub    VARCHAR(255) NOT NULL PRIMARY KEY,
  keycloak_sub VARCHAR(255) NOT NULL
);

INSERT INTO auth_id_map (auth0_sub, keycloak_sub) VALUES
  ('auth0|0123456789abcdef01234567', '00000000-0000-0000-0000-000000000000');
--  ('google-oauth2|123456789012345678901', '11111111-1111-1111-1111-111111111111'),

UPDATE forward_rules r
  JOIN auth_id_map m ON r.auth_id = m.auth0_sub
   SET r.auth_id = m.keycloak_sub;

-- 未変換の行（対応表に載っていない Auth0 の sub）を確認する。0 行であること。
SELECT id, auth_id, protocol, src_addr, src_port
  FROM forward_rules
 WHERE auth_id LIKE '%|%';

-- 問題なければ COMMIT、そうでなければ ROLLBACK。
-- COMMIT;
-- ROLLBACK;
