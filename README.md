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
+ Database 設定情報
+ Auth0 設定情報
+ rproxyのAPI部の受信hostを設定してください
  + API Address
  + TCP IPC Controlle Address
  + UDP IPC Controlle Address

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

#Auth0
AUTH0_CLIENT_ID="[client_id]"
AUTH0_API_CLIENT_ID="[api_client_id]"
AUTH0_CLIENT_SECRET="[client_secret]"
AUTH0_DOMAIN="[domain]"

# rproxy
RPROXY_API_ADDR="127.0.0.1"
RPROXY_API_PORT=8080
RPROXY_TCP_ADDR="127.0.0.2"
RPROXY_UDP_ADDR="127.0.0.3"
```
