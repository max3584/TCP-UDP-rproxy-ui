# CLAUDE.md — TCP-UDP-rproxy-ui

`rproxy-api`（Rust 製の TCP/UDP リバースプロキシ、別リポジトリ `../rproxy-api`）の転送ルールを管理する Web UI。
Next.js 16（Pages Router）、React 19、NextAuth v4 + Keycloak、MariaDB、Tailwind CSS 3 で構成されている。

## バージョン管理

`docs/RELEASING.md` の決まりで、確認を取らずに進める。rproxy-api と同じ番号で一緒に出す（UI の vX.Y.Z は rproxy-api の vX.Y.Z と組み合わせる）。
PR・issue を作るときにパッチ／マイナーのマイルストーンを付け、マージ後のタグ・リリースノート・マイルストーンの片付けまで行う。
PR のブランチに追加で push する前に、その PR がまだ開いているか（`gh pr view <n> --json state`）を確かめる。

## パッケージ（apt）

`scripts/build-deb.sh` が `next build`（`output: 'standalone'`、`images.unoptimized`）の結果から `rproxy-ui_<version>-1_all.deb` を作る（`packaging/debian/` にユニット・設定・maintainer scripts）。
CPU ごとのネイティブなモジュール（`.node`）が入ると `all` にできないので、build-deb.sh が見つけたら止める。依存を足すときに気をつける。
CI の `Debian package` ジョブ（`scripts/test-deb.sh`、NodeSource の nodejs で実際に入れる）で確かめる。GitHub Release を公開すると `release.yml` が .deb を添付し、rproxy-api の apt リポジトリがそれを取る（docs/RELEASING.md）。

## ドキュメント（日本語と英語）

利用者向けのドキュメントは日本語と英語の両方がある：`README.md` ↔ `README.en.md`、`docs/<NAME>.md` ↔ `docs/en/<NAME>.md`、`db/README.md` ↔ `db/README.en.md`。
片方を変えたら、同じ PR でもう片方も同じ内容に直す（構成・コードブロック・環境変数名・設定のキーをそろえる）。ドキュメントを足すときも両方を作り、先頭の `English:` / `日本語:` の相互リンクを付ける。英語版の相対リンクは英語版を指す。
.deb には `README.md` と `README.en.md` を入れる（`scripts/build-deb.sh`。`db/` はまるごと入る）。

## コマンド

```bash
npm run dev     # 開発サーバ
npm run build   # 環境変数がなくてもビルドは通る
npm run lint    # eslint .（eslint.config.mjs。Next 16 で next lint がなくなったので ESLint の flat config で next/core-web-vitals を使う）
npm test        # vitest（tests/ 配下）
npm run test:ui # Playwright（tests/ui）。先に npm run build。MariaDB と rproxy-api（DB_* / RPROXY_API_*）が要る
```

- 開発機 con0 では 3000 番（別サービス）と 8080 番（code-server）が使用中。UI は `./node_modules/.bin/next dev -p 3001`、rproxy は 8081 で動かす（`.env.local` の `NEXTAUTH_URL` と `RPROXY_API_URL` もこのポートに合わせてある）。
- Next.js 16 は学習データより新しいので、API や設定を変えるときは `node_modules/next/dist/docs/` の説明書を先に読む（`next.config.mjs` の `agentRules: false` で、`next dev` がこの注意を CLAUDE.md に書き足すのを止めている）。
- `next dev` が動いている間に同じディレクトリで `npm run build` を実行しない（`.next` を上書きして開発サーバが 404 を返すようになる）。
- react-hooks v7 の規則（`set-state-in-effect` など）が有効。選べなくなった値を既定に戻す処理は、エフェクトではなく描画中に条件つきで `setState` する（React の「props が変わったときに state を直す」の書き方）。初回の取得（`await` の後でだけ state を変える）はコメントを付けて規則を外している。
- DB の接続プールは、開発モードでは `globalThis` に置いて使い回す（読み直しのたびにプールが増えて Too many connections になるのを防ぐ）。

