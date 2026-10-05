# CLAUDE.md — TCP-UDP-rproxy-ui

`rproxy-api`（Rust 製の TCP/UDP リバースプロキシ、別リポジトリ `../rproxy-api`）の転送ルールを管理する Web UI。
Next.js 16（Pages Router）、React 19、NextAuth v4 + Keycloak、MariaDB、Tailwind CSS 4 で構成されている。

## バージョン管理

`docs/RELEASING.md` の決まりで、確認を取らずに進める。番号は rproxy-api と別々に進め、タグはずれてよい。動くものが変わったリポジトリだけ番号を上げて出す。組み合わせは UI が `GET /capabilities` の `version` で確かめ（`components/version.ts` の `MIN_RPROXY_VERSION`。新しい rproxy-api の機能が要るようになったら上げる）、UI のリリースノートに必要な rproxy-api の最小の版を書く。UI の .deb は UI のリリースの後に `gh workflow run release.yml -R max3584/rproxy-api -f ui_tag=vX.Y.Z` で apt に載せる。
PR・issue を作るときにパッチ／マイナーのマイルストーンを付け、マージ後のタグ・リリースノート・マイルストーンの片付けまで行う。
PR のブランチに追加で push する前に、その PR がまだ開いているか（`gh pr view <n> --json state`）を確かめる。

## パッケージ（apt）

