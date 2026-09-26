# 本番環境の構築

rproxy-api と UI（rproxy-ui）を 1 台のホスト（Debian 13 / Ubuntu 24.04）に入れ、ダッシュボードを rproxy 経由の HTTPS で公開する手順。
DB（MariaDB）と Keycloak は別のホストにある前提で書く。

```
ブラウザ ──HTTPS 443──▶ rproxy-api（TLS の終端、dashboard.example.com だけ通す、allow_from）
                            │ 127.0.0.1:3000
                            ▼
                         rproxy-ui ──▶ 制御 API 127.0.0.1:8080（トークン）
                            │  └────▶ MariaDB（UI 用ユーザー）
                            └───────▶ Keycloak（OIDC）
rproxy-api ──起動時にルールを復元──▶ MariaDB（読み取り専用ユーザー）
```

## 1. インストール

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update
sudo apt install rproxy-api rproxy-ui
```

- rproxy-ui は Node.js 20.18.1 以上が要る。Ubuntu 24.04 では先に [NodeSource](https://github.com/nodesource/distributions) の nodejs（22 など）を入れる。
- rproxy-api を先に入れると、rproxy-ui のインストール時に rproxy-api のトークンと制御 API の URL が `/etc/rproxy-ui/rproxy-ui.env` に入る。
- どちらもインストールしただけでは起動しない。
- 権限（capability、ファイルの所有者）は rproxy-api の [docs/PERMISSIONS.md](https://github.com/max3584/rproxy-api/blob/master/docs/PERMISSIONS.md)。

## 2. DB（MariaDB）

**テーブルは管理者ユーザーで作り、アプリのユーザーには DDL の権限を与えない。**
開発環境（`rproxy_dev`）では UI のユーザーにテーブル作成の権限も与えていたが、本番では与えない。

```shell
# 管理者で DB とテーブルを作る
mariadb -h db.example.com -u admin -p -e 'CREATE DATABASE rproxy CHARACTER SET utf8mb4'
mariadb -h db.example.com -u admin -p rproxy < /usr/share/rproxy-ui/db/schema.sql
```

```sql
-- UI 用（ルールの管理と変更履歴）。ホストは UI のホストに合わせる
CREATE USER 'rproxy_ui'@'10.0.0.10' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.10';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.10';

-- rproxy-api 用（起動時にルールを読むだけ）
CREATE USER 'rproxy'@'10.0.0.10' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'10.0.0.10';
```

### 旧環境からルールを移す場合

旧環境のテーブルをそのまま使う場合は、先にバックアップを取ってから `db/migrations/` を順に適用する（詳細は `db/README.md`）。

```shell
mysqldump -h db.example.com -u admin -p rproxy forward_rules forward_rules_log > rproxy-backup.sql
cd /usr/share/rproxy-ui/db/migrations
mariadb -h db.example.com -u admin -p rproxy < 002_source_ip_udp_idle.sql
mariadb -h db.example.com -u admin -p rproxy < 004_log_auth_id.sql
mariadb -h db.example.com -u admin -p rproxy < 005_ranges_and_tls.sql
```

- `003_auth_id_to_keycloak.sql` は、利用者を Auth0 から Keycloak に移すときだけ使うテンプレート。Auth0 の sub と Keycloak の sub（ユーザーの「ID」）の対応表を VALUES に書いてから、ファイルの手順どおりトランザクションの中で実行し、未変換の行がないことを確かめてから COMMIT する。
- 適用済みの migration をもう一度流すと失敗する（列がすでにある）。どこまで適用したかは `SHOW COLUMNS FROM forward_rules` で確かめる。

## 3. Keycloak

1. 管理コンソールの「Create realm」→「Resource file」で `keycloak/realm-rproxy-dev.json`（リポジトリ）を読み込み、レルム名を本番用（例 `rproxy`）に変える。
2. クライアント `rproxy-ui`（Confidential）の設定を本番の URL に直す。
   - Valid redirect URIs: `https://dashboard.example.com/api/auth/callback/keycloak`
   - Web origins / Root URL: `https://dashboard.example.com`
