# テスト一覧（TCP-UDP-rproxy-ui）

| 実行方法 | 対象 | CI のジョブ |
|---|---|---|
| `npx tsc --noEmit` / `npm run lint` / `npm run build` | 型、lint、ビルド | `check` |
| `npm test` | 単体テスト（DB・rproxy・NextAuth はモック） | `check` |
| `RUN_E2E=1 npx vitest run tests/e2e.test.ts` | 本物の MariaDB と rproxy-api につないだ E2E。変数がなければスキップ | `e2e`（rproxy-api の同じ名前のブランチ、なければ master をビルドして使う） |

## 単体テスト：rproxy クライアント（`tests/rproxy.test.ts`）

| テスト | 確かめること |
|---|---|
| returns parsed rules on success | 一覧の応答を型どおりに読む |
| posts a rule as JSON | 追加は `POST /rules` に JSON で送る |
| maps the error body to RproxyError | `{error, code}` を `RproxyError` にする |
| uses code internal for a non-JSON error body | JSON でないエラー応答は `internal` |
| reports network failures as unreachable | 接続できないときは `unreachable`（status 0） |
| sends the bearer token when RPROXY_API_TOKEN is set / omits the Authorization header when RPROXY_API_TOKEN is unset | トークンの有無で `Authorization` ヘッダを付け外しする |
| URL-encodes an IPv6 listen address | パスの IPv6 アドレスをエンコードする |
| deletes a rule and accepts 204 | 削除の 204 を成功として扱う |
| posts a range rule with TLS and STARTTLS as JSON | 範囲・TLS・STARTTLS をそのまま送り、`tls_config` を `RproxyError` にする |

## 単体テスト：API route（`tests/forward.test.ts`）