- パッケージマネージャは npm だけ（`package-lock.json`）。CI・.deb の作成・Renovate もこれを使う。ほかのロックファイル（`pnpm-lock.yaml` など）は足さない（Renovate が「複数の npm のロックファイル」の警告を出す）。
- 必要な環境変数（`.env.local`）は README に記載がある：`NEXTAUTH_*`、`DB_HOST/PORT/DATABASE/USER/PASSWORD`、`KEYCLOAK_CLIENT_ID/CLIENT_SECRET/ISSUER`、`RPROXY_API_URL`、`RPROXY_API_TOKEN`。
- import のパスエイリアスは `@/`（リポジトリのルート）。vitest でも `vitest.config.mts` で同じエイリアスを設定している。
- テストは MariaDB・rproxy・NextAuth をすべてモックする（`tests/forward.test.ts`）。実際の DB や rproxy は不要。
- 画面操作の E2E（`tests/ui`、Playwright）は CI の e2e ジョブで本物の MariaDB と rproxy-api を相手に動く。サインインは Keycloak を通さず、テスト用の `NEXTAUTH_SECRET` で作ったセッションのクッキー（`tests/ui/global-setup.ts`）。ライト・ダークで白地に白文字がないことも確かめる。画面の文言やボタン名を変えたら `tests/ui` も直す。

## 構成

