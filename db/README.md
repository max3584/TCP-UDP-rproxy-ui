# データベース（MariaDB）

English: [README.en.md](README.en.md)

UI と rproxy-api が共有するテーブルの定義。

| ファイル | 内容 |
|---|---|
| `schema.sql` | 現在のテーブル定義。新しく環境を作るときはこれだけを流せばよい |
| `migrations/001_initial.sql` | 初期状態（`source_ip` / `udp_idle_secs` 追加前）の定義 |
| `migrations/002_source_ip_udp_idle.sql` | `source_ip`、`udp_idle_secs` 列の追加と `protocol` の小文字化 |
| `migrations/003_auth_id_to_keycloak.sql` | `auth_id` を Auth0 の sub から Keycloak の sub に置き換えるテンプレート（一度だけ手動で実行） |
| `migrations/004_log_auth_id.sql` | `forward_rules_log` に操作した利用者（`auth_id`）の列を追加 |
| `migrations/005_ranges_and_tls.sql` | 両テーブルにポート範囲の終わり（`src_port_end`）と TLS / STARTTLS の設定（`options`）の列を追加 |
| `migrations/006_nodes.sql` | 複数の rproxy（#98）：両テーブルに `target` 列、キーを `(target, protocol, src_addr, src_port)` に、`forward_rule_targets` 表を追加。`RPROXY_UI_NODES` を使わない 1 台の環境では適用しなくても動く |
| `migrations/007_log_node.sql` | 複数の rproxy（#98）：`forward_rules_log` に送り直したノード（`node`）の列を追加。`RPROXY_UI_NODES` を使うときに必要 |
| `node-view.mjs` | ノードごとのデータベースと `forward_rules` ビュー・読み取りだけの DB ユーザーの SQL を出す（下の「複数の rproxy（ノードごとのビュー）」） |

既存の環境では `002` から順に適用する。`schema.sql` を変えたときは、同じ変更をする migration も追加すること。

```bash
mariadb -h <host> -P <port> -u <admin> -p <database> < db/migrations/002_source_ip_udp_idle.sql
```

## テーブル

- `forward_rules`：転送ルール。`(target, protocol, src_addr, src_port)` で一意（`006` より前は `(protocol, src_addr, src_port)`）。`auth_id` は IdP（Keycloak）の `sub`。
  - `target`：ルールを置くノードかグループの名前（`RPROXY_UI_NODES`。既定 `default`）。`RPROXY_UI_NODES` を使わないときは UI はこの列を読み書きしない（すべて `default`）。
  `protocol` は小文字の `tcp` / `udp`、IPv6 の `src_addr` は圧縮表記（例 `::1`）で保存する。
  - `src_port_end`：ポート範囲の終わり。単一ポートなら NULL。範囲ルールのキーは先頭の `src_port`（範囲の重なりは rproxy が拒否する）。
  - `options`：TLS / STARTTLS / 接続を許可する送信元 / L7 の設定の JSON。形は必ず `{"tls": <TLS>, "starttls": "smtp" | "imap" | "pop3" | null, "starttls_required": bool, "allow_from": [<CIDR>, ...], "http": <L7>, "crowdsec": bool, "targets": [<宛先>, ...], "balance": "round_robin" | "least_conn" | "failover", "health_check": {"interval", "timeout", "port"}, "extra_listen_addrs": [<IP>, ...], "enabled": false}`
    （`<TLS>` は `../rproxy-api/docs/API.md` の「TLS」と同じ。`allow_from` は正規化した CIDR（`10.0.0.5/32` など）で、空なら省く。
    `<L7>` は API.md の「v0.3 の設定」のルールの `http` で、L7 のルールだけに付く（そのルールの `dist_addr` は `''`、`dist_port` は `0`）。rproxy は未知のキーを拒否して読み込むので、ほかのキーを足さないこと。
    `crowdsec`（L4 で CrowdSec の判定に入っている接続元を切る。rproxy-api v0.3.2 から）は true のときだけ付ける。
    `targets`（宛先を複数にしたとき。`<宛先>` は `{"addr", "port", "weight"?, "backup"?}`。rproxy-api v0.3.3 から）は宛先が複数のときだけ付け、
    `balance`（既定の `round_robin` なら省く）と `health_check` も `targets` があるときだけ付ける。そのルールの `dist_addr` は `''`、`dist_port` は `0`
    （rproxy は `targets` と `remote_addr` を一緒に受け付けないため。一覧に出す先頭の宛先は `targets[0]`）。
    `extra_listen_addrs`（同じポートで追加で待ち受ける IP アドレスの配列、最大 16 件。rproxy-api v0.3.3 から）は空なら省く。
    `enabled`（UI での一時停止）は `false` のときだけ書く。rproxy-api v0.3.5 から、rproxy は起動時にこの行を作らない（rproxy の API には送らない項目）。
    `<TLS>` の `routes[]` は `server_name` か `server_names`（どちらか一方）と、true のときだけ `passthrough` を持つ（rproxy-api v0.3.3 から）。
    passthrough で既定値のまま、STARTTLS なし、allow_from なし、http なし、crowdsec なし、宛先が 1 つのルールは NULL を保存する。列の型は変わらないので、migration は不要。
  - rproxy の固定ルール（`--static-rules` のファイル）はこのテーブルに入らない。