`scripts/build-deb.sh` が `next build`（`output: 'standalone'`、`images.unoptimized`）の結果から `rproxy-ui_<version>-1_all.deb` を作る（`packaging/debian/` にユニット・設定・maintainer scripts）。
CPU ごとのネイティブなモジュール（`.node`）が入ると `all` にできないので、build-deb.sh が見つけたら止める。依存を足すときに気をつける。
CI の `Debian package` ジョブ（`scripts/test-deb.sh`、NodeSource の nodejs で実際に入れる）で確かめる。GitHub Release を公開すると `release.yml` が .deb を添付し、rproxy-api の `release.yml` を `ui_tag` で手動実行すると apt リポジトリに載る（docs/RELEASING.md）。

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
npm run screenshots # README の画面の画像（docs/images/<名前>.<ja|en>.png）を撮り直す。先に npm run build
```

- 開発機 con0 では 3000 番（別サービス）と 8080 番（code-server）が使用中。UI は `./node_modules/.bin/next dev -p 3001`、rproxy は 8081 で動かす（`.env.local` の `NEXTAUTH_URL` と `RPROXY_API_URL` もこのポートに合わせてある）。
- Next.js 16 は学習データより新しいので、API や設定を変えるときは `node_modules/next/dist/docs/` の説明書を先に読む（`next.config.mjs` の `agentRules: false` で、`next dev` がこの注意を CLAUDE.md に書き足すのを止めている）。
- `next dev` が動いている間に同じディレクトリで `npm run build` を実行しない（`.next` を上書きして開発サーバが 404 を返すようになる）。
- react-hooks v7 の規則（`set-state-in-effect` など）が有効。選べなくなった値を既定に戻す処理は、エフェクトではなく描画中に条件つきで `setState` する（React の「props が変わったときに state を直す」の書き方）。初回の取得（`await` の後でだけ state を変える）はコメントを付けて規則を外している。
- DB の接続プールは `globalThis` に置いて使い回す（`components/ruledb.ts` の `getPool`。読み直しのたびにプールが増えて Too many connections になるのを防ぎ、instrumentation の自動の送り直しと API route で 1 つにする）。

- パッケージマネージャは npm だけ（`package-lock.json`）。CI・.deb の作成・Renovate もこれを使う。ほかのロックファイル（`pnpm-lock.yaml` など）は足さない（Renovate が「複数の npm のロックファイル」の警告を出す）。
- TypeScript は 7（`@typescript/native` = `npm:typescript@^7`、`npx tsc` はこれ）と 6 の API（`typescript` = `npm:@typescript/typescript6`、コマンドは `tsc6`）を並べて入れている。TypeScript 7 には JavaScript の API がなく、typescript-eslint（eslint-config-next が使う）と `i18n/extract.mjs` は `typescript` の API を読むため（TypeScript 7.0 の告知の「Running side-by-side with TypeScript 6.0」の書き方）。`next build` の型チェックは `typescript` の CLI（tsc6）を使う。typescript-eslint が TypeScript 7.1 の API に対応したら（typescript-eslint/typescript-eslint#10940）`typescript` を 7 に戻す。
- 必要な環境変数（`.env.local`）は README に記載がある：`NEXTAUTH_*`、`DB_HOST/PORT/DATABASE/USER/PASSWORD`、`KEYCLOAK_CLIENT_ID/CLIENT_SECRET/ISSUER`、`RPROXY_API_URL`、`RPROXY_API_TOKEN`（複数の rproxy なら代わりに `RPROXY_UI_NODES`）。
- import のパスエイリアスは `@/`（リポジトリのルート）。vitest でも `vitest.config.mts` で同じエイリアスを設定している。
- テストは MariaDB・rproxy・NextAuth をすべてモックする（`tests/forward.test.ts`）。実際の DB や rproxy は不要。
- 複数のノードの E2E（`tests/e2e-nodes.test.ts`、CI の `e2e-nodes`）は rproxy-api を 2 台、別々のコンテナ（同じ待ち受けを両方で使うため。制御 API は Unix ソケット）で動かし、ノードごとのビューから戻すことまで確かめる。
- 画面操作の E2E（`tests/ui`、Playwright）は CI の e2e ジョブで本物の MariaDB と rproxy-api を相手に動く。サインインは Keycloak を通さず、テスト用の `NEXTAUTH_SECRET` で作ったセッションのクッキー（`tests/ui/global-setup.ts`）。ライト・ダークで白地に白文字がないことも確かめる。画面の文言やボタン名を変えたら `tests/ui` も直す。
- README のスクリーンショット（`scripts/screenshots/`、`npm run screenshots`）は通常の E2E とは別の Playwright の設定で、3197 番（`SCREENSHOTS_PORT`）で `next start` し、画面が呼ぶ `/api/forward/*` をブラウザの中で `sample-data.ts` のデータに差し替える（本番のコードにモックは入れない。DB・rproxy・Keycloak は不要）。データは文書用のアドレス（192.0.2.0/24・198.51.100.0/24・2001:db8::/32）と example.com だけ。PNG は next が入れる sharp があれば 256 色に減らす。画面を大きく変えたら撮り直し、画像を目で確かめる。

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
| `components/nodes.ts` | 複数の rproxy（#98）の設定。`RPROXY_UI_NODES`（YAML / JSON）の `nodes`（name・url・token_file）と `groups`（name・nodes・mode: single / active_standby）、`default_target` を読んで確かめる（`parseNodesConfig`、誤りは `NodesConfigError`）。なければ `RPROXY_API_URL` / `RPROXY_API_TOKEN` の 1 台（`implicitConfig`、名前 `default`、`configured: false`）。グループのノード（`targetNodes`）、重なり（`targetsOverlap`）、`forward_rule_targets` の行（`membership`）、1 台に聞く問い合わせの相手（`probeNode`） |
| `components/overrides.ts` | グループのルールのノードごとの上書き（`NodeOverride`：待ち受けアドレス・追加の待ち受けアドレス・転送先（1 つか複数）・allow_from・このノードだけの停止）。検証 `normalizeOverride`、そのノードで動かす内容 `effectiveRule`、DB の行 `overrideRow` / `overrideFromRow`（options は JSON_MERGE_PATCH の差分。ビューと同じ重ね方）、エクスポートの形 `toSettingsOverride` / `settingsOverridesToBody`。React と Node に依存しない |
| `components/OverrideEditor.tsx` | ルールの詳細のノードのタブの「このノードだけの設定（上書き）」 |
| `components/hasync.ts` | act / stb の昇格の前に揃える（#109）：自動の送り直し（`startHaSync` を instrumentation から 1 回。状態は globalThis、見回りは DB の `GET_LOCK` で 1 つの UI だけ。`runHaSyncOnce`・`syncNode`。履歴は RESEND で操作者 `system`）、昇格してよいか（`nodeReadiness`）、act / stb の画面の元（`haOverview`）、失敗の数（`haSyncStatus`） |
| `components/hatoken.ts` | keepalived の口（`pages/api/forward/ha/ready.ts`・`notify.ts`）の認証。`RPROXY_UI_HA_TOKEN_FILE` のトークンを Bearer で受け取る（なければ 404 `ha_disabled`） |
| `components/ruledb.ts` | DB のプール（`getPool`。globalThis で 1 つ）、行とルールの変換（`fromRow`・`ruleOptions`）、上書きの読み込み、1 つのノードへの送り直し（`resendOne`）。API route と hasync が共有する |
| `pages/ha.tsx` | act / stb の画面（グループの act、ノードごとに揃っているか、「このノードを揃える」、failback の手順）。管理者だけ |
| `contrib/keepalived/` | keepalived の track_script（`rproxy-ui-ready.sh`。503 のときだけ 1）・notify_master（`rproxy-ui-notify.sh`）と設定の例。.deb の `/usr/share/doc/rproxy-ui/examples/keepalived/` |
| `components/drift.ts` | UI の定義と各ノードの実際のルールの「ずれ」（`ruleDrift`：`ruleFromStatus` で画面の形に揃え、`canon` で既定値・空の値を省いて項目ごとに比べる。結果は項目のコード `DriftField`、名前は `DRIFT_LABELS`）と、送り直しで作り直しが要るか（`needsRecreateOnNode`） |
| `components/ha.ts` | active_standby の act の判定（`vipAddrs`：グループの `vip`、なければルールの特定の待ち受けアドレス。`haStatus`：各ノードの `GET /interfaces` に VIP があれば act、だれも・複数が持てば警告 none / split） |
| `components/Tabs.tsx` | WAI-ARIA のタブの並び（矢印キー / Home / End）と `tabPanelProps`。ダッシュボードとルールの詳細の「全体 / ノードごと」 |
| `components/fanout.ts` | グループの変更を全ノードに送る `applyToNodes`（`withNode` でノードごとに実行。1 台でも失敗したら成功したノードの undo を実行して `FanoutError`（ノードごとの結果 `results`）。ノードが 1 つなら例外をそのまま投げる） |
| `db/node-view.mjs` | ノードごとのデータベースと `forward_rules` ビュー・読み取りだけのユーザーの SQL を出す（依存のない JS。`npm run db:node-view -- <ノード>`。.deb の db/ からも動く） |
| `instrumentation.ts` | 起動時に `RPROXY_UI_NODES` を確かめ、誤りなら理由を出して終了する。各ノードの rproxy-api の版をログに出す（`logVersions`。待たない・失敗しても起動を止めない） |
| `components/version.ts` | UI の版（`UI_VERSION`。`next.config.mjs` の `env` が package.json から埋め込む）、必要な rproxy-api の最小の版（`MIN_RPROXY_VERSION`）と知っているマイナー（`KNOWN_RPROXY_MINOR`）、版の比較と判定（`versionStatus`：ok / old / unknown / newer / unreachable）。React に依存しない |
| `components/versioncheck.ts` / `pages/api/forward/versions.ts` | 各ノードの `GET /capabilities` の `version` を聞く（`checkVersions`）。`/api/forward/versions` は問い合わせできないノードがあっても 200 |
| `components/VersionInfo.tsx` | サイドバーの下の版（`SidebarVersions`）、ダッシュボードの注意（`VersionNotice`：古い・分からないは注意、新しいマイナーは知らせるだけ）、ノードが 1 つのときの版の一覧（`VersionsCard`）と、2 つ以上のときのノードの一覧（`NodesCard`）の rproxy-api の欄（`NodeVersionCell`）。機能ごとの判断は `features` のまま |
| `components/rproxy.ts` | rproxy-api の HTTP クライアント。`withNode(node, fn)`（AsyncLocalStorage）の中ではそのノードの URL とトークン、外では `RPROXY_API_URL` / `RPROXY_API_TOKEN` に送る（関数の引数は 1 台のときと同じ）。失敗時は `RproxyError`（`code`、`status`。通信失敗は `unreachable` / 0）。`RPROXY_API_URL=unix:/path` なら Unix ソケット（rproxy の `RPROXY_API_SOCKET`）に undici の `fetch` と `Agent({ connect: { socketPath } })` で接続する（`apiTarget`。TCP はグローバルの `fetch`） |
| `pages/api/auth/[...nextauth].ts` | Keycloak の設定。サインイン時にアクセストークンのロール（既定 `realm_access.roles`）を読んで JWT に保存し、セッションに `roles` と `access`（admin / user / none。画面の表示用）を入れる |
| `pages/api/forward/[forward].ts` | `nodes` / `list` / `dashboard` / `rule` / `export` / `history`(GET)、`add` / `modify` / `delete` / `import` / `revert` / `pause` / `resume`(POST) のエンドポイント |
| `pages/api/forward/capabilities.ts` | rproxy の `GET /capabilities` をそのまま返す |
| `pages/api/forward/config.ts` | rproxy の設定ファイルの状態（`GET /config`）を、ダッシュボードの注意（誤り・再起動が要る変更）の形で返す（`configStatusView`）。読めない（403 / 404 / 届かない）ときは何も出さない |
| `pages/api/forward/interfaces.ts` | rproxy の `GET /interfaces`（待ち受けアドレスの候補と、制御 API が使う予約済みのアドレス）を返す |
| `components/sourceip.ts` | source_ip の欄に出す説明（transparent が使えない理由、IPv4 だけであること、選んだときのルーティングの前提）。`GET /capabilities` の `transparent` を使う |
| `components/listen.ts` | 待ち受けアドレスの選択肢と、予約済みのアドレス・ポートとの重なりの判定 |
| `components/messages.ts` | API のエラーコードを利用者向けの説明に直す（`resolve_failed`、`static`、`no_role`、`rproxy_unauthorized` など） |
| `components/roles.ts` | ロール（`rproxy-admin` / `rproxy-user`）の判定。クレームの位置・ロールの名前・利用者が使えるポート・ノードは環境変数（`RPROXY_UI_ROLES_CLAIM` / `RPROXY_UI_ADMIN_ROLE` / `RPROXY_UI_USER_ROLE` / `RPROXY_UI_USER_PORTS` / `RPROXY_UI_USER_NODES`。`nodesAllowed`） |
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
   - 複数のノード（#98。`RPROXY_UI_NODES` があるときだけ）：ルールの置き場所 `Place`（`target` とノード）を body / query の `target` で決める（追加は `target` か `default_target`、なければ 400 `target_required`。既存のルールは `target` がなければ DB で探し、同じキーが複数あれば 400 `target_required`。設定にない名前は 400 `unknown_target`）。
     SQL は `target` 列を使い（`keyWhere`）、rproxy への反映は `onNodes`（`applyToNodes`）でグループの全ノードに送る。一部のノードで失敗したら、成功したノードを戻し、ROLLBACK し、失敗したノードの応答のステータスで `{error: "ノード X: ...", code, nodes}` を返す。成功の応答にも `nodes`。
     同じキーをノードが重なるノード／グループに置くのは 409 `target_conflict`（`checkOverlap`。一意キーは target ごとなので UI が確かめる）。最初のリクエストで `forward_rule_targets` を設定に合わせる（`syncMembership`）。
     `RPROXY_UI_NODES` がなければ SQL も応答も今までと同じ（`target` 列を読み書きしない。migration 006 なしで動く）。既存の単体テストがそのまま通ることで確かめている。
5. `list` は DB のルールに rproxy の `GET /rules` の稼働状態をつけて返す（`state` は `running` / `failed` / `missing`（rproxy にない）/ `unknown`（rproxy に問い合わせできない）/ `paused`（UI で一時停止中））。
   稼働情報は `connections`、`stats`（rproxy の `{total_connections, rx_bytes, tx_bytes, tls_failures, denied, dropped, http}` をそのまま。`dropped`（UDP で rproxy が捨てたデータグラム）は v0.3.9 より前の rproxy にはない（そのときは画面に出さない）。`denied` は古い rproxy に、`http`（L7 のリクエスト数：`requests`・`by_status`・`routes`・`limited`・`blocked`）は v0.3.1 より前の rproxy と http のないルールにはない）、`startedAt`（rproxy の `started_at`、Unix 秒）、`resolved`。`missing` / `unknown` のときは null / 空配列。
   各行には `origin`（DB の行は常に `dynamic`）と `allowFrom` が付く。`list` は自分の DB のルールだけ（`rproxy-admin` はすべての利用者のルールで、`owner` が付く）。
   - `dashboard` は `{reachable, rproxyError, rules}`。`rules` は `list` の後ろに、rproxy の固定ルール（`origin: "static"`）を読み取り専用の行として足したもの（`mergeStaticRules`。id は負の数で、画面の key にだけ使う）。
     固定ルールはシステムのルールなので、ログインしていればだれにでも見せる（ほかの利用者の `dynamic` なルールは見せない）。rproxy に接続できなければ固定ルールは出ない。ルールが 0 件でも rproxy に接続できるかがわかる。
   - `rule?protocol=&addr=&port=` は自分のルール 1 件か、DB になければ rproxy の固定ルール（キーが不正なら 400、ほかの利用者のルールや存在しないルールは 404、DB になく rproxy に問い合わせできなければ 502）。稼働状態は rproxy の `GET /rules/{protocol}/{addr}/{port}` から取る。

   - 複数のノード：全ノードに `GET /rules` を聞き、各ルールに `target` とノードごとの状態 `nodes`（`NodeLiveState[]`）を付け、上の `state` などはその集計（`aggregateNodeStates`：state は悪いほう、接続数・stats は合計）。`dashboard` には `nodes`（`NodeSummary`：つながるか・ルール数・失敗数）、`reachable` はどれか 1 台に聞けたか、`rproxyError` は聞けなかったノード。固定ルールはノードごと（`target` がそのノード）。
     画面は `useNodes()`（`GET /api/forward/nodes`）でノードが 2 つ以上のときだけ、フォームの「ノード／グループ」・一覧と詳細のノード／グループ・ダッシュボードのノードの一覧を出す（1 つなら今と同じ見た目）。詳細・変更の URL は `?target=` を付ける（`ruleHref`）。
     各ノードの状態には `drift`（UI の定義との違いのコード）と、active_standby のグループでは `role`（act / stb）、ルールには `ha`（判定に使った VIP・act のノード・警告）を付ける（act の判定のため、active_standby のグループがあるときだけ `GET /interfaces` も聞く）。`dashboard` の `nodes` に `drifted`、`groups` に vip を書いたグループの act。
     画面はノードが 2 つ以上なら「全体 / ノードごと」のタブ（`projectRule` / `projectToNode` でそのノードの値に置き換えて同じ部品で出す）。「全体」はノードごとの比較の表。ルールの詳細のノードのタブに「UI の定義との違い」と「このノードに送り直す」。
   - `resend`（POST `{protocol, srcAddr, srcPort, target, node}`）：DB の内容を 1 つのノードにだけ送る（未登録なら POST、PATCH で直せる違いは PATCH、直せない違いは削除して作り直し、停止中なのに動いていれば削除、同じなら何もしない）。自分のルール（admin はだれのでも）だけ。履歴は `RESEND` で `node` 列（migration 007）にノード。DB の内容に揃えるだけなので COMMIT の失敗では戻さない。
   - 設定ファイルの注意（`config`）は全ノードに聞いてまとめる（`mergeConfigStatusViews`）。
   - ノードごとの上書き（migration 008、`forward_rule_overrides`）：ノードへの送信・状態の取得・ずれ・送り直しは、すべてそのノードの `effectiveRule`（キーも上書きの待ち受けアドレス）で行う（`onNodes` の step がノードを受け取り、`lockedExtras` で上書きを読む）。1 台のとき・上書きがないときは今までと同じ。
     `override`（POST `{protocol, srcAddr, srcPort, target, node, override | null}`）はグループのルールだけ。そのノードにだけ反映（待ち受けアドレスが変われば作り直し）し、履歴は `OVERRIDE`（`node` に ノード。巻き戻し不可。差分の計算では前の版から外す）。ノードごとのビューは同じ差分を `JSON_MERGE_PATCH` で重ねる（`db/node-view.mjs`）。
     エクスポートは `overrides`（UI のエクスポートだけ）を書き、インポートはグループに読み込むときだけ受け付ける。置き換えで上書きが変わるときは作り直す。
   - `pause-node`（POST `{node, action}`）：そのノードのルールをまとめて止める・再開する（そのノードに置いたルールはルールの停止、グループのルールは上書きの `enabled: false`）。1 件ずつ別のトランザクション。
   - `copy`（POST `{protocol, srcAddr, srcPort, target, to, move?}`）：ほかのノード／グループへコピー・移動（重なる先へのコピーは 409 `target_conflict`、重なる先への移動は元を消してから作り、だめなら戻す）。上書きは先にもあるノードの分だけ。ノードに置くときはそのノードの上書きを重ねた内容。
   - `RPROXY_UI_USER_NODES`：`rproxy-user` が触れるノード（`checkNodes`。外は 403 `node_not_allowed`。`nodes` の応答の `allowedTargets` で画面の選択肢も絞る）。admin とノードを設定していないときは関係ない。
   - act / stb（#109）：`ha`（GET。admin だけ。グループの act とノードごとの揃い具合）、`ha-sync`（POST `{node}`。admin だけ）。`dashboard` に `haSync`（自動の送り直しの間隔・最後の見回り・続けて失敗しているもの）。グループの `auto_resend: false` なら自動では送り直さない（notify・ha-sync は送る）。
   - `dashboard` の `nodes[].lastSync`：そのノードを含むノード／グループの履歴の最後（送り直し・上書きはそのノードの分だけ）。

HTTP の取り決めは `../rproxy-api/docs/API.md` が正。変更するときは両方のリポジトリを揃えること。
rproxy は起動時に `forward_rules` を読んでルールを復元する（読む列は `db/README.md` を参照）。複数のノードでは、各 rproxy はノードごとのデータベースの `forward_rules` ビュー（`db/node-view.mjs`。`forward_rule_targets` で自分とグループの行に絞る）を読む。rproxy-api は変えない。

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
- Tailwind CSS 4 は CSS で設定する（`styles/globals.css`。`tailwind.config.ts` はない）。クラスを探すのは `pages/` と `components/` だけ（`@source`）。色は v3 の値（`styles/tailwind-v3-colors.css`）、文字の並び・枠線の既定の色・プレースホルダの色・ボタンのカーソル・`hover:`（タッチ端末でも効く）・dialog の margin・表のセルの padding は v3 と同じになるように `globals.css` で上書きしている。v4 の名前を使う（角の丸めは `rounded-sm`（v3 の `rounded`）/ `rounded-xs`（v3 の `rounded-sm`）、`outline-hidden`（v3 の `outline-none`）、`shadow-xs`（v3 の `shadow-sm`）、`wrap-break-word`）。
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
