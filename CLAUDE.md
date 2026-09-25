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

- 開発機 con0 では 3000 番（別サービス）と 8080 番（code-server）が使用中。UI は `./node_modules/.bin/next dev -p 3001`、rproxy は 8081 で動かす（`.env.local` の `NEXTAUTH_URL` と `RPROXY_API_URL` もこのポートに合わせてある）。
- `next dev` が動いている間に同じディレクトリで `npm run build` を実行しない（`.next` を上書きして開発サーバが 404 を返すようになる）。
- DB の接続プールは、開発モードでは `globalThis` に置いて使い回す（読み直しのたびにプールが増えて Too many connections になるのを防ぐ）。

- `package-lock.json` と `pnpm-lock.yaml` の両方がある。依存関係を変えるときはどちらも更新すること（`pnpm install --lockfile-only`）。
- 必要な環境変数（`.env.local`）は README に記載がある：`NEXTAUTH_*`、`DB_HOST/PORT/DATABASE/USER/PASSWORD`、`KEYCLOAK_CLIENT_ID/CLIENT_SECRET/ISSUER`、`RPROXY_API_URL`、`RPROXY_API_TOKEN`。
- import のパスエイリアスは `@/`（リポジトリのルート）。vitest でも `vitest.config.mts` で同じエイリアスを設定している。
- テストは MariaDB・rproxy・NextAuth をすべてモックする（`tests/forward.test.ts`）。実際の DB や rproxy は不要。

## 構成

| パス | 役割 |
|---|---|
| `pages/index.tsx` | ダッシュボード（Traefik 風）。rproxy に接続できるか、件数、TCP / UDP のカード（状態のドーナツ、接続数、累計、rx / tx、TLS 失敗）、TLS の内訳、要確認のルール（failed / missing）、絞り込みつきの全ルールの表。5 秒ごとに自動更新（切り替えられる。タブが隠れている間は止める） |
| `pages/rules/new.tsx` | ルールの追加画面。保存したら詳細画面へ、キャンセルは前の画面へ |
| `pages/rules/[protocol]/[listenAddr]/[listenPort]/index.tsx` | ルールの詳細（概要・待ち受け・転送先と解決したアドレス・TLS（routes、証明書と中間 CA、クライアント認証、ALPN、upstream）・STARTTLS・詳細・統計）。編集ボタンと、確認ダイアログつきの削除ボタン。`listenAddr` は URL エンコードする（IPv6 の `:` を含むため） |
| `pages/rules/[protocol]/[listenAddr]/[listenPort]/edit.tsx` | ルールの変更画面。保存したら詳細画面へ |
| `components/RuleForm.tsx` | ルールの入力フォームとクライアント側のバリデーション（追加・変更の画面で使う。旧 `Modal.tsx`）。タブ（基本 / TLS・DTLS / メール (STARTTLS) / 詳細）に分かれ、矢印キー / Home / End で移れる（WAI-ARIA の Tabs）。エラーのあるタブには件数の印が付く。`source_ip`・TLS のモード・STARTTLS の選択肢と範囲の上限は `/api/forward/capabilities` から取得する。中間 CA（`chain_file`）の欄は証明書ごと・クライアント認証・upstream に常に出す（3 階層以上の PKI を使うため） |
| `components/dashboard.ts` | ダッシュボードと詳細画面の集計・整形（状態の集計、TLS の内訳、絞り込み、バイト数・時間の表示、ドーナツの `conic-gradient`、画面の URL）。React に依存しない |
| `components/ui.tsx` | 状態・TLS のバッジ、エラーのバナー、確認ダイアログ（`<dialog>`）、自動更新のフック、1 件取得のフック `useRule`、API への送信 |
| `components/profiles.ts` | 追加フォームの「プロファイル」（用途別のひな形）。`../rproxy-api/docs/PROFILES.md` に合わせる |
| `components/tls.ts` | TLS / STARTTLS / ポート範囲の正規化と検証、DB の `options` 列の読み書き。画面と API route の両方で使う |
| `components/lib.ts` | 共通の型（`ForwardRule`、`TlsSpec`、`ForwardRules`、`RuleStats`、`DashboardData`、`sessionUser` など）と pino ロガー |
| `components/rproxy.ts` | rproxy-api の HTTP クライアント。失敗時は `RproxyError`（`code`、`status`。通信失敗は `unreachable` / 0） |
| `pages/api/auth/[...nextauth].ts` | Keycloak の設定。サインイン時にアクセストークンの `realm_access.roles` を読んで JWT に保存する |
| `pages/api/forward/[forward].ts` | `list` / `dashboard` / `rule`(GET)、`add` / `modify` / `delete`(POST) のエンドポイント |
| `pages/api/forward/capabilities.ts` | rproxy の `GET /capabilities` をそのまま返す |
| `keycloak/` | Keycloak のレルム定義（読み込み用の JSON。シークレットとユーザーは含めない） |
| `db/` | テーブル定義（`schema.sql`）とマイグレーション。`db/README.md` を参照 |

## データの流れ

1. 画面から `/api/forward/<action>` を呼ぶ。
2. サーバ側で入力を検証・正規化する（`protocol` は小文字、ポートは 1〜65535、listen アドレスは IP のみで IPv6 は圧縮表記）。
   TLS の組み合わせは `components/tls.ts` の `checkTls` で rproxy と同じ規則を先に確かめ、日本語のメッセージを返す（コードも rproxy と同じ `tls_config` / `unsupported` / `invalid`）。
   証明書ファイルが読めるか、範囲の上限（`max_range_ports`）、範囲の重なりは rproxy が判定する。
