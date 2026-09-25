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

## 単体テスト：入力フォームとプロファイル（`tests/modal.test.ts`）

| テスト | 確かめること |
|---|---|
| splits the form into four accessible tabs with the basic tab selected | `role="tablist"` / `tab` / `tabpanel` と `aria-selected`。tcp + passthrough では STARTTLS のタブが `aria-disabled` |
| titles the TLS tab DTLS for UDP and keeps the range read-only when editing | UDP ではタブ名が DTLS。編集では範囲が読み取り専用で、プロファイルは出ない |
| <プロファイル名> is a valid rule | すべてのプロファイルが範囲の上限と TLS の組み合わせの規則を満たす |
| follows the PROFILES.md warnings | WebRTC のメディアは passthrough、SMTP は passthrough + proxy_v2 など |

## E2E（`tests/e2e.test.ts`）

| テスト | 確かめること |
|---|---|
| adds a rule that forwards traffic | 追加したルールで実際に転送できる |
| rejects a duplicate and an unresolvable target without leaving rows | 重複は 409、名前解決できない転送先は 502 で、DB に行が残らない |
| modifies and deletes the rule | 変更後も転送でき、削除すると接続できなくなる |
| records who changed what in forward_rules_log | 履歴に `auth_id` と ADD / UPDATE / DELETE が残る |
| forwards a two-port range one to one | 2 ポートの TCP 範囲ルールが、連続する 2 つのエコーサーバ（`E2E_BACKEND_PORT` + 1、+ 2）へ 1 対 1 で転送する。`src_port_end` が保存され `options` は NULL |
| rejects a terminate rule whose certificate cannot be read without leaving rows | 存在しない証明書の terminate は 400 `tls_config` で、DB に行が残らない |
| deletes the range rule | 範囲ルールを削除すると接続できなくなる |

## まだテストしていないこと

- 画面の操作（ブラウザでの E2E）。見た目の確認はスクリーンショットで手動で行った（フォームは HTML の描画結果だけを見ている）
- 証明書を使う TLS の終端・STARTTLS・DTLS の実際の通信（E2E には証明書がない。rproxy 側のテストで確認している）。
  UI が書いた `options` を rproxy が再起動時に読めることは手動で確認した
- Keycloak との実際のログイン（手動では確認済み）
