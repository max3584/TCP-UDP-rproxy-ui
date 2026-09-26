# TCP-UDP-rproxy-ui

[rproxy-api](https://github.com/max3584/rproxy-api) の転送ルールを管理する Web UI（Next.js、Keycloak でサインイン、ルールは MariaDB に保存）。
バージョンは rproxy-api と同じ番号で出す（UI の vX.Y.Z は rproxy-api の vX.Y.Z と組み合わせる。docs/RELEASING.md）。

## インストール（Debian / Ubuntu）

rproxy-api と同じ apt リポジトリから入れられる（`rproxy-ui`、CPU を問わない 1 つのパッケージ）。
Node.js 20.18.1 以上が要る（Next.js 16 は 20.9、Unix ソケットに使う undici 7 は 20.18.1 から）。Debian 13 は標準の `nodejs` でよい。Ubuntu 24.04 の標準の nodejs は 18 なので、先に [NodeSource](https://github.com/nodesource/distributions) の nodejs（22 など）を入れる。

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-ui
```

- 設定は `/etc/rproxy-ui/rproxy-ui.env`（600）。`NEXTAUTH_URL`、`KEYCLOAK_*`、`DB_*` を書いてから `sudo systemctl enable --now rproxy-ui` で起動する（インストールしただけでは起動しない）
- `NEXTAUTH_SECRET` はインストール時に生成する。同じホストに rproxy-api があれば、そのトークンと API の URL も入れる
- 既定の待ち受けは `127.0.0.1:3000`（`HOSTNAME` / `PORT`）。外から見せるときは rproxy の固定ルール（TLS の終端とサーバ名での振り分け、`allow_from`）を前に置く（rproxy-api の README「固定ルールと、ダッシュボードの公開」）
- DB のテーブルは `/usr/share/rproxy-ui/db/schema.sql`（`db/README.md`）で作る
- `/usr/lib/rproxy-ui` の `server.js`（Next.js の standalone 出力）を `rproxy-ui` ユーザーで動かす。ログは `journalctl -u rproxy-ui`

## 開発

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

各種必要な情報

+ NEXTAUTH 設定情報
+ Database 設定情報（`DB_PORT` を省略した場合は 3306）
+ Keycloak 設定情報（Confidential クライアント。ロールは realm ロールをアクセストークンの `realm_access.roles` から読む。下の「ロール」）
+ rproxy-api の制御 API の URL とトークン（`RPROXY_API_TOKEN` は rproxy を `--token-file` 付きで起動した場合のみ必要）
  + rproxy のトークンを権限付き（YAML）にする場合、UI のトークンには `rules:read`（一覧・詳細）と `rules:write`（追加・変更・削除）のスコープが要ります。`metrics:read` は使いません（`GET /capabilities` はどのトークンでも読めます）。
    `allow_listen_ports` を付けると、その範囲の外の待ち受けポートのルールは UI から作成・変更・削除できません。
    スコープが足りないと、画面に「UI が使う rproxy のトークンに、この操作の権限がありません」と出ます（UI のログにも残ります）。

enviroment:
```.env.local
NEXTAUTH_URL="http://[hostname]:[port]"
NEXTAUTH_SECRET="secret"

# database data
DB_HOST="[hostname]"
DB_PORT=3307
DB_DATABASE="[database]"
DB_USER="[username]"
DB_PASSWORD="[password]"

# Keycloak
KEYCLOAK_CLIENT_ID="[client_id]"
KEYCLOAK_CLIENT_SECRET="[client_secret]"
KEYCLOAK_ISSUER="https://[keycloak-host]/realms/[realm]"

# rproxy
RPROXY_API_URL="http://127.0.0.1:8080"
RPROXY_API_TOKEN="[token]"
```

`RPROXY_API_URL` は `http://` / `https://` の URL か、`unix:/run/rproxy/api.sock`（rproxy-api の `RPROXY_API_SOCKET` の Unix ソケット。HTTP の Host は `localhost`）。
Unix ソケットは rproxy-api の既定でモード 660 なので、UI を動かすユーザーを `RPROXY_API_SOCKET_GROUP` のグループに入れておく（トークンは TCP と同じく要る）。

Keycloak のレルムは `keycloak/realm-rproxy-dev.json` から作れる（管理コンソールの「Create realm」→「Resource file」で読み込む）。
このファイルにはクライアントシークレットとユーザーが入っていないので、読み込んだあと、クライアント `rproxy-ui` の「Credentials」でシークレットを確認して `KEYCLOAK_CLIENT_SECRET` に設定する。URL は con0 の開発環境（`http://con0.dev.home:3001`）向け。

Keycloak クライアントの「Valid redirect URIs」には `${NEXTAUTH_URL}/api/auth/callback/keycloak` を登録してください。

## ロール（権限）

Keycloak のロールで、だれが何をできるかを決める（API route がリクエストごとに確かめる）。

| ロール | できること |
|---|---|
| `rproxy-admin` | すべての利用者のルールを一覧・詳細・変更・削除できる（一覧と詳細に所有者（Keycloak の ID）を出す）。どの待ち受けポートでも使える |
| `rproxy-user` | 自分のルールだけを作成・一覧・変更・削除できる。既定ではロールを問わず、サインインできる人はだれでもこの扱い（v0.3.1 までと同じ） |
| どちらもない | `RPROXY_UI_USER_ROLE=rproxy-user` のようにロールを必須にしたときだけ、画面も API も使えない（403。「権限がありません」と出る） |

- ロールはアクセストークンの `realm_access.roles`（realm ロール）から読む。クライアントロールを使うなら `RPROXY_UI_ROLES_CLAIM=resource_access.rproxy-ui.roles` のようにクレームの位置（ドット区切り）を変える。
- ロールの名前は `RPROXY_UI_ADMIN_ROLE`（既定 `rproxy-admin`）と `RPROXY_UI_USER_ROLE`（既定は空）で決める。`RPROXY_UI_USER_ROLE` が空（既定）なら、サインインできる人はだれでも `rproxy-user` と同じ扱い（ロールを使わない運用）。`RPROXY_UI_USER_ROLE=rproxy-user` にすると、そのロールのない利用者は使えなくなる。
- `RPROXY_UI_USER_PORTS=1024-65535` のように書くと、`rproxy-user` が使える待ち受けポートを制限できる（範囲の外は 403 `port_not_allowed`。`rproxy-admin` は制限されない）。既定は制限なし。
- ロールはサインインしたときに読むので、Keycloak でロールを変えたら利用者にサインインし直してもらう。
- 履歴（`forward_rules_log`）の `auth_id` は操作した利用者（管理者がほかの人のルールを変えたら管理者）。

## L7（HTTP）のルール

rproxy-api v0.3.1 以降（`GET /capabilities` の `features.http` が true）では、TCP のルールの「基本」タブで「L7（HTTP）で振り分ける」を選ぶと、
「L7 (HTTP)」タブでルート（Traefik と同じ `match` の式。よく使う条件は選んで組み立てられる）・サービス（転送先と重み）・ミドルウェア（リダイレクト、レート制限、CrowdSec など。rproxy が使える種類だけ）・一致しないときの応答を編集できる。
プロファイルの「HTTPS リバースプロキシ（L7）」「HTTP→HTTPS リダイレクト（80 番、L7）」がひな形になる。L4 と L7 の切り替えは作成時だけ（rproxy が PATCH で切り替えられないため）。
「詳細」タブの「CrowdSec の判定で接続元を遮断する（L4）」は、rproxy の設定ファイルに `global.crowdsec` があるときに使える（rproxy-api v0.3.2 以降）。

本番環境の構築（apt、DB のユーザーと権限、Keycloak、HTTPS での公開、更新とバックアップ）は [docs/PRODUCTION.md](docs/PRODUCTION.md)。

テーブル定義とマイグレーションは `db/` にあります（`db/README.md` を参照）。既存の環境では `db/migrations/005_ranges_and_tls.sql`（ポート範囲と TLS の列）を適用してください。
rproxy-api との HTTP API の取り決めは `../rproxy-api/docs/API.md` です。

## 使い方

| 画面 | 内容 |
|---|---|
| ダッシュボード（`/`） | rproxy に接続できるか、ルールの件数（固定ルールを含む）、TCP / UDP ごとのカード（稼働中・失敗・未登録・不明のドーナツ、接続数、累計の接続、rx / tx、TLS 失敗、拒否）、TLS の内訳、要確認のルール、全ルールの表（プロトコル・状態・検索で絞り込み。行を選ぶと詳細へ。固定ルールには「固定」、送信元を絞ったルールには「IP 制限」の印）。5 秒ごとに自動更新します（切り替えられます） |
| 新規ルール（`/rules/new`） | 追加フォーム |
| ルールの詳細（`/rules/{tcp\|udp}/{待ち受けアドレス}/{ポート}`） | 設定と稼働状態・統計。「編集」「削除」（固定ルールにはありません） |
| 編集（詳細の URL + `/edit`） | 変更フォーム |

rx はクライアントから転送先へ、tx は転送先からクライアントへのバイト数です（rproxy がルールを開始してからの累計。rproxy を再起動すると 0 に戻ります）。
「拒否」は、接続を許可する送信元（allow_from）の範囲外か、どのサーバ名にも一致しない接続を切断する設定（unmatched: reject）のために切断した接続の数です。

固定ルールは rproxy の起動時のファイル（`RPROXY_STATIC_RULES` / `--static-rules`。`../rproxy-api/docs/API.md` の「固定ルール」）にあるルールで、DB には入りません。
ログインしていればだれにでもダッシュボードと詳細画面に表示されますが、画面からは変更・削除できません（ファイルを書き換えて rproxy を再起動します）。

フォームはタブに分かれています。

| タブ | 内容 |
|---|---|
| 基本 | プロファイル（用途別のひな形）、プロトコル、待ち受けアドレス、ポート（範囲の終わりは任意）、転送先 |
| TLS / DTLS | passthrough / sni / 終端（UDP では DTLS）、サーバ名ごとの転送先と、どのサーバ名にも一致しない接続の扱い（基本の転送先へ送る / 切断する）、証明書、クライアント証明書の検証（mTLS）、ALPN、転送先への再暗号化 |
| メール (STARTTLS) | SMTP / IMAP / POP3 の STARTTLS（TCP で「終端」のときだけ） |
| 詳細 | 送信元 IP の扱い（source_ip）、UDP のアイドルタイムアウト、接続を許可する送信元（allow_from） |

- プロファイルは `../rproxy-api/docs/PROFILES.md` の推奨設定をフォームに入れるだけです。アドレスと証明書のパスは環境に合わせて入力してください。
- 証明書・秘密鍵・CA のパスは rproxy-api のサーバ上のパスです。読めないと `tls_config` のエラーになります。
- 証明書は certbot や cert-manager などで取得したファイルを指定します（rproxy は ACME を内蔵していません。設定ファイルに ACME の証明書が書かれていると、画面に「この rproxy では使えない設定」と出ます）。
  rproxy はファイルが変わったかを 60 秒ごと（rproxy の `RPROXY_CERT_CHECK_SECS`）に確かめ、更新された証明書を自動で読み直すので、更新のたびにルールを編集する必要はありません。
- 中間 CA（任意）は、サーバ証明書を発行した CA からルートへ向かう順に 1 つの PEM ファイルに並べます（ルートは不要）。順番が違うと rproxy が `tls_config` で拒否します。
  クライアント証明書の検証では、CA ファイルにルート CA（信頼の起点）を、中間 CA にクライアント証明書を発行した中間 CA を指定します。転送先へのクライアント証明書にも中間 CA を指定できます。
- ポート範囲（例 `8000-8001`）は各ポートを転送先ポートから順に転送します。上限は rproxy の `max_range_ports`（既定 20000）。範囲と送信元 IP の扱いは作成後に変更できません（TLS の設定は変更できます）。
- WebRTC のメディアは DTLS を終端すると接続できません。passthrough の範囲ルールにしてください。
- 接続を許可する送信元（allow_from）は 1 行に 1 件、CIDR（`172.16.0.0/16`、`fd00::/8`）か単一の IP を書きます（最大 64 件）。空欄ならすべて許可します。
  範囲外からの TCP 接続は TLS や PROXY ヘッダより前に切断し、UDP では範囲外の送信元のデータグラムを捨てます。保存すると `10.0.0.5` → `10.0.0.5/32` のように正規化します。
- 「どのサーバ名にも一致しない接続」は、TCP の sni / 終端でサーバ名ごとの転送先があるときだけ選べます。「切断する」にすると、一致しない名前や SNI のない接続を切断します（終端ではハンドシェイクを完了せずに切断）。

## テスト

```bash
npm test
```

テストの一覧と、本物の MariaDB と rproxy-api を使う E2E（`RUN_E2E=1`）の動かし方は `docs/TESTING.md` にあります。
