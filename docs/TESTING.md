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

## E2E（`tests/e2e.test.ts`）

| テスト | 確かめること |
|---|---|
| adds a rule that forwards traffic | 追加したルールで実際に転送できる |
| rejects a duplicate and an unresolvable target without leaving rows | 重複は 409、名前解決できない転送先は 502 で、DB に行が残らない |
| modifies and deletes the rule | 変更後も転送でき、削除すると接続できなくなる |
| records who changed what in forward_rules_log | 履歴に `auth_id` と ADD / UPDATE / DELETE が残る |

## まだテストしていないこと

- 画面の操作（ブラウザでの E2E）。見た目の確認はスクリーンショットで手動で行った
- Keycloak との実際のログイン（手動では確認済み）