- `forward_rules_log`：追加・変更・削除の履歴。`update_action` は `ADD` / `UPDATE` / `DELETE`、`auth_id` は操作した利用者（`004` より前の行は NULL）。
  各行はその操作のあとのルールの内容（`DELETE` は削除する前の内容）を持つので、UI の「変更の履歴」はこの行から前の版との違いを出し、「この版に戻す」でその内容に戻す（インポート・巻き戻しの操作も同じく記録する）。

- `forward_rule_targets`：ノード → そのノードが読む `target`（ノード自身と、そのノードを含むグループ）。UI が `RPROXY_UI_NODES` の内容に合わせて書き直す（`RPROXY_UI_NODES` があるときだけ）。ノードごとのビューがこれで絞り込む。
  `forward_rules_log` にも `target` 列がある。1 つのノードへの送り直しは `update_action` が `RESEND` で、`node`（007）にそのノードを残す（内容は送ったルール）。

## DB ユーザー

UI 用のユーザーには両テーブルへの読み書き権限を与える。

```sql
CREATE USER 'rproxy_ui'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.%';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.%';
-- RPROXY_UI_NODES を使うとき
GRANT SELECT, INSERT, DELETE         ON rproxy.forward_rule_targets TO 'rproxy_ui'@'10.0.0.%';
```

rproxy-api は起動時に `forward_rules` を読むだけなので、読み取り専用のユーザーを使う。
読む列は `protocol`、`src_addr`、`src_port`、`src_port_end`、`dist_addr`、`dist_port`、`source_ip`、`udp_idle_secs`、`options`
（`src_port_end` / `options` がない古いテーブルでも既定値で読み込む）。

```sql
CREATE USER 'rproxy'@'127.0.0.1' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'127.0.0.1';
```

（例ではデータベース名を `rproxy` としている。`DB_DATABASE` に合わせて読み替えること。）

## 複数の rproxy（ノードごとのビュー）

`RPROXY_UI_NODES` で複数のノードを使うときは、rproxy ごとにデータベースを分け、その中に `forward_rules` という名前のビューを作る。
ビューは UI のテーブルのうち、そのノードの行と、そのノードを含むグループの行だけを、rproxy が読む列だけで出す（rproxy の `SELECT ... CAST(src_port AS SIGNED) ... FROM forward_rules` はビューにもそのまま通る）。
rproxy の DB ユーザーにはビューの読み取りだけを渡す（ビューは作った人の権限で元のテーブルを読む `SQL SECURITY DEFINER`。作った人のアカウントを消さないこと）。

```bash
node db/node-view.mjs node1 --database rproxy --host 10.0.0.11 --password '<password>' | mariadb -u root -p
```

出る SQL（`--view-database` の既定は `rproxy_node_<ノード名>`、`--user` は `rproxy_<ノード名>`、`--host` は `127.0.0.1`。`--password` がなければ CREATE USER は出さない）:

```sql
CREATE DATABASE IF NOT EXISTS `rproxy_node_node1` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE OR REPLACE SQL SECURITY DEFINER VIEW `rproxy_node_node1`.`forward_rules` AS
  SELECT r.`protocol`, r.`src_addr`, r.`src_port`, r.`src_port_end`, r.`dist_addr`, r.`dist_port`, r.`source_ip`, r.`udp_idle_secs`, r.`options`
    FROM `rproxy`.`forward_rules` r
   WHERE r.`target` IN (SELECT t.`target` FROM `rproxy`.`forward_rule_targets` t WHERE t.`node` = 'node1');
CREATE USER IF NOT EXISTS 'rproxy_node1'@'10.0.0.11' IDENTIFIED BY '<password>';
GRANT SELECT ON `rproxy_node_node1`.`forward_rules` TO 'rproxy_node1'@'10.0.0.11';
```

その rproxy は `RPROXY_DATABASE_URL=mysql://rproxy_node1:<password>@<DB のホスト>/rproxy_node_node1` にする。
グループの構成を変えても `forward_rule_targets` を UI が直すので、ビューは作り直さなくてよい。ノードを足したときだけ、そのノードの分を流す。

## バックアップ

両テーブルを `mariadb-dump --single-transaction` で取る。取り方・戻す順番（DB ユーザーと migration を含む）・戻した後の確認は rproxy-api の [docs/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/BACKUP.md)。