| パス | 役割 |
|---|---|
| `pages/index.tsx` | ダッシュボード（Traefik 風）。rproxy に接続できるか、件数（固定ルールを含む）、TCP / UDP のカード（状態のドーナツ、接続数、累計、rx / tx、TLS 失敗、拒否）、TLS の内訳、要確認のルール（failed / missing）、絞り込みつきの全ルールの表（固定ルールには「固定」、allow_from のあるルールには「IP 制限」のバッジ）。5 秒ごとに自動更新（切り替えられる。タブが隠れている間は止める） |
| `pages/rules/new.tsx` | ルールの追加画面。保存したら詳細画面へ、キャンセルは前の画面へ |
| `pages/rules/[protocol]/[listenAddr]/[listenPort]/index.tsx` | ルールの詳細（概要・待ち受け・転送先と解決したアドレス・TLS（routes と unmatched、証明書と中間 CA、クライアント認証、ALPN、upstream）・STARTTLS・詳細（allow_from を含む）・統計（拒否を含む）・L7 のルールでは HTTP のリクエスト（状態コード別、ルートごと、制限・遮断の数））。編集ボタンと、確認ダイアログつきの削除ボタン。固定ルールでは両方を出さず「固定ルール（rproxy の設定ファイルで管理）」と出す。`listenAddr` は URL エンコードする（IPv6 の `:` を含むため） |
| `pages/rules/[protocol]/[listenAddr]/[listenPort]/edit.tsx` | ルールの変更画面。保存したら詳細画面へ。固定ルールではフォームを出さない |
| `components/RuleForm.tsx` | ルールの入力フォームとクライアント側のバリデーション（追加・変更の画面で使う。旧 `Modal.tsx`）。タブ（基本 / TLS・DTLS / メール (STARTTLS) / 詳細）に分かれ、矢印キー / Home / End で移れる（WAI-ARIA の Tabs）。エラーのあるタブには件数の印が付く。「詳細」タブに allow_from（1 行に 1 件）、TLS タブに unmatched（tcp の sni / terminate で routes があるときだけ）。`source_ip`・TLS のモード・STARTTLS の選択肢と範囲の上限は `/api/forward/capabilities` から取得する。中間 CA（`chain_file`）の欄は証明書ごと・クライアント認証・upstream に常に出す（3 階層以上の PKI を使うため） |
| `components/dashboard.ts` | 一覧の表示は待ち受けをポートだけ（`listenPortLabel`。アドレスは詳細画面と title の `listenLabel`）、転送先を代表の名前 1 つ（`listTarget` / `representativeHost`。L7 は最初のルートの `Host(...)`）にする。検索は表示していないアドレスや名前でも一致する。ダッシュボードと詳細画面の集計・整形（状態の集計、TLS の内訳、絞り込み、バイト数・時間の表示、ドーナツの `conic-gradient`、画面の URL）と、rproxy の応答から固定ルールの行を作る `ruleFromStatus` / `mergeStaticRules`。React に依存しない |
| `components/RequireAuth.tsx` | 画面のサインインの確認。`_app.tsx` で `PUBLIC_PATHS`（`/profile` だけ）以外の全ページを包み、サインインしていなければ Keycloak のサインインへ移す（サインイン後は元のページに戻る）。ページを足したら、サインインなしで開けてよいかを決めて `PUBLIC_PATHS` を見直す |
| `components/ui.tsx` | 状態・TLS・固定・IP 制限のバッジ、エラーのバナー、確認ダイアログ（`<dialog>`）、自動更新のフック、1 件取得のフック `useRule`、API への送信 |
| `components/profiles.ts` | 追加フォームの「プロファイル」（用途別のひな形）。`../rproxy-api/docs/PROFILES.md` に合わせる |
| `components/tls.ts` | TLS / STARTTLS / ポート範囲 / allow_from / unmatched の正規化と検証、DB の `options` 列の読み書き。画面と API route の両方で使う |
| `components/cidr.ts` | allow_from の CIDR / 単一 IP の検証と正規化（rproxy の `src/cidr.rs` と同じ規則。Node の `net` を使わないので画面でも使える） |
| `components/lib.ts` | 共通の型（`ForwardRule`、`TlsSpec`、`ForwardRules`、`RuleStats`、`DashboardData`、`sessionUser` など）と pino ロガー |
| `components/rproxy.ts` | rproxy-api の HTTP クライアント。失敗時は `RproxyError`（`code`、`status`。通信失敗は `unreachable` / 0）。`RPROXY_API_URL=unix:/path` なら Unix ソケット（rproxy の `RPROXY_API_SOCKET`）に undici の `fetch` と `Agent({ connect: { socketPath } })` で接続する（`apiTarget`。TCP はグローバルの `fetch`） |
| `pages/api/auth/[...nextauth].ts` | Keycloak の設定。サインイン時にアクセストークンのロール（既定 `realm_access.roles`）を読んで JWT に保存し、セッションに `roles` と `access`（admin / user / none。画面の表示用）を入れる |
| `pages/api/forward/[forward].ts` | `list` / `dashboard` / `rule` / `export` / `history`(GET)、`add` / `modify` / `delete` / `import` / `revert` / `pause` / `resume`(POST) のエンドポイント |
| `pages/api/forward/capabilities.ts` | rproxy の `GET /capabilities` をそのまま返す |
| `pages/api/forward/config.ts` | rproxy の設定ファイルの状態（`GET /config`）を、ダッシュボードの注意（誤り・再起動が要る変更）の形で返す（`configStatusView`）。読めない（403 / 404 / 届かない）ときは何も出さない |
| `pages/api/forward/interfaces.ts` | rproxy の `GET /interfaces`（待ち受けアドレスの候補と、制御 API が使う予約済みのアドレス）を返す |
| `components/sourceip.ts` | source_ip の欄に出す説明（transparent が使えない理由、IPv4 だけであること、選んだときのルーティングの前提）。`GET /capabilities` の `transparent` を使う |
| `components/listen.ts` | 待ち受けアドレスの選択肢と、予約済みのアドレス・ポートとの重なりの判定 |
| `components/messages.ts` | API のエラーコードを利用者向けの説明に直す（`resolve_failed`、`static`、`no_role`、`rproxy_unauthorized` など） |
| `components/roles.ts` | ロール（`rproxy-admin` / `rproxy-user`）の判定。クレームの位置・ロールの名前・利用者が使えるポートは環境変数（`RPROXY_UI_ROLES_CLAIM` / `RPROXY_UI_ADMIN_ROLE` / `RPROXY_UI_USER_ROLE` / `RPROXY_UI_USER_PORTS`） |
| `components/apiguard.ts` | API route の共通の確認（サインインとロール、`requireRole`）と、rproxy の失敗の返し方（`rproxyFailure`。rproxy の 401 は `rproxy_unauthorized`） |
| `components/httpspec.ts` | L7（ルールの `http`）の型、`match` の式の検査（rproxy の `src/http/matcher.rs` と同じ書き方）と組み立て、`validateHttp`・`cleanHttp`。画面と API route の両方で使う |
| `components/HttpEditor.tsx` | RuleForm の「L7 (HTTP)」タブ（ルート・サービス・ミドルウェア・一致しないとき）。ミドルウェアの種類は `features.middlewares`、サービスのヘルスチェック・スティッキーは `features.services` にあるものだけ出す |
| `components/targets.ts` | 宛先を複数にしたとき（`targets` / `balance` / `health_check`）のフォームの行・組み立て・宛先ごとの状態の探し方。形の検証は `tls.ts` の `normalizeTargets` / `checkBalancing` |
| `components/TargetsEditor.tsx` | RuleForm の「基本」タブの宛先の一覧・振り分け方・ヘルスチェック（「宛先を追加」で出る） |
| `components/HttpSummary.tsx` | 詳細画面の L7 の読み取り専用の表示（ルートは rproxy が試す順） |
| `components/settingsdoc.ts` | ルールと rproxy の設定ファイルの形の変換（エクスポートの `toSettingsRule`・`exportDoc`・`formatDoc`、インポートの `parseDoc`・`settingsRuleToBody`）と、rproxy へ送るルールの形 `toRproxyRule`（API route と共有）。エクスポートは JSON だけで、先頭の `format: "rproxy-ui-export"` で rproxy の設定ファイルと区別する（rproxy は知らない項目として断る）。インポートは UI のエクスポートと rproxy の設定ファイル（YAML / JSON。`yaml`、純粋な JS で読む）を読む。`enabled`（停止中）は UI のエクスポートの中だけ |
| `components/history.ts` | 変更の履歴の型（`HistoryEntry`）と、前の版との違いの文（`ruleChanges`） |
| `components/HistoryList.tsx` | 履歴の表（ページ送り、「この版に戻す」）。`/history` と詳細画面で使う |
| `pages/rules/import.tsx` | インポート（確かめる → 置き換えるものを選ぶ → 実行） |
| `pages/history.tsx` | 変更の履歴（絞り込み） |
| `keycloak/` | Keycloak のレルム定義（読み込み用の JSON。シークレットとユーザーは含めない） |
| `db/` | テーブル定義（`schema.sql`）とマイグレーション。`db/README.md` を参照 |

