# Running on Kubernetes

日本語: [../KUBERNETES.md](../KUBERNETES.md)

How to install the UI (rproxy-ui) on Kubernetes, with the container image `ghcr.io/max3584/rproxy-ui` and the Helm chart `oci://ghcr.io/max3584/charts/rproxy-ui` (`charts/rproxy-ui` in the repository).
The .deb ("Installation" in the [README](../../README.en.md)) behaves as before.

- The chart is separate from the [rproxy-gateway](https://github.com/max3584/rproxy-gateway) chart (not a subchart) and has its own versions. The UI is also useful with rproxy-api on VMs only.
- rproxy of the Gateway API (the pods rproxy-gateway runs) can be shown read-only ("Seeing Gateways' rproxy" below).
- The database is an external MariaDB by default. For trials and small setups the chart can bundle MariaDB (the official `mariadb` image, one pod, a PVC).

## What it contains

| Item | Content |
|---|---|
| Image | The `next build` standalone output (the same as in the .deb) and `db/` on `node:24-alpine`. `node server.js` as uid 65532 (port 3000). The root file system may be read-only (it only writes to `/tmp` and `/app/.next/cache`; the chart mounts emptyDirs there). amd64, arm64 |
| Deployment | The UI (2 replicas by default, a PDB with `maxUnavailable: 1`, spread over nodes). Usage collection and the active/standby resend run in one pod at a time (a DB lock) and sessions are JWTs, so any number of replicas works (no sticky sessions on the Ingress either) |
| `GET /api/healthz` | Answers just `{"ok":true}` without a sign-in (no version). It does not ask the DB or rproxy (a DB outage does not take every replica out of the Service at once). The startup, readiness and liveness probes |
| Migration Job | A Helm hook (`post-install`, `pre-upgrade`) running `node db/migrate.mjs` with the DB admin's credentials. The UI pods only get DML |
| MariaDB (optional) | A StatefulSet with one pod and a PVC. No HA |
| Backup (optional) | A CronJob writing `mariadb-dump` into a PVC |
| Ingress, HTTPRoute, NetworkPolicy (optional) | Below |

The chart creates no secrets (give their names with `existingSecret`; `helm template` output then holds no secret and suits GitOps). `helm install` refuses when a required value is missing.

## Creating the secrets

```shell
kubectl create namespace rproxy-ui
# the UI (required): NextAuth's secret, the Keycloak client secret, the password of the UI's DB user
kubectl -n rproxy-ui create secret generic rproxy-ui \
  --from-literal=NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=KEYCLOAK_CLIENT_SECRET='<Keycloak client secret>' \
  --from-literal=DB_PASSWORD="$(openssl rand -hex 24)"
# external DB: the admin used for migrations (a user that may run DDL)
kubectl -n rproxy-ui create secret generic rproxy-ui-db-admin \
  --from-literal=DB_ADMIN_USER=rproxy_admin --from-literal=DB_ADMIN_PASSWORD='<password>'
# bundled MariaDB: the root password
kubectl -n rproxy-ui create secret generic rproxy-ui-mariadb \
  --from-literal=MARIADB_ROOT_PASSWORD="$(openssl rand -hex 24)"
# backup: a read-only user (the migration Job creates it with the bundled MariaDB)
kubectl -n rproxy-ui create secret generic rproxy-ui-backup \
  --from-literal=DB_BACKUP_USER=rproxy_backup --from-literal=DB_BACKUP_PASSWORD="$(openssl rand -hex 24)"
```

Every replica uses the same `NEXTAUTH_SECRET` (to read the session JWTs). Register `<url>/api/auth/callback/keycloak` as a redirect URI of the Keycloak client (the Keycloak section of [docs/en/PRODUCTION.md](PRODUCTION.md)).

## Installing with an external DB

The DB admin creates the database (`rproxy` or another) and the UI's user beforehand (the GRANTs in "DB users" of [db/README.en.md](../../db/README.en.md)). With `migrate.createUser: true` the migration Job creates the UI's user and grants it (with `DB_PASSWORD`); `migrate.createDatabase: true` also creates the database.

```yaml
# values.yaml
url: https://rproxy-ui.example.com
existingSecret: rproxy-ui
keycloak: {issuer: https://sso.example.com/realms/rproxy, clientId: rproxy-ui}
db: {host: mariadb.db.svc, port: 3306, database: rproxy, user: rproxy_ui}
migrate: {existingSecret: rproxy-ui-db-admin}
rproxyApi: {url: https://10.0.0.11:8443, existingSecret: rproxy-ui-api}   # rproxy-api on a VM (optional)
```

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <version> -n rproxy-ui -f values.yaml
```

## Installing with the bundled MariaDB

```yaml
url: https://rproxy-ui.example.com
existingSecret: rproxy-ui
keycloak: {issuer: https://sso.example.com/realms/rproxy}
mariadb:
  enabled: true
  existingSecret: rproxy-ui-mariadb
  persistence: {size: 10Gi, storageClass: ""}
```

- A StatefulSet with one pod of the official `mariadb` image (`11.8` by default) and its PVC (`data-<release>-rproxy-ui-mariadb-0`). With `db.host` empty the UI uses it.
- The migration Job creates the database and the UI's user (`db.user`, password `DB_PASSWORD` of `existingSecret`) as root.
- **No HA** (one pod: while the pod or its node is down the UI has no DB; the data stays on the PVC). Where that is not acceptable, use an external DB (replicated MariaDB, Galera) or a MariaDB operator.
- Deleting the pod keeps the PVC and the data comes back. `helm uninstall` does not delete the StatefulSet's PVC either (delete it by hand).

## Migrations

`db/migrate.mjs` applies `db/migrations/` in number order and records what it applied in `schema_migrations` (`version`, `applied_at`, `checksum`, `method`).

- A new database (no `forward_rules`): it runs `schema.sql` and records every migration as applied (`method = schema`).
- Later runs apply only what is missing; with nothing to apply they do nothing. Concurrent runs take turns (`GET_LOCK('rproxy-ui-migrate')`).
- A migration whose content changed after it was applied only gets a warning. `003` (the one-time Auth0 to Keycloak template) is never run; it is recorded as `skipped`.
- In the chart it is a Helm hook Job (`post-install`: once the bundled MariaDB exists; `pre-upgrade`: before the new UI pods). It waits up to `migrate.waitSeconds` (300 s by default) for the DB. A successful Job is deleted (a failed one stays: `kubectl -n rproxy-ui logs job/<release>-rproxy-ui-migrate`).

### Moving a .deb database, and using it with the .deb

A database without `schema_migrations` (one migrated by hand with the .deb) is refused without `--baseline <number>`, since nobody knows how far it was migrated. With the number of the last migration applied, it records everything up to it as applied (`baseline`) and applies the rest.

```yaml
migrate: {existingSecret: rproxy-ui-db-admin, baseline: "012"}
```

The .deb ships it too (`/usr/share/rproxy-ui/db/migrate.mjs`; it loads the driver from `/usr/lib/rproxy-ui/node_modules`). With the .deb you may keep applying migrations by hand; to use `migrate.mjs`:

```shell
sudo -u rproxy-ui sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=<admin> DB_ADMIN_PASSWORD=<password> node /usr/share/rproxy-ui/db/migrate.mjs --baseline 012'
node /usr/share/rproxy-ui/db/migrate.mjs --status    # applied and pending (same DB_*)
node /usr/share/rproxy-ui/db/migrate.mjs --dry-run   # only print what it would do
```

`--baseline` is needed only the first time (later runs read `schema_migrations`). Options and variables: "migrate.mjs" in [db/README.en.md](../../db/README.en.md).

## Connecting to rproxy-api (VMs)

- One: `rproxyApi.url` and `rproxyApi.existingSecret` (key `RPROXY_API_TOKEN`; change it with `rproxyApi.tokenKey`).
- Several: put the content of `RPROXY_UI_NODES` ("Several rproxy" in the [README](../../README.en.md)) in `nodes`, with `token_file` at `/etc/rproxy-ui/tokens/<key>`, and the tokens' Secret in `nodeTokensSecret`.

## Seeing Gateways' rproxy

rproxy pods run by rproxy-gateway are shown **read-only** (C in rproxy-gateway's docs/DESIGN-v0.4.x.md). Both sides have to opt in:

1. In the rproxy-gateway chart, set `ui.namespace: rproxy-ui` (this UI's namespace). The default pod selector `ui.podSelector` (`app.kubernetes.io/name: rproxy-ui`, `app.kubernetes.io/component: ui`) matches this chart's UI pods only (the migration and backup pods cannot reach rproxy).
2. Only Gateways whose parameters (`RproxyGatewayParameters`) do not set `ui.visible: false` are listed (default `true`; a Gateway cannot turn its class's `false` into `true`).
3. In this chart, set `rproxy.discovery.enabled: true`.

The controller writes the Secret `rproxy-ui-discovery` (`rproxy.discovery.secretName`) into the UI's namespace: a group `k8s:<namespace>/<Gateway>` per Gateway with its rproxy pods (`https://<pod IP>:9443`), the CA certificate (no key), and a read-only token per Gateway (scopes `rules:read`, `metrics:read`). The UI reads it at `/etc/rproxy-ui/k8s` (`RPROXY_UI_K8S_DISCOVERY`) and again when the files change.

- **Admins only** (Kubernetes rules have no UI owner). Rules (targets, labels, state) and usage are shown.
- **No writes**: the screens show no buttons that change them and the API refuses with `409 readonly_node`. The token can only read, so rproxy refuses with `403` as well. The source of truth for Kubernetes rules is the Gateway API objects (etcd); the UI's DB does not hold them.
- The Gateway's NetworkPolicy lets the UI pods of the UI namespace reach port 9443 only (the controller adds this).
- After a pod is replaced, the UI may ask the old IP and fail until the kubelet updates the Secret volume (1 to 2 minutes; the next reload fixes it).
- The UI runs while the Secret does not exist yet (no Gateway): the volume is `optional`.
- Whoever can read Secrets in this namespace can read the rules and statistics of every Gateway shown to the UI (not change them; there are no keys). See rproxy-gateway's docs/SECURITY.md.

## Usage

One UI collects every `usage.intervalSeconds` (`RPROXY_UI_USAGE_SECS`; 60 s by default in the chart; a DB lock).

- For Gateways' rproxy the differences are taken per pod and added to a row per Gateway (`k8s:<namespace>/<Gateway>`). A replaced pod's counters start from 0 and are added in full, so a Gateway's rows never go down.
- **A stopping pod's traffic since the last collection (up to one interval) is lost.** rproxy keeps answering read requests while it stops (its `delay` and `drain`), so a shorter interval makes the loss smaller.

## Exposing it

- Ingress: `ingress.enabled`, `className`, `hosts`, `tls`.
- Gateway API: `httpRoute.enabled`, `parentRefs`, `hostnames` (an rproxy-gateway Gateway works too).
- Set `url` (`NEXTAUTH_URL`) to the URL users open in the browser.

## NetworkPolicy

With `networkPolicy.enabled: true`:

- The UI pods accept port 3000 only, and with `networkPolicy.ingressFrom` (a list of NetworkPolicyPeers: the Ingress controller's or the Gateway rproxy's namespace, ...) only from there.
- The bundled MariaDB accepts port 3306 only from this release's UI, migration and backup pods.

Outgoing traffic (DB, Keycloak, rproxy) is not restricted.

## Backup and restore

```yaml
backup:
  enabled: true
  schedule: "15 3 * * *"
  keep: 14              # days
  existingSecret: rproxy-ui-backup
  persistence: {size: 20Gi}
```

The CronJob writes `mariadb-dump --single-transaction --routines --databases <db>`, gzipped, into a PVC (`<release>-rproxy-ui-backup`, kept by `helm uninstall`) as `rproxy-ui-<UTC time>.sql.gz` and deletes dumps older than `keep` days. It uses a read-only user (`SELECT, LOCK TABLES, SHOW VIEW`; the migration Job creates it with the bundled MariaDB, create it yourself on an external DB). The bundled MariaDB's PVC can also be snapshotted with a CSI VolumeSnapshot. The approach is that of rproxy-api's [docs/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/en/BACKUP.md).

Restoring:

```shell
# 1. stop the UI (collection and writes)
kubectl -n rproxy-ui scale deploy/rproxy-ui --replicas=0
# 2. restore from a pod with the backup PVC (bundled MariaDB; on an external DB, as its admin)
kubectl -n rproxy-ui run restore --rm -it --restart=Never --image=mariadb:11.8 \
  --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"rproxy-ui-backup"}}],
    "containers":[{"name":"restore","image":"mariadb:11.8","stdin":true,"tty":true,"command":["sh"],
    "volumeMounts":[{"name":"b","mountPath":"/backup"}]}]}}'
#   (in the pod) gunzip -c /backup/rproxy-ui-<time>.sql.gz | mariadb -h rproxy-ui-mariadb -u root -p
# 3. apply the migrations again (any added after the dump) and bring the UI back
helm upgrade rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <version> -n rproxy-ui -f values.yaml
kubectl -n rproxy-ui scale deploy/rproxy-ui --replicas=2
```

(With the release named `rproxy-ui` the names are `rproxy-ui`, `rproxy-ui-mariadb` and `rproxy-ui-backup`; other release names give `<release>-rproxy-ui-…`.)

## Main values

| Value | Default | Meaning |
|---|---|---|
| `image.repository`, `tag`, `digest` | `ghcr.io/max3584/rproxy-ui`, the chart's appVersion | |
| `replicas` | `2` | |
| `url` | (required) | `NEXTAUTH_URL` |
| `existingSecret` | (required) | `NEXTAUTH_SECRET`, `KEYCLOAK_CLIENT_SECRET`, `DB_PASSWORD` |
| `keycloak.issuer`, `clientId` | (required), `rproxy-ui` | |
| `roles.*` | empty | `RPROXY_UI_ROLES_CLAIM`, `_ADMIN_ROLE`, `_USER_ROLE`, `_USER_PORTS`, `_USER_NODES` |
| `db.host`, `port`, `database`, `user` | empty, 3306, `rproxy`, `rproxy_ui` | |
| `migrate.enabled`, `existingSecret`, `baseline`, `createDatabase`, `createUser` | `true`, empty, empty, `false`, `false` | |
| `mariadb.enabled`, `existingSecret`, `image`, `persistence` | `false`, empty, `mariadb:11.8`, 10Gi | |
| `rproxyApi.url`, `existingSecret`, `tokenKey` | empty | one rproxy-api on a VM |
| `nodes`, `nodeTokensSecret` | empty | the content of `RPROXY_UI_NODES` and its tokens |
| `rproxy.discovery.enabled`, `secretName` | `false`, `rproxy-ui-discovery` | Gateways' rproxy (read-only) |
| `usage.intervalSeconds` | `60` | `RPROXY_UI_USAGE_SECS` |
| `backup.*` | off | |
| `ingress.*`, `httpRoute.*`, `networkPolicy.*` | off | |
| `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts` | empty | other `RPROXY_UI_*` and so on |

Every value is in `charts/rproxy-ui/values.yaml` of the repository.
