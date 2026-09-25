# CLAUDE.md — TCP-UDP-rproxy-ui

`rproxy-api`（Rust 製の TCP/UDP リバースプロキシ、別リポジトリ `../rproxy-api`）の転送ルールを管理する Web UI。
Next.js 14（Pages Router）、NextAuth + Keycloak、MariaDB、Tailwind CSS で構成されている。

## コマンド

```bash
npm run dev     # 開発サーバ
npm run build   # 環境変数がなくてもビルドは通る
npm run lint    # next lint（.eslintrc.json は next/core-web-vitals）
npm test        # vitest（tests/ 配下）
```

- `package-lock.json` と `pnpm-lock.yaml` の両方がある。依存関係を変えるときはどちらも更新すること（`pnpm install --lockfile-only`）。
- 必要な環境変数（`.env.local`）は README に記載がある：`NEXTAUTH_*`、`DB_HOST/PORT/DATABASE/USER/PASSWORD`、`KEYCLOAK_CLIENT_ID/CLIENT_SECRET/ISSUER`、`RPROXY_API_URL`、`RPROXY_API_TOKEN`。
- import のパスエイリアスは `@/`（リポジトリのルート）。vitest でも `vitest.config.mts` で同じエイリアスを設定している。
- テストは MariaDB・rproxy・NextAuth をすべてモックする（`tests/forward.test.ts`）。実際の DB や rproxy は不要。

## 構成

| パス | 役割 |
|---|---|
| `pages/index.tsx` | ルールの一覧・追加・変更・削除の画面（ダッシュボード）。エラーは画面上部のバナーに出す |
| `components/Modal.tsx` | ルールの入力フォームとクライアント側のバリデーション。`source_ip` の選択肢は `/api/forward/capabilities` から取得する |
| `components/lib.ts` | 共通の型（`ForwardRule`、`ForwardRules`、`sessionUser` など）と pino ロガー |
| `components/rproxy.ts` | rproxy-api の HTTP クライアント。失敗時は `RproxyError`（`code`、`status`。通信失敗は `unreachable` / 0） |
| `pages/api/auth/[...nextauth].ts` | Keycloak の設定。サインイン時にアクセストークンの `realm_access.roles` を読んで JWT に保存する |
| `pages/api/forward/[forward].ts` | `list`(GET)、`add` / `modify` / `delete`(POST) のエンドポイント |
| `pages/api/forward/capabilities.ts` | rproxy の `GET /capabilities` をそのまま返す |
| `db/` | テーブル定義（`schema.sql`）とマイグレーション。`db/README.md` を参照 |

## データの流れ

1. 画面から `/api/forward/<action>` を呼ぶ。
2. サーバ側で入力を検証・正規化する（`protocol` は小文字、ポートは 1〜65535、listen アドレスは IP のみで IPv6 は圧縮表記）。
3. トランザクション内で `forward_rules` を更新し、履歴を `forward_rules_log` に書き込む（`update_action` 列は `ADD` / `UPDATE` / `DELETE`）。
   ルールは Keycloak の `sub`（`auth_id`）ごとに持ち、キーは `protocol`、`src_addr`、`src_port` の組み合わせ（DB 全体で一意）。
4. rproxy-api の HTTP API を呼ぶ（`POST /rules`、`PATCH /rules/{protocol}/{addr}/{port}`、`DELETE ...`）。成功したときだけ COMMIT し、失敗したら ROLLBACK する。
   - rproxy の 4xx はそのままのステータスで返す（401/403 は UI サーバ側の設定ミスなので 502）。それ以外の失敗は 502。本文は `{error, code}`。
   - 削除で rproxy が `not_found` を返した場合は成功として扱う。
5. `list` は DB のルールに rproxy の `GET /rules` の稼働状態をつけて返す（`state` は `running` / `failed` / `missing`（rproxy にない）/ `unknown`（rproxy に問い合わせできない））。

HTTP の取り決めは `../rproxy-api/docs/API.md` が正。変更するときは両方のリポジトリを揃えること。
rproxy は起動時に `forward_rules` を読んでルールを復元する（読む列は `db/README.md` を参照）。

## 注意点

- COMMIT は rproxy の呼び出しが成功した後なので、COMMIT 自体が失敗すると rproxy だけにルールが残る。
- `modify` で rproxy が `not_found` を返すと（`missing` のルール）、そのまま 404 になる。復旧するには削除して追加し直す。
- `source_ip` は作成後に変更できない（API の制約）。編集画面では読み取り専用。
- クライアント側の IPv6 の検証は緩い（文字種だけ）。最終的な検証はサーバ側の `net.isIP` で行う。
- `package-lock.json` と `pnpm-lock.yaml` で解決されたバージョンが異なる依存がある（例：mariadb）。
- ファイル名 `Sideber.tsx` は原文のまま（綴りは Sidebar の誤り）。変更する場合は import もすべて直すこと。