## データの流れ

1. 画面から `/api/forward/<action>` を呼ぶ。
2. サーバ側で入力を検証・正規化する（`protocol` は小文字、ポートは 1〜65535、listen アドレスは IP のみで IPv6 は圧縮表記）。
   TLS の組み合わせは `components/tls.ts` の `checkTls` で rproxy と同じ規則を先に確かめ、日本語のメッセージを返す（コードも rproxy と同じ `tls_config` / `unsupported` / `invalid`）。
   `tls.unmatched: "reject"` は sni（tcp / udp）か tcp の terminate で routes があるときだけ（それ以外は `tls_config`）。udp の sni（rproxy v0.3.8。DTLS・QUIC のサーバ名で振り分ける）は作成・編集できる。`passthrough` の route は tcp の terminate だけ。フォームは udp の sni に注意（`UDP_SNI_NOTES`）と、同じアドレス・ポートの HTTP/3 の L7 のルールとの重なりの警告（`http3PortConflicts`）を出す。既定の `default` は省いた形に揃える。
   `allowFrom`（API の body。rproxy と DB では `allow_from`）は CIDR か単一の IP の配列で最大 64 件（`invalid`）。rproxy の応答と同じ形に正規化して保存する（`10.0.0.5` → `10.0.0.5/32`、`172.16.9.9/16` → `172.16.0.0/16`、IPv6 は圧縮表記、IPv4-mapped は IPv4）。
   証明書ファイルが読めるか、範囲の上限（`max_range_ports`）、範囲の重なりは rproxy が判定する。
