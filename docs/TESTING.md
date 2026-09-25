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
| modify replaces the TLS settings with PATCH and stores options | PATCH に `tls` / `starttls` / `allow_from` を付け、`options` を更新する |
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
| rule returns 404 for a rule of another user (a dynamic rule in rproxy is not shown) | ほかの利用者のルールは 404（DB になければ rproxy に問い合わせるが、`origin` が `static` でなければ見せない。`origin` のない古い rproxy も同じ） |
| rule reports missing and unknown like list | rproxy の `not_found` は `missing`、接続できなければ `unknown` |
| rule rejects an invalid key（5 パターン） / rule returns 401 without a session | キーが不正なら 400、未ログインは 401。どちらも DB に触れない |

## 単体テスト：allow_from・unmatched・固定ルール（`tests/forward.test.ts` の後半）

| テスト | 確かめること |
|---|---|
| add normalizes allow_from, stores it in options and sends it to rproxy | `10.0.0.5` → `10.0.0.5/32` などに正規化し、TLS が既定でも `options` に `{tls, starttls, starttls_required, allow_from}` を保存して POST に付ける |
| add leaves allow_from out of the POST and options when empty | 空なら POST に付けず、`options` は NULL のまま |
| rejects invalid allow_from / unmatched（6 パターン） | 配列でない、ホスト名、長すぎるプレフィックス（IPv4 / IPv6）、65 件、未知の `unmatched`（`invalid`）。DB に触れない |
| rejects unmatched: reject for …（3 パターン） | routes のない sni、passthrough、UDP の terminate では `tls_config` |
| passes unmatched: reject through and drops the default | `reject` は rproxy と `options` にそのまま、`default` は省く |
| modify replaces allow_from when given and keeps the stored value when omitted | 指定があれば置き換え、なければ DB の値を保つ。`[]` で解除（PATCH にも `[]`、`options` は NULL） |
| modify restores the previous allow_from and tls (with unmatched) when COMMIT fails | undo は元の `allow_from` と `tls`（`unmatched` を含む）で PATCH する |
| delete re-adds the rule with its allow_from when COMMIT fails | 削除の undo は `allow_from` ごと作り直す |
| list returns allowFrom, origin dynamic and stats.denied for DB rules, but no static rules | `list` は自分の DB のルールだけ。`origin: dynamic`、`allowFrom`、`stats.denied` |
| dashboard merges static rules from rproxy as read-only rows after the own rules | 自分のルールの後ろに固定ルール（id は負の数）を足す。ほかの利用者の dynamic なルールは足さない。`tls` は既定値を省いた形 |
| dashboard has no static rows when rproxy is unreachable | 接続できなければ固定ルールは出ない |
| rule returns a static rule that is not in the DB | DB になければ rproxy の固定ルールを返す |
| rule reports an unreachable rproxy instead of 404 for a rule that is not in the DB | DB になく rproxy に接続できなければ 502 `unreachable` |
| rule returns an own DB rule with origin dynamic | DB の行は DB の設定を返す |
| modify / delete refuses a static rule with 409 static without touching rproxy | 固定ルールの変更・削除は 409 `static`（PATCH / DELETE は呼ばず ROLLBACK） |
| modify / delete still returns 404 for a rule that is neither own nor static | dynamic なほかの利用者のルールや、rproxy に問い合わせできないときは 404 |
| passes a 409 static from rproxy through and rolls back | rproxy の 409 `static` はそのまま返す |

## 単体テスト：CIDR・options・unmatched（`tests/cidr.test.ts`）

| テスト | 確かめること |
|---|---|
| parseCidr: normalizes …（18 パターン） | rproxy の `src/cidr.rs` と同じ正規化（単一 IP は /32・/128、ホスト部を落とす、IPv6 の圧縮表記、IPv4-mapped は IPv4、`[ ]` を無視、埋め込み IPv4） |
| parseCidr: rejects …（19 パターン） | 空、ホスト名、/33・/129、数字でないプレフィックス、255 を超えるオクテット、先頭の 0、グループ数の誤り、`::` が 2 つ、ゾーン ID、IPv4-mapped に /104 |
| explains a too long prefix separately / formats IPv6 like RFC 5952 | エラーメッセージ、`::` にする 0 の並びの選び方 |
| allow_from lists | 1 行に 1 件（空行は無視）、64 件まで、最初の誤りを返す、`normalizeAllowFrom` は `invalid` |
| options JSON with allow_from | 空なら省いて既定なら NULL、あれば 4 つのキー。文字列・オブジェクトから読み戻し、未知のキーは拒否 |
| tls.unmatched | `reject` を残して `default` を省く。tcp の sni / terminate で routes があるときだけ許す。rproxy の応答（既定値の項目を含む）も読める |

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
| puts a labelled allow_from textarea with its help text in the advanced tab | 「詳細」タブに `<label for>` つきの textarea と説明文（空欄ならすべて許可…） |
| fills the textarea with one CIDR per line when editing | 編集では 1 行に 1 件で入る |
| offers the unmatched choice in the TLS tab for tcp sni / terminate with routes | 「どのサーバ名にも一致しない接続」（基本の転送先へ送る / 切断する）と、選んでいる値 |
| hides the unmatched choice without routes, for passthrough and for UDP | routes がない・passthrough・UDP では出さない |

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
| badges | 状態のバッジは文字でも表し、文字色を指定する。DTLS と STARTTLS の表示。「固定」と「IP 制限」（allow_from が空なら出さない） |
| summarize: adds up denied connections … and counts static rules | `stats.denied` の合計（古い rproxy の欠けは 0）と固定ルールの件数 |
| static rules | `ruleFromStatus`（rproxy の応答から行を作る。範囲・古い rproxy）、`mergeStaticRules`（自分のルールの後ろに負の id で足す。dynamic・`origin` なし・同じキーは足さない。集計にも入る） |

