This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

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
+ Keycloak 設定情報（Confidential クライアント。ロールは realm ロールをアクセストークンの `realm_access.roles` から読む）
+ rproxy-api の制御 API の URL とトークン（`RPROXY_API_TOKEN` は rproxy を `--token-file` 付きで起動した場合のみ必要）

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

Keycloak のレルムは `keycloak/realm-rproxy-dev.json` から作れる（管理コンソールの「Create realm」→「Resource file」で読み込む）。
このファイルにはクライアントシークレットとユーザーが入っていないので、読み込んだあと、クライアント `rproxy-ui` の「Credentials」でシークレットを確認して `KEYCLOAK_CLIENT_SECRET` に設定する。URL は con0 の開発環境（`http://con0.dev.home:3001`）向け。

Keycloak クライアントの「Valid redirect URIs」には `${NEXTAUTH_URL}/api/auth/callback/keycloak` を登録してください。

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