3. トランザクション内で `forward_rules` を更新し、履歴を `forward_rules_log` に書き込む（`update_action` 列は `ADD` / `UPDATE` / `DELETE`、`auth_id` は操作した利用者）。
   ルールは Keycloak の `sub`（`auth_id`）ごとに持ち、キーは `protocol`、`src_addr`、`src_port` の組み合わせ（DB 全体で一意。範囲ルールでは先頭のポート）。
   ポート範囲の終わりは `src_port_end`、TLS / STARTTLS / allow_from / L7 / CrowdSec / 複数の宛先は `options` 列に `{"tls", "starttls", "starttls_required", "allow_from", "http", "crowdsec", "targets", "balance", "health_check", "extra_listen_addrs", "enabled"}` の JSON で保存する（`allow_from` は空なら、`http` は null なら、`crowdsec` は false なら、`targets` と `extra_listen_addrs` は空なら省き、`balance` / `health_check` は `targets` があるときだけ。すべて既定なら NULL）。
   rproxy は `options` を未知のキーを拒否して読むので、`OPTIONS_KEYS` 以外のキーを入れないこと（`parseOptions` も未知のキーを拒否する）。
4. rproxy-api の HTTP API を呼ぶ（`POST /rules`、`PATCH /rules/{protocol}/{addr}/{port}`、`DELETE ...`）。成功したときだけ COMMIT し、失敗したら ROLLBACK する。
   rproxy に反映した後で COMMIT だけが失敗した場合は、rproxy 側の変更を元に戻す（`withTransaction` に渡す undo）。
   - rproxy の 4xx はそのままのステータスで返す（401/403 は UI サーバ側の設定ミスなので 502）。それ以外の失敗は 502。本文は `{error, code}`。
   - 削除で rproxy が `not_found` を返した場合は成功として扱う。
   - 変更で rproxy が `not_found` を返した場合（`missing` のルール）は、変更後の内容で作り直す。
   - 変更の PATCH には毎回 `tls`（と STARTTLS を使うなら `starttls` / `starttls_required`）と `allow_from`（空なら `[]`）を付け、丸ごと置き換える。COMMIT が失敗したときの undo も、元の転送先・TLS の設定・allow_from で PATCH する。
     `modify` の body に `allowFrom` がなければ DB の値を保つ（あれば置き換える）。追加の POST には `allow_from` が空でなければ付ける。
   - 固定ルール（rproxy の `--static-rules` のファイルのルール。`origin: "static"`）は DB にない。`modify` / `delete` で自分の行がなく、rproxy の `GET /rules/{key}` が `origin: "static"` を返したら 409 `static` を返す（rproxy も PATCH / DELETE を 409 `static` で拒否する。その場合もそのまま返す）。
5. `list` は DB のルールに rproxy の `GET /rules` の稼働状態をつけて返す（`state` は `running` / `failed` / `missing`（rproxy にない）/ `unknown`（rproxy に問い合わせできない）/ `paused`（UI で一時停止中））。
   稼働情報は `connections`、`stats`（rproxy の `{total_connections, rx_bytes, tx_bytes, tls_failures, denied, dropped, http}` をそのまま。`dropped`（UDP で rproxy が捨てたデータグラム）は v0.3.9 より前の rproxy にはない（そのときは画面に出さない）。`denied` は古い rproxy に、`http`（L7 のリクエスト数：`requests`・`by_status`・`routes`・`limited`・`blocked`）は v0.3.1 より前の rproxy と http のないルールにはない）、`startedAt`（rproxy の `started_at`、Unix 秒）、`resolved`。`missing` / `unknown` のときは null / 空配列。
   各行には `origin`（DB の行は常に `dynamic`）と `allowFrom` が付く。`list` は自分の DB のルールだけ（`rproxy-admin` はすべての利用者のルールで、`owner` が付く）。
   - `dashboard` は `{reachable, rproxyError, rules}`。`rules` は `list` の後ろに、rproxy の固定ルール（`origin: "static"`）を読み取り専用の行として足したもの（`mergeStaticRules`。id は負の数で、画面の key にだけ使う）。
     固定ルールはシステムのルールなので、ログインしていればだれにでも見せる（ほかの利用者の `dynamic` なルールは見せない）。rproxy に接続できなければ固定ルールは出ない。ルールが 0 件でも rproxy に接続できるかがわかる。
   - `rule?protocol=&addr=&port=` は自分のルール 1 件か、DB になければ rproxy の固定ルール（キーが不正なら 400、ほかの利用者のルールや存在しないルールは 404、DB になく rproxy に問い合わせできなければ 502）。稼働状態は rproxy の `GET /rules/{protocol}/{addr}/{port}` から取る。