## E2E（`tests/e2e.test.ts`）

| テスト | 確かめること |
|---|---|
| adds a rule that forwards traffic | 追加したルールで実際に転送できる |
| rejects a duplicate and an unresolvable target without leaving rows | 重複は 409、名前解決できない転送先は 502 で、DB に行が残らない。一覧に rproxy の `stats`（累計の接続 1 以上、rx 2 バイト以上）、`startedAt`、`resolved` が付く |
| returns one rule and the dashboard with live state | `rule` で 1 件取得（なければ 404）、`dashboard` の `reachable` が true |
| modifies and deletes the rule | 変更後も転送でき、削除すると接続できなくなる |
| records who changed what in forward_rules_log | 履歴に `auth_id` と ADD / UPDATE / DELETE が残る |
| forwards a two-port range one to one | 2 ポートの TCP 範囲ルールが、連続する 2 つのエコーサーバ（`E2E_BACKEND_PORT` + 1、+ 2）へ 1 対 1 で転送する。`src_port_end` が保存され `options` は NULL |
| round-trips allow_from through the DB and rproxy and drops connections outside it | `allowFrom` が正規化されて DB の `options` と rproxy（`GET /rules/{key}` の `allow_from`、`origin: dynamic`）に入り、範囲外にすると接続が切られて `stats.denied` が増える。省いた変更では保ち、`[]` で解除（`options` は NULL） |
| rejects a terminate rule whose certificate cannot be read without leaving rows | 存在しない証明書の terminate は 400 `tls_config` で、DB に行が残らない |
| deletes the range rule | 範囲ルールを削除すると接続できなくなる |

## まだテストしていないこと

- 画面の操作（ブラウザでの E2E）。見た目の確認はスクリーンショットで手動で行った（1280px と 768px。フォームは HTML の描画結果だけを見ている）。
  ダッシュボード・詳細・変更画面のページ自体（データの取得と自動更新）は単体テストがない（集計と整形は `components/dashboard.ts` で確かめている）
- 中間 CA を使う TLS の終端は E2E にない。3 階層（ルート → 中間 2 つ → サーバ証明書）の証明書で、UI から追加したルールが中間 CA を送り、ルートだけを信頼するクライアントで検証が通ることを手動で確認した
- 証明書を使う TLS の終端・STARTTLS・DTLS の実際の通信（E2E には証明書がない。rproxy 側のテストで確認している）。
  UI が書いた `options` を rproxy が再起動時に読めることは手動で確認した
- Keycloak との実際のログイン（手動では確認済み）
- 固定ルール（`--static-rules`）は E2E にない（CI の rproxy は固定ルールなしで起動する。固定ルールがあると E2E の `dashboard` の件数の確認が合わなくなる）。
  `unmatched: reject` の実際の切断も E2E にない（証明書と SNI を使う接続が要る。rproxy 側のテストで確認する）

## 単体テスト：待ち受けアドレスとエラーの説明（`tests/listen.test.ts`）

| テスト | 確かめること |
|---|---|
| listenOptions | 全インターフェース（0.0.0.0 / ::）を先頭に、各インターフェース、最後にループバック。リンクローカルは出さない |
| reservedClash（8 パターン） | 制御 API と同じアドレス・ワイルドカード・ポート範囲で重なりを検出し、別のアドレス・別のポート・UDP では検出しない |
| explainError | `resolve_failed` などのコードに説明を付け、詳細も残す。未知のコードはそのまま表示する |
| explains that static rules cannot be changed or deleted from the UI (409 static) | `static` に「固定ルールは rproxy の設定ファイルで管理されているため…」を付ける（詳細が同じなら繰り返さない） |

