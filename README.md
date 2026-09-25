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

テーブル定義とマイグレーションは `db/` にあります（`db/README.md` を参照）。
rproxy-api との HTTP API の取り決めは `../rproxy-api/docs/API.md` です。

## テスト

```bash
npm test
```