HTTP の取り決めは `../rproxy-api/docs/API.md` が正。変更するときは両方のリポジトリを揃えること。
rproxy は起動時に `forward_rules` を読んでルールを復元する（読む列は `db/README.md` を参照）。

## 注意点

- v0.3 の形（rproxy-api の docs/API.md「v0.3 の設定」）：ルールの `http`（L7）、`tls.certificates[]` の ACME（`acme` / `domains`）、`tls.options`（`min_version` / `cipher_suites`）、`GET /capabilities` の `features`。
  L7 はフォームの「L7 (HTTP)」タブで作成・編集できる（`HttpEditor`。tcp で `features.http` が true のとき）。API route は `validateHttp` で形を確かめてから保存して rproxy に渡す（細かい検証は rproxy）。L4 と L7 の切り替えは作成時だけ（rproxy が PATCH で切り替えられないので `modify` は 400 `unsupported`）。`modify` の body に `http` がなければ DB の値を保つ。
  `http` のあるルールは転送先を持たない（DB の `dist_addr` は `''`、`dist_port` は `0`。rproxy への POST / PATCH では `remote_addr` / `remote_port` を送らずに `http` を送る）。一覧・詳細では転送先の代わりに「L7 (HTTP)」とルートの数を出す（`targetLabel`）。
  ACME は rproxy に内蔵しない方針（rproxy-api#17）なので、ACME の証明書は詳細画面とフォームに「この rproxy では使えない設定」と出す（`ACME_UNSUPPORTED_NOTE`。設定は消さずに保つ）。証明書は certbot / cert-manager で取ったファイルで、rproxy が変更を検知して読み直す（`RPROXY_CERT_CHECK_SECS`）。
  rproxy の 403 `forbidden`（UI のトークンのスコープ・`allow_listen_ports` の不足）は 502 で `code: forbidden` を返し、画面は `FORBIDDEN_MESSAGE` で説明する。UI のトークンに要るスコープは `rules:read` と `rules:write`。
  フォームは ACME の証明書と `tls.options` を読み取り専用で残して送る。
  宛先を複数にしたルール（rproxy v0.3.3 の `targets` / `balance` / `health_check`）は、`options` に `targets` があるときだけ書き、DB の `dist_addr` は `''`、`dist_port` は `0`。rproxy へは `remote_addr` / `remote_port` の代わりに送る（PATCH では宛先の一覧・振り分け方・ヘルスチェックを丸ごと置き換え、単一に戻すときは `remote_addr` と `targets: []`）。`modify` の body に `targets` がなければ DB の値を保つ。
  ルールの `crowdsec`（L4 の CrowdSec。rproxy v0.3.2 から）は `options` に true のときだけ保存し、rproxy へも true のとき（PATCH では有効から無効にするときも）だけ送る（古い rproxy は知らない項目を拒否する）。
  追加の待ち受けアドレス（`extraListenAddrs`、rproxy の `extra_listen_addrs`。v0.3.3）は IP アドレスだけで最大 16 件（`normalizeExtraListenAddrs`）。rproxy へは空でないとき（PATCH では空にするときも）だけ送る。`modify` の body になければ DB の値を保つ。
  TLS の `routes[]` は `server_name` か `server_names`（フォームはカンマ区切りの 1 欄）と `passthrough`（terminate のときだけ。L7 のルールでは passthrough の行だけ、`unmatched: reject` も不可。`checkTls` の 5 番目の引数）。`**.` は何階層でも一致するワイルドカード。