| テスト | 確かめること |
|---|---|
| returns 401 without a session | 未ログインは 401 で、DB に触れない |
| add commits when rproxy succeeds | DB への書き込み → rproxy → COMMIT。履歴に `auth_id` を記録する |
| add rolls back and returns the rproxy error code | rproxy が失敗したら ROLLBACK し、rproxy のエラーコードを返す |
| add returns 502 when rproxy is unreachable | rproxy に接続できないときは 502 |
| add returns 409 on a duplicate key without calling rproxy | DB の重複キーは 409 で、rproxy は呼ばない |
| normalizes the protocol to lowercase | プロトコル名を小文字にそろえる |
| rejects invalid input（9 パターン） | ポート 0 / 65536 / 文字列 / 小数、未知のプロトコル、待ち受けのホスト名、UDP で `proxy_v2`、範囲外の `udp_idle_secs` |
| accepts ports 1 and 65535 | 境界値のポートを受け付ける |
| modify sends PATCH with udp_idle_secs and keeps source_ip from the DB | 変更は PATCH。`source_ip` は DB の値を保つ |
| modify returns 404 when the rule is not owned by the user | 他人のルールは 404 |
| modify re-creates a rule that rproxy does not have | rproxy にないルール（`missing`）は作り直す |
| delete treats rproxy not_found as success | rproxy に既にないなら削除成功とする |
| delete rolls back on other rproxy errors | それ以外のエラーでは ROLLBACK する |
| add undoes the rproxy change when COMMIT fails / modify restores the previous target when COMMIT fails / delete re-adds the rule to rproxy when COMMIT fails | COMMIT が失敗したら、rproxy 側の変更を元に戻す |
| reports but survives a failed undo | 元に戻す処理が失敗しても、接続を解放してエラーを返す |
| list merges live state from rproxy | DB のルールに `running` / `failed` / `missing` を付ける |
| list returns DB rules with state unknown when rproxy is down | rproxy に接続できないときは `unknown` |
| rejects invalid range / TLS input（18 パターン） | 範囲の終わりが開始より前・文字列・転送先ポートが 65535 を超える、未知のモード・キー・STARTTLS、鍵のない証明書（`invalid`）、UDP で sni（`unsupported`）、証明書のない terminate、passthrough に証明書・routes、sni に ALPN、CA のないクライアント認証、鍵のない転送先クライアント証明書、不正なサーバ名、terminate でない STARTTLS、UDP の STARTTLS、UDP の ALPN（`tls_config`）。DB にも rproxy にも触れない |
| add stores the range and options JSON and passes them to rproxy | `src_port_end` と `options`（既定値を省いた `{tls, starttls, starttls_required}`）を保存し、`listen_port_end` / `tls` / `starttls` を rproxy に送る |
| forces starttls_required for imap and pop3 | 必須にしない指定は SMTP だけ |
| treats a range that ends at its start as a single port | 終わり = 開始 は単一ポート（NULL） |
| passes the rproxy tls_config error through as 400 | 証明書が読めないなどの `tls_config` は 400 のまま返し、ROLLBACK する |
| modify replaces the TLS settings with PATCH and stores options | PATCH に `tls` / `starttls` を付け、`options` を更新する |
| modify restores the previous TLS settings when COMMIT fails / modify restores STARTTLS too when COMMIT fails | undo は元の TLS・STARTTLS の設定で PATCH する（`options` がオブジェクトで返る場合も） |
| modify keeps the range from the DB and rejects a changed range | 範囲の変更は 400（`unsupported`） |
| modify checks the new target port against the stored range | DB の範囲で転送先ポートの上限を確かめる |
| modify re-creates a missing range rule with its range and new TLS settings | 作り直すときも範囲と新しい TLS の設定を使う |
| delete re-adds the range rule with its TLS settings when COMMIT fails | 削除の undo は範囲と TLS の設定ごと作り直す。履歴にも残す |
| list returns the range and TLS settings from the DB | 一覧に `srcPortEnd` / `tls` / `starttls` / `starttlsRequired` を含める |
| rejects invalid range / TLS input（中間 CA の 5 パターン） | 証明書のない upstream の `chain_file`、`mode: none` や passthrough の `client_auth.chain_file`（`tls_config`）、証明書の未知のキー、文字列でない `chain_file`（`invalid`） |
| stores certificate, client_auth and upstream chain files in the exact rproxy shape | `options` と rproxy に送る `tls` の `chain_file` が rproxy と同じ形（空欄は省き、キーは `cert_file, chain_file, key_file` の順） |
| reads chain files back from the options column | `options` の `chain_file` を読み戻す |
| list passes stats, started_at and resolved through from rproxy | `stats` / `startedAt` / `resolved` を渡す。`missing` は null / 空 |
| list leaves stats empty when rproxy is unreachable or an old rproxy omits them | `unknown` と、`stats` を返さない古い rproxy では null |
| dashboard reports whether rproxy was reachable | `dashboard` の `reachable` / `rproxyError` |
| rule returns one own rule with its live state (IPv6 address normalized) | 1 件取得。IPv6 を圧縮表記にし、`auth_id` で絞って DB を引く |
| rule returns 404 for a rule of another user without asking rproxy | ほかの利用者のルールは 404 |
| rule reports missing and unknown like list | rproxy の `not_found` は `missing`、接続できなければ `unknown` |
| rule rejects an invalid key（5 パターン） / rule returns 401 without a session | キーが不正なら 400、未ログインは 401。どちらも DB に触れない |

## 単体テスト：入力フォームとプロファイル（`tests/ruleform.test.ts`）

| テスト | 確かめること |
|---|---|
| splits the form into four accessible tabs with the basic tab selected | `role="tablist"` / `tab` / `tabpanel` と `aria-selected`。tcp + passthrough では STARTTLS のタブが `aria-disabled` |
| titles the TLS tab DTLS for UDP and keeps the range read-only when editing | UDP ではタブ名が DTLS。編集では範囲が読み取り専用で、プロファイルは出ない |
| is a page form with a submit and a cancel button instead of a modal overlay | `<form>` で、オーバーレイはない。追加 / 変更 / 保存中のボタン |
| labels every visible input | id のある入力欄にはすべて `<label for>` がある |
| shows the chain fields of certificates, client auth and upstream as first-class inputs | 証明書ごと（中間 CA のない行にも）・クライアント認証・upstream に中間 CA の欄と説明文がある |
| hides the client auth chain field when client auth is none | クライアント認証が none のときは、その中間 CA の欄を出さない |
| <プロファイル名> is a valid rule | すべてのプロファイルが範囲の上限と TLS の組み合わせの規則を満たす |
| follows the PROFILES.md warnings | WebRTC のメディアは passthrough、SMTP は passthrough + proxy_v2 など |

