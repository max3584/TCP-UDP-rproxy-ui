# データベース（MariaDB）

UI と rproxy-api が共有するテーブルの定義。

| ファイル | 内容 |
|---|---|
| `schema.sql` | 現在のテーブル定義。新しく環境を作るときはこれだけを流せばよい |
| `migrations/001_initial.sql` | 初期状態（`source_ip` / `udp_idle_secs` 追加前）の定義 |
| `migrations/002_source_ip_udp_idle.sql` | `source_ip`、`udp_idle_secs` 列の追加と `protocol` の小文字化 |
| `migrations/003_auth_id_to_keycloak.sql` | `auth_id` を Auth0 の sub から Keycloak の sub に置き換えるテンプレート（一度だけ手動で実行） |
| `migrations/004_log_auth_id.sql` | `forward_rules_log` に操作した利用者（`auth_id`）の列を追加 |
| `migrations/005_ranges_and_tls.sql` | 両テーブルにポート範囲の終わり（`src_port_end`）と TLS / STARTTLS の設定（`options`）の列を追加 |

既存の環境では `002` から順に適用する。`schema.sql` を変えたときは、同じ変更をする migration も追加すること。

```bash
mariadb -h <host> -P <port> -u <admin> -p <database> < db/migrations/002_source_ip_udp_idle.sql
```

## テーブル

- `forward_rules`：転送ルール。`(protocol, src_addr, src_port)` で一意。`auth_id` は IdP（Keycloak）の `sub`。
  `protocol` は小文字の `tcp` / `udp`、IPv6 の `src_addr` は圧縮表記（例 `::1`）で保存する。
  - `src_port_end`：ポート範囲の終わり。単一ポートなら NULL。範囲ルールのキーは先頭の `src_port`（範囲の重なりは rproxy が拒否する）。
  - `options`：TLS / STARTTLS / 接続を許可する送信元 / L7 の設定の JSON。形は必ず `{"tls": <TLS>, "starttls": "smtp" | "imap" | "pop3" | null, "starttls_required": bool, "allow_from": [<CIDR>, ...], "http": <L7>, "crowdsec": bool}`
    （`<TLS>` は `../rproxy-api/docs/API.md` の「TLS」と同じ。`allow_from` は正規化した CIDR（`10.0.0.5/32` など）で、空なら省く。
    `<L7>` は API.md の「v0.3 の設定」のルールの `http` で、L7 のルールだけに付く（そのルールの `dist_addr` は `''`、`dist_port` は `0`）。rproxy は未知のキーを拒否して読み込むので、ほかのキーを足さないこと。
    `crowdsec`（L4 で CrowdSec の判定に入っている接続元を切る。rproxy-api v0.3.2 から）は true のときだけ付ける。
    passthrough で既定値のまま、STARTTLS なし、allow_from なし、http なし、crowdsec なしのルールは NULL を保存する。列の型は変わらないので、migration は不要。
  - rproxy の固定ルール（`--static-rules` のファイル）はこのテーブルに入らない。
- `forward_rules_log`：追加・変更・削除の履歴。`update_action` は `ADD` / `UPDATE` / `DELETE`、`auth_id` は操作した利用者（`004` より前の行は NULL）。

## DB ユーザー

UI 用のユーザーには両テーブルへの読み書き権限を与える。

```sql
CREATE USER 'rproxy_ui'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.%';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.%';
```

rproxy-api は起動時に `forward_rules` を読むだけなので、読み取り専用のユーザーを使う。
読む列は `protocol`、`src_addr`、`src_port`、`src_port_end`、`dist_addr`、`dist_port`、`source_ip`、`udp_idle_secs`、`options`
（`src_port_end` / `options` がない古いテーブルでも既定値で読み込む）。

```sql
CREATE USER 'rproxy'@'127.0.0.1' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'127.0.0.1';
```

（例ではデータベース名を `rproxy` としている。`DB_DATABASE` に合わせて読み替えること。）