- 証明書の期限（#66）：rproxy（v0.3.5 以降）の `cert_status`（証明書ごとの `role`・`file`・`not_after`・`days_left`・`state`: ok / expiring / expired）を `certStatus` として持つ（`withLiveState`・`ruleFromStatus`。古い rproxy・証明書のないルールでは付かない）。詳細画面の「証明書の期限」、ダッシュボードの「要確認」（failed・missing のあとに、期限が近い・切れた証明書のあるルール。`needsAttention`・`certProblem`）と一覧の `CertBadge`（`worstCertState`）。サーバ証明書がすべて切れたルールは rproxy が `failed`（error は `certificate expired: ...`）にするので、`ruleErrorText` / `explainError` が対処（証明書を更新すれば自動で戻る）を添える。
- ロール：`rproxy-admin` はすべての利用者のルール（`owner` 付き。WHERE に `auth_id` を付けない）、`rproxy-user` は自分のルールだけ（`RPROXY_UI_USER_ROLE` が空（既定）なら、サインインした人はだれでも user）、ロールを必須にしてどちらもなければ 403 `no_role`（画面は `RequireAuth` が出す）。`RPROXY_UI_USER_PORTS` で `rproxy-user` の待ち受けポートを制限できる（403 `port_not_allowed`）。
  rproxy の 401（UI の `RPROXY_API_TOKEN` の誤り・期限切れ）は 502 `rproxy_unauthorized`（利用者のサインインの問題と区別する）。

- エクスポート / インポート（#60）：`export` は DB のルールを `toSettingsRule`（既定値を省いた rproxy の形）で、`{format: "rproxy-ui-export", version: 1, exported_at, rules}` の JSON に書き出す。`import` は `parseDoc` → `settingsRuleToBody` → `parseRule`（画面からの追加と同じ検証）で 1 件ずつ確かめ、`dryRun` なら結果だけ、実行では 1 件ずつ別のトランザクションで `addForwardingRule` / `replaceForwardingRule`（PATCH で変えられない違いは削除して作り直す。所有者は変えない）。書き出して読み込むと同じルールになること（DB の行と rproxy に送る形）を `tests/export-import.test.ts` で確かめている。
- 履歴（#61）：`forward_rules_log` の行はその操作のあとの内容（DELETE は削除の前）。利用者に見せる範囲は「自分が操作した行」と「今自分が持っているルールの行」（`historyScope`。所有者の列はないので、削除されたほかの人のルールの履歴は admin だけ）。`revert` は履歴の版を置き換え / 作り直しで戻す（固定ルールと同じキーなら 409 `static`）。
- 一時停止（#63）：`pause` は DB の `options` に `"enabled": false` を付け（`false` のときだけ保存）、rproxy から削除する。`resume` は印を外して rproxy に作る（どちらも履歴は UPDATE、COMMIT の失敗では rproxy を戻す）。停止中（`isPaused`）のルールの `modify` / `delete` は DB だけ、`add`（インポートの `enabled: false`）も DB だけ。状態は `paused`（`missing` ではない）。`enabled` は rproxy の API には送らない（rproxy は DB の復元のときだけ読む）。`modify` では停止・再開の状態を変えない（`enabled` を送っても今の状態のまま）。置き換え・巻き戻しも今の状態を保つ。
- COMMIT が失敗して、さらに rproxy 側の取り消しも失敗した場合は、DB と rproxy が食い違う（ログに出る）。rproxy を再起動すれば DB の内容に戻る。
- `source_ip` とポート範囲は作成後に変更できない（API の制約）。編集画面では読み取り専用。API に違う範囲が来たら 400（`unsupported`）。
- TLS の設定は編集できる。フォームは選んでいるモードで使う項目だけを送る（隠れている欄の値は送らない）。
- allow_from の範囲外からの接続は、rproxy が TLS や PROXY ヘッダより前に切断する（UDP はデータグラムを捨てる）。`stats.denied` に数える（`unmatched: reject` で切った接続も同じ）。
- 固定ルールは画面から変更・削除できない（編集・削除のボタンを出さない）。変えるときは rproxy のファイルを書き換えて rproxy を再起動する。
- 中間 CA（`chain_file`）は `certificates[]`、`client_auth`、`upstream` にある。空欄は省く。rproxy と同じく、`client_auth.chain_file` は `mode` が optional / required のとき、`upstream.chain_file` は `upstream.cert_file` があるときだけ使える（`checkTls` が `tls_config` を返す）。チェーンの順番（発行した CA からルートへ）は rproxy が読み込むときに確かめる。
- 画面の言語（日本語 / English、#82）：文言は日本語のままソースに書き、`i18n/en.ts`（キーは日本語の文言、`{0}` は差し込む値）で訳す。JSX の文字列と属性は `tsconfig.json` の `jsxImportSource: "@/i18n"`（`i18n/jsx-runtime.ts`）が自動で訳し、JSX を通らない文字列（`window.confirm` など）は `t()`、日付は `localeTag()`。API route は `localizedApi` で包み、`error` / `message` を cookie（`rproxy_ui_lang`）か Accept-Language の言語で返す（`code` は変えない）。文言を足したら `npm run i18n:check` で訳を足す。E2E は `locale: 'ja-JP'`（日本語）。
  組み立てた文字列（条件で付け足す部分・`join` でつないだもの・文を続けたもの）は丸ごとでは辞書に一致しないので、組み立てる側で部品ごとに訳す（#94）：語句を並べるのは `joinList`（英語は ", "）、文を並べるのは `joinSentences`（英語は文の間に空白）、場面で訳が違う語は `tc('有効', 'on-off')`（辞書のキーは `有効|on-off`）。履歴の差分の文（`ruleChanges`）は API がリクエストの言語で作る。JSX で「。」で終わる文の後に別の子が続くときは、英語では `i18n/props.ts` が空白を足す。`tests/i18n-leak.test.ts` が英語で組み立てた結果に日本語が残らないことを確かめる。
