# 設定と運用の手引き

English: [en/GUIDE.md](en/GUIDE.md)

はじめて rproxy-ui を入れる人のための道順。
入れる・最初の設定・サインイン・毎日の使い方・運用・困ったときの順に並べる。
細かい項目は [README](../README.md) の各節に任せ、ここからリンクする。

## 目次

1. [rproxy-ui とは](#1-rproxy-ui-とは)
2. [入れる](#2-入れる)
3. [最初の設定](#3-最初の設定)
4. [サインイン](#4-サインイン)
5. [毎日の使い方](#5-毎日の使い方)
6. [複数のノードとグループ](#6-複数のノードとグループ)
7. [運用](#7-運用)
8. [困ったとき](#8-困ったとき)

## 1. rproxy-ui とは

rproxy-ui は [rproxy-api](https://github.com/max3584/rproxy-api)（Rust の TCP/UDP リバースプロキシ）の転送ルールを管理する Web UI。

```
ブラウザ ──▶ rproxy-ui ──制御 API（トークン）──▶ rproxy-api ──▶ 転送先
                 │
                 └──▶ MariaDB（ルール・履歴・利用量）◀── rproxy-api（起動時に読むだけ）
```

- ルールの正は MariaDB の `forward_rules`。画面で保存すると、UI が DB に書き、rproxy-api の制御 API に送る。rproxy が断れば DB も戻す。
- rproxy-api は起動のときに `forward_rules` を読み、ルールを戻す。UI が止まっていても転送は止まらない。
- 変更はすべて `forward_rules_log` に残る（履歴と巻き戻しに使う）。
- rproxy の設定ファイルのルール（固定ルール）は DB に入らない。画面には読み取り専用で出る。
- 版は rproxy-api と別々に進む。UI に要る rproxy-api の最小の版は UI のリリースノートに書く（[7. 運用](#7-運用)）。

## 2. 入れる

どれでも中身は同じ（Next.js の standalone）。

| 置き場所 | 入れ方 | 詳しく |
|---|---|---|
| Debian / Ubuntu の VM | apt（`rproxy-ui`） | 下の 2.1、[PRODUCTION.md](PRODUCTION.md) |
| Raspberry Pi | apt（arm64） | 下の 2.2 |
| Kubernetes | Helm chart | 下の 2.3、[KUBERNETES.md](KUBERNETES.md) |
| コンテナ（Docker など） | `ghcr.io/max3584/rproxy-ui` | 下の 2.4 |

### 2.1 Debian / Ubuntu（VM）

Node.js 22.23.4 以上が要る（24 なら 24.22.1 以上、26 なら 26.12.1 以上）。
Debian 13 の標準の nodejs は 20、Ubuntu 24.04 は 18 で足りない。
[NodeSource](https://github.com/nodesource/distributions) の nodejs をメジャー版を決めて入れ、apt の pin でディストリの nodejs を選ばせない。

```shell
NODE_MAJOR=24
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSLo /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' \
  | sudo tee /etc/apt/preferences.d/nodejs
sudo apt update && sudo apt install nodejs
node --version      # v24.x.x
```

そのあと rproxy-api の apt リポジトリから入れる（rproxy-api も同じホストに入れるなら一緒に）。

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-api   # 同じホストに置くなら先に入れる
sudo apt install rproxy-ui
```

- 入れただけでは起動しない。[3. 最初の設定](#3-最初の設定)を済ませてから `sudo systemctl enable --now rproxy-ui`。
- rproxy-api を先に入れておくと、UI のインストールのときに env ファイルへ制御 API の URL とトークンファイル（`RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens`）が入る。rproxy-ui は rproxy-api を Suggests にしているだけなので、入れる順は apt が決めない。入らなかったときは `RPROXY_API_URL` と `RPROXY_API_TOKEN_FILE`（か `RPROXY_API_TOKEN`）を手で書く。
- `rproxy-ui` ユーザーは rproxy-api と共有するグループ `rproxy` に入る。rproxy-api のトークンファイル・Unix ソケットをコピーせずに読める。
- 既定の待ち受けは `127.0.0.1:3000`。外に見せるときは rproxy の固定ルールで TLS を終端して前に置く（[PRODUCTION.md の「ダッシュボードの公開（固定ルール）」](PRODUCTION.md#ダッシュボードの公開固定ルール)）。
- NodeSource の nodejs のメジャー版の上げ方と pin の意味は [README の「インストール」](../README.md#インストールdebian--ubuntu)。

### 2.2 Raspberry Pi

- パッケージ `rproxy-ui` は CPU を問わない 1 つの .deb（`all`）。arm64 でも 2.1 と同じ手順で入る。
- arm64 は NodeSource の nodejs で動く。Raspberry Pi では 64 ビットの OS（Raspberry Pi OS の 64 ビット版など）を勧める。
- Kubernetes・コンテナでも、イメージは amd64 と arm64 の両方がある。

### 2.3 Kubernetes（Helm）

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <版> -n rproxy-ui -f values.yaml
```

- chart は秘密を作らない。先に Secret を作り、`existingSecret` で名前を渡す。
- DB は外の MariaDB が既定。試すときは `mariadb.enabled: true` で同梱の MariaDB（1 台、冗長化しない）。
- migration は Helm のフック（`post-install`・`pre-upgrade`）の Job が `db/migrate.mjs` で当てる。手で当てなくてよい。
- 秘密の作り方・values の例・Keycloak なしの入れ方・Gateway の rproxy を見る方法は [KUBERNETES.md](KUBERNETES.md)。

### 2.4 コンテナ（Docker など）

イメージは `ghcr.io/max3584/rproxy-ui:<版>`（uid 65532、ポート 3000、`HOSTNAME=0.0.0.0`）。ルートを読むだけにしてよい。書くのは `/tmp` と `/app/.next/cache` だけ。

```shell
docker run -d --name rproxy-ui --env-file rproxy-ui.env -p 3000:3000 \
  --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=65532,gid=65532 \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/max3584/rproxy-ui:<版>
```

- env ファイルの中身は [3.2](#32-env-ファイル) と同じ。`docker --env-file` は値の引用符をそのまま読むので、引用符を付けずに書く。`HOSTNAME` は書かない（イメージの `0.0.0.0` のまま）。
- migration はイメージの中の `node db/migrate.mjs`（[3.1](#31-dbmariadbと-migration)）。トークンは `node rproxy-ui-token.mjs new --name admin --role admin --stdout`。
- トークンのファイルをマウントするなら、uid 65532 の持ち物で 600 にするか、root の持ち物・グループ 65532・0440 にして `--group-add 65532` を付ける。
- 生きているかは `GET /api/healthz`（サインインなしで `{"ok":true}`。DB・rproxy には聞かない）。

## 3. 最初の設定

順番は DB → env ファイル → rproxy-api への接続 → サインインの方法（[4.](#4-サインイン)）→ 起動。

### 3.1 DB（MariaDB）と migration

同じホストに置くなら `sudo apt install mariadb-server` でよい（`DB_HOST=127.0.0.1` なら DB への TLS は要らない）。

テーブルは DB の管理者で作り、UI のユーザーには DDL の権限を渡さない。いちばん楽なのは `migrate.mjs` に任せる方法。新しい DB では `schema.sql` を流し、UI のユーザーを作って要る権限だけを渡す。

`migrate.mjs` は `DB_HOST`・`DB_PORT` に TCP でつなぎ、`DB_ADMIN_USER`・`DB_ADMIN_PASSWORD` のパスワードで入る（Unix ソケットでは入らない）。
管理者には DDL を流す権限と、`DB_APP_USER` を使うならユーザーを作って権限を渡す権限（`CREATE USER` と `GRANT OPTION`）が要る。
MariaDB の root がパスワードで TCP から入れるかは環境による（root をソケットの認証だけにしている環境では入れない）。入れないときは、パスワードで入れる管理者を作る。例：

```shell
sudo mariadb -e "CREATE USER 'rproxy_admin'@'127.0.0.1' IDENTIFIED BY '<管理者のパスワード>';
  GRANT ALL PRIVILEGES ON *.* TO 'rproxy_admin'@'127.0.0.1' WITH GRANT OPTION;"
```

権限の範囲は環境に合わせて狭めてよい（この例は試しやすさを優先している）。

```shell
sudo sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=rproxy_admin DB_ADMIN_PASSWORD=<管理者のパスワード> \
  DB_APP_USER=rproxy_ui DB_APP_PASSWORD=<UI のパスワード> DB_APP_HOST=127.0.0.1 \
  node /usr/share/rproxy-ui/db/migrate.mjs --create-database'
```

同じ形で `--status` を付けると、当てたものと残りが出る（`--dry-run` は何をするかを出すだけ）。

- 接続先は env ファイルの `DB_HOST`・`DB_PORT`・`DB_DATABASE` を読むので、先に env ファイルの `DB_*` を書いておく（[3.2](#32-env-ファイル)）。
- `DB_APP_PASSWORD` は env ファイルの `DB_PASSWORD` と同じにする。`DB_APP_HOST` は UI のホスト（同じホストなら `127.0.0.1`）。
- 手で作るなら `mariadb ... < /usr/share/rproxy-ui/db/schema.sql` と、[db/README.md の「DB ユーザー」](../db/README.md#db-ユーザー)の GRANT。利用量の表（`usage_*`）の権限も忘れない。
- rproxy-api には、起動時に読むだけのユーザー（`GRANT SELECT ON rproxy.forward_rules`）を別に作る。rproxy-api v0.4 の API のルール・global の値・固定ルールに重ねる分を保存するなら、その表の権限も渡す（同じ節）。
- 前から手で migration を当ててきた DB（`schema_migrations` がない）は、`--baseline <最後に当てた番号>` を 1 回だけ付ける（[db/README.md の「migrate.mjs」](../db/README.md#migratemjs)）。
- 別のホストの DB なら TLS にする（`DB_SSL=true`、社内の CA なら `DB_SSL_CA`。[README の「DB への接続（TLS）」](../README.md#db-への接続tls)）。

### 3.2 env ファイル

.deb では `/etc/rproxy-ui/rproxy-ui.env`（`root:root` 600）。変えたら `sudo systemctl restart rproxy-ui`。

| 変数 | 内容 |
|---|---|
| `HOSTNAME`・`PORT` | 待ち受け（既定 `127.0.0.1`・`3000`） |
| `NEXTAUTH_URL` | 利用者がブラウザで開く URL（例 `https://dashboard.example.com`）。CSRF の確認・HSTS・Keycloak の戻り先に使う |
| `NEXTAUTH_SECRET` | セッションの暗号の鍵。.deb はインストール時に作る。UI を複数台で動かすなら全台で同じにする |
| `DB_HOST`・`DB_PORT`・`DB_DATABASE`・`DB_USER`・`DB_PASSWORD` | MariaDB（`DB_PORT` の既定は 3306） |
| `RPROXY_API_URL` | rproxy-api の制御 API。`http://`・`https://` か `unix:/run/rproxy/api.sock` |
| `RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` | UI が rproxy-api に送るトークン（下の 3.3）。両方あれば `RPROXY_API_TOKEN` が勝つ |
| `RPROXY_UI_AUTH` | サインインの方法 `keycloak`（既定）・`token`・`both`（[4.](#4-サインイン)） |
| `KEYCLOAK_ISSUER`・`KEYCLOAK_CLIENT_ID`・`KEYCLOAK_CLIENT_SECRET` | Keycloak を使うとき |
| `RPROXY_UI_TOKENS_FILE` | トークンでサインインするときのファイル |
| `RPROXY_UI_USER_ROLE` | 利用者のロール。空（既定）なら管理者しか使えない |
| `RPROXY_UI_NODES` | 複数の rproxy を使うときの `nodes.yaml`（[6.](#6-複数のノードとグループ)）。書くと `RPROXY_API_URL`・`RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` は使わない |

ほかの変数（セッションの長さ・利用量・利用者の制限・mTLS・act / stb）はファイルの中のコメントと [README の「開発」の環境変数の一覧](../README.md#開発)。

### 3.3 rproxy-api への接続とトークンのスコープ

UI は 1 つのトークンで rproxy-api と話す。利用者ごとの持ち主は UI が自分で確かめる。

- 同じホストの rproxy-api で、トークンファイルが 1 行に 1 トークンの書き方（インストールの既定）なら、そのトークンはもともと `admin`。何もしなくてよい。
- トークンファイルを権限つき（YAML）にしたら、**UI のトークンは `scopes: [admin]` にする**。

```yaml
# /etc/rproxy/tokens（rproxy-api の RPROXY_TOKEN_FILE。SHA-256 だけを置く）
tokens:
  - name: rproxy-ui
    sha256: <printf %s "$TOKEN" | sha256sum の値>
    scopes: [admin]
```

`admin` が要るわけ：

| 使うもの | 要るスコープ |
|---|---|
| ルールの一覧・詳細 | `rules:read` |
| ルールの追加・変更・削除・一時停止 | `rules:write` |
| ACME の証明書を使うルール | `acme:write` |
| 利用者が選ぶ登録済みの証明書 | `certs:read` |
| global の設定（`/global`） | `admin` |
| rproxy の API で作ったルールの編集・削除（管理者の画面）と、複数のノードの送り直し | `admin`（rproxy-api v0.4.23 から） |

rproxy-api v0.4.23（rproxy-api #401）から、`admin` でないトークンは自分が作ったルール・重ねる分・組しか直せない（ほかは `403 not_owner`）。
API のルールの画面と送り直しは、ほかのトークンが作ったルールを UI のトークンで変えるので、`admin` でないと止まる。
それらを使わず、UI が戻したルールだけを直せばよい構成なら、`rules:read`・`rules:write` に `allow_restored: true` でもよい（rproxy-api の docs/API.md）。`allow_restored` は rproxy-api v0.4.23 以上でだけ足す（v0.4.22 以前の rproxy-api は知らない項目があるとトークンファイル全体を読まず、すべてのトークンが通らなくなる）。版を戻す前に外す。

UI のトークンに `persist: true` を付けるかは、次の引き換えで決める（ふつうは付けない）。

- 付けないと：UI から作った固定ルールに重ねる分は、rproxy ではメモリにだけあり、rproxy を再起動すると消える（再起動しない更新では引き継ぐ）。UI は重ねる分の正しい形を自分の DB（`forward_rule_overlays`、migration `015`）に持っているので、消えた・違う重ねる分をずれとして出す（ダッシュボードの「要確認のルール」と、ルールの詳細の「重ねる分」）。管理者は「重ねる分のずれ N 件をまとめて送り直す」か詳細の「UI の DB の内容を送り直す」で戻す。重ねる分はノードごとで、act / stb のグループでも act の分を stb に写さない（自動の送り直しが戻すのは、そのノードの行だけ。昇格の判定には入れない）。1 行に 1 トークンの書き方のトークンも `persist` はない。ふつうはこれでよい。
- 付けると：UI が作るルールまで rproxy の API のルール（`origin: api`）になり、rproxy の `rproxy_rules` にも入る（UI の DB と二重）。UI はそれを「API のルールが同じキーを使っている」と見て、変更・再開・送り直しを 409 `shadowed` で断る。UI のルールの管理が止まるので勧めない。

- トークンファイルを変えたら `sudo systemctl reload rproxy-api`。
- UI 側は `RPROXY_API_TOKEN` に平文で書くか、UI だけが読むファイル（`root:rproxy-ui` 0640）に 1 行で書いて `RPROXY_API_TOKEN_FILE` で指す。YAML のトークンファイルは SHA-256 しかないので、UI からは指せない。
- Unix ソケットにするなら、rproxy 側で `RPROXY_API_SOCKET=/run/rproxy/api.sock` と `RPROXY_API_SOCKET_GROUP=rproxy`、UI 側で `RPROXY_API_URL=unix:/run/rproxy/api.sock`（トークンは TCP と同じく要る）。global の設定のうち守りに関わる項目（`trusted_proxies`・`access_log`・`crowdsec`・`geoip`・`acme`）は、既定では Unix ソケットからしか変えられない（rproxy-api の `RPROXY_API_RELOAD_UNIX_ONLY=false` で TCP からも変えられるが、勧めない）。
- UI を別のホストに置くなら制御 API は `https://` にする。クライアント証明書（mTLS）は `RPROXY_API_TLS_CERT`・`RPROXY_API_TLS_KEY`・`RPROXY_API_TLS_CA`。

起動して確かめる。

```shell
sudo systemctl enable --now rproxy-ui
journalctl -u rproxy-ui -f
```

ダッシュボードの「rproxy」の欄に「接続できます」と出て、サイドバーの下に UI と rproxy-api の版が出ればよい。

## 4. サインイン

### 4.1 Keycloak なし（トークン）

UI・MariaDB・rproxy だけの最小構成。管理者が `rproxy-ui-token` でトークンを作る。トークンは 1 回だけ出る。ファイルには SHA-256 だけが入る。

```shell
sudo rproxy-ui-token new --name admin --role admin --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token new --name alice --role user  --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token list   --file /etc/rproxy-ui/tokens.yaml
sudo rproxy-ui-token remove --name alice --file /etc/rproxy-ui/tokens.yaml
```

```shell
# /etc/rproxy-ui/rproxy-ui.env
RPROXY_UI_AUTH=token
RPROXY_UI_TOKENS_FILE=/etc/rproxy-ui/tokens.yaml
RPROXY_UI_USER_ROLE=rproxy-user        # role: user のトークンを使うなら
```

- サインインのページ（`/signin`）の「アクセストークン」に貼る。
- ファイルは `rproxy-ui` の持ち物で 600。ほかの持ち主・権限なら UI は起動しない。
- ファイルは変われば読み直す（再起動は要らない）。行を消すと、そのトークンのセッションは次の確認で切れる。
- `role: user` のトークンは `RPROXY_UI_USER_ROLE` が空だと使えない（403 `no_role`）。
- 行に `sub` を書くと、その値がルールの持ち主になる（既定は `token:<name>`）。Keycloak の `sub` にすれば同じ人のルールになる。
- 詳しくは [README の「トークンでのサインイン（Keycloak なし）」](../README.md#トークンでのサインインkeycloak-なし)。

### 4.2 Keycloak

```shell
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<クライアントの Credentials>
```

- クライアントは Confidential。「Valid redirect URIs」に `${NEXTAUTH_URL}/api/auth/callback/keycloak` を入れる。
- ロールは realm ロールをアクセストークンの `realm_access.roles` から読む（クライアントロールなら `RPROXY_UI_ROLES_CLAIM`）。
- レルムは `keycloak/realm-rproxy-dev.json` から作れるが開発用。本番ではパスワードの決まり・OTP・https の URI・セッションの時間を直す（[PRODUCTION.md の「3. Keycloak」](PRODUCTION.md#3-keycloak)）。
- セッションはサインインから `RPROXY_UI_SESSION_MAX_AGE`（既定 8 時間）で切れる。ロールは `RPROXY_UI_ROLE_REFRESH_SECS`（既定 300 秒）ごとに Keycloak に聞き直す（[README の「セッション」](../README.md#セッション)）。

### 4.3 両方（`both`）

`RPROXY_UI_AUTH=both` で、`/signin` にトークンの欄と「Keycloak でサインイン」のボタンが並ぶ。`KEYCLOAK_*` と `RPROXY_UI_TOKENS_FILE` の両方を書く。
`RPROXY_UI_AUTH` を書かず、`KEYCLOAK_ISSUER` がなくて `RPROXY_UI_TOKENS_FILE` があれば `token` になる。

### 4.4 ロール

| ロール | できること |
|---|---|
| 管理者（`rproxy-admin`、トークンでは `role: admin`） | すべての利用者のルール。どのポート・ノードでも。API のルール・global の設定・act / stb の画面も |
| 利用者（`RPROXY_UI_USER_ROLE` のロール、トークンでは `role: user`） | 自分のルールだけ。下の制限がかかる |
| どちらもない | 使えない（403 `no_role`） |

ロールの名前は `RPROXY_UI_ADMIN_ROLE`（既定 `rproxy-admin`）と `RPROXY_UI_USER_ROLE`（既定は空）。v0.4.9 からは、空なら管理者でない人は使えない。

### 4.5 利用者にできること

利用者は自分のルールだけを作り・見て・変え・消せる。ほかの人のルールは見えない（固定ルールはだれにでも見える。ファイルのパスは `<hidden>`）。
管理者は、利用者に許す範囲を env ファイルで決める。

| 変数 | 決めること | 外のとき |
|---|---|---|
| `RPROXY_UI_USER_PORTS` | 使える待ち受けポート（例 `1024-65535`） | 403 `port_not_allowed` |
| `RPROXY_UI_USER_NODES` | 触れるノード（例 `node1,node2`） | 403 `node_not_allowed` |
| `RPROXY_UI_USER_TARGETS` | 使える転送先（CIDR・IP・ホスト名、`*.example.com`）。本番では書くことを勧める | 403 `target_not_allowed` |
| `RPROXY_UI_USER_CERTS`（`_BY_ROLE`・`_BY_SUB`） | 選べる登録済みの証明書の名前の先頭 | 403 `cert_not_allowed` |
| `RPROXY_UI_PROTECTED_TARGETS` | 許可リストに書いても断る宛先 | 403 `target_not_allowed` |

- 既定はどれも制限なし。ただし転送先のループバック・リンクローカル・制御 API・UI・DB はいつも断る。
- 利用者はサーバのファイルのパス（`*_file`）を書けない（403 `file_not_allowed`）。TLS の証明書は rproxy の証明書の API に管理者が登録したものから選ぶ。
- OIDC のミドルウェアは足せない。応答のキャッシュは上限の内だけ。
- 前からある値は、変えなければそのまま保存できる。
- 全部の決まりは [README の「利用者の制限（ファイルのパス・転送先）」](../README.md#利用者の制限ファイルのパス転送先)。

## 5. 毎日の使い方

画面の一覧は [README の「使い方」](../README.md#使い方)。

### 5.1 ルールを足す・変える

ダッシュボードの「新規ルール」（`/rules/new`）か、ルールの詳細の「編集」。フォームはタブに分かれる。

| タブ | おもな欄 |
|---|---|
| 基本 | プロファイル（用途別のひな形）、プロトコル（tcp / udp）、待ち受けアドレス・待ち受けポート（範囲の終わりは任意）、転送先アドレス・転送先ポート、「宛先を追加」（複数の宛先と振り分け方）、「L7（HTTP）で振り分ける」 |
| L7 (HTTP) | ルート（`match` の式）・サービス・ミドルウェア・どのルートにも一致しないとき |
| TLS / DTLS | モード（passthrough / sni / 終端）、サーバ名ごとの転送先、どのサーバ名にも一致しない接続、サーバ証明書・中間 CA・秘密鍵（「＋ ACME の証明書を追加」「＋ 登録済みの証明書を追加」も）、クライアント証明書の検証（mTLS）、ALPN、転送先への再暗号化 |
| メール (STARTTLS) | SMTP / IMAP / POP3（TCP の終端のときだけ） |
| 制限・GeoIP | ラベル、L4 の制限、帯域の上限、GeoIP、受け身のヘルスチェック |
| 詳細 | 送信元 IP の扱い（source_ip）、UDP のアイドルタイムアウト、TCP の中継の時間切れ、宛先への接続の時間、接続を許可する送信元（allow_from）、PROXY protocol の受け取り |

ルールの種類ごとの道筋：

- **L4（TCP / UDP をそのまま中継）**：「基本」だけでよい。送信元を絞るなら「詳細」の allow_from（1 行に 1 件の CIDR か IP）。
- **TLS**：「TLS / DTLS」でモードを選ぶ。終端するなら証明書と鍵（rproxy-api のホストのパス。持ち主は `rproxy-api`）か ACME。名前で振り分けるなら「サーバ名ごとの転送先」。
- **HTTP（L7）**：TCP のルールで「L7（HTTP）で振り分ける」を選び、「L7 (HTTP)」タブでルート・サービスを作る。プロファイル「HTTPS リバースプロキシ（L7）」がひな形になる。L4 と L7 は作るときにしか選べない。

覚えておくこと：

- 欄は rproxy-api の `GET /capabilities` の `features` が使えると言うものだけ出る。古い rproxy では、値があれば読み取り専用で残して送る（保存しても消えない）。
- 送信元 IP の扱いとポート範囲は作った後で変えられない。
- rproxy が `features.dry_run` を返すなら、保存の前に「差分を見る」で rproxy で何が変わるかを確かめられる。
- 一覧や詳細の「一時停止」で、消さずに止められる（「再開」で戻す。[README の「ルールの一時停止」](../README.md#ルールの一時停止)）。
- 項目ごとの説明：[L7](../README.md#l7httpのルール)・[Gateway API 向けの項目](../README.md#gateway-api-向けの-l7tls-の項目)・[応答のキャッシュ](../README.md#応答のキャッシュcache)・[宛先を複数にする](../README.md#宛先を複数にする)・[SNI の passthrough](../README.md#一部のサーバ名だけ終端せずに流すsni-の-passthrough)・[PROXY protocol](../README.md#前段の-proxy-protocol-を受け取る名前ごとに送信元-ip-の渡し方を変える)・[TCP の中継の時間切れ](../README.md#tcp-の中継の時間切れidle_timeouthalf_close_timeout)・[宛先への接続の時間](../README.md#宛先への接続の時間connect_timeout)・[UDP のサーバ名](../README.md#udp-をサーバ名で振り分けるdtlsquic)・[ACME](../README.md#acme-で証明書を取る)・[v0.4 の項目](../README.md#v04-のルールの項目制限帯域geoipラベル)。

### 5.2 固定ルールに重ねる分

rproxy の設定ファイルのルール（固定ルール）は画面から変えられない。
rproxy-api v0.4.23 以上（`features.static_overlay`）なら、固定ルールの詳細の「重ねる分」で、ファイルはそのままに足せる。

- 足せるもの：http のルート・サービス・ミドルウェア（ルールに `http` があるとき）か、サーバ名ごとの転送先（`tls.routes`）。
- 重ねる分のルートは、ファイルのルートのどれにも当たらないリクエストだけを受ける。
- ファイルにある名前は使えない（409 `overlay_conflict`）。
- 保存は丸ごとの置き換え。ほかの人が先に変えていれば 412。「読み直す」で今の内容にしてからやり直す。
- 重ねる分はノードごと（グループにまとめない）。
- 管理者でない人は、自分が作った重ねる分だけを直せる。設定ファイルのサービスと、秘密のファイルを持つものは使えない。
- UI は重ねる分の正しい形を自分の DB（`forward_rule_overlays`、migration `015`）に持つ。ふつうの UI のトークン（`persist` なし）では rproxy を再起動すると重ねる分が消えるが、UI がずれ（「UI の DB にある重ねる分が rproxy にありません」）として出し、送り直せる（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。送り直せるのは、その重ねる分を直せる人（管理者と、作った本人）。まとめての送り直しは管理者だけ。管理者でない人が作ったものは、送り直す前に作った人として確かめ直す（許可リストを狭めた後なら送らない）。外すと UI の DB の行も消える。
- 重ねる分はノードごと。各ノードは自分の行だけを持ち、act / stb の自動の送り直し・「このノードを揃える」はそのノードの行だけを戻す（act から stb へ写さない）。ずれは act / stb の画面に出すが、昇格の判定（`ha/ready`）には入れない。
- ノードや固定ルールがなくなって UI の DB にだけ残った行は、管理者のダッシュボードの「UI の DB からだけ外す」で消す。
- 詳しくは [README の「使い方」の「固定ルールに重ねる分」](../README.md#使い方)。

### 5.3 global の設定（acme・geoip・タイムアウト）

「rproxy の機能と設定」（`/system`）から「global の設定」（`/global`）を開く。管理者だけ。rproxy-api v0.4.19 以上（`features.global_api`）と、UI のトークンの `admin` が要る。

1. 項目ごとに今の値・出どころ（設定ファイル / 環境変数 / API / 既定）・変え方が出る。設定ファイルと環境変数に書いた項目は変えられない。
2. 値を入れて「差分を確かめる」（dry run）。
3. 「適用する」。グループを選ぶと全ノードに送り、1 台でも断れば戻す。「API の値を消す」で既定に戻す。

- `http.timeouts`（タイムアウト）・`udp_max_sessions` などのすぐ効く項目を変えられる。
- `geoip`・`acme` は rproxy-api v0.4.22 以上（`features.global_api_geoip`・`global_api_acme`）で、Unix ソケットのノードだけ。ファイルは rproxy-api の `RPROXY_API_GEOIP_DIR`・`RPROXY_API_ACME_DIR` のすぐ下だけ。
- 秘密の値は `***` で返る。`acme` を変えるときは、その欄を入れ直す。
- rproxy は値を DB の `rproxy_global`（migration 013）に保存する。
- 詳しくは [README の「v0.4 のルールの項目」](../README.md#v04-のルールの項目制限帯域geoipラベル)の「global の設定」。

### 5.4 履歴と巻き戻し

「変更の履歴」（`/history`）に、いつ・だれが・何を変えたかが出る。ルールの詳細にもそのルールの履歴が出る。

- 「この版に戻す」で、その時点の内容に戻す。消したルールも作り直せる。巻き戻しも履歴に残る。
- 利用者は、自分が操作した履歴と、今自分が持っているルールの履歴を見られる。
- ノードの上書き（`OVERRIDE`）と重ねる分（`OVERLAY`）は巻き戻せない。
- 詳しくは [README の「変更の履歴と巻き戻し」](../README.md#変更の履歴と巻き戻し)。

### 5.5 エクスポートとインポート

- ダッシュボードの「エクスポート（JSON）」で、自分のルール（管理者はすべて）を書き出す。控えと移行に使う。
- 「インポート」（`/rules/import`）で、UI のエクスポートか rproxy の設定ファイル（YAML / JSON）を読む。
  1. 「確かめる」：1 件ずつ検証する。まだ何も変えない。
  2. 同じキーのルールは、行ごとに「置き換える」を選ぶ。
  3. 「インポートする」：1 件ずつ足す・置き換える。
- 詳しくは [README の「エクスポートとインポート」](../README.md#エクスポートとインポート)。

### 5.6 ずれと送り直し

複数のノードでは、各ノードで動いているルールを UI の定義（DB）と比べ、違う項目を「ずれ」と出す。

- ルールの詳細のノードのタブで「UI の定義との違い」を見て、「このノードに送り直す」で UI の定義をそのノードだけに送る。
- PATCH で直せない違いは作り直す。ノードにないルールは作る。停止中なのに動いていれば消す。
- 使えるのはルールの持ち主と管理者。履歴に `RESEND` とノードが残る。
- rproxy-api v0.4.23 以上では UI のトークンに `admin` が要る（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。

## 6. 複数のノードとグループ

1 つの UI で複数の rproxy（ノード）を管理する。同じルールを持つノードのまとまりがグループ。

```yaml
# /etc/rproxy-ui/nodes.yaml（RPROXY_UI_NODES=/etc/rproxy-ui/nodes.yaml）
nodes:
  - name: node1
    url: http://10.0.0.11:8080
    token_file: /etc/rproxy-ui/tokens/node1
  - name: node2
    url: http://10.0.0.12:8080
    token_file: /etc/rproxy-ui/tokens/node2
groups:
  - name: ha
    nodes: [node1, node2]
    mode: active_standby      # single（既定）か active_standby
    vip: 192.0.2.10
default_target: ha
```

1. DB に migration `006`〜`009` を当てる（`migrate.mjs` なら済んでいる）。
2. 各ノードの rproxy が読むビューを `db/node-view.mjs` で作る（[README の「rproxy の起動時の復元（ノードごとのビュー）」](../README.md#rproxy-の起動時の復元ノードごとのビュー)）。
3. 各 rproxy の `RPROXY_NODE_NAME` をノードの名前にそろえる。
4. `RPROXY_UI_NODES` を書いて UI を再起動する（誤りがあれば起動しない）。

画面の変わるところ：

- ノードが 2 つ以上だと、追加の画面に「ノード／グループ」、ダッシュボードとルールの詳細に「全体 / ノードごと」のタブが出る。
- グループのルールは全ノードに送る。1 台でも失敗すれば、ほかのノードも戻す。
- ルールの詳細のノードのタブの「このノードだけの設定（上書き）」で、待ち受けアドレス・転送先・allow_from をノードごとに変えられる。
- 「コピー・移動」でほかのノード／グループに移せる。ノードのタブの「すべて一時停止」でノードのルールをまとめて止める。
- 詳しくは [README の「複数の rproxy（ノードとグループ）」](../README.md#複数の-rproxyノードとグループ)。

## 7. 運用

### 7.1 上げる

```shell
sudo apt update && sudo apt upgrade
```

- 設定とトークンは保たれる。動いていたサービスは再起動される。
- テーブルの形が変わる版では、リリースノートに migration が書いてある。先に当てる（`migrate.mjs` ならまだのものだけを当てる）。Kubernetes では `helm upgrade` の Job が当てる。
- UI に要る rproxy-api の最小の版は **v0.3.5**。新しい項目は rproxy-api の `features` で判断し、なければ出さない。版はサイドバーの下とダッシュボードに出る。古い・分からないときはダッシュボードに注意が出る。
- 気をつける組み合わせ：
  - rproxy-api を v0.4.23 以上に上げるときは、UI のトークンを `admin` にしておく（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。
  - UI v0.4.9 から、`RPROXY_UI_USER_ROLE` が空なら管理者しか使えない。利用者に使わせていたなら上げる前に設定する。
  - Node.js は 22.23.4 以上（24 なら 24.22.1 以上）。古いと起動時に警告が出る。
- 詳しくは [PRODUCTION.md の「7. 更新」](PRODUCTION.md#7-更新)。

### 7.2 バックアップ

- DB：`forward_rules`（ルールの正）と `forward_rules_log`（履歴）。ほかの表も含めて `mariadb-dump --single-transaction` で丸ごと取るのが楽。
- ファイル：`/etc/rproxy-ui/rproxy-ui.env`（`NEXTAUTH_SECRET`・秘密）、`tokens.yaml`、`nodes.yaml`、ノードのトークン、`ha.tokens`。rproxy 側の `/etc/rproxy`。
- 「エクスポート（JSON）」もルールの控えになる。
- 取り方・戻す順番・戻した後の確かめ方は rproxy-api の [docs/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/BACKUP.md)。Kubernetes は [KUBERNETES.md の「バックアップと戻し方」](KUBERNETES.md#バックアップと戻し方)。

### 7.3 keepalived と組む（act / stb）

`active_standby` のグループで VIP を keepalived で動かすとき、stb が DB の定義とずれたまま昇格しないようにする。

- UI は `RPROXY_UI_HA_SYNC_SECS`（既定 30 秒）ごとにずれた stb へ自動で送り直す（グループに `auto_resend: false` で止める）。
- keepalived の track_script と notify_master は、`RPROXY_UI_HA_TOKEN_FILE` のトークンで `/api/forward/ha/ready`・`/api/forward/ha/notify` を呼ぶ。
- スクリプトと設定の例は [contrib/keepalived](../contrib/keepalived/README.md)（.deb では `/usr/share/doc/rproxy-ui/examples/keepalived/`）。
- 「act / stb」（`/ha`。管理者だけ）で、揃っているかを見て「このノードを揃える」。failback の手順もここにある。
- UI そのものは何台でも動かせる（集計と送り直しは DB のロックで 1 台だけが行う。`NEXTAUTH_SECRET` は全台で同じに）。

### 7.4 ログ

- .deb：`journalctl -u rproxy-ui`（`-f` で追う）。起動時の誤り（`nodes.yaml`・トークンのファイルの権限・DB の TLS・mTLS の組）は理由を出して止まる。各ノードの rproxy-api の版も起動時に出る。
- rproxy が UI のトークンを断ったとき（401・403・429）は、UI のログに理由と確かめるものが出る。
- Kubernetes：`kubectl -n rproxy-ui logs deploy/rproxy-ui`。migration の失敗は `kubectl -n rproxy-ui logs job/rproxy-ui-migrate`（リリース名が `rproxy-ui` のとき。名前の決まりは [KUBERNETES.md の「バックアップと戻し方」](KUBERNETES.md#バックアップと戻し方)の終わり）。
- rproxy-api のログ（作成・変更・削除の `event: "audit"` など）は rproxy-api の側（`/var/log/rproxy/`）。

### 7.5 セキュリティの注意

- **ほかのサイトからの要求（CSRF）**：状態を変える API は、ほかのサイトからの要求を 403 `csrf` で断る。前にリバースプロキシを置くなら `Host` か `X-Forwarded-Host` を渡し、`Origin`・`Referer`・`Sec-Fetch-*` を落とさない。`NEXTAUTH_URL` は利用者が開く URL にする。
- **トークンの締め出し**：同じ送信元から誤ったトークンが 15 分に 5 回を超えると、その送信元の誤ったトークンは 15 分 429 になる（`RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS`・`RPROXY_UI_TOKEN_LOCKOUT_SECS`）。正しいトークンは通す。守りはトークンの強さなので、トークンは必ず `rproxy-ui-token` で作る。
- **HTTP のプロキシの後ろ**：nginx・Ingress などの後ろでは、そのアドレスだけを `RPROXY_UI_TRUSTED_PROXIES` に書く（広く書くと送信元を偽れる）。前が rproxy（L4）なら要らない。
- **公開**：UI は既定で `127.0.0.1` だけで待つ。rproxy の固定ルールで TLS を終端し、`allow_from` で使う人の範囲に絞る。
- **ファイルの持ち主**：rproxy-api は自分（`rproxy-api`）が持つ証明書・鍵・秘密のファイルだけを読む（`rproxy-api:rproxy` 0640。[PRODUCTION.md の「ファイルの持ち主」](PRODUCTION.md#ファイルの持ち主os-のユーザーとグループ)）。
- ヘッダ・セッション・利用者の制限の全体は [README の「セキュリティ」](../README.md#セキュリティ)。

## 8. 困ったとき

画面の誤りの文の後ろの `code` で探す。rproxy が UI のトークンを断ったものは、UI が 502 にして返す。

| 出るもの | わけ | すること |
|---|---|---|
| 403 `no_role`（「権限がありません」） | 管理者のロールがなく、`RPROXY_UI_USER_ROLE` が空か、そのロールがない | ロールを付けるか、`RPROXY_UI_USER_ROLE` を書く。トークンなら `role` を見る |
| 502 `forbidden`（「UI が使う rproxy のトークンに、この操作の権限がありません」） | UI のトークンのスコープが足りないか、トークンの `allow_listen_ports`・`allow_certs` の外 | UI のトークンを `admin` にする（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。`allow_listen_ports`・`allow_certs` は `admin` でも効くので、広げるか外す。画面の文は「rules:read と rules:write」と言うが、文が古い。`admin` が正しい |
| 502 `not_owner` | rproxy-api v0.4.23 以上で、UI のトークンが `admin` でない。API のルールの編集・削除、送り直し、rproxy の再起動で戻したルールの変更で出る | UI のトークンを `admin` にする（それらを使わないなら `allow_restored: true`。rproxy-api v0.4.23 以上でだけ足す（v0.4.22 以前の rproxy-api は知らない項目があるとトークンファイル全体を読まず、すべてのトークンが通らなくなる）。版を戻す前に外す）。`reload rproxy-api` |
| 502 `global_forbidden` | global の設定に要る `admin` が UI のトークンにない | UI のトークンを `admin` にする |
| 403 `global_unix_only` | 守りに関わる項目を TCP のノードから変えようとした | そのノードの url を `unix:/…` のソケットにする |
| 502 `rproxy_unauthorized` | UI のトークンが違う・期限切れ | `RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` と rproxy のトークンファイルを見る |
| 502 `rproxy_locked_out` | UI の認証の失敗が続き、rproxy が UI を一時的に止めた | トークン・クライアント証明書を直す。止める時間が過ぎれば解ける |
| `unreachable`（「rproxy に接続できませんでした」） | rproxy-api が止まっている・URL の誤り・ソケットのグループ | `systemctl status rproxy-api`、`RPROXY_API_URL`、`rproxy-ui` がソケットのグループに入っているか |
| 400 `unsupported` | rproxy が使えない組み合わせ。L4 と L7 の切り替え・送信元 IP の扱いやポート範囲の変更・古い rproxy への `connect_timeout`・古い rproxy の UDP の sni など | 新しいルールとして作り直すか、rproxy-api を上げる。文の続きに理由が出る |
| 409 `file_in_use` | 重ねる分で、秘密のファイルを持つ設定ファイルのサービス・ミドルウェアを利用者が使った。または rproxy が、ほかの持ち主の鍵・秘密のファイルを断った | 管理者に頼むか、自分のサービス・別のファイルにする |
| 403 `file_service_not_allowed` | 利用者が重ねる分から設定ファイルのサービスを使った | 重ねる分に自分のサービスを作る |
| 412 `precondition_failed` | 重ねる分を、開いた後にほかの人が作った・変えた | 「読み直す」で今の内容にしてからやり直す |
| 403 `overlay_not_owner` | 利用者が、ほかの人の作った重ねる分を直そうとした | 管理者に頼む |
| 409 `overlay_conflict` | 重ねる分に設定ファイルと同じ名前を使った | 別の名前にする |
| 409 `static` | 固定ルールと同じキー。固定ルールは画面から変えられない | rproxy の設定ファイルを直すか、重ねる分を使う |
| 409 `shadowed` | 同じキーを rproxy では API のルール・組のルールが使っている | どちらかを消すか、キーを変える |
| 409 `target_conflict`・400 `target_required`・400 `unknown_target` | 複数のノードで、ノードが重なる先に同じキー・置き場所の指定がない・知らない名前 | ノード／グループを選び直す。`nodes.yaml` を見る |
| 409 `readonly_node` | Kubernetes の Gateway の rproxy（読むだけ）に書こうとした | Gateway API の資源の側で変える |
| 403 `csrf` | ほかのサイトからの要求と見なした | 画面を開き直す。前のプロキシが `Host`・`Origin` を渡しているか、`NEXTAUTH_URL` を見る |
| 403 `port_not_allowed`・`file_not_allowed`・`target_not_allowed`・`cert_not_allowed`・`node_not_allowed`・`middleware_not_allowed`・`cache_limit` | 利用者の制限の外 | [4.5](#45-利用者にできること)。必要なら管理者が許す範囲を広げる |
| サインインで 429 | 誤ったトークンの締め出し | 待つか、正しいトークンで入る（正しいトークンは通る） |
| `tls_config`、ファイルの持ち主の断り | 証明書・鍵のパスや中身、持ち主・モードの誤り | `rproxy-api:rproxy` 0640 にする。画面に直し方が出る |
| 「usage_* の表がありません（…010_usage.sql…）」・「attr 列がありません（…011…）」 | 利用量の migration がない | `010`・`011` を当てる（`migrate.mjs`） |
| 500 `nodes_db`（「forward_rule_targets を更新できません」） | 複数のノードの migration（`006`・`007`）がないか、権限がない | 当てて、UI のユーザーに権限を渡す |
| 重ねる分の保存で「DB（rproxy_rule_overlays）に保存できませんでした」 | `persist: true` のトークンの重ねる分で、migration `014` がないか、rproxy のユーザーの権限がない | `014` を当て、rproxy のユーザーに権限を渡す。今は効いているが再起動で消える |
| rproxy を再起動したら重ねる分が消えた | UI のトークンに `persist` がない（ふつう）。重ねる分は rproxy のメモリにだけあった。migration `014` の問題ではない | ダッシュボードの「要確認のルール」の「重ねる分のずれ N 件をまとめて送り直す」か、詳細の「UI の DB の内容を送り直す」で戻す（[3.3](#33-rproxy-api-への接続とトークンのスコープ)） |
| 重ねる分の保存で 500 `overlay_db`（「forward_rule_overlays がありません」）か、権限の誤り | migration `015` がないか、UI のユーザーに権限がない | `015` を当てて、UI のユーザーに権限を渡す（rproxy には何も送っていない） |
| 重ねる分が act / stb の画面で「作った人として確かめ直して断った」 | 作った利用者の決まり（許可リスト・ノード・ポートなど）が保存の後で変わった、か作った人が分からない | 管理者が詳細画面で直して保存するか、外す |
| UI が起動しない | `nodes.yaml` の誤り、トークンのファイルの持ち主・権限、DB の TLS の設定、`http://` の URL と `RPROXY_API_TLS_*` の組など | `journalctl -u rproxy-ui` の理由を見て直す |
| ダッシュボードに版の注意 | rproxy-api が v0.3.5 より古いか、版を返さない（v0.3.18 より前） | rproxy-api を上げる |

ほかのコードの文は画面に出る。分からないときは UI のログ（[7.4](#74-ログ)）と rproxy-api のログを合わせて見る。