## 単体テスト：ダッシュボード（`tests/dashboard.test.ts`）

| テスト | 確かめること |
|---|---|
| summarize | プロトコルごとの状態の件数、接続数・累計・rx / tx・TLS 失敗の合計（null は 0 として足す）。0 件 |
| tlsBreakdown | passthrough / sni / TLS 終端（tcp）/ DTLS 終端（udp）、STARTTLS、範囲ルールの件数 |
| needsAttention | failed を先に、次に missing |
| filterRules | プロトコル・状態で絞る。検索はアドレス、ポート（範囲の途中や転送先の範囲も）、SNI のサーバ名とその転送先ポート、`addr:port` |
| formatting | `formatBytes`（1024 単位。1.2 MiB など）、`formatDuration`（上から 2 単位）、稼働時間（負にならない）、件数・ポート範囲・`[IPv6]:port`・TLS の名前 |
| donut | 状態ごとの `conic-gradient` とスクリーンリーダー向けの内訳。0 件は灰色 |
| rule URLs | 詳細・変更画面と 1 件取得の API の URL（IPv6 をエンコード）と、画面の query からキーを読む（不正なら null） |
| toRule | API に送るときに稼働情報を落とす |
| badges | 状態のバッジは文字でも表し、文字色を指定する。DTLS と STARTTLS の表示 |

## E2E（`tests/e2e.test.ts`）

| テスト | 確かめること |
|---|---|
| adds a rule that forwards traffic | 追加したルールで実際に転送できる |
| rejects a duplicate and an unresolvable target without leaving rows | 重複は 409、名前解決できない転送先は 502 で、DB に行が残らない。一覧に rproxy の `stats`（累計の接続 1 以上、rx 2 バイト以上）、`startedAt`、`resolved` が付く |
| returns one rule and the dashboard with live state | `rule` で 1 件取得（なければ 404）、`dashboard` の `reachable` が true |
| modifies and deletes the rule | 変更後も転送でき、削除すると接続できなくなる |
| records who changed what in forward_rules_log | 履歴に `auth_id` と ADD / UPDATE / DELETE が残る |
| forwards a two-port range one to one | 2 ポートの TCP 範囲ルールが、連続する 2 つのエコーサーバ（`E2E_BACKEND_PORT` + 1、+ 2）へ 1 対 1 で転送する。`src_port_end` が保存され `options` は NULL |
| rejects a terminate rule whose certificate cannot be read without leaving rows | 存在しない証明書の terminate は 400 `tls_config` で、DB に行が残らない |
| deletes the range rule | 範囲ルールを削除すると接続できなくなる |

## まだテストしていないこと

- 画面の操作（ブラウザでの E2E）。見た目の確認はスクリーンショットで手動で行った（1280px と 768px。フォームは HTML の描画結果だけを見ている）。
  ダッシュボード・詳細・変更画面のページ自体（データの取得と自動更新）は単体テストがない（集計と整形は `components/dashboard.ts` で確かめている）
- 中間 CA を使う TLS の終端は E2E にない。3 階層（ルート → 中間 2 つ → サーバ証明書）の証明書で、UI から追加したルールが中間 CA を送り、ルートだけを信頼するクライアントで検証が通ることを手動で確認した
- 証明書を使う TLS の終端・STARTTLS・DTLS の実際の通信（E2E には証明書がない。rproxy 側のテストで確認している）。
  UI が書いた `options` を rproxy が再起動時に読めることは手動で確認した
- Keycloak との実際のログイン（手動では確認済み）

## 単体テスト：待ち受けアドレスとエラーの説明（`tests/listen.test.ts`）

| テスト | 確かめること |
|---|---|
| listenOptions | 全インターフェース（0.0.0.0 / ::）を先頭に、各インターフェース、最後にループバック。リンクローカルは出さない |
| reservedClash（8 パターン） | 制御 API と同じアドレス・ワイルドカード・ポート範囲で重なりを検出し、別のアドレス・別のポート・UDP では検出しない |
| explainError | `resolve_failed` などのコードに説明を付け、詳細も残す。未知のコードはそのまま表示する |