- 画面は明るい配色だけ。カード・表・ボタンは `styles/globals.css` の `.card` / `.data-table` / `.btn-*` / `.badge` を使い、背景色と文字色を必ず両方指定する（以前、白地に白文字になる不具合があった）。
- レスポンシブ（#88）：lg（1024px）以上は左のサイドバー、未満はヘッダーの「メニュー」で開閉する（`Layout` が状態を持ち、画面を移る・Esc で閉じる。言語の切り替えとサインアウトもメニューの中）。横に長い表は `.table-scroll` で包み、表の中だけを横にスクロールさせる（ページ全体をはみ出させない。`relative` は表の中の `sr-only` がページの幅を広げないため）。狭い幅のボタンは `max-lg:min-h-11` でタップしやすくする。`tests/ui/responsive.spec.ts` が 375px と 768px ではみ出さないことを確かめる。
- `res.status(200).json(await ...)` と書かない（`status` が先に呼ばれて、失敗しても 200 になる）。先に値を取ってから返す。
- `mariadb` ドライバは JSON 列をオブジェクトで返すことがある。`parseOptions` は文字列とオブジェクトの両方を受け付ける。
- クライアント側の IPv6 の検証は緩い（文字種だけ）。最終的な検証はサーバ側の `net.isIP` で行う。

## プロファイル（`components/profiles.ts`）

`../rproxy-api/docs/PROFILES.md` の推奨設定をフォームに入れるだけ（アドレスと証明書のパスは利用者が入力する）。PROFILES.md の注意に従うこと。

- WebRTC のメディア（`webrtc-media`、UDP 50000-60000）は必ず passthrough。DTLS を終端すると接続できない。メディアサーバに rproxy の公開 IP を告知させる注意を出す。
- RTSP は TCP interleaved を推奨。UDP の RTP 範囲（`rtp-range`）はクライアントからサーバへの方向だけ使える、と注意を出す。
- SMTP（25）は passthrough + `proxy_v2`。STARTTLS を終端する場合は `starttls_required: false`（説明文で案内する）。
- ほか：https-sni（443 sni）、submission（587 terminate + smtp）、smtps（465）、imap（143 + imap）、imaps（993）、pop3（110 + pop3）、pop3s（995）、rtsp（554）、rtsps（322）、turn-udp / turn-tcp（3478）、turns-tls（5349/tcp terminate）、turns-dtls（5349/udp terminate = DTLS）、ftp（21）、ftp-passive（TCP の範囲）。
