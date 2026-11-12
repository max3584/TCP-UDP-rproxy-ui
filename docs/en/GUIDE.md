# Setup and operations guide

日本語: [../GUIDE.md](../GUIDE.md)

A path through rproxy-ui for first-time users.
It goes in order: install, first setup, sign-in, daily use, operations and troubleshooting.
The details stay in the sections of the [README](../../README.en.md); this guide links to them.

## Contents

1. [What rproxy-ui is](#1-what-rproxy-ui-is)
2. [Installing](#2-installing)
3. [First setup](#3-first-setup)
4. [Sign-in](#4-sign-in)
5. [Daily use](#5-daily-use)
6. [Multiple nodes and groups](#6-multiple-nodes-and-groups)
7. [Operations](#7-operations)
8. [Troubleshooting](#8-troubleshooting)

## 1. What rproxy-ui is

rproxy-ui is a web UI for managing the forwarding rules of [rproxy-api](https://github.com/max3584/rproxy-api) (a TCP/UDP reverse proxy written in Rust).

```
browser ──▶ rproxy-ui ──control API (token)──▶ rproxy-api ──▶ targets
                 │
                 └──▶ MariaDB (rules, history, usage) ◀── rproxy-api (reads at startup only)
```

- The source of truth for rules is `forward_rules` in MariaDB. When you save on a screen, the UI writes the DB and sends the rule to rproxy-api's control API. If rproxy refuses, the DB is rolled back.
- rproxy-api reads `forward_rules` at startup and restores the rules. Forwarding keeps running while the UI is down.
- Every change is recorded in `forward_rules_log` (used for history and revert).
- Rules in rproxy's settings file (static rules) are not in the DB. The screens show them read-only.
- Versions are numbered independently of rproxy-api. The UI's release notes state the minimum rproxy-api version it needs ([7. Operations](#7-operations)).

## 2. Installing

All options contain the same thing (the Next.js standalone output).

| Where | How | Details |
|---|---|---|
| Debian / Ubuntu VM | apt (`rproxy-ui`) | 2.1 below, [PRODUCTION.md](PRODUCTION.md) |
| Raspberry Pi | apt (arm64) | 2.2 below |
| Kubernetes | Helm chart | 2.3 below, [KUBERNETES.md](KUBERNETES.md) |
| Containers (Docker etc.) | `ghcr.io/max3584/rproxy-ui` | 2.4 below |

### 2.1 Debian / Ubuntu (VM)

Node.js 22.23.4 or later is required (24.22.1 or later on 24, 26.12.1 or later on 26).
Debian 13's own nodejs is 20 and Ubuntu 24.04's is 18, which are too old.
Install nodejs from [NodeSource](https://github.com/nodesource/distributions) with a fixed major version, and pin it with apt so the distribution's nodejs is not chosen.

```shell
NODE_MAJOR=24
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSLo /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' \
  | sudo tee /etc/apt/preferences.d/nodejs
sudo apt update && sudo apt install nodejs
node --version      # v24.x.x
```

Then install from rproxy-api's apt repository (together with rproxy-api if it runs on the same host).

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-api rproxy-ui
```

- Installing does not start it. Finish [3. First setup](#3-first-setup), then run `sudo systemctl enable --now rproxy-ui`.
- If rproxy-api is installed first, the UI's env file gets the control API URL and the token file (`RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens`).
- The `rproxy-ui` user joins the group `rproxy` shared with rproxy-api. It reads rproxy-api's token file and Unix socket without copying them.
- It listens on `127.0.0.1:3000` by default. To expose it, put a static rule of rproxy in front that terminates TLS ([PRODUCTION.md, "Publishing the dashboard (static rule)"](PRODUCTION.md#publishing-the-dashboard-static-rule)).
- How to change NodeSource's major version and what the pin does: [README, "Installation"](../../README.en.md#installation-debian--ubuntu).

### 2.2 Raspberry Pi

- The `rproxy-ui` package is one .deb for all CPUs (`all`). It installs on arm64 with the same steps as 2.1.
- On arm64 it runs with NodeSource's nodejs. On a Raspberry Pi, a 64-bit OS (such as the 64-bit Raspberry Pi OS) is recommended.
- For Kubernetes and containers, the image exists for both amd64 and arm64.

### 2.3 Kubernetes (Helm)

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <version> -n rproxy-ui -f values.yaml
```

- The chart does not create secrets. Create the Secrets first and pass their names with `existingSecret`.
- An external MariaDB is the default. For a trial, `mariadb.enabled: true` adds a bundled MariaDB (one instance, not redundant).
- Migrations are applied by a Job on Helm hooks (`post-install`, `pre-upgrade`) with `db/migrate.mjs`. You do not apply them by hand.
- Creating the secrets, example values, installing without Keycloak and seeing Gateways' rproxy: [KUBERNETES.md](KUBERNETES.md).

### 2.4 Containers (Docker etc.)

The image is `ghcr.io/max3584/rproxy-ui:<version>` (uid 65532, port 3000, `HOSTNAME=0.0.0.0`). The root file system may be read-only. It only writes to `/tmp` and `/app/.next/cache`.

```shell
docker run -d --name rproxy-ui --env-file rproxy-ui.env -p 3000:3000 \
  --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=65532,gid=65532 \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/max3584/rproxy-ui:<version>
```

- The env file has the same contents as [3.2](#32-the-env-file). `docker --env-file` keeps quotes as part of the value, so write values without quotes. Do not set `HOSTNAME` (keep the image's `0.0.0.0`).
- Migrations: `node db/migrate.mjs` inside the image ([3.1](#31-the-db-mariadb-and-migrations)). Tokens: `node rproxy-ui-token.mjs new --name admin --role admin --stdout`.
- If you mount a token file, make it owned by uid 65532 with mode 600, or owned by root with group 65532 and mode 0440 plus `--group-add 65532`.
- Liveness: `GET /api/healthz` (returns `{"ok":true}` without sign-in; it asks neither the DB nor rproxy).

## 3. First setup

The order: DB → env file → connecting to rproxy-api → sign-in method ([4.](#4-sign-in)) → start.

### 3.1 The DB (MariaDB) and migrations

On the same host, `sudo apt install mariadb-server` is enough (with `DB_HOST=127.0.0.1`, TLS to the DB is not needed).

Create the tables as the DB administrator, and do not give the UI's user DDL rights. The easiest way is to let `migrate.mjs` do it. On a new DB it runs `schema.sql`, creates the UI's user and grants only what it needs.

`migrate.mjs` connects to `DB_HOST` / `DB_PORT` over TCP and signs in with the password of `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` (not through the Unix socket).
The administrator needs the rights to run DDL and, with `DB_APP_USER`, to create users and grant rights (`CREATE USER` and `GRANT OPTION`).
Whether MariaDB's root can sign in with a password over TCP depends on the environment (not where root uses socket authentication only). If it cannot, create an administrator that signs in with a password. For example:

```shell
sudo mariadb -e "CREATE USER 'rproxy_admin'@'127.0.0.1' IDENTIFIED BY '<admin password>';
  GRANT ALL PRIVILEGES ON *.* TO 'rproxy_admin'@'127.0.0.1' WITH GRANT OPTION;"
```

You may narrow the rights to suit your environment (this example favours ease of trying).

```shell
sudo sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=rproxy_admin DB_ADMIN_PASSWORD=<admin password> \
  DB_APP_USER=rproxy_ui DB_APP_PASSWORD=<UI password> DB_APP_HOST=127.0.0.1 \
  node /usr/share/rproxy-ui/db/migrate.mjs --create-database'
```

The same command with `--status` shows what is applied and what is left (`--dry-run` only shows what it would do).

- It reads `DB_HOST`, `DB_PORT` and `DB_DATABASE` from the env file, so fill in the `DB_*` lines of the env file first ([3.2](#32-the-env-file)).
- Make `DB_APP_PASSWORD` the same as `DB_PASSWORD` in the env file. `DB_APP_HOST` is the UI's host (`127.0.0.1` on the same host).
- To do it by hand: `mariadb ... < /usr/share/rproxy-ui/db/schema.sql` and the GRANTs in [db/README.en.md, "DB users"](../../db/README.en.md#db-users). Do not forget the rights on the usage tables (`usage_*`).
- For rproxy-api, create a separate user that only reads at startup (`GRANT SELECT ON rproxy.forward_rules`). If rproxy-api v0.4 stores API rules, global values or overlays on static rules, grant those tables too (same section).
- A DB where migrations were applied by hand before (no `schema_migrations`) needs `--baseline <last applied number>` once ([db/README.en.md, "migrate.mjs"](../../db/README.en.md#migratemjs)).
- Use TLS for a DB on another host (`DB_SSL=true`, and `DB_SSL_CA` for an internal CA; [README, "TLS to the DB"](../../README.en.md#tls-to-the-db)).

### 3.2 The env file

With the .deb it is `/etc/rproxy-ui/rproxy-ui.env` (`root:root` 600). After changing it, run `sudo systemctl restart rproxy-ui`.

| Variable | Meaning |
|---|---|
| `HOSTNAME`, `PORT` | Where it listens (default `127.0.0.1`, `3000`) |
| `NEXTAUTH_URL` | The URL users open in the browser (e.g. `https://dashboard.example.com`). Used for the CSRF check, HSTS and Keycloak's redirect |
| `NEXTAUTH_SECRET` | The key that encrypts sessions. The .deb generates it at install. When several UIs run, use the same value on all |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD` | MariaDB (`DB_PORT` defaults to 3306) |
| `RPROXY_API_URL` | rproxy-api's control API: `http://`, `https://` or `unix:/run/rproxy/api.sock` |
| `RPROXY_API_TOKEN`, `RPROXY_API_TOKEN_FILE` | The token the UI sends to rproxy-api (3.3 below). If both are set, `RPROXY_API_TOKEN` wins |
| `RPROXY_UI_AUTH` | Sign-in method: `keycloak` (default), `token` or `both` ([4.](#4-sign-in)) |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | When using Keycloak |
| `RPROXY_UI_TOKENS_FILE` | The file for token sign-in |
| `RPROXY_UI_USER_ROLE` | The role of users. Empty (default) means only administrators can use the UI |
| `RPROXY_UI_NODES` | `nodes.yaml` for several rproxy instances ([6.](#6-multiple-nodes-and-groups)). When set, `RPROXY_API_URL` and `RPROXY_API_TOKEN` are not used |

Other variables (session length, usage, user limits, mTLS, act / stb): the comments in the file and [the variable list under "Development" in the README](../../README.en.md#development).

### 3.3 Connecting to rproxy-api and the token's scopes

The UI talks to rproxy-api with one token. It checks each user's ownership itself.

- If rproxy-api is on the same host and its token file uses the one-token-per-line format (the install default), that token is already `admin`. Nothing to do.
- If the token file uses the format with permissions (YAML), **give the UI's token `scopes: [admin]`**.

```yaml
# /etc/rproxy/tokens (rproxy-api's RPROXY_TOKEN_FILE; only SHA-256 values)
tokens:
  - name: rproxy-ui
    sha256: <the value of printf %s "$TOKEN" | sha256sum>
    scopes: [admin]
```

Why `admin`:

| What | Scope needed |
|---|---|
| Listing rules and their details | `rules:read` |
| Adding, changing, deleting and pausing rules | `rules:write` |
| Rules using ACME certificates | `acme:write` |
| Stored certificates chosen by users | `certs:read` |
| Global settings (`/global`) | `admin` |
| Editing and deleting rules created through the rproxy API (administrator screen), and resending on several nodes | `admin` (from rproxy-api v0.4.23) |

From rproxy-api v0.4.23 (rproxy-api #401), a token without `admin` may only change the rules, overlays and rule sets it created (others get `403 not_owner`).
The API rules screen and resending change rules other tokens created with the UI's token, so they stop working without `admin`.
A setup that uses neither and only changes the rules the UI restored may use `rules:read`, `rules:write` and `allow_restored: true` instead (rproxy-api's docs/en/API.md).
Do not give the UI's token `persist: true` (the UI stores rules in its own DB, so they would be stored twice).

- After changing the token file, run `sudo systemctl reload rproxy-api`.
- On the UI side, put the token in plain text in `RPROXY_API_TOKEN`, or write it on one line in a file only the UI reads (`root:rproxy-ui` 0640) and point `RPROXY_API_TOKEN_FILE` at it. A YAML token file holds only SHA-256 values, so the UI cannot point at it.
- For a Unix socket, set `RPROXY_API_SOCKET=/run/rproxy/api.sock` and `RPROXY_API_SOCKET_GROUP=rproxy` on rproxy, and `RPROXY_API_URL=unix:/run/rproxy/api.sock` on the UI (a token is still needed, as over TCP). The security-related global items (`trusted_proxies`, `access_log`, `crowdsec`, `geoip`, `acme`) can only be changed over the Unix socket.
- If the UI runs on another host, use `https://` for the control API. Client certificates (mTLS): `RPROXY_API_TLS_CERT`, `RPROXY_API_TLS_KEY`, `RPROXY_API_TLS_CA`.

Start it and check.

```shell
sudo systemctl enable --now rproxy-ui
journalctl -u rproxy-ui -f
```

The dashboard should say rproxy is reachable, and the bottom of the sidebar should show the UI and rproxy-api versions.

## 4. Sign-in

### 4.1 Without Keycloak (tokens)

The minimal setup: UI, MariaDB and rproxy only. The administrator makes tokens with `rproxy-ui-token`. A token is shown once. The file only gets its SHA-256.

```shell
sudo rproxy-ui-token new --name admin --role admin --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token new --name alice --role user  --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token list   --file /etc/rproxy-ui/tokens.yaml
sudo rproxy-ui-token remove --name alice --file /etc/rproxy-ui/tokens.yaml
```

```shell
# /etc/rproxy-ui/rproxy-ui.env
RPROXY_UI_AUTH=token
RPROXY_UI_TOKENS_FILE=/etc/rproxy-ui/tokens.yaml
RPROXY_UI_USER_ROLE=rproxy-user        # if you use role: user tokens
```

- Paste the token into the access token field on the sign-in page (`/signin`).
- The file is owned by `rproxy-ui` with mode 600. With another owner or mode, the UI does not start.
- The file is read again when it changes (no restart). Removing a row ends that token's sessions at the next check.
- A `role: user` token does not work while `RPROXY_UI_USER_ROLE` is empty (403 `no_role`).
- A row's `sub` becomes the owner of its rules (default `token:<name>`). Set it to the Keycloak `sub` to share rules with that person's Keycloak sign-in.
- Details: [README, "Token sign-in (without Keycloak)"](../../README.en.md#token-sign-in-without-keycloak).

### 4.2 Keycloak

```shell
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<the client's Credentials>
```

- The client is Confidential. Add `${NEXTAUTH_URL}/api/auth/callback/keycloak` to "Valid redirect URIs".
- Roles are realm roles read from `realm_access.roles` of the access token (`RPROXY_UI_ROLES_CLAIM` for client roles).
- A realm can be made from `keycloak/realm-rproxy-dev.json`, but it is for development. For production, fix the password policy, OTP, https URIs and session times ([PRODUCTION.md, "3. Keycloak"](PRODUCTION.md#3-keycloak)).
- Sessions end `RPROXY_UI_SESSION_MAX_AGE` after sign-in (default 8 hours). Roles are checked again with Keycloak every `RPROXY_UI_ROLE_REFRESH_SECS` (default 300 seconds) ([README, "Sessions"](../../README.en.md#sessions)).

### 4.3 Both (`both`)

With `RPROXY_UI_AUTH=both`, `/signin` shows the token field and a "Sign in with Keycloak" button. Set both `KEYCLOAK_*` and `RPROXY_UI_TOKENS_FILE`.
Without `RPROXY_UI_AUTH`, if there is no `KEYCLOAK_ISSUER` but there is `RPROXY_UI_TOKENS_FILE`, the method is `token`.

### 4.4 Roles

| Role | What it can do |
|---|---|
| Administrator (`rproxy-admin`; `role: admin` for tokens) | All users' rules. Any port and node. Also the API rules, global settings and act / stb screens |
| User (the role in `RPROXY_UI_USER_ROLE`; `role: user` for tokens) | Their own rules only, within the limits below |
| Neither | Cannot use the UI (403 `no_role`) |

The role names are `RPROXY_UI_ADMIN_ROLE` (default `rproxy-admin`) and `RPROXY_UI_USER_ROLE` (default empty). From v0.4.9, when it is empty, people who are not administrators cannot use the UI.

### 4.5 What users can do

Users create, see, change and delete their own rules only. They do not see other people's rules (static rules are shown to everyone, with file paths as `<hidden>`).
The administrator sets what users may use in the env file.

| Variable | What it sets | Outside it |
|---|---|---|
| `RPROXY_UI_USER_PORTS` | Listen ports users may use (e.g. `1024-65535`) | 403 `port_not_allowed` |
| `RPROXY_UI_USER_NODES` | Nodes users may touch (e.g. `node1,node2`) | 403 `node_not_allowed` |
| `RPROXY_UI_USER_TARGETS` | Targets users may use (CIDRs, IPs, host names, `*.example.com`). Recommended in production | 403 `target_not_allowed` |
| `RPROXY_UI_USER_CERTS` (`_BY_ROLE`, `_BY_SUB`) | Name prefixes of stored certificates users may choose | 403 `cert_not_allowed` |
| `RPROXY_UI_PROTECTED_TARGETS` | Destinations refused even when in the allowlist | 403 `target_not_allowed` |

- None of them limits anything by default. Loopback, link-local, the control API, the UI and the DB are always refused as targets, though.
- Users cannot write server file paths (`*_file`) (403 `file_not_allowed`). For TLS certificates they choose from those the administrator stored through rproxy's certificate API.
- They cannot add OIDC middlewares. Response caches stay within limits.
- Values that were already there can be saved again unchanged.
- All the rules: [README, "Limits for users (file paths and destinations)"](../../README.en.md#limits-for-users-file-paths-and-destinations).

## 5. Daily use

The list of screens: [README, "Usage"](../../README.en.md#usage).

### 5.1 Adding and editing rules

Use "New rule" (`/rules/new`) on the dashboard, or "Edit" on a rule's details. The form has tabs.

| Tab | Main fields |
|---|---|
| Basic | Profile (templates per use), protocol (tcp / udp), listen address and listen port (range end optional), target address and target port, "Add backend" (several targets and how to balance), "Route with L7 (HTTP)" |
| L7 (HTTP) | Routes (`match` expressions), services, middlewares, what to do when no route matches |
| TLS / DTLS | Mode (passthrough / sni / terminate), per-server-name destinations, connections matching no server name, server certificate, intermediate CA and private key ("+ Add ACME certificate", "+ Add a stored certificate"), client certificate verification (mTLS), ALPN, re-encryption to the target |
| Mail (STARTTLS) | SMTP / IMAP / POP3 (only when terminating TCP) |
| Limits & GeoIP | Labels, L4 limits, bandwidth caps, GeoIP, passive health checks |
| Advanced | Client IP handling (source_ip), UDP idle timeout, TCP relay timeouts, time to connect to a target, allowed sources (allow_from), accepting PROXY protocol |

By kind of rule:

- **L4 (relay TCP / UDP as is)**: "Basic" is enough. To limit sources, use allow_from under "Advanced" (one CIDR or IP per line).
- **TLS**: choose the mode under "TLS / DTLS". To terminate, give a certificate and key (paths on the rproxy-api host, owned by `rproxy-api`) or ACME. To route by name, use the per-server-name destinations.
- **HTTP (L7)**: on a TCP rule, choose "Route with L7 (HTTP)" and build routes and services under "L7 (HTTP)". The profile "HTTPS reverse proxy (L7)" is a template. L4 or L7 can only be chosen when the rule is created.

Keep in mind:

- Fields appear only when rproxy-api's `GET /capabilities` `features` says they are supported. On an older rproxy, existing values are kept read-only and sent as they are (saving does not drop them).
- Client IP handling and the port range cannot be changed after the rule is created.
- If rproxy returns `features.dry_run`, "Show the difference" shows what changes on rproxy before you save.
- "Pause" in the list or details stops a rule without deleting it ("Resume" brings it back; [README, "Pausing a rule"](../../README.en.md#pausing-a-rule)).
- Per topic: [L7](../../README.en.md#l7-http-rules), [Gateway API fields](../../README.en.md#gateway-api-l7-and-tls-fields), [response cache](../../README.en.md#response-cache-cache), [multiple targets](../../README.en.md#multiple-targets), [SNI passthrough](../../README.en.md#passing-some-server-names-through-without-termination-sni-passthrough), [PROXY protocol](../../README.en.md#accepting-proxy-protocol-from-a-front-end-and-client-ip-handling-per-server-name), [TCP relay timeouts](../../README.en.md#tcp-relay-timeouts-idle_timeout-half_close_timeout), [time to connect](../../README.en.md#time-to-connect-to-a-target-connect_timeout), [UDP server names](../../README.en.md#routing-udp-by-server-name-dtls-quic), [ACME](../../README.en.md#obtaining-certificates-with-acme), [v0.4 settings](../../README.en.md#v04-rule-settings-limits-bandwidth-geoip-labels).

### 5.2 Overlays on static rules

Rules in rproxy's settings file (static rules) cannot be changed from the screens.
With rproxy-api v0.4.23 or later (`features.static_overlay`), "Overlay" in a static rule's details adds to it while the file stays as it is.

- What you can add: http routes, services and middlewares (when the rule has `http`), or per-server-name destinations (`tls.routes`).
- Overlay routes only receive requests that match none of the file's routes.
- Names the file already has cannot be used (409 `overlay_conflict`).
- Saving replaces the whole overlay. If someone changed it first, you get 412. Use "Reload" to load the current contents, then try again.
- Overlays are per node (not per group).
- People who are not administrators may only change overlays they created. They cannot use the settings file's services, nor anything with secret files.
- Details: "Overlays on static rules" under [README, "Usage"](../../README.en.md#usage).

### 5.3 Global settings (acme, geoip, timeouts)

Open "Global settings" (`/global`) from "rproxy features & settings" (`/system`). Administrators only. It needs rproxy-api v0.4.19 or later (`features.global_api`) and `admin` on the UI's token.

1. Each item shows its value in force, where it comes from (settings file / environment / API / default) and how it changes. Items set in the settings file or environment cannot be changed.
2. Enter values and use "Check the changes" (dry run).
3. "Apply". Choosing a group sends to all its nodes, and if one refuses, the others are rolled back. "Clear the API value (back to the default)" returns to the default.

- Items that take effect at once, such as `http.timeouts` (timeouts) and `udp_max_sessions`, can be changed.
- `geoip` and `acme` need rproxy-api v0.4.22 or later (`features.global_api_geoip`, `global_api_acme`) and a node reached over the Unix socket. Files must be directly under rproxy-api's `RPROXY_API_GEOIP_DIR` / `RPROXY_API_ACME_DIR`.
- Secret values come back as `***`. When you change `acme`, enter those fields again.
- rproxy stores the values in the DB table `rproxy_global` (migration 013).
- Details: "Global settings" in [README, "v0.4 rule settings"](../../README.en.md#v04-rule-settings-limits-bandwidth-geoip-labels).

### 5.4 History and revert

"History" (`/history`) shows when, who and what changed. A rule's details show that rule's history too.

- "Revert to this version" goes back to the contents at that point. Deleted rules can be created again. Reverts are recorded too.
- Users see the history they made and the history of the rules they own now.
- Node overrides (`OVERRIDE`) and overlays (`OVERLAY`) cannot be reverted.
- Details: [README, "Change history and revert"](../../README.en.md#change-history-and-revert).

### 5.5 Export and import

- "Export (JSON)" on the dashboard writes out your rules (all rules for administrators). Use it as a copy or for moving.
- "Import" (`/rules/import`) reads a UI export or an rproxy settings file (YAML / JSON).
  1. "Check": validates each rule. Nothing changes yet.
  2. For rules with the same key, choose "Replace" per row.
  3. "Import": adds or replaces one rule at a time.
- Details: [README, "Export and import"](../../README.en.md#export-and-import).

### 5.6 Drift and resend

With several nodes, the rules running on each node are compared with the UI's definition (the DB), and differing fields are shown as drift.

- On the node's tab of a rule's details, look at "Difference from the UI's definition" and use "Resend to this node" to send the UI's definition to that node only.
- Differences PATCH cannot fix are recreated. Rules missing on the node are created. Paused rules that are running are deleted.
- The rule's owner and administrators may use it. The history records `RESEND` and the node.
- From rproxy-api v0.4.23 the UI's token needs `admin` ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

## 6. Multiple nodes and groups

One UI manages several rproxy instances (nodes). A set of nodes with the same rules is a group.

```yaml
# /etc/rproxy-ui/nodes.yaml (RPROXY_UI_NODES=/etc/rproxy-ui/nodes.yaml)
nodes:
  - name: node1
    url: http://10.0.0.11:8080
    token_file: /etc/rproxy-ui/tokens/node1
  - name: node2
    url: http://10.0.0.12:8080
    token_file: /etc/rproxy-ui/tokens/node2
groups:
  - name: ha
    nodes: [node1, node2]
    mode: active_standby      # single (default) or active_standby
    vip: 192.0.2.10
default_target: ha
```

1. Apply migrations `006` to `009` to the DB (already done with `migrate.mjs`).
2. Create the view each node's rproxy reads with `db/node-view.mjs` ([README, "Restoring at rproxy startup (a view per node)"](../../README.en.md#restoring-at-rproxy-startup-a-view-per-node)).
3. Set each rproxy's `RPROXY_NODE_NAME` to the node's name.
4. Set `RPROXY_UI_NODES` and restart the UI (it does not start if the file has errors).

What changes on the screens:

- With two or more nodes, the add screen gets "Node / group", and the dashboard and rule details get "All / per node" tabs.
- A group's rules are sent to all its nodes. If one node fails, the others are rolled back.
- "Settings for this node only (override)" on a node's tab changes the listen address, targets and allow_from per node.
- "Copy / move" moves a rule to another node or group. "Pause all" on a node's tab stops all its rules.
- Details: [README, "Several rproxy instances (nodes and groups)"](../../README.en.md#several-rproxy-instances-nodes-and-groups).

## 7. Operations

### 7.1 Upgrading

```shell
sudo apt update && sudo apt upgrade
```

- Settings and tokens are kept. Running services are restarted.
- For versions that change tables, the release notes list the migrations. Apply them first (`migrate.mjs` applies only the missing ones). On Kubernetes, the `helm upgrade` Job applies them.
- The minimum rproxy-api version the UI needs is **v0.3.5**. Newer fields are decided by rproxy-api's `features` and hidden when missing. Versions appear at the bottom of the sidebar and on the dashboard. The dashboard warns when a version is too old or unknown.
- Combinations to watch:
  - Before upgrading rproxy-api to v0.4.23 or later, make the UI's token `admin` ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).
  - From UI v0.4.9, an empty `RPROXY_UI_USER_ROLE` means only administrators can use the UI. If users used it before, set it before upgrading.
  - Node.js 22.23.4 or later (24.22.1 or later on 24). Older versions log a warning at startup.
- Details: [PRODUCTION.md, "7. Updates"](PRODUCTION.md#7-updates).

### 7.2 Backup

- DB: `forward_rules` (the source of truth for rules) and `forward_rules_log` (history). Dumping the whole database with `mariadb-dump --single-transaction` is the easiest.
- Files: `/etc/rproxy-ui/rproxy-ui.env` (`NEXTAUTH_SECRET` and secrets), `tokens.yaml`, `nodes.yaml`, the node tokens, `ha.tokens`. On the rproxy side, `/etc/rproxy`.
- "Export (JSON)" is also a copy of the rules.
- How to take backups, the order of restoring and how to check afterwards: rproxy-api's [docs/en/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/en/BACKUP.md). For Kubernetes: [KUBERNETES.md, "Backup and restore"](KUBERNETES.md#backup-and-restore).

### 7.3 With keepalived (act / stb)

When keepalived moves the VIP of an `active_standby` group, this keeps a standby from being promoted while it differs from the DB's definition.

- The UI resends to drifted standbys every `RPROXY_UI_HA_SYNC_SECS` (default 30 seconds). `auto_resend: false` on a group stops this.
- keepalived's track_script and notify_master call `/api/forward/ha/ready` and `/api/forward/ha/notify` with the token in `RPROXY_UI_HA_TOKEN_FILE`.
- Scripts and example settings: [contrib/keepalived](../../contrib/keepalived/README.en.md) (`/usr/share/doc/rproxy-ui/examples/keepalived/` with the .deb).
- "act / stb" (`/ha`, administrators only) shows whether nodes are in sync, with "Sync this node". The failback steps are there too.
- The UI itself can run on any number of instances (collection and resending are done by one instance at a time through a DB lock; use the same `NEXTAUTH_SECRET` on all).

### 7.4 Logs

- .deb: `journalctl -u rproxy-ui` (`-f` to follow). Startup errors (`nodes.yaml`, token file permissions, DB TLS, mTLS combinations) stop it with the reason. Each node's rproxy-api version is also logged at startup.
- When rproxy refuses the UI's token (401, 403, 429), the UI logs the reason and what to check.
- Kubernetes: `kubectl -n rproxy-ui logs deploy/rproxy-ui`. Failed migrations: `kubectl -n rproxy-ui logs job/<release>-rproxy-ui-migrate`.
- rproxy-api's logs (such as `event: "audit"` for creating, changing and deleting) are on the rproxy-api side (`/var/log/rproxy/`).

### 7.5 Security notes

- **Requests from other sites (CSRF)**: APIs that change state refuse requests from other sites with 403 `csrf`. A reverse proxy in front must pass `Host` or `X-Forwarded-Host` and must not drop `Origin`, `Referer` or `Sec-Fetch-*`. Set `NEXTAUTH_URL` to the URL users open.
- **Token lockout**: after more than 5 wrong tokens in 15 minutes from one source, that source's wrong tokens get 429 for 15 minutes (`RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS`, `RPROXY_UI_TOKEN_LOCKOUT_SECS`). Correct tokens still pass. The protection is the token's strength, so always make tokens with `rproxy-ui-token`.
- **Behind an HTTP proxy**: behind nginx, an Ingress and the like, put only their addresses in `RPROXY_UI_TRUSTED_PROXIES` (a wide range lets others fake the source). Not needed when rproxy (L4) is in front.
- **Exposing**: the UI listens on `127.0.0.1` only by default. Terminate TLS with a static rule of rproxy and narrow the users' range with `allow_from`.
- **File owners**: rproxy-api only reads certificates, keys and secret files it owns (`rproxy-api:rproxy` 0640; [PRODUCTION.md, "File owners"](PRODUCTION.md#file-owners-os-users-and-groups)).
- Headers, sessions and user limits as a whole: [README, "Security"](../../README.en.md#security).

## 8. Troubleshooting

Look for the `code` after the error text on the screen. When rproxy refuses the UI's token, the UI returns 502.

| What you see | Why | What to do |
|---|---|---|
| 403 `no_role` | No administrator role, and `RPROXY_UI_USER_ROLE` is empty or the person lacks that role | Give the role, or set `RPROXY_UI_USER_ROLE`. For tokens, check `role` |
| 502 `forbidden` ("The rproxy token used by the UI lacks the permission for this.") | The UI's token lacks scopes or `allow_listen_ports` | Make the UI's token `admin` ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)) |
| 502 `not_owner` | rproxy-api v0.4.23 or later and the UI's token is not `admin`. Seen when editing or deleting API rules, resending, or changing rules restored at an rproxy restart | Make the UI's token `admin` (or `allow_restored: true` if you use none of those). `reload rproxy-api` |
| 403 `global_forbidden` | The UI's token lacks the `admin` that global settings need | Make the UI's token `admin` |
| 403 `global_unix_only` | A security-related item was changed through a TCP node | Set that node's url to the `unix:/…` socket |
| 502 `rproxy_unauthorized` | The UI's token is wrong or expired | Check `RPROXY_API_TOKEN` / `RPROXY_API_TOKEN_FILE` and rproxy's token file |
| 502 `rproxy_locked_out` | Repeated authentication failures made rproxy block the UI for a while | Fix the token or client certificate. It clears when the time passes |
| `unreachable` ("Could not connect to rproxy.") | rproxy-api is down, the URL is wrong, or the socket's group | `systemctl status rproxy-api`, `RPROXY_API_URL`, whether `rproxy-ui` is in the socket's group |
| 400 `unsupported` | A combination rproxy does not support: switching L4 / L7, changing client IP handling or the port range, `connect_timeout` on an old rproxy, UDP sni on an old rproxy, and so on | Create it again as a new rule, or upgrade rproxy-api. The text continues with the reason |
| 409 `file_in_use` | A user used a settings-file service or middleware with secret files in an overlay. Or rproxy refused a key or secret file of another owner | Ask an administrator, or use your own service or another file |
| 403 `file_service_not_allowed` | A user used a settings-file service from an overlay | Define your own service in the overlay |
| 412 `precondition_failed` | Someone created or changed the overlay after you opened it | "Reload" to load the current contents and try again |
| 403 `overlay_not_owner` | A user tried to change an overlay someone else created | Ask an administrator |
| 409 `overlay_conflict` | The overlay uses a name the settings file has | Use another name |
| 409 `static` | Same key as a static rule. Static rules cannot be changed from the screens | Edit rproxy's settings file, or use an overlay |
| 409 `shadowed` | rproxy uses the same key for an API rule or a rule set's rule | Delete one of them or change the key |
| 409 `target_conflict`, 400 `target_required`, 400 `unknown_target` | With several nodes: the same key on overlapping nodes, no placement given, or an unknown name | Choose the node / group again. Check `nodes.yaml` |
| 409 `readonly_node` | A write to a Kubernetes Gateway's rproxy (read-only) | Change the Gateway API resources instead |
| 403 `csrf` | The request was taken as coming from another site | Reopen the screen. Check that the proxy in front passes `Host` and `Origin`, and check `NEXTAUTH_URL` |
| 403 `port_not_allowed`, `file_not_allowed`, `target_not_allowed`, `cert_not_allowed`, `node_not_allowed`, `middleware_not_allowed`, `cache_limit` | Outside the user limits | [4.5](#45-what-users-can-do). If needed, the administrator widens what users may use |
| 429 at sign-in | Lockout of wrong tokens | Wait, or sign in with a correct token (correct tokens pass) |
| `tls_config`, file owner refusals | Wrong certificate or key path or contents, or wrong owner or mode | Use `rproxy-api:rproxy` 0640. The screen shows how to fix it |
| "The usage_* tables are missing (…010_usage.sql)", "usage_hourly and usage_daily have no attr column (…011_usage_attr.sql)" | The usage migrations are missing | Apply `010` and `011` (`migrate.mjs`) |
| 500 `nodes_db` ("Cannot update forward_rule_targets …") | The migrations for several nodes (`006`, `007`) are missing, or rights are missing | Apply them and grant rights to the UI's user |
| Saving an overlay says "rproxy could not store it in the database (rproxy_rule_overlays …)" | Migration `014` is missing, or rproxy's user lacks rights | Apply `014` and grant rights to rproxy's user. It works now but is lost at a restart |
| The UI does not start | Errors in `nodes.yaml`, the token file's owner or mode, DB TLS settings, an `http://` URL with `RPROXY_API_TLS_*`, and so on | Read the reason in `journalctl -u rproxy-ui` and fix it |
| A version notice on the dashboard | rproxy-api is older than v0.3.5, or does not return its version (before v0.3.18) | Upgrade rproxy-api |

Other codes are explained on the screen. When unsure, read the UI's logs ([7.4](#74-logs)) together with rproxy-api's logs.
