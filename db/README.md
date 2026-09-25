# データベース（MariaDB）

UI と rproxy-api が共有するテーブルの定義。

| ファイル | 内容 |
|---|---|
| `schema.sql` | 現在のテーブル定義。新しく環境を作るときはこれだけを流せばよい |
| `migrations/001_initial.sql` | 初期状態（`source_ip` / `udp_idle_secs` 追加前）の定義 |
| `migrations/002_source_ip_udp_idle.sql` | `source_ip`、`udp_idle_secs` 列の追加と `protocol` の小文字化 |
| `migrations/003_auth_id_to_keycloak.sql` | `auth_id` を Auth0 の sub から Keycloak の sub に置き換えるテンプレート（一度だけ手動で実行） |

既存の環境では `002` から順に適用する。`schema.sql` を変えたときは、同じ変更をする migration も追加すること。

```bash
mariadb -h <host> -P <port> -u <admin> -p <database> < db/migrations/002_source_ip_udp_idle.sql
```

## テーブル

- `forward_rules`：転送ルール。`(protocol, src_addr, src_port)` で一意。`auth_id` は IdP（Keycloak）の `sub`。
  `protocol` は小文字の `tcp` / `udp`、IPv6 の `src_addr` は圧縮表記（例 `::1`）で保存する。
- `forward_rules_log`：追加・変更・削除の履歴。`update_action` は `ADD` / `UPDATE` / `DELETE`。

## DB ユーザー

UI 用のユーザーには両テーブルへの読み書き権限を与える。

```sql
CREATE USER 'rproxy_ui'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.%';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.%';
```

rproxy-api は起動時に `forward_rules` を読むだけなので、読み取り専用のユーザーを使う。
読む列は `protocol`、`src_addr`、`src_port`、`dist_addr`、`dist_port`、`source_ip`、`udp_idle_secs`。

```sql
CREATE USER 'rproxy'@'127.0.0.1' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'127.0.0.1';
```

（例ではデータベース名を `rproxy` としている。`DB_DATABASE` に合わせて読み替えること。）