3. 「Credentials」のクライアントシークレットを `KEYCLOAK_CLIENT_SECRET` に設定する。
4. 利用者を作るか、既存の IdP と連携し、realm ロール `rproxy-user`（自分のルールだけ）か `rproxy-admin`（すべてのルール）を付ける。どちらもない利用者は画面を使えない（README の「ロール」。ロールの名前・クレームの位置・利用者が使えるポートは `RPROXY_UI_ADMIN_ROLE` / `RPROXY_UI_USER_ROLE` / `RPROXY_UI_ROLES_CLAIM` / `RPROXY_UI_USER_PORTS` で変えられる）。
   v0.3.1 以前から上げる場合、ロールのない利用者は使えなくなるので、先にロールを付けるか `RPROXY_UI_USER_ROLE=`（空）にする。

Keycloak の証明書が社内の CA のものなら、Node.js がその CA を信頼するように `rproxy-ui.env` に `NODE_EXTRA_CA_CERTS=/etc/rproxy-ui/ca.pem` を足す（`rproxy-ui` ユーザーが読めること。`/home`・`/root`・`/tmp` には置かない）。

## 4. rproxy-api

`/etc/rproxy/rproxy.env`:

```shell
RPROXY_API_ADDR=127.0.0.1           # UI と同じホストなら loopback のまま
RPROXY_API_PORT=8080
RPROXY_TOKEN_FILE=/etc/rproxy/tokens   # インストール時に 1 つ生成済み
RPROXY_DATABASE_URL=mysql://rproxy:<password>@db.example.com:3306/rproxy
RPROXY_STATIC_RULES=/etc/rproxy/static-rules.json
RPROXY_LOG_FILE=/var/log/rproxy/rproxy.log
```

UI と rproxy-api が同じホストなら、制御 API を Unix ソケットで受けることもできる（loopback の TCP は同じホストのだれでも接続できるが、ソケットはファイルのモードとグループで絞れる）。
rproxy 側で `RPROXY_API_SOCKET=/run/rproxy/api.sock` と `RPROXY_API_SOCKET_GROUP=<グループ>`（モードは既定 660。`RPROXY_API_PORT=0` で TCP を閉じられる）、
UI 側で `RPROXY_API_URL=unix:/run/rproxy/api.sock` にし、`rproxy-ui` のユーザーをそのグループに入れる（`sudo usermod -aG <グループ> rproxy-ui` のあと `systemctl restart rproxy-ui`）。トークンは TCP と同じく要る。

UI を別のホストに置く場合は、制御 API を loopback 以外で待ち受けることになり、トークンと TLS が必須になる（`RPROXY_TLS_CERT` / `RPROXY_TLS_KEY`。無いと起動しない）。UI 側は `RPROXY_API_URL=https://...` にし、自己署名や社内 CA なら `NODE_EXTRA_CA_CERTS` で信頼させる。

### ダッシュボードの公開（固定ルール）

`/etc/rproxy/static-rules.json`（`root:rproxy` 640）。443 で TLS を終端し、`dashboard.example.com` だけを UI に通す。社内の範囲だけに絞るなら `allow_from` を付ける。

```json
[
  {
    "protocol": "tcp", "listen_addr": "0.0.0.0", "listen_port": 443,
    "remote_addr": "127.0.0.1", "remote_port": 3000,
    "allow_from": ["10.0.0.0/8"],
    "tls": {
      "mode": "terminate",
      "certificates": [{
        "cert_file": "/etc/rproxy/tls/dashboard.pem",
        "chain_file": "/etc/rproxy/tls/intermediates.pem",
        "key_file": "/etc/rproxy/tls/dashboard.key"
      }],
      "routes": [{ "server_name": "dashboard.example.com", "remote_addr": "127.0.0.1", "remote_port": 3000 }],
      "unmatched": "reject"
    }
  }
]
```

証明書と鍵は `root:rproxy` 640 で `/etc/rproxy/tls/` に置く。rproxy は ACME を内蔵していないので、証明書は certbot・acme.sh などで取得する（Kubernetes なら cert-manager の Secret をマウントする）。
rproxy はファイルの大きさ・更新時刻・inode を 60 秒ごと（`RPROXY_CERT_CHECK_SECS`。`0` で止める）に確かめ、変わった証明書だけを自動で読み直す（シンボリックリンクの差し替えも検知する）。すぐに反映したいときは `sudo systemctl reload rproxy-api`。

