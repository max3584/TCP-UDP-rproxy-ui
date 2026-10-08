# Kubernetes で動かす

English: [en/KUBERNETES.md](en/KUBERNETES.md)

UI（rproxy-ui）を Kubernetes に入れる手順。コンテナイメージ `ghcr.io/max3584/rproxy-ui` と Helm chart `oci://ghcr.io/max3584/charts/rproxy-ui`（リポジトリの `charts/rproxy-ui`）を使う。
.deb（[README](../README.md) の「インストール」）の動きは変わらない。

- chart は [rproxy-gateway](https://github.com/max3584/rproxy-gateway) の chart とは別（subchart にしない）。版も別に進む。UI は VM の rproxy-api だけを相手にしても使える。
- Gateway API の rproxy（rproxy-gateway が動かす Pod）は、読むだけで画面に出せる（下の「Gateway の rproxy を見る」）。
- DB は外の MariaDB が既定。試すとき・小さな環境では、chart に MariaDB（公式の `mariadb` イメージ、1 台、PVC）を入れられる。

## 中身

| もの | 内容 |
|---|---|
| イメージ | `node:24-alpine` に `next build` の standalone（.deb と同じもの）と `db/`。uid 65532 で `node server.js`（ポート 3000）。ルートは読むだけでよい（書くのは `/tmp` と `/app/.next/cache` だけ。chart は emptyDir を付ける）。amd64・arm64 |
| Deployment | UI（既定 2 台、PDB `maxUnavailable: 1`、ノードに散らす）。利用量の集計と act / stb の自動の送り直しは DB のロックで 1 台だけが行い、セッションは JWT なので、何台でもよい（Ingress のセッションの固定も要らない） |
| `GET /api/healthz` | サインインなしで `{"ok":true}` だけを返す（版も出さない）。DB・rproxy に聞かない（DB が止まっても全台が同時にサービスから外れない）。startup・readiness・liveness のプローブ |
| migration の Job | Helm のフック（`post-install`・`pre-upgrade`）で `node db/migrate.mjs` を DB の管理者の資格で動かす。UI の Pod には DML の資格だけ |
| MariaDB（任意） | StatefulSet 1 台と PVC。冗長化しない |
| バックアップ（任意） | `mariadb-dump` を PVC に取る CronJob |
| Ingress・HTTPRoute・NetworkPolicy（任意） | 下 |

chart は秘密を作らない（`existingSecret` で名前を渡す。`helm template` の結果に秘密が入らないので GitOps で扱える）。要る値がなければ `helm install` が断る。

## 秘密を作る

```shell
kubectl create namespace rproxy-ui
# UI（必須）：NextAuth の秘密、Keycloak のクライアントの秘密、UI の DB ユーザーのパスワード
kubectl -n rproxy-ui create secret generic rproxy-ui \
  --from-literal=NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=KEYCLOAK_CLIENT_SECRET='<Keycloak のクライアントの秘密>' \
  --from-literal=DB_PASSWORD="$(openssl rand -hex 24)"
# 外の DB：migration に使う管理者（DDL を流せるユーザー）
kubectl -n rproxy-ui create secret generic rproxy-ui-db-admin \
  --from-literal=DB_ADMIN_USER=rproxy_admin --from-literal=DB_ADMIN_PASSWORD='<パスワード>'
# 同梱の MariaDB：root のパスワード
kubectl -n rproxy-ui create secret generic rproxy-ui-mariadb \
  --from-literal=MARIADB_ROOT_PASSWORD="$(openssl rand -hex 24)"
# バックアップ：読むだけのユーザー（同梱の MariaDB なら migration の Job が作る）
kubectl -n rproxy-ui create secret generic rproxy-ui-backup \
  --from-literal=DB_BACKUP_USER=rproxy_backup --from-literal=DB_BACKUP_PASSWORD="$(openssl rand -hex 24)"
```

`NEXTAUTH_SECRET` は全台で同じものを使う（セッションの JWT を読むため）。Keycloak のクライアントには `<url>/api/auth/callback/keycloak` をリダイレクト先に登録する（[docs/PRODUCTION.md](PRODUCTION.md) の Keycloak の項）。

## 外の DB で入れる

DB（`rproxy` など）と UI のユーザーは DB の管理者が作っておく（[db/README.md](../db/README.md) の「DB ユーザー」の GRANT）。`migrate.createUser: true` にすると migration の Job が UI のユーザーを作って権限を渡し（`DB_PASSWORD` を使う）、`migrate.createDatabase: true` でデータベースも作る。

```yaml
# values.yaml
url: https://rproxy-ui.example.com
existingSecret: rproxy-ui
keycloak: {issuer: https://sso.example.com/realms/rproxy, clientId: rproxy-ui}
db: {host: mariadb.db.svc, port: 3306, database: rproxy, user: rproxy_ui}
migrate: {existingSecret: rproxy-ui-db-admin}
rproxyApi: {url: https://10.0.0.11:8443, existingSecret: rproxy-ui-api}   # VM の rproxy-api（任意）
```

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <版> -n rproxy-ui -f values.yaml
```

## 同梱の MariaDB で入れる

```yaml
url: https://rproxy-ui.example.com
existingSecret: rproxy-ui
keycloak: {issuer: https://sso.example.com/realms/rproxy}
mariadb:
  enabled: true
  existingSecret: rproxy-ui-mariadb
  persistence: {size: 10Gi, storageClass: ""}
```

- 公式の `mariadb` イメージ（既定 `11.8`）の StatefulSet 1 台と PVC（`data-<リリース>-rproxy-ui-mariadb-0`）。`db.host` を空にすると UI はこれを使う。
- データベースと UI のユーザー（`db.user`、パスワードは `existingSecret` の `DB_PASSWORD`）は migration の Job が root で作る。
- **冗長化しない**（1 台。Pod・ノードが止まると UI も DB を使えない。データは PVC に残る）。止まってはいけない環境では、外の DB（レプリケーションのある MariaDB・Galera）か MariaDB のオペレータを使う。
- Pod を消しても PVC は残り、データは戻る。`helm uninstall` でも StatefulSet の PVC は消えない（消すときは手で消す）。

## migration

`db/migrate.mjs` が `db/migrations/` を番号の順に当て、当てたものを `schema_migrations`（`version`・`applied_at`・`checksum`・`method`）に書く。

- 新しい DB（`forward_rules` がない）：`schema.sql` を流し、すべての migration を当てたことにする（`method = schema`）。
- 2 回目からは、まだのものだけを当てる。当てるものがなければ何もしない。同時に動かしても `GET_LOCK('rproxy-ui-migrate')` で 1 つずつになる。
- 当てた後で中身の変わった migration は警告だけ出す。`003`（Auth0 から Keycloak への一度だけのテンプレート）は流さずに `skipped` で記録する。
- chart では Helm のフックの Job（`post-install`：同梱の MariaDB ができてから、`pre-upgrade`：新しい UI の Pod より前）。DB に接続できるまで `migrate.waitSeconds`（既定 300 秒）待つ。成功した Job は消える（失敗したものは `kubectl -n rproxy-ui logs job/<リリース>-rproxy-ui-migrate` で見られる）。

### .deb の DB を移す・.deb で使う

`schema_migrations` のない DB（.deb で migration を手で当ててきた DB）は、どこまで当てたか分からないので、`--baseline <番号>` がないと断る。最後に当てた番号を指定すると、そこまでを当てたことにして（`baseline`）、その後を当てる。

```yaml
migrate: {existingSecret: rproxy-ui-db-admin, baseline: "012"}
```

.deb にも入っている（`/usr/share/rproxy-ui/db/migrate.mjs`。ドライバは `/usr/lib/rproxy-ui/node_modules` から読む）。.deb の環境は今までどおり手で当ててよく、`migrate.mjs` を使うなら：

```shell
sudo -u rproxy-ui sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=<管理者> DB_ADMIN_PASSWORD=<パスワード> node /usr/share/rproxy-ui/db/migrate.mjs --baseline 012'
node /usr/share/rproxy-ui/db/migrate.mjs --status    # 当てたものと残り（DB_* は同じ）
node /usr/share/rproxy-ui/db/migrate.mjs --dry-run   # 何をするかを出すだけ
```

`--baseline` は最初の 1 回だけ要る（2 回目からは `schema_migrations` を見る）。オプションと環境変数は [db/README.md](../db/README.md) の「migrate.mjs」。

## rproxy-api（VM）につなぐ

- 1 台：`rproxyApi.url` と `rproxyApi.existingSecret`（キー `RPROXY_API_TOKEN`。`rproxyApi.tokenKey` で変える）。
- 複数：`nodes` に `RPROXY_UI_NODES` の中身（[README](../README.md) の「複数の rproxy」）を書き、`token_file` は `/etc/rproxy-ui/tokens/<キー>`、トークンの Secret を `nodeTokensSecret` に渡す。

## Gateway の rproxy を見る

rproxy-gateway が動かす rproxy の Pod を、**読むだけ**で画面に出す（rproxy-gateway の docs/DESIGN-v0.4.x.md の C）。両側の明示が要る。

1. rproxy-gateway の chart で `ui.namespace: rproxy-ui`（この UI の namespace）にする（Pod を選ぶ `ui.podSelector` の既定 `app.kubernetes.io/name: rproxy-ui` はこの chart の Pod に合う）。
2. Gateway の parameters（`RproxyGatewayParameters`）の `ui.visible` が `false` でない Gateway だけが載る（既定 `true`。クラスで `false` にした Gateway は Gateway の側で `true` にできない）。
3. この chart で `rproxy.discovery.enabled: true`。

コントローラは UI の namespace に Secret `rproxy-ui-discovery`（`rproxy.discovery.secretName`）を書く：Gateway ごとのグループ `k8s:<namespace>/<Gateway>` とその rproxy の Pod（`https://<Pod の IP>:9443`）、CA の証明書（鍵は入らない）、Gateway ごとの読むだけのトークン（スコープ `rules:read`・`metrics:read`）。UI はこれを `/etc/rproxy-ui/k8s`（`RPROXY_UI_K8S_DISCOVERY`）に読み、ファイルが変われば読み直す。

- **管理者だけ**に見せる（Kubernetes のルールには UI の持ち主がいない）。ルール（宛先・ラベル・状態）と利用量が出る。
- **書けない**：画面は変更のボタンを出さず、API は `409 readonly_node` で断る。トークンも読むだけなので、rproxy も `403` で断る。Kubernetes のルールの正は Gateway API の資源（etcd）で、UI の DB には持たない。
- Gateway の NetworkPolicy は、UI の namespace の UI の Pod から 9443 だけを開ける（コントローラが足す）。
- Pod が入れ替わると、kubelet が Secret のボリュームを更新するまで（1〜2 分）古い IP に聞いて失敗することがある（次の読み直しで直る）。
- Secret が無い間（まだ Gateway がない）も UI は動く（ボリュームは `optional`）。
- この namespace の Secret を読める人は、UI に見せたすべての Gateway のルールと統計を読める（書けない、鍵はない）。rproxy-gateway の docs/SECURITY.md。

## 利用量

`usage.intervalSeconds`（`RPROXY_UI_USAGE_SECS`、chart の既定 60 秒）ごとに 1 台の UI が集める（DB のロック）。

- Gateway の rproxy は Pod ごとに差を取り、Gateway ごと（`k8s:<namespace>/<Gateway>`）の行に足す。Pod が入れ替わっても新しい Pod の数を 0 から足すので、Gateway の行は減らない。
- **終わる Pod の、最後に集めてからの分（最大 1 間隔）は取れない**。rproxy は終わるとき（`delay`・`drain` の間）も読む API に答えるので、間隔を短くすれば小さくなる。

## 公開する

- Ingress：`ingress.enabled`・`className`・`hosts`・`tls`。
- Gateway API：`httpRoute.enabled`・`parentRefs`・`hostnames`（rproxy-gateway の Gateway も使える）。
- `url`（`NEXTAUTH_URL`）は利用者がブラウザで開く URL にする。

## NetworkPolicy

`networkPolicy.enabled: true` で：

- UI の Pod は 3000 番だけを受ける。`networkPolicy.ingressFrom`（NetworkPolicyPeer の並び。Ingress のコントローラ・Gateway の rproxy の namespace など）があればそこからだけ。
- 同梱の MariaDB は、このリリースの UI・migration・バックアップの Pod からの 3306 番だけを受ける。

出ていく通信（DB・Keycloak・rproxy）は絞らない。

## バックアップと戻し方

```yaml
backup:
  enabled: true
  schedule: "15 3 * * *"
  keep: 14              # 日
  existingSecret: rproxy-ui-backup
  persistence: {size: 20Gi}
```

CronJob が `mariadb-dump --single-transaction --routines --databases <db>` を gzip で PVC（`<リリース>-rproxy-ui-backup`。`helm uninstall` でも残す）に `rproxy-ui-<UTC の時刻>.sql.gz` で取り、`keep` 日より古いものを消す。資格は読むだけのユーザー（`SELECT, LOCK TABLES, SHOW VIEW`。同梱の MariaDB なら migration の Job が作る。外の DB では作っておく）。同梱の MariaDB の PVC は CSI の VolumeSnapshot も使える。取り方の考え方は rproxy-api の [docs/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/BACKUP.md)。

戻し方：

```shell
# 1. UI を止める（集計と書き込みを止める）
kubectl -n rproxy-ui scale deploy/rproxy-ui --replicas=0
# 2. バックアップの PVC を付けた Pod で戻す（同梱の MariaDB の例。外の DB では管理者で）
kubectl -n rproxy-ui run restore --rm -it --restart=Never --image=mariadb:11.8 \
  --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"rproxy-ui-backup"}}],
    "containers":[{"name":"restore","image":"mariadb:11.8","stdin":true,"tty":true,"command":["sh"],
    "volumeMounts":[{"name":"b","mountPath":"/backup"}]}]}}'
#   （Pod の中で）gunzip -c /backup/rproxy-ui-<時刻>.sql.gz | mariadb -h rproxy-ui-mariadb -u root -p
# 3. migration を当て直し（ダンプの後に足された migration）、UI を戻す
helm upgrade rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <版> -n rproxy-ui -f values.yaml
kubectl -n rproxy-ui scale deploy/rproxy-ui --replicas=2
```

（リリース名が `rproxy-ui` のとき、名前は `rproxy-ui`・`rproxy-ui-mariadb`・`rproxy-ui-backup`。ほかの名前では `<リリース>-rproxy-ui-…`。）

## おもな値

| 値 | 既定 | 内容 |
|---|---|---|
| `image.repository`・`tag`・`digest` | `ghcr.io/max3584/rproxy-ui`・chart の appVersion | |
| `replicas` | `2` | |
| `url` | （必須） | `NEXTAUTH_URL` |
| `existingSecret` | （必須） | `NEXTAUTH_SECRET`・`KEYCLOAK_CLIENT_SECRET`・`DB_PASSWORD` |
| `keycloak.issuer`・`clientId` | （必須）・`rproxy-ui` | |
| `roles.*` | 空 | `RPROXY_UI_ROLES_CLAIM`・`_ADMIN_ROLE`・`_USER_ROLE`・`_USER_PORTS`・`_USER_NODES` |
| `db.host`・`port`・`database`・`user` | 空・3306・`rproxy`・`rproxy_ui` | |
| `migrate.enabled`・`existingSecret`・`baseline`・`createDatabase`・`createUser` | `true`・空・空・`false`・`false` | |
| `mariadb.enabled`・`existingSecret`・`image`・`persistence` | `false`・空・`mariadb:11.8`・10Gi | |
| `rproxyApi.url`・`existingSecret`・`tokenKey` | 空 | VM の rproxy-api 1 台 |
| `nodes`・`nodeTokensSecret` | 空 | `RPROXY_UI_NODES` の中身とトークン |
| `rproxy.discovery.enabled`・`secretName` | `false`・`rproxy-ui-discovery` | Gateway の rproxy（読むだけ） |
| `usage.intervalSeconds` | `60` | `RPROXY_UI_USAGE_SECS` |
| `backup.*` | 無効 | |
| `ingress.*`・`httpRoute.*`・`networkPolicy.*` | 無効 | |
| `extraEnv`・`extraEnvFrom`・`extraVolumes`・`extraVolumeMounts` | 空 | ほかの `RPROXY_UI_*` など |

すべての値はリポジトリの `charts/rproxy-ui/values.yaml`。