3. トランザクション内で `forward_rules` を更新し、履歴を `forward_rules_log` に書き込む（`update_action` 列は `ADD` / `UPDATE` / `DELETE`、`auth_id` は操作した利用者）。
   ルールは Keycloak の `sub`（`auth_id`）ごとに持ち、キーは `protocol`、`src_addr`、`src_port` の組み合わせ（DB 全体で一意。範囲ルールでは先頭のポート）。
   ポート範囲の終わりは `src_port_end`、TLS / STARTTLS は `options` 列に `{"tls", "starttls", "starttls_required"}` の JSON で保存する（既定なら NULL）。
   rproxy は `options` を未知のキーを拒否して読むので、この 3 つ以外のキーを入れないこと。
4. rproxy-api の HTTP API を呼ぶ（`POST /rules`、`PATCH /rules/{protocol}/{addr}/{port}`、`DELETE ...`）。成功したときだけ COMMIT し、失敗したら ROLLBACK する。
   rproxy に反映した後で COMMIT だけが失敗した場合は、rproxy 側の変更を元に戻す（`withTransaction` に渡す undo）。
   - rproxy の 4xx はそのままのステータスで返す（401/403 は UI サーバ側の設定ミスなので 502）。それ以外の失敗は 502。本文は `{error, code}`。
   - 削除で rproxy が `not_found` を返した場合は成功として扱う。
   - 変更で rproxy が `not_found` を返した場合（`missing` のルール）は、変更後の内容で作り直す。
   - 変更の PATCH には毎回 `tls`（と STARTTLS を使うなら `starttls` / `starttls_required`）を付け、TLS の設定を丸ごと置き換える。COMMIT が失敗したときの undo も、元の転送先と元の TLS の設定で PATCH する。
5. `list` は DB のルールに rproxy の `GET /rules` の稼働状態をつけて返す（`state` は `running` / `failed` / `missing`（rproxy にない）/ `unknown`（rproxy に問い合わせできない））。
   稼働情報は `connections`、`stats`（rproxy の `{total_connections, rx_bytes, tx_bytes, tls_failures}` をそのまま）、`startedAt`（rproxy の `started_at`、Unix 秒）、`resolved`。`missing` / `unknown` のときは null / 空配列。
   - `dashboard` は `{reachable, rproxyError, rules}`（`rules` は `list` と同じ）。ルールが 0 件でも rproxy に接続できるかがわかる。
   - `rule?protocol=&addr=&port=` は自分のルール 1 件（ほかの利用者のルールや存在しないルールは 404、キーが不正なら 400）。稼働状態は rproxy の `GET /rules/{protocol}/{addr}/{port}` から取る。

HTTP の取り決めは `../rproxy-api/docs/API.md` が正。変更するときは両方のリポジトリを揃えること。
rproxy は起動時に `forward_rules` を読んでルールを復元する（読む列は `db/README.md` を参照）。

## 注意点

- COMMIT が失敗して、さらに rproxy 側の取り消しも失敗した場合は、DB と rproxy が食い違う（ログに出る）。rproxy を再起動すれば DB の内容に戻る。
- `source_ip` とポート範囲は作成後に変更できない（API の制約）。編集画面では読み取り専用。API に違う範囲が来たら 400（`unsupported`）。
- TLS の設定は編集できる。フォームは選んでいるモードで使う項目だけを送る（隠れている欄の値は送らない）。
- 中間 CA（`chain_file`）は `certificates[]`、`client_auth`、`upstream` にある。空欄は省く。rproxy と同じく、`client_auth.chain_file` は `mode` が optional / required のとき、`upstream.chain_file` は `upstream.cert_file` があるときだけ使える（`checkTls` が `tls_config` を返す）。チェーンの順番（発行した CA からルートへ）は rproxy が読み込むときに確かめる。
- 画面は明るい配色だけ。カード・表・ボタンは `styles/globals.css` の `.card` / `.data-table` / `.btn-*` / `.badge` を使い、背景色と文字色を必ず両方指定する（以前、白地に白文字になる不具合があった）。
- `res.status(200).json(await ...)` と書かない（`status` が先に呼ばれて、失敗しても 200 になる）。先に値を取ってから返す。
- `mariadb` ドライバは JSON 列をオブジェクトで返すことがある。`parseOptions` は文字列とオブジェクトの両方を受け付ける。
- クライアント側の IPv6 の検証は緩い（文字種だけ）。最終的な検証はサーバ側の `net.isIP` で行う。
- ファイル名 `Sideber.tsx` は原文のまま（綴りは Sidebar の誤り）。変更する場合は import もすべて直すこと。

## プロファイル（`components/profiles.ts`）

`../rproxy-api/docs/PROFILES.md` の推奨設定をフォームに入れるだけ（アドレスと証明書のパスは利用者が入力する）。PROFILES.md の注意に従うこと。

- WebRTC のメディア（`webrtc-media`、UDP 50000-60000）は必ず passthrough。DTLS を終端すると接続できない。メディアサーバに rproxy の公開 IP を告知させる注意を出す。
- RTSP は TCP interleaved を推奨。UDP の RTP 範囲（`rtp-range`）はクライアントからサーバへの方向だけ使える、と注意を出す。
- SMTP（25）は passthrough + `proxy_v2`。STARTTLS を終端する場合は `starttls_required: false`（説明文で案内する）。
- ほか：https-sni（443 sni）、submission（587 terminate + smtp）、smtps（465）、imap（143 + imap）、imaps（993）、pop3（110 + pop3）、pop3s（995）、rtsp（554）、rtsps（322）、turn-udp / turn-tcp（3478）、turns-tls（5349/tcp terminate）、turns-dtls（5349/udp terminate = DTLS）、ftp（21）、ftp-passive（TCP の範囲）。