certbot の http-01 で取る場合は、80 番の L7（`http`）のルールで `/.well-known/acme-challenge/` を certbot の standalone（例 `--http-01-port 8888`）か webroot を配るサーバへ振り分ける（ほかのパスは HTTPS へリダイレクトする）:

```yaml
- protocol: tcp
  listen_addr: 0.0.0.0
  listen_port: 80
  http:
    routes:
      - {name: acme, match: 'PathPrefix(`/.well-known/acme-challenge/`)', to: 'http://127.0.0.1:8888'}
      - {name: to-https, match: 'PathPrefix(`/`)', middlewares: [to-https]}
    middlewares:
      to-https: {redirect_scheme: {scheme: https, permanent: true}}
```

証明書のファイルは certbot の `/etc/letsencrypt/live/<名前>/fullchain.pem` と `privkey.pem` をそのまま指定できる（rproxy ユーザーが読めるように、`deploy-hook` で `/etc/rproxy/tls/` にコピーしてもよい）。

## 5. rproxy-ui

`/etc/rproxy-ui/rproxy-ui.env`（`root:root` 600）:

```shell
HOSTNAME=127.0.0.1                 # rproxy の固定ルールの転送先に合わせる
PORT=3000
NEXTAUTH_URL=https://dashboard.example.com
NEXTAUTH_SECRET=<インストール時に生成済み>
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<Keycloak の Credentials>
DB_HOST=db.example.com
DB_PORT=3306
DB_DATABASE=rproxy
DB_USER=rproxy_ui
DB_PASSWORD=<password>
RPROXY_API_URL=http://127.0.0.1:8080   # Unix ソケットなら unix:/run/rproxy/api.sock（4. を参照）
RPROXY_API_TOKEN=<インストール時に /etc/rproxy/tokens から入る>
```

rproxy のトークンファイルを権限付き（YAML）にする場合、UI のトークンには `rules:read` と `rules:write` のスコープを付ける（`metrics:read` は使わない。`GET /capabilities` はどのトークンでも読める）。
`allow_listen_ports` を付けると、その範囲の外のルールは UI から作成・変更・削除できない。足りないと rproxy が 403 `forbidden` を返し、画面にはスコープを確かめるように出る。

```yaml
# /etc/rproxy/tokens（rproxy の RPROXY_TOKEN_FILE。ファイルには SHA-256 だけを置く）
tokens:
  - name: rproxy-ui
    sha256: <printf %s "$TOKEN" | sha256sum の値>
    scopes: [rules:read, rules:write]
```

`TOKEN` は UI の `RPROXY_API_TOKEN` に入れる値（`openssl rand -hex 32` などで作る）。トークンファイルを変えたら `sudo systemctl reload rproxy-api`。

## 6. 起動と確認

```shell
sudo systemctl enable --now rproxy-api rproxy-ui
systemctl status rproxy-api rproxy-ui
journalctl -u rproxy-ui -f
tail -f /var/log/rproxy/rproxy.*.log      # rproxy-api（JSON Lines。"event":"degraded" があれば制限つきで動いている）
```

- `https://dashboard.example.com` を開き、Keycloak でサインインしてダッシュボードが出ること。「rproxy に接続できます」になっていること。
- 固定ルール（443）が「固定」の印つきで一覧に出ること。
- `allow_from` の範囲外からは接続できないこと（ダッシュボードの「拒否」の数が増える）。

## 7. 更新

```shell
sudo apt update && sudo apt upgrade   # rproxy-api と rproxy-ui は同じ番号で出る
```

- 設定ファイル（`rproxy.env`・`rproxy-ui.env`）とトークンは更新しても保たれる。
- テーブルの形が変わる版では、リリースノートに migration が書いてある。適用してから更新する。
- 動いていたサービスは更新のときに再起動される。

## 8. バックアップ

- DB: `forward_rules` と `forward_rules_log`（ルールの本体と履歴）
- `/etc/rproxy/`（設定・トークン・固定ルール・証明書）と `/etc/rproxy-ui/rproxy-ui.env`
- Keycloak のレルム（管理コンソールの「Realm settings」→「Action」→「Partial export」）
