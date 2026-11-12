# Setup and operations guide

日本語: [../GUIDE.md](../GUIDE.md)

This guide walks you through installing rproxy-ui, doing the first setup, and then using and running it day to day. It is written for someone who runs the UI but has never used rproxy (rproxy-api) before. It assumes you know how to install Linux packages and the basics of MariaDB.

The guide explains the overall path and the ideas behind it, and leaves the detailed rules of each setting to the sections of the [README](../../README.en.md), which it links to. How to look up the codes shown on screen when something goes wrong is collected in [8. Troubleshooting](#8-troubleshooting).

## How to read this guide

Pick the chapters for what you want to do.

| Situation | Chapters to read |
|---|---|
| Installing for the first time | Read [1.](#1-what-rproxy-ui-is) for the overall shape and the terms, then only the section of [2.](#2-installing) for where you install. Continue with [3.](#3-first-setup) to set up the DB, the settings file and the connection to rproxy-api, and choose a sign-in method in [4.](#4-sign-in) |
| Daily use (adding, changing and reverting rules) | Read [5.](#5-daily-use). People who are not administrators (users) should also check what they may do in [4.4](#44-roles) and [4.5](#45-what-users-can-do) |
| Running several rproxy instances, or act / stb for redundancy | Set up nodes and groups in [6.](#6-multiple-nodes-and-groups), then read how to fix drift in [5.6](#56-drift-and-resend) and how to work with keepalived in [7.3](#73-with-keepalived-act--stb) |
| Upgrading, backups, hardening | Read [7.](#7-operations) |
| Something does not work | Look up the code shown after the error text on screen (such as `no_role`) in [8.](#8-troubleshooting). If it is not there, read the logs as in [7.4](#74-logs) |

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

This chapter explains what rproxy-ui does and how it connects to rproxy-api and MariaDB. It also explains the terms used in later chapters, so read it first if you are new.

### 1.1 How it fits together

rproxy-ui is a web UI for managing the forwarding rules of [rproxy-api](https://github.com/max3584/rproxy-api) from a browser. rproxy-api is a TCP/UDP reverse proxy written in Rust: it listens for connections on given ports and relays them to other servers (targets). What to listen on and where to relay it is a **forwarding rule** (just "rule" in this guide).

The three parts are connected like this:

```
browser ──▶ rproxy-ui ──control API (token)──▶ rproxy-api ──▶ targets
                 │
                 └──▶ MariaDB (rules, history, usage) ◀── rproxy-api (reads at startup only)
```

- **The source of truth for rules is the `forward_rules` table in MariaDB.** When you save a rule on a screen, the UI first writes it to the DB and then sends it to rproxy-api's control API. If rproxy refuses, the UI rolls the DB back too, so the DB and rproxy are not left disagreeing.
- **rproxy-api reads `forward_rules` at startup and restores the rules.** rproxy never asks the UI anything, so forwarding keeps running while the UI is down. The UI is only needed when you change rules.
- **Every change is recorded in the `forward_rules_log` table.** It is used for the history of who changed what and when, and for reverting to an earlier version ([5.4](#54-history-and-revert)).
- **Rules written in rproxy's settings file (static rules) are not in the DB.** The screens show them read-only. To change a static rule you edit the settings file, but some parts can be added from the screens while the file stays as it is ([5.2](#52-overlays-on-static-rules)).
- **rproxy-ui and rproxy-api have separate version numbers.** The UI's release notes state the minimum rproxy-api version it needs ([7.1](#71-upgrading)).

### 1.2 Terms used in this guide

This section explains terms that come up again and again in later chapters. You do not need to memorise them now; come back here when you meet one you do not know.

**rproxy-api and the control API**: rproxy-api is the proxy that actually relays traffic (this guide also calls it just "rproxy"). It has an HTTP API that accepts adding, changing and deleting rules, called the **control API**. rproxy-ui operates rproxy through this control API.

**Two kinds of tokens**: this guide talks about two kinds of tokens with different jobs. They are easy to mix up, so tell them apart from the start.

- **The token the UI sends to rproxy-api**: the secret the UI uses when it calls the control API. It is registered in rproxy-api's token file (`/etc/rproxy/tokens`) and set in the UI's settings (`RPROXY_API_TOKEN` or `RPROXY_API_TOKEN_FILE`). There is one for the whole UI ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).
- **Tokens people use to sign in to the UI**: when Keycloak is not used, people paste one of these on the sign-in page. They are made with `rproxy-ui-token` and registered in the UI's token file (`RPROXY_UI_TOKENS_FILE`). There is one per person ([4.1](#41-without-keycloak-tokens)).

**Scopes**: permissions attached to an rproxy-api token (`rules:read`, `rules:write`, `admin` and so on). They decide what the token may do. The UI's token gets `admin` ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

**A rule's key**: rules are identified by protocol (tcp or udp), listen address and port together. This combination is the key. Two rules with the same key cannot be in the same place.

**Static rules, API rules and rule sets**: besides the rules the UI made, rproxy may run rules from other sources. **Static rules** are written in rproxy's settings file (`RPROXY_STATIC_RULES`). **API rules** were created by calling rproxy's control API directly, without the UI (by CI, scripts, Kubernetes controllers and the like); administrators see them with an "API" badge. A **rule set** (`ruleset`) is a group of rules that something like a Kubernetes controller hands over as a whole; the screens show it read-only.

**Administrators and users (roles)**: people who use the UI have one of two positions. **Administrators** (role `rproxy-admin`) can handle everyone's rules and rproxy-wide settings. **Users** (the role named in `RPROXY_UI_USER_ROLE`) can only handle the rules they created, and the administrator can limit the ports and targets they use. People with neither role cannot use the UI ([4.4](#44-roles)).

**Owner**: a rule made in the UI records the person who made it as its owner. The owner is the Keycloak user ID (`sub`), or `token:<name>` for token sign-in. Users only see and change rules they own.

**Nodes and groups**: one UI can manage several rproxy instances. One rproxy as seen from the UI is a **node**. A set of nodes that should have the same rules is a **group**; a rule placed on a group is sent to all its nodes ([6.](#6-multiple-nodes-and-groups)). With a single rproxy you can ignore nodes and groups.

**Overlay**: static rules cannot be changed from the screens, but you can add HTTP routes or per-server-name destinations from the screens while the settings file stays as it is. The added part is called an "overlay" ([5.2](#52-overlays-on-static-rules)).

**Drift and resend**: **drift** is when the correct content in the UI's DB and what actually runs on rproxy disagree. It happens when, say, one of several nodes was left with old content, or an overlay was lost when rproxy restarted. The UI shows drift on screen and sends the DB's content to rproxy again to bring them back in line. That is a **resend** ([5.6](#56-drift-and-resend)).

**act / stb**: a setup where two rproxy instances hand one address (a VIP, virtual IP address) back and forth for redundancy. The one that holds the VIP and receives traffic now is **act** (active); the one waiting is **stb** (standby). keepalived moves the VIP, and the UI watches that the stb has the same rules as the act ([7.3](#73-with-keepalived-act--stb)).

**persist**: a flag on an rproxy-api token. Rules created with such a token are stored by rproxy in its own DB table and restored after a restart. The UI's token normally does not have it; the trade-off is explained in [3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes).

**Migrations**: SQL that creates the tables the UI uses or changes their shape. They live in `db/migrations/` as files numbered from `001`, and a new one is added whenever a new feature needs a new table. "Migration `015`" in this guide means `015_forward_rule_overlays.sql`. How to apply them is in [3.1](#31-the-db-mariadb-and-migrations).

**features**: rproxy-api returns the list of features it supports in `features` of `GET /capabilities`. The UI uses it to show only the fields and buttons that rproxy can handle. "If `features.static_overlay` is there" in this guide means "if rproxy says it supports that feature".

## 2. Installing

This chapter explains how to install rproxy-ui for each kind of place. Every option contains the same thing (the app packed as Next.js standalone output). Read only the section for where you install.

| Where | How | Details |
|---|---|---|
| Debian / Ubuntu VM | apt (`rproxy-ui`) | 2.1 below, [PRODUCTION.md](PRODUCTION.md) |
| Raspberry Pi | apt (arm64) | 2.2 below |
| Kubernetes | Helm chart | 2.3 below, [KUBERNETES.md](KUBERNETES.md) |
| Containers (Docker etc.) | `ghcr.io/max3584/rproxy-ui` | 2.4 below |

### 2.1 Debian / Ubuntu (VM)

This section installs on a Debian or Ubuntu VM with apt. Putting it on the same host as rproxy-api is the simplest setup.

rproxy-ui runs on Node.js, so install Node.js first. You need 22.23.4 or later (24.22.1 or later on the 24 line, 26.12.1 or later on 26). Debian 13's own nodejs is 20 and Ubuntu 24.04's is 18, both too old. So install the nodejs that [NodeSource](https://github.com/nodesource/distributions) distributes. The commands below add NodeSource's apt repository, make apt pick NodeSource's nodejs instead of the distribution's, and install it.

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

- `NODE_MAJOR=24` fixes the Node.js major version. The version is part of the repository URL, so apt will not move to the next major version on its own.
- The `printf 'Package: nodejs ...'` line is an apt pin (a priority setting). It gives nodejs from NodeSource priority 600 so it is chosen before the distribution's nodejs.
- If the final `node --version` prints a version starting with `v24.`, it is installed.

How to change the major version and what the pin does are explained in [README, "Installation"](../../README.en.md#installation-debian--ubuntu).

Next, install rproxy-ui. It is distributed from the same apt repository as rproxy-api, so add that repository and install. If rproxy-api runs on the same host, install it here too.

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-api   # first, if it runs on the same host
sudo apt install rproxy-ui
```

A few things about what happens after installing:

- **Installing does not start it.** The settings are still empty, so finish [3. First setup](#3-first-setup) and then start it with `sudo systemctl enable --now rproxy-ui`.
- **Installing rproxy-api first fills in part of the settings.** When rproxy-ui is installed and rproxy-api is on the same host, the control API URL and the token file location (`RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens`) are written to the env file. rproxy-ui only "Suggests" rproxy-api, though, so even when you install both at once apt does not decide the order. Install rproxy-api first as in the commands above. If they were not filled in, write `RPROXY_API_URL` and `RPROXY_API_TOKEN_FILE` (or `RPROXY_API_TOKEN`) by hand ([3.2](#32-the-env-file)).
- **The `rproxy-ui` user joins the group `rproxy` shared with rproxy-api.** That lets it read rproxy-api's token file and Unix socket as they are, without copying them.
- **By default it listens on `127.0.0.1:3000`.** That means it can only be opened from that host. To use it from browsers on other machines, put a static rule of rproxy in front of the UI that terminates TLS. The steps are in [PRODUCTION.md, "Publishing the dashboard (static rule)"](PRODUCTION.md#publishing-the-dashboard-static-rule).

### 2.2 Raspberry Pi

On a Raspberry Pi the steps are the same as 2.1.

- The `rproxy-ui` package is one .deb for every CPU (architecture `all`). It installs on arm64 with the same steps as 2.1.
- On arm64 it runs with NodeSource's nodejs. On a Raspberry Pi, use a 64-bit OS (such as the 64-bit Raspberry Pi OS).
- For Kubernetes and containers, the image exists for both amd64 and arm64.

### 2.3 Kubernetes (Helm)

This section gives the key points of installing on Kubernetes with the Helm chart. The whole procedure, including creating the secrets and example values, is in [KUBERNETES.md](KUBERNETES.md).

The command below installs into the namespace `rproxy-ui` with the settings in `values.yaml`. Put the version to install in `<version>`.

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <version> -n rproxy-ui -f values.yaml
```

- **The chart does not create secrets.** Create the Secrets holding the DB password, `NEXTAUTH_SECRET` and so on yourself first, and pass their names to the chart with `existingSecret`.
- **The default is a MariaDB outside the cluster.** For a trial, `mariadb.enabled: true` adds the MariaDB bundled with the chart. It is a single instance, though, and is not redundant.
- **Migrations are applied automatically.** A Job run by Helm hooks (`post-install`, `pre-upgrade`) applies them with `db/migrate.mjs`. You do not apply them by hand.
- How to install without Keycloak and how to see Kubernetes Gateways' rproxy from the UI are also in [KUBERNETES.md](KUBERNETES.md).

### 2.4 Containers (Docker etc.)

This section gives the key points of running the image directly with Docker and the like.

The image is `ghcr.io/max3584/rproxy-ui:<version>`. The process inside runs as uid 65532 and listens on port 3000 on all addresses (`HOSTNAME=0.0.0.0`). It only writes to `/tmp` and `/app/.next/cache`, so it can run with a read-only root file system. The command below starts it that way, with as few privileges as possible.

```shell
docker run -d --name rproxy-ui --env-file rproxy-ui.env -p 3000:3000 \
  --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=65532,gid=65532 \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/max3584/rproxy-ui:<version>
```

- `--env-file rproxy-ui.env` passes the settings.
- `--read-only` makes the root read-only, and `--tmpfs` provides the two writable places in memory. `/app/.next/cache` is made writable for uid 65532.
- `--cap-drop ALL` and `--security-opt no-new-privileges` drop the container's privileges.

Things to watch when running it in a container:

- **The env file has the same contents as [3.2](#32-the-env-file).** But `docker --env-file` keeps quotes as part of the value, so write values without quotes. Do not set `HOSTNAME`; keep the image's `0.0.0.0` (with `127.0.0.1` it could not be reached from outside the container).
- **Apply migrations with `node db/migrate.mjs` inside the image** ([3.1](#31-the-db-mariadb-and-migrations)). **Make sign-in tokens** with `node rproxy-ui-token.mjs new --name admin --role admin --stdout`.
- **When you mount a token file**, make it owned by uid 65532 with mode 600, or owned by root with group 65532 and mode 0440 plus `--group-add 65532`. With any other owner or mode the UI does not start ([4.1](#41-without-keycloak-tokens)).
- **Check that it is alive with `GET /api/healthz`.** It returns `{"ok":true}` without sign-in. It asks neither the DB nor rproxy, so it only tells you the UI process is running.

## 3. First setup

This chapter covers the settings to finish after installing and before starting. Go in this order:

1. Prepare the DB and create the tables (3.1)
2. Write the settings in the env file (3.2)
3. Set up the connection to rproxy-api (3.3)
4. Choose the sign-in method ([4.](#4-sign-in))
5. Start and check (end of 3.3)

### 3.1 The DB (MariaDB) and migrations

This section prepares the MariaDB the UI uses and creates its tables. The UI stores rules, history and usage here, and rproxy-api also reads rules from here at startup.

If the DB is on the same host as the UI, `sudo apt install mariadb-server` is enough. Then connect with `DB_HOST=127.0.0.1`; traffic to the DB does not leave the host, so TLS is not needed.

Create the tables with the DB administrator's rights. The DB user the UI normally uses does not get the rights to create or change tables (DDL); it only gets the rights it needs for everyday reading and writing. Letting `migrate.mjs` do this is the easiest way. On a new DB, `migrate.mjs` creates the tables from `schema.sql`, creates the UI's DB user and grants only what it needs. On an existing DB it applies only the migrations not applied yet, in numeric order. It records what it applied in a table called `schema_migrations`, so running it again never applies the same one twice.

`migrate.mjs` connects to `DB_HOST` / `DB_PORT` over TCP and signs in with the user and password in `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`. It does not use the Unix socket. This administrator needs the rights to run DDL. If it should also create the UI's user through `DB_APP_USER` (explained below), it also needs the rights to create users and grant rights (`CREATE USER` and `GRANT OPTION`).

Whether MariaDB's root can sign in with a password over TCP depends on the environment. Where root uses socket authentication only (such as Debian's default), it cannot. In that case, create an administrator that signs in with a password. The command below creates an administrator `rproxy_admin` that signs in with a password from `127.0.0.1`.

```shell
sudo mariadb -e "CREATE USER 'rproxy_admin'@'127.0.0.1' IDENTIFIED BY '<admin password>';
  GRANT ALL PRIVILEGES ON *.* TO 'rproxy_admin'@'127.0.0.1' WITH GRANT OPTION;"
```

This example grants every right to make trying easy; you may narrow them to suit your environment.

With the administrator in place, run `migrate.mjs`. The command below loads `DB_*` from the env file, creates the DB if missing, creates the tables, creates the UI's user `rproxy_ui` and grants its rights.

```shell
sudo sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=rproxy_admin DB_ADMIN_PASSWORD=<admin password> \
  DB_APP_USER=rproxy_ui DB_APP_PASSWORD=<UI password> DB_APP_HOST=127.0.0.1 \
  node /usr/share/rproxy-ui/db/migrate.mjs --create-database'
```

- `set -a; . /etc/rproxy-ui/rproxy-ui.env` loads `DB_HOST`, `DB_PORT` and `DB_DATABASE` from the env file. The connection comes from there, so **fill in the `DB_*` lines of the env file first** ([3.2](#32-the-env-file)).
- `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` are the administrator created above.
- `DB_APP_USER` / `DB_APP_PASSWORD` are the user the UI normally uses. Make `DB_APP_PASSWORD` the same as `DB_PASSWORD` in the env file. `DB_APP_HOST` is the host the UI connects from (`127.0.0.1` on the same host).
- `--create-database` creates the `DB_DATABASE` database if it does not exist yet.

Running the same command with `--status` instead of `--create-database` shows which migrations are applied and which are left. With `--dry-run` it only shows what it would do and changes nothing.

Other things to know about the DB:

- **You can also create the tables by hand.** Run `mariadb ... < /usr/share/rproxy-ui/db/schema.sql` and the GRANTs in [db/README.en.md, "DB users"](../../db/README.en.md#db-users). If you do, do not forget the rights on the usage tables (`usage_*`).
- **Create a separate DB user for rproxy-api.** rproxy-api only reads rules at startup, so a read-only user with `GRANT SELECT ON rproxy.forward_rules` is enough. If rproxy-api v0.4 should store API rules, global values or overlays on static rules itself, grant those tables too (same section).
- **A DB where migrations were applied by hand before** has no `schema_migrations` table, so `migrate.mjs` cannot tell how far it got and refuses as it is. In that case, run it once with `--baseline <last applied number>` ([db/README.en.md, "migrate.mjs"](../../db/README.en.md#migratemjs)).
- **If the DB is on another host, use TLS to the DB** (`DB_SSL=true`, plus `DB_SSL_CA` if an internal CA issued the DB's certificate; [README, "TLS to the DB"](../../README.en.md#tls-to-the-db)).

### 3.2 The env file

This section explains the main variables of the env file, where the UI's settings go. All UI settings are passed as environment variables. With the .deb, the env file is `/etc/rproxy-ui/rproxy-ui.env` (owner `root:root`, mode 600). After editing it, restart the UI with `sudo systemctl restart rproxy-ui` for the change to take effect.

First, the variables every setup needs.

| Variable | What it decides | Default |
|---|---|---|
| `HOSTNAME`, `PORT` | The address and port the UI listens on | `127.0.0.1`, `3000` with the .deb (the container image uses `0.0.0.0`; [2.4](#24-containers-docker-etc)) |
| `NEXTAUTH_URL` | The URL users open in the browser | None (always set it) |
| `NEXTAUTH_SECRET` | The key that encrypts sign-in sessions | The .deb generates it at install |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD` | The MariaDB the UI connects to | `DB_PORT` is 3306 |
| `RPROXY_API_URL` | Where rproxy-api's control API is | Filled in at install if rproxy-api is on the same host |
| `RPROXY_API_TOKEN`, `RPROXY_API_TOKEN_FILE` | The token the UI sends to rproxy-api | Same as above (`RPROXY_API_TOKEN_FILE`) |

- **`HOSTNAME`, `PORT`**: with the .deb env file's default (`HOSTNAME=127.0.0.1`), the UI can only be opened from that host. With a static rule of rproxy in front to expose it ([2.1](#21-debian--ubuntu-vm)), leave these as they are. Change them only when other hosts should open it directly, and even then a front end that terminates TLS is the norm ([7.5](#75-security-notes)).
- **`NEXTAUTH_URL`**: write exactly the URL users type into the browser's address bar (e.g. `https://dashboard.example.com`). The UI uses it for the check that recognises requests from other sites (CSRF), the HSTS header (for `https://`), and Keycloak's redirect. The CSRF check compares the `Origin` the browser sends with the request's `Host`, `X-Forwarded-Host` and `NEXTAUTH_URL`. If a proxy in front rewrites `Host` and `NEXTAUTH_URL` differs too, every save is refused with 403 `csrf`, so always set it to the URL users open.
- **`NEXTAUTH_SECRET`**: the .deb writes a random value at install, so you normally leave it alone. Changing it makes all current sessions unreadable, and everyone has to sign in again. When several UIs run, use the same value on all of them (otherwise a request reaching another instance cannot read the session).
- **`DB_*`**: the DB and UI user from [3.1](#31-the-db-mariadb-and-migrations). Match `DB_USER` to `DB_APP_USER` and `DB_PASSWORD` to `DB_APP_PASSWORD`.
- **`RPROXY_API_URL`**: an `http://` or `https://` URL, or the Unix socket `unix:/run/rproxy/api.sock`. On the same host either works, but changing security-related global settings from the UI needs the socket ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).
- **`RPROXY_API_TOKEN`, `RPROXY_API_TOKEN_FILE`**: `RPROXY_API_TOKEN` holds the token itself, `RPROXY_API_TOKEN_FILE` the path of a file containing it. If both are set, `RPROXY_API_TOKEN` is used. With a file, you can replace the token without editing the UI's settings (the file is used from the next request after it changes). Which token to use is explained in [3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes).

Next, the variables about sign-in and who may use the UI. Which ones to set is decided in [4.](#4-sign-in).

| Variable | What it decides | Default |
|---|---|---|
| `RPROXY_UI_AUTH` | The sign-in method (`keycloak`, `token` or `both`) | `keycloak` |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | Where Keycloak is and which client to use, for Keycloak sign-in | None |
| `RPROXY_UI_TOKENS_FILE` | The token file, for token sign-in | None |
| `RPROXY_UI_USER_ROLE` | The name of the role treated as users | Empty (only administrators can use the UI) |

- **`RPROXY_UI_AUTH`**: `keycloak` to use Keycloak, `token` to sign in with tokens only and no Keycloak, `both` to allow either ([4.](#4-sign-in)).
- **`RPROXY_UI_USER_ROLE`**: while it is empty, only people with the administrator role can use the UI. Set it to a role name such as `rproxy-user` when people who are not administrators should also create their own rules ([4.4](#44-roles)).

Last, the variable for several rproxy instances.

| Variable | What it decides | Default |
|---|---|---|
| `RPROXY_UI_NODES` | Where `nodes.yaml`, listing several rproxy instances, is | None (one rproxy) |

With `RPROXY_UI_NODES` set, the rproxy addresses and tokens are read from `nodes.yaml`, so `RPROXY_API_URL`, `RPROXY_API_TOKEN` and `RPROXY_API_TOKEN_FILE` are no longer used ([6.](#6-multiple-nodes-and-groups)).

Besides these, there are variables you set when you need them. Unset, they keep their defaults.

| Variable | What it decides | Default | See |
|---|---|---|---|
| `RPROXY_UI_SESSION_MAX_AGE` | Seconds from sign-in until the session ends | 28800 (8 hours) | [4.2](#42-keycloak) |
| `RPROXY_UI_ROLE_REFRESH_SECS` | How often roles are checked again with Keycloak (seconds) | 300 | [4.2](#42-keycloak) |
| `RPROXY_UI_USER_*`, `RPROXY_UI_PROTECTED_TARGETS` | What users may use | No limits (except the response cache caps `RPROXY_UI_USER_CACHE_MAX_MEMORY` and `RPROXY_UI_USER_CACHE_MAX_ENTRIES`: 16 MiB and 1024) | [4.5](#45-what-users-can-do) |
| `RPROXY_UI_USAGE_SECS` | How often usage is collected (seconds; 0 stops it) | 300 | [README, "Usage"](../../README.en.md#usage-traffic-accounting) |
| `RPROXY_UI_USAGE_HOURLY_DAYS`, `RPROXY_UI_USAGE_DAILY_DAYS` | Days to keep hourly and daily usage | 32, 400 | Same |
| `RPROXY_API_TLS_CERT`, `RPROXY_API_TLS_KEY`, `RPROXY_API_TLS_CA` | Connecting to the control API with a client certificate (mTLS) | None | [3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes) |
| `RPROXY_UI_HA_SYNC_SECS`, `RPROXY_UI_HA_TOKEN_FILE` | The interval of the automatic act / stb resend, and the token keepalived uses | 30, none | [7.3](#73-with-keepalived-act--stb) |
| `RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS`, `RPROXY_UI_TOKEN_LOCKOUT_SECS`, `RPROXY_UI_TRUSTED_PROXIES` | Locking out wrong sign-in tokens, and how the source is identified | 5, 900, none | [7.5](#75-security-notes) |

All variables are described in the comments in the env file and in [the variable list under "Development" in the README](../../README.en.md#development).

### 3.3 Connecting to rproxy-api and the token's scopes

This section explains the settings that connect the UI to rproxy-api's control API, and the permissions (scopes) the UI's token needs. If this is wrong, the screens open but saving rules is refused with 502.

Whoever is operating, the UI talks to rproxy-api with its one token. Who may change which rule is checked by the UI itself, not by rproxy. So the UI's token needs permission for every operation the UI uses.

First, check which format your rproxy-api token file uses.

- **One token per line** (the default when installed on the same host): a token in this format already has `admin`. Nothing to do.
- **The format with permissions (YAML)**: scopes are written per token. In this case, **give the UI's token `scopes: [admin]`.**

In the YAML format, write the UI's token as below. rproxy-api's token file holds only the SHA-256 value, not the token itself.

```yaml
# /etc/rproxy/tokens (rproxy-api's RPROXY_TOKEN_FILE; only SHA-256 values)
tokens:
  - name: rproxy-ui
    sha256: <the value of printf %s "$TOKEN" | sha256sum>
    scopes: [admin]
```

- `name` is a name for telling the token apart, for example in rproxy's logs.
- `sha256` is the SHA-256 of the token you give the UI. Put the UI's token in `$TOKEN` and paste the value printed by `printf %s "$TOKEN" | sha256sum`.
- `scopes: [admin]` allows this token every operation.

Why `admin` is needed becomes clear from the scope each operation of the UI needs:

| Operation the UI uses | Scope needed |
|---|---|
| Listing rules and their details | `rules:read` |
| Adding, changing, deleting and pausing rules | `rules:write` |
| Rules using ACME certificates | `acme:write` |
| Stored certificates chosen by users | `certs:read` |
| Global settings (`/global`) | `admin` |
| Editing and deleting rules created through the rproxy API (administrator screen), and resending on several nodes | `admin` (from rproxy-api v0.4.23) |

The last two rows need `admin`. The last one in particular changed in rproxy-api v0.4.23 (rproxy-api #401). From that version, a token without `admin` may only change the rules, overlays and rule sets it created (others get `403 not_owner`). The UI's "API rules" screen and resending change rules other tokens created, using the UI's token, so they stop working unless the UI's token is `admin`.

A setup that uses neither the API rules screen nor resending, and only needs to change the rules the UI restored when rproxy restarted, may use `rules:read`, `rules:write` and `allow_restored: true` instead of `admin` (rproxy-api's docs/en/API.md). Add `allow_restored` only on rproxy-api v0.4.23 or later, though. v0.4.22 and earlier do not read the token file at all when it has an unknown field, so every token stops working. When going back to an older rproxy-api, remove that line before you do.

**Whether to give the UI's token `persist: true`** is a trade-off. Normally do not.

- **Without it (the normal case)**: overlays on static rules ([5.2](#52-overlays-on-static-rules)) made from the UI live only in rproxy's memory and are lost when rproxy restarts (an upgrade without a restart hands them over). But the UI keeps the desired state of its overlays in its own database (`forward_rule_overlays`, migration `015`), so a lost or different overlay is shown as drift. It appears under "Rules needing attention" on the dashboard and under "Overlay" in the rule's details. An administrator puts it back with "Resend all N drifted overlays", or with "Resend from the UI database" in the details. Overlays belong to a node: even in an act / stb group, the act's overlays are not copied to the stb. The automatic resend only puts back that node's own rows, and they are not part of the check that decides whether a node may be promoted. A token in the one-per-line format has no `persist` either. This normally causes no trouble.
- **With it**: even the ordinary rules the UI creates are treated as rproxy API rules (`origin: api`) and are also stored in rproxy's own table `rproxy_rules` (stored twice, together with the UI's DB). The UI then sees them as "an API rule uses the same key" and refuses changes, resumes and resends with 409 `shadowed`. The UI can no longer manage its rules, so this is not recommended.

The connection settings:

- **After changing the token file**, make rproxy-api read it again with `sudo systemctl reload rproxy-api`.
- **There are two ways to give the UI its token.** Put it in plain text in `RPROXY_API_TOKEN`, or write it on one line in a file only the UI can read (`root:rproxy-ui`, mode 0640) and point `RPROXY_API_TOKEN_FILE` at it. A YAML token file holds only SHA-256 values and not the token itself, so the UI cannot point at `/etc/rproxy/tokens` then.
- **For a Unix socket**, set `RPROXY_API_SOCKET=/run/rproxy/api.sock` and `RPROXY_API_SOCKET_GROUP=rproxy` on rproxy, and `RPROXY_API_URL=unix:/run/rproxy/api.sock` on the UI. A token is still needed over the socket, as over TCP. The reason to use the socket is that the security-related global items (`trusted_proxies`, `access_log`, `crowdsec`, `geoip`, `acme`) can by default only be changed over the Unix socket. rproxy-api's `RPROXY_API_RELOAD_UNIX_ONLY=false` allows TCP too, but it is not recommended.
- **If the UI runs on another host**, use `https://` for the control API. To connect with a client certificate (mTLS) as well, set `RPROXY_API_TLS_CERT` (the UI's certificate), `RPROXY_API_TLS_KEY` (its key) and `RPROXY_API_TLS_CA` (the CA that checks rproxy's certificate).

When this is done, decide the sign-in method ([4.](#4-sign-in)) and start the UI. The commands below start it, make it start at boot, and keep printing its log so you can watch.

```shell
sudo systemctl enable --now rproxy-ui
journalctl -u rproxy-ui -f
```

If a setting is wrong, the UI logs the reason and stops ([7.4](#74-logs)). Once it is up, open `NEXTAUTH_URL` in the browser and sign in. If the "rproxy" tile on the dashboard says "Reachable" and the bottom of the sidebar shows the UI and rproxy-api versions, it is connected to rproxy-api.

## 4. Sign-in

This chapter explains how people sign in to the UI and what signed-in people may do. In the first setup, choose and set up one of 4.1 to 4.3. Then decide how to split administrators and users in 4.4 and 4.5.

The sign-in method is chosen with `RPROXY_UI_AUTH`:

| `RPROXY_UI_AUTH` | Sign-in | Suits |
|---|---|---|
| `keycloak` (default) | Keycloak only | You have Keycloak and want it to manage users |
| `token` | Tokens handed out by the administrator only | You want to start small with only the UI, MariaDB and rproxy, without Keycloak |
| `both` | Either | You are moving to Keycloak, or want a way in when Keycloak is down |

Without `RPROXY_UI_AUTH`, the method is `token` if there is no `KEYCLOAK_ISSUER` but there is `RPROXY_UI_TOKENS_FILE`, and `keycloak` otherwise.

### 4.1 Without Keycloak (tokens)

This section explains signing in with tokens the administrator hands out, without Keycloak. It is the smallest setup: only the UI, MariaDB and rproxy.

The tokens here are for people signing in to the UI. They are different from "the token the UI sends to rproxy-api" in [3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes); do not mix them up.

The administrator makes tokens with the `rproxy-ui-token` command. A new token is shown on screen only once, so hand it to its user right away. The token file only gets the SHA-256 value, not the token itself, so the token cannot be recovered from the file. If one is lost, make a new one.

The commands below make tokens for an administrator `admin` and a user `alice`, list them, and remove `alice`.

```shell
sudo rproxy-ui-token new --name admin --role admin --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token new --name alice --role user  --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token list   --file /etc/rproxy-ui/tokens.yaml
sudo rproxy-ui-token remove --name alice --file /etc/rproxy-ui/tokens.yaml
```

- `new` makes a token and adds it to the file. `--name` is the token's name and must be unique in the file. `--role` is `admin` (administrator) or `user` (user).
- `--file` is where the token file is; it is created if missing. `--owner rproxy-ui` makes the user that runs the UI the file's owner.
- `list` lists the names of the tokens in the file. `remove` deletes the row with that name.

Then write the following in the env file to switch to token sign-in.

```shell
# /etc/rproxy-ui/rproxy-ui.env
RPROXY_UI_AUTH=token
RPROXY_UI_TOKENS_FILE=/etc/rproxy-ui/tokens.yaml
RPROXY_UI_USER_ROLE=rproxy-user        # if you use role: user tokens
```

- `RPROXY_UI_AUTH=token` makes tokens the only sign-in method. `KEYCLOAK_*` is not needed.
- `RPROXY_UI_TOKENS_FILE` points at the file made above.
- Set `RPROXY_UI_USER_ROLE` only if you use `role: user` tokens. Without it, a `role: user` token can sign in but cannot use the UI (explained below).

To sign in, paste the token into the "Access token" field on the sign-in page (`/signin`) and press "Sign in with a token".

Things to know about the token file:

- **The file is owned by `rproxy-ui` with mode 600.** With another owner or mode, the UI does not read it and stops at startup. `rproxy-ui-token` creates it this way.
- **The file is read again as soon as it changes.** Adding or removing tokens needs no UI restart. Removing a row ends the sessions of whoever signed in with that token at the next check.
- **A `role: user` token does not work while `RPROXY_UI_USER_ROLE` is empty.** Signing in gives 403 `no_role` ([4.4](#44-roles)).
- **A row's `sub` becomes the owner of its rules.** Without it the owner is `token:<name>`. Set it to the same value as a Keycloak user's `sub`, and the token handles the same rules as that person's Keycloak sign-in. Give `sub` when making the token, with `--sub <sub>` on `rproxy-ui-token new`.

The file format, the lockout mechanism and other details are in [README, "Token sign-in (without Keycloak)"](../../README.en.md#token-sign-in-without-keycloak).

### 4.2 Keycloak

This section explains signing in with Keycloak. Create one client in Keycloak and write its details in the env file.

Write these three in the env file:

```shell
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<the client's Credentials>
```

- `KEYCLOAK_ISSUER` is the URL of the realm to use (`https://<Keycloak host>/realms/<realm name>`).
- `KEYCLOAK_CLIENT_ID` is the ID of the client created in Keycloak.
- `KEYCLOAK_CLIENT_SECRET` is that client's secret, shown on its "Credentials" tab.

What to set on the Keycloak side:

- **Make the client Confidential** (in the Keycloak console, turn on "Client authentication"). Put `${NEXTAUTH_URL}/api/auth/callback/keycloak` in "Valid redirect URIs". If `NEXTAUTH_URL` is `https://dashboard.example.com`, that is `https://dashboard.example.com/api/auth/callback/keycloak`.
- **Create roles as realm roles.** The UI reads roles from `realm_access.roles` of the access token. To use client roles, change where roles are read with `RPROXY_UI_ROLES_CLAIM` ([README, "Roles (permissions)"](../../README.en.md#roles-permissions)).
- **A realm can be made from `keycloak/realm-rproxy-dev.json`, but it is for development.** It has no password policy or OTP, and its URIs are plain http. For production, fix the password policy, OTP, https URIs and session times ([PRODUCTION.md, "3. Keycloak"](PRODUCTION.md#3-keycloak)).

After sign-in, the session is governed by two variables:

- **`RPROXY_UI_SESSION_MAX_AGE`** (default 8 hours): once this much time has passed since sign-in, the session ends and the person signs in again. Using the UI does not extend it. Lower it if you want shorter sessions.
- **`RPROXY_UI_ROLE_REFRESH_SECS`** (default 300 seconds): roles are checked again with Keycloak at this interval. When you remove a role or disable a user in Keycloak, the UI reflects it after this interval at the latest.

Details: [README, "Sessions"](../../README.en.md#sessions).

### 4.3 Both (`both`)

This section explains allowing sign-in with both Keycloak and tokens. Use it, for example, while moving to Keycloak when some people still use tokens.

With `RPROXY_UI_AUTH=both`, the sign-in page (`/signin`) shows the token field and a "Sign in with Keycloak" button side by side. It needs the settings of both 4.1 and 4.2, so set both `KEYCLOAK_*` and `RPROXY_UI_TOKENS_FILE`.

Note that without `RPROXY_UI_AUTH`, if there is no `KEYCLOAK_ISSUER` and only `RPROXY_UI_TOKENS_FILE`, the method is `token`, not `both`.

### 4.4 Roles

This section explains roles, which split signed-in people into administrators and users. The role decides which rules a person sees and which screens they can use.

| Role | How it is given | What it can do |
|---|---|---|
| Administrator | Keycloak role `rproxy-admin`; `role: admin` for tokens | Handles everyone's rules, on any port and node |
| User | The role named in `RPROXY_UI_USER_ROLE`; `role: user` for tokens | Handles their own rules only, within the limits in 4.5 |
| Neither | — | Cannot use the UI (403 `no_role`) |

The screens only administrators can use include editing API rules, global settings ([5.3](#53-global-settings-acme-geoip-timeouts)) and the act / stb screen ([7.3](#73-with-keepalived-act--stb)).

The role names are set by two variables:

- **`RPROXY_UI_ADMIN_ROLE`** (default `rproxy-admin`): the name of the role treated as administrators. Change it if Keycloak already uses a role with a different name.
- **`RPROXY_UI_USER_ROLE`** (default empty): the name of the role treated as users. While it is empty there are no users, and people without the administrator role cannot use the UI. To let people who are not administrators in, set it like `RPROXY_UI_USER_ROLE=rproxy-user` and give them that role in Keycloak.

This "empty means administrators only" default applies from v0.4.9. Up to v0.4.8, an empty value meant anyone who could sign in was treated as a user.

### 4.5 What users can do

This section explains what users (people who are not administrators) can do and how the administrator limits it. If your setup has no users (`RPROXY_UI_USER_ROLE` is empty), you can skip it.

Users create, see, change and delete only the rules they own. They do not see other people's rules. Static rules are shown to everyone, though, with server file paths hidden as `<hidden>`.

The administrator sets what users may use in the env file. When none of the variables in the table below is set, nothing is limited.

| Variable | What it decides | Outside it |
|---|---|---|
| `RPROXY_UI_USER_PORTS` | Ports users may listen on | 403 `port_not_allowed` |
| `RPROXY_UI_USER_NODES` | Nodes users may touch | 403 `node_not_allowed` |
| `RPROXY_UI_USER_TARGETS` | Addresses and names users may use as targets | 403 `target_not_allowed` |
| `RPROXY_UI_USER_CERTS` (`_BY_ROLE`, `_BY_SUB`) | Stored certificates users may choose | 403 `cert_not_allowed` |
| `RPROXY_UI_PROTECTED_TARGETS` | Destinations users may never use, even if in the allowlist | 403 `target_not_allowed` |

- **`RPROXY_UI_USER_PORTS`**: a range such as `1024-65535`. Use it to keep users from taking ports such as 443 that the administrator's services use.
- **`RPROXY_UI_USER_NODES`**: node names such as `node1,node2`. Use it with several rproxy instances to decide which nodes users may touch ([6.](#6-multiple-nodes-and-groups)).
- **`RPROXY_UI_USER_TARGETS`**: CIDRs, IP addresses and host names (forms like `*.example.com` too). Setting it in production is recommended, so users cannot forward to any server on your network.
- **`RPROXY_UI_USER_CERTS`**: limits, by name prefix, which of the certificates the administrator stored in rproxy users may choose. To separate tenants, assign prefixes per role (`_BY_ROLE`) or per person (`_BY_SUB`).
- **`RPROXY_UI_PROTECTED_TARGETS`**: destinations to protect even inside a range the allowlist covers, such as a DB on another host.

Some rules apply regardless of these variables:

- **Some targets are refused by default.** Even with no limits set, loopback, link-local (including the cloud metadata address), unspecified, multicast and broadcast addresses cannot be used as targets. If users really need one, put a CIDR inside that range (e.g. `127.0.0.1/32`) in `RPROXY_UI_USER_TARGETS` to allow it (a wide range such as `0.0.0.0/0` does not).
- **Some targets are always refused.** The address and port pairs of the control API, the UI and the DB cannot be used even if they are in the allowlist. This stops users from reaching them through rproxy. Destinations in `RPROXY_UI_PROTECTED_TARGETS` are treated the same way.
- **Users cannot write server file paths (`*_file` fields)** (403 `file_not_allowed`). rproxy can use any key it can read, so this keeps users from pointing at someone else's certificate key. For TLS certificates, users choose from those the administrator stored through rproxy's certificate API.
- **They cannot add OIDC middlewares.** Response caches can only be used within limits (by default 16 MiB and 1024 entries per middleware; `RPROXY_UI_USER_CACHE_MAX_MEMORY`, `RPROXY_UI_USER_CACHE_MAX_ENTRIES`).
- **Values that were already there can be saved again unchanged.** Even after limits are narrowed, a user can still change other fields of their own rules.

All the rules: [README, "Limits for users (file paths and destinations)"](../../README.en.md#limits-for-users-file-paths-and-destinations).

## 5. Daily use

This chapter covers the work you do after signing in. It goes in this order: adding and changing rules, adding to static rules, changing rproxy-wide settings, reverting from the history, exporting and importing, and fixing drift. The list of screens is in [README, "Usage"](../../README.en.md#usage).

### 5.1 Adding and editing rules

This section explains the form for creating and changing rules.

Create a new rule with "New rule" (`/rules/new`) on the dashboard. To change an existing rule, open its details and press "Edit". Both use the same form, split into tabs.

| Tab | What it decides |
|---|---|
| Basic | Which port to listen on and where to forward |
| L7 (HTTP) | Where to send HTTP requests, based on their contents |
| TLS / DTLS | How encrypted traffic is handled |
| Mail (STARTTLS) | How mail STARTTLS is handled |
| Limits & GeoIP | Protection such as connection, bandwidth and country limits |
| Advanced | Fine tuning such as client address handling and timeouts |

The main fields on each tab:

- **Basic**: profile (templates per use), protocol (tcp / udp), listen address and listen port (range end optional), target address and target port, "Add backend" (several targets and how to balance them), and "Route with L7 (HTTP)". Choosing a profile fills in ports and settings for uses such as HTTPS, mail or TURN, so starting from one is quicker.
- **L7 (HTTP)**: routes (`match` expressions deciding which requests), services (targets), middlewares (processing on the way) and what to do when no route matches.
- **TLS / DTLS**: the mode (explained below), per-server-name destinations, connections matching no server name, server certificate, intermediate CA and private key ("+ Add ACME certificate" and "+ Add a stored certificate" too), client certificate verification (mTLS), ALPN and re-encryption to the target.
- **Mail (STARTTLS)**: SMTP / IMAP / POP3 STARTTLS. Only on TCP rules that terminate TLS.
- **Limits & GeoIP**: labels, L4 limits, bandwidth caps, GeoIP and passive health checks.
- **Advanced**: client IP handling (source_ip; how the client's address is passed to the target), UDP idle timeout, TCP relay timeouts, time to connect to a target, allowed sources (allow_from) and accepting PROXY protocol.

Which tabs to use for each kind of rule:

- **L4 (relay TCP / UDP as is)**: a rule that passes whatever arrives to the target without looking inside. "Basic" is enough. To limit who may connect, list CIDRs or IPs in allow_from under "Advanced", one per line.
- **TLS**: choose the mode under "TLS / DTLS". There are three. passthrough relays the encrypted traffic without decrypting it. sni looks at the server name (SNI) sent at the start of the connection and picks the target per name. terminate makes rproxy hold the certificate and decrypt. To terminate, point at a certificate and key (paths on the rproxy-api host, owned by `rproxy-api`) or get one with ACME. To route by name, use the per-server-name destinations.
- **HTTP (L7)**: a rule that picks the target from the contents of the HTTP request, such as Host or path. On a TCP rule, choose "Route with L7 (HTTP)" and build routes and services under "L7 (HTTP)". The profile "HTTPS reverse proxy (L7)" is a template. L4 or L7 can only be chosen when the rule is created.

Things to keep in mind when using the form:

- **The fields shown depend on the connected rproxy.** The UI looks at `features` of rproxy-api's `GET /capabilities` and shows only the fields that rproxy says it supports. If a newer field is missing on an older rproxy but the rule has a value for it, the value is kept read-only and sent as is, so saving does not drop it.
- **Client IP handling and the port range cannot be changed after the rule is created.** To change them, create the rule again.
- **You can see what changes before saving.** If rproxy returns `features.dry_run`, "Show the difference" shows what saving would change on rproxy.
- **Rules can be stopped without deleting them.** "Pause" in the list or details stops a rule, and "Resume" brings it back with the same contents ([README, "Pausing a rule"](../../README.en.md#pausing-a-rule)).

Detailed explanations per topic are in these README sections: [L7](../../README.en.md#l7-http-rules), [Gateway API fields](../../README.en.md#gateway-api-l7-and-tls-fields), [response cache](../../README.en.md#response-cache-cache), [multiple targets](../../README.en.md#multiple-targets), [SNI passthrough](../../README.en.md#passing-some-server-names-through-without-termination-sni-passthrough), [PROXY protocol](../../README.en.md#accepting-proxy-protocol-from-a-front-end-and-client-ip-handling-per-server-name), [TCP relay timeouts](../../README.en.md#tcp-relay-timeouts-idle_timeout-half_close_timeout), [time to connect](../../README.en.md#time-to-connect-to-a-target-connect_timeout), [UDP server names](../../README.en.md#routing-udp-by-server-name-dtls-quic), [ACME](../../README.en.md#obtaining-certificates-with-acme), [v0.4 settings](../../README.en.md#v04-rule-settings-limits-bandwidth-geoip-labels).

### 5.2 Overlays on static rules

This section explains adding HTTP routes and the like from the screens to static rules written in rproxy's settings file. A typical use: the administrator provides an HTTPS entry point in the settings file, and users add routes for their own services to it.

Static rules themselves cannot be changed from the screens. With rproxy-api v0.4.23 or later (`features.static_overlay`), "Overlay" in a static rule's details adds to it while the file stays as it is.

**What you can add**

- When the rule has `http`: http routes, services and middlewares.
- Without `http`: per-server-name destinations (`tls.routes`), when the TLS mode is sni, or terminate without client certificate verification.

**How it takes effect**

- Overlay routes only receive requests that matched none of the file's routes. They cannot take over the file's routes.
- Names the file already has cannot be used (409 `overlay_conflict`).
- Overlays belong to a node. They are not combined per group; each node keeps only its own rows.

**Saving**

- Saving replaces the whole overlay. If someone else changed it after you opened the screen, the save is refused with 412. Then use "Reload" to load the current contents and try again.
- People who are not administrators may only change overlays they created. They cannot use the settings file's services, nor anything with secret files.

**When rproxy restarts (drift and resend)**

The UI keeps the desired state of overlays in its own database (`forward_rule_overlays`, migration `015`). With a normal UI token (no `persist`), an overlay disappears from rproxy when rproxy restarts, but the UI shows it as drift ("The overlay in the UI database is missing on rproxy") and can resend it ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

- **Who can resend**: whoever may change the overlay, that is, administrators and its creator. Only administrators can resend several at once.
- **The check before resending**: it depends on who resends and how. There are three cases.
  - **An administrator resends one overlay from the details page**: it is sent without a check.
  - **A user resends one of their own overlays from the details page**: it is checked against the current limits of the person resending (the user). rproxy's current overlay is used as the previous content, so values still on rproxy pass if unchanged. If the allow list was narrowed since and a value no longer fits, it is not sent.
  - **Bulk resends (administrators) and the automatic act / stb resend**: if a user wrote it last, it is checked again as its creator with no previous content. So values a user could only keep "because they were already there" (such as ones an administrator added) are refused too; an administrator then changes and saves it in the details. If an administrator wrote it last, it is not checked. One whose creator is unknown is not sent.

  With an empty `RPROXY_UI_USER_ROLE` (administrators only), the check as creator is skipped. The check runs only right before sending, so `ha/ready`, which keepalived polls, does no name resolution.
- **A save whose answer never came**: a save whose answer from rproxy never came (timeout, 5xx) stays in the UI database and the history, and is resent as drift.
- **Removing**: removing an overlay also deletes its row in the UI database.

**In act / stb groups**

Each node keeps only its own rows. The automatic act / stb resend and "Sync this node" put back only that node's rows; nothing is copied from act to stb. Overlay drift is shown on the act / stb screen but is not part of the check that decides whether a node may be promoted (`ha/ready`).

**Cleaning up leftover rows**

A row left only in the UI database, because its node was removed from `nodes.yaml` or its static rule was removed from the settings file, is deleted with "Remove from the UI database only" on an administrator's dashboard.

Details: "Overlays on static rules" under [README, "Usage"](../../README.en.md#usage).

### 5.3 Global settings (acme, geoip, timeouts)

This section explains changing, from the screens, settings that apply to all of rproxy rather than to one rule (global settings). Examples are HTTP timeouts, the cap on UDP sessions, and the ACME and GeoIP settings. Administrators only.

It needs rproxy-api v0.4.19 or later (`features.global_api`) and `admin` on the UI's token ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)). Open "Global settings" (`/global`) from "rproxy features & settings" (`/system`).

The steps:

1. The screen shows, per item, the value in force, where it comes from (settings file / environment / API / default) and how it can be changed. Items set in the settings file or environment take precedence and cannot be changed from the screen.
2. Enter the values to change and use "Check the changes" (dry run) to see what would change. Nothing changes yet.
3. "Apply" puts it into effect. If you chose a group, it is sent to all its nodes, and if one refuses, all are rolled back. Choosing "Clear the API value (back to the default)" for an item and applying removes the value set from the screen and returns it to the default.

Things to know about the items:

- **Items that take effect at once can be changed.** Examples are `http.timeouts` (timeouts) and `udp_max_sessions`.
- **`geoip` and `acme` have conditions.** They need rproxy-api v0.4.22 or later (`features.global_api_geoip`, `global_api_acme`) and can only be changed on nodes connected over the Unix socket. The files the GeoIP and ACME settings point at must be directly under rproxy-api's `RPROXY_API_GEOIP_DIR` and `RPROXY_API_ACME_DIR` respectively. ACME's `storage` stays at the default location or is a directory under `RPROXY_API_ACME_DIR`.
- **Secret values come back as `***`.** When you change `acme`, enter the secret fields again.
- **rproxy stores the values.** Values changed on screen are stored by rproxy in the DB table `rproxy_global` (migration 013) and restored after a restart.

Details: "Global settings" in [README, "v0.4 rule settings"](../../README.en.md#v04-rule-settings-limits-bandwidth-geoip-labels).

### 5.4 History and revert

This section explains looking at the history of rule changes and going back to an earlier version. Use it to undo a rule you changed or deleted by mistake.

"History" (`/history`) lists when, who and what changed. A rule's details show that rule's history too.

- **Reverting**: press "Revert to this version" on the row you want, and the rule goes back to its contents at that point. Deleted rules can be created again. The revert is recorded in the history too.
- **What you can see**: users see the history they made and the history of the rules they own now. Administrators see everything.
- **What cannot be reverted**: changes to node overrides (`OVERRIDE`, [6.](#6-multiple-nodes-and-groups)) and overlays (`OVERLAY`, [5.2](#52-overlays-on-static-rules)) appear in the history but cannot be reverted.

Details: [README, "Change history and revert"](../../README.en.md#change-history-and-revert).

### 5.5 Export and import

This section explains writing rules out to a file and reading them in from one. Use it to keep a copy, to move to another UI, or to bring rules from rproxy's settings file under the UI's management.

**Exporting**: "Export (JSON)" on the dashboard writes out your rules (all rules for administrators) as JSON.

**Importing**: "Import" (`/rules/import`) reads a UI export or an rproxy settings file (YAML / JSON). It goes in three steps:

1. "Check" validates each rule. Nothing changes at this step.
2. For rows whose key already has a rule, choose per row with "Replace" whether to replace it.
3. "Import" adds or replaces the rules one at a time.

Details: [README, "Export and import"](../../README.en.md#export-and-import).

### 5.6 Drift and resend

This section explains fixing a node whose rules came to differ from the content of the UI's DB, when you use several nodes. With a single rproxy you can skip it (for overlay drift, see [5.2](#52-overlays-on-static-rules)).

With several nodes, the UI compares the rules actually running on each node with the UI's definition (the DB), and shows differing fields as "drift". It happens when, for example, saving failed on just one node, or someone changed a node by hand.

- **Finding and fixing it**: on the node's tab of a rule's details, look at "Difference from the UI's definition". "Resend to this node" sends the UI's definition to that node only and brings it back in line.
- **What a resend does**: differences a partial change (PATCH) cannot fix are fixed by recreating the rule. Rules missing on the node are created. Rules paused in the UI but running on the node are deleted.
- **Who can use it**: the rule's owner and administrators. A resend records `RESEND` and the node in the history.
- **The token's permission**: from rproxy-api v0.4.23, the UI's token needs `admin` ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

## 6. Multiple nodes and groups

This chapter explains managing several rproxy instances from one UI. Use it when you put an rproxy at each site, or run two for redundancy. With a single rproxy you do not need this chapter.

One rproxy as seen from the UI is a node, and a set of nodes that should have the same rules is a group ([1.2](#12-terms-used-in-this-guide)). Nodes and groups are written in a file called `nodes.yaml`. The example below puts two nodes, `node1` and `node2`, into a group `ha` made redundant with act / stb.

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

- **`nodes`**: the list of nodes. `name` is the node's name, `url` is that rproxy's control API (`http(s)://` or `unix:/run/rproxy/api.sock`), and `token_file` is the file holding the token sent to that node. Tokens are read from files, not kept in the DB. Make the files readable by the user that runs the UI (`rproxy-ui` with the .deb).
- **`groups`**: the list of groups. `nodes` names the nodes to put together.
- **`mode`**: how the group behaves. `single` (default) is all nodes running the same rules at once. `active_standby` is only the one node holding the VIP through keepalived or similar (act) receiving traffic while the others wait (stb) ([7.3](#73-with-keepalived-act--stb)). `active_standby` needs two or more nodes.
- **`vip`**: the VIP of an `active_standby` group. The UI checks which node holds this address and shows which one is act. Without it, the rule's listen address is used to decide, but because the stb does not hold the VIP, rules normally listen on `0.0.0.0`, so setting `vip` is recommended. It can only be set on `active_standby` groups.
- **`default_target`**: the node or group selected first on the add-rule screen. Optional.

A group can also have `auto_resend` ([7.3](#73-with-keepalived-act--stb)).

Set it up in this order:

1. **Apply migrations `006` to `009` to the DB.** If you used `migrate.mjs`, this is already done.
2. **Create the view each node's rproxy reads.** rproxy reads all of `forward_rules` at startup, so each node gets a view that shows only "rows for its own node and for groups that include it". `db/node-view.mjs` prints the SQL ([README, "Restoring at rproxy startup (a view per node)"](../../README.en.md#restoring-at-rproxy-startup-a-view-per-node)).
3. **Set each rproxy's `RPROXY_NODE_NAME` to the node's name in `nodes.yaml`.**
4. **Set `RPROXY_UI_NODES` in the UI's env file and restart the UI.** If `nodes.yaml` has errors, the UI logs the reason and does not start.

Once set up, the screens change like this:

- **More choices and tabs appear.** With two or more nodes, the add screen gets a "Node / group" choice, and the dashboard and rule details get "All / per node" tabs.
- **A group's rules are sent to all its nodes.** If one node fails, the others are rolled back.
- **Parts can differ per node.** "Settings for this node only (override)" on a node's tab of the rule details changes the listen address, targets and allow_from per node.
- **Rules can be moved, and stopped together.** "Copy / move" moves a rule to another node or group. "Pause all" on a node's tab stops all that node's rules at once.

Details: [README, "Several rproxy instances (nodes and groups)"](../../README.en.md#several-rproxy-instances-nodes-and-groups).

## 7. Operations

This chapter covers the ongoing work once things are running: upgrading, backups, working with keepalived, logs and security checks, in that order.

### 7.1 Upgrading

This section explains how to upgrade rproxy-ui and which combinations need care.

With the .deb, upgrade with apt like any other package.

```shell
sudo apt update && sudo apt upgrade
```

- **Settings and tokens are kept.** Services that were running are restarted after the upgrade.
- **For versions that change tables, apply the migrations first.** The release notes of such versions list the migrations needed. Running `migrate.mjs` applies only the missing ones ([3.1](#31-the-db-mariadb-and-migrations)). On Kubernetes, the Job applies them during `helm upgrade`.
- **Check rproxy-api's version too.** The minimum rproxy-api version the UI needs is **v0.3.5**. Newer fields are decided by rproxy-api's `features` and hidden when missing. The current versions appear at the bottom of the sidebar and on the dashboard. When rproxy-api is too old, or its version is unknown, the dashboard shows a notice.

Three combinations need particular care when upgrading:

- **Upgrading rproxy-api to v0.4.23 or later**: make the UI's token `admin` first ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)). Otherwise the API rules screen and resending stop working.
- **Upgrading the UI to v0.4.9 or later**: check `RPROXY_UI_USER_ROLE`. From v0.4.9, while it is empty only administrators can use the UI. If people who are not administrators used it before, set it before upgrading ([4.4](#44-roles)).
- **Node.js** must be 22.23.4 or later (24.22.1 or later on the 24 line). An older one logs a warning at startup.

Details: [PRODUCTION.md, "7. Updates"](PRODUCTION.md#7-updates).

### 7.2 Backup

This section explains what to keep a copy of so the UI can be restored.

- **DB**: the most important tables are `forward_rules` (the source of truth for rules) and `forward_rules_log` (history). Dumping the whole database, other tables included, with `mariadb-dump --single-transaction` is the easiest. `--single-transaction` gives a consistent snapshot without stopping the UI.
- **Files**: keep `/etc/rproxy-ui/rproxy-ui.env` (it contains secrets such as `NEXTAUTH_SECRET` and passwords), `tokens.yaml`, `nodes.yaml`, the node tokens and `ha.tokens`. On the rproxy side, keep `/etc/rproxy`.
- **Export**: "Export (JSON)" on the dashboard is also a copy of the rules ([5.5](#55-export-and-import)).

How to take backups, the order of restoring and how to check afterwards are in rproxy-api's [docs/en/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/en/BACKUP.md). For Kubernetes, see [KUBERNETES.md, "Backup and restore"](KUBERNETES.md#backup-and-restore).

### 7.3 With keepalived (act / stb)

This section explains combining an `active_standby` group ([6.](#6-multiple-nodes-and-groups)) with keepalived so the VIP moves automatically. Use it when two rproxy instances should hand one address back and forth so traffic continues if one goes down.

The problem in this setup is a stb being promoted and taking the VIP while its rules still differ from the act (that is, from the DB's definition). Traffic would then run on old rules the moment it switches. The UI prevents this in two ways.

**Automatic resend**: every `RPROXY_UI_HA_SYNC_SECS` (default 30 seconds) the UI checks `active_standby` groups and automatically resends rules to drifted stb nodes. For a group where you do not want this, set `auto_resend: false` in `nodes.yaml`; that group then only shows the drift.

**Checks from keepalived**: keepalived's track_script and notify_master call the UI's `/api/forward/ha/ready` and `/api/forward/ha/notify`. `ha/ready` returns 200 when the node is in sync and 503 when it is not, so track_script uses it to lower the priority of a node that is not in sync. `ha/notify` makes the UI resend to a node right after it is promoted. Both are called with the token in `RPROXY_UI_HA_TOKEN_FILE` instead of a sign-in session.

Examples and how to check:

- **Scripts and example settings** are in [contrib/keepalived](../../contrib/keepalived/README.en.md) (`/usr/share/doc/rproxy-ui/examples/keepalived/` with the .deb).
- **Checking on screen**: the "act / stb" screen (`/ha`, administrators only) shows whether each node is in sync. A node that is not can be resent with "Sync this node". The screen also guides you through going back to the original act (failback).
- **Redundancy of the UI itself**: the UI can run on any number of instances. Usage collection and resending are done by one instance at a time through a DB lock, so they do not overlap. When running several, use the same `NEXTAUTH_SECRET` on all ([3.2](#32-the-env-file)).

### 7.4 Logs

This section explains which logs to read when something does not work.

- **.deb**: read them with `journalctl -u rproxy-ui` (`-f` keeps following). If a setting is wrong at startup (`nodes.yaml`, token file permissions, DB TLS, mTLS combinations), it stops with the reason. Each node's rproxy-api version is also logged at startup.
- **When rproxy refuses the UI's token** (401, 403, 429), the UI's log shows why and what to check.
- **Kubernetes**: read them with `kubectl -n rproxy-ui logs deploy/rproxy-ui`. When migrations fail, use `kubectl -n rproxy-ui logs job/rproxy-ui-migrate` (the name with the release name `rproxy-ui`; the naming rule is at the end of [KUBERNETES.md, "Backup and restore"](KUBERNETES.md#backup-and-restore)).
- **rproxy-api's logs**: what happened on the rproxy side, such as the records of creating, changing and deleting rules (`event: "audit"`), is in rproxy-api's logs (`/var/log/rproxy/`).

### 7.5 Security notes

This section covers what to watch in particular when making the UI usable from outside.

- **Requests from other sites (CSRF)**: APIs that change state refuse requests sent from other sites with 403 `csrf`. This keeps pages on other sites from using a signed-in person's browser to change rules. If you put a reverse proxy in front of the UI, pass `Host` or `X-Forwarded-Host` to the UI and do not drop the `Origin`, `Referer` or `Sec-Fetch-*` headers. Set `NEXTAUTH_URL` to the URL users open.
- **Token lockout**: after more than 5 wrong tokens in 15 minutes from one source, wrong tokens from that source are refused with 429 for 15 minutes (the count and times are `RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS` and `RPROXY_UI_TOKEN_LOCKOUT_SECS`). Correct tokens still pass during the lockout, so that someone sending wrong tokens cannot lock out other people who appear to come from the same source. As a result it does not limit the number of guesses; the only protection is the token's strength. Always make tokens with `rproxy-ui-token`.
- **Behind an HTTP proxy**: behind nginx, an Ingress and the like, put only that proxy's addresses in `RPROXY_UI_TRUSTED_PROXIES`. The UI trusts the `X-Forwarded-For` arriving from there to identify the source, so a wide range lets others fake the source. With rproxy (L4) in front it is not needed, since it does not add `X-Forwarded-For`.
- **Exposing it**: a UI installed from the .deb listens only on `127.0.0.1` by default. To expose it, terminate TLS with a static rule of rproxy and narrow it to the users' address range with `allow_from`.
- **File owners**: rproxy-api only reads certificates, keys and secret files it owns (`rproxy-api:rproxy`, mode 0640; [PRODUCTION.md, "File owners"](PRODUCTION.md#file-owners-os-users-and-groups)).

Response headers, sessions and user limits as a whole: [README, "Security"](../../README.en.md#security).

## 8. Troubleshooting

This chapter explains how to find the cause and fix when an error appears on screen.

After the error text on screen there is a code such as `no_role` or `not_owner`. Look up that code in the tables below. The tables are grouped by where the cause lies:

- 8.1 Sign-in and permissions
- 8.2 rproxy refused the UI's token (502)
- 8.3 rproxy is unreachable, or rproxy refused
- 8.4 Overlays on static rules
- 8.5 Multiple nodes
- 8.6 The DB and migrations
- 8.7 Startup and versions

When rproxy refuses the UI's token, the UI returns it to the screen as 502. Read a 502 on screen as "a problem between the UI and rproxy" and check the UI's token.

Codes not listed here are explained on screen. When unsure, read the UI's logs ([7.4](#74-logs)) together with rproxy-api's logs.

### 8.1 Sign-in and permissions

| What you see | Why | What to do |
|---|---|---|
| 403 `no_role` | No administrator role, and `RPROXY_UI_USER_ROLE` is empty or the person lacks that role | Give the person a role, or set `RPROXY_UI_USER_ROLE`. For tokens, check `role` in the file's row ([4.4](#44-roles)) |
| 429 at sign-in | Lockout after repeated wrong tokens | Wait, or sign in with a correct token (correct tokens pass; [7.5](#75-security-notes)) |
| 403 `csrf` | The request was taken as coming from another site | Reopen the screen. Check that the proxy in front passes `Host` and `Origin`, and that `NEXTAUTH_URL` is the URL users open ([7.5](#75-security-notes)) |
| 403 `port_not_allowed`, `file_not_allowed`, `target_not_allowed`, `cert_not_allowed`, `node_not_allowed`, `middleware_not_allowed`, `cache_limit` | Outside what users are allowed | See [4.5](#45-what-users-can-do). If needed, the administrator widens what users may use |

### 8.2 rproxy refused the UI's token (502)

The codes in this table are fixed in the settings of the UI's token ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

| What you see | Why | What to do |
|---|---|---|
| 502 `forbidden` ("The rproxy token used by the UI lacks the permission for this.") | The UI's token lacks scopes, or the action is outside the token's `allow_listen_ports` / `allow_certs` | Make the UI's token `admin`. `allow_listen_ports` and `allow_certs` apply even to `admin`, so widen or remove them |
| 502 `not_owner` | rproxy-api v0.4.23 or later, and the UI's token is not `admin` | Explained below |
| 502 `global_forbidden` | The UI's token lacks the `admin` that global settings need | Make the UI's token `admin` |
| 502 `rproxy_unauthorized` | The UI's token is wrong or expired | Compare `RPROXY_API_TOKEN` / `RPROXY_API_TOKEN_FILE` with rproxy's token file |
| 502 `rproxy_locked_out` | Repeated authentication failures made rproxy block the UI for a while | Fix the token or client certificate. It clears when the time passes |

**502 `not_owner`** appears on rproxy-api v0.4.23 or later when the UI's token is not `admin`. It happens when editing or deleting API rules, resending, or changing rules restored at an rproxy restart. Make the UI's token `admin` and have rproxy-api read it again with `sudo systemctl reload rproxy-api`. In a setup that uses none of those operations, `allow_restored: true` is enough instead of `admin`. Add `allow_restored` only on rproxy-api v0.4.23 or later, though: v0.4.22 and earlier do not read the token file at all when it has an unknown field, so every token stops working. Remove it before going back to an older version.

### 8.3 rproxy is unreachable, or rproxy refused

| What you see | Why | What to do |
|---|---|---|
| `unreachable` ("Could not connect to rproxy.") | rproxy-api is down, the URL is wrong, or the socket's group setting | Check that it runs with `systemctl status rproxy-api`. Check `RPROXY_API_URL` and whether `rproxy-ui` is in the socket's group |
| 400 `unsupported` | A combination rproxy does not support | Explained below |
| 403 `global_unix_only` | A security-related global item was changed through a node connected over TCP | Set that node's url to the `unix:/…` socket ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)) |
| 409 `static` | Same key as a static rule. Static rules cannot be changed from the screens | Edit rproxy's settings file, or use an overlay ([5.2](#52-overlays-on-static-rules)) |
| 409 `shadowed` | rproxy uses the same key for an API rule or a rule set's rule | Delete one of them or change the key |
| 409 `file_in_use` | A user used a settings-file service or middleware with secret files in an overlay. Or rproxy refused because it points at a key or secret file used by a rule of another token (or of the settings file) | Ask an administrator, or use your own service or another file |
| `tls_config`, file owner refusals | Wrong certificate or key path or contents, or wrong owner or mode | Make the files `rproxy-api:rproxy` with mode 0640. The screen shows how to fix it |

**400 `unsupported`** appears when a combination rproxy does not accept was sent: switching L4 / L7, changing client IP handling or the port range, `connect_timeout` on an old rproxy, UDP sni on an old rproxy, and so on. If it is a field that cannot change after creation, create the rule again as a new one. If rproxy is too old, upgrade rproxy-api. The text after the error says which it is.

### 8.4 Overlays on static rules

These appear with the overlays of [5.2](#52-overlays-on-static-rules).

| What you see | Why | What to do |
|---|---|---|
| 409 `overlay_conflict` | The overlay uses a name the settings file has | Use another name |
| 412 `precondition_failed` | Someone created or changed the overlay after you opened the screen | "Reload" to load the current contents, then try again |
| 403 `overlay_not_owner` | A user tried to change an overlay someone else created | Ask an administrator |
| 403 `file_service_not_allowed` | A user used a settings-file service from an overlay | Define your own service inside the overlay |
| 500 `overlay_db` ("no overlay table (forward_rule_overlays)") or a permission error | Migration `015` is missing or the UI's user lacks rights | Apply `015` and grant rights to the UI's user. Nothing was sent to rproxy in this case |

Three cases do not fit in the table:

**Overlays disappeared after rproxy restarted**: the UI's token has no `persist` (the normal setup), so the overlay lived only in rproxy's memory. It is not a migration `014` problem. Put it back with "Resend all N drifted overlays" under "Rules needing attention" on the dashboard, or "Resend from the UI database" in the rule's details ([3.3](#33-connecting-to-rproxy-api-and-the-tokens-scopes)).

**Saving an overlay says "rproxy could not store it in the database (rproxy_rule_overlays …)"**: rproxy tried to store, in its own DB, an overlay made with a `persist: true` token, and migration `014` was missing or rproxy's DB user lacked rights. The overlay works now but is lost when rproxy restarts. Apply `014` and grant rights to rproxy's user.

**An overlay shows "Refused when checked again as its creator" on the act / stb screen**: the creating user's limits (allow list, nodes, ports, and so on) changed after it was saved, or the creator is no longer known, so it is held back instead of being resent. An administrator changes and saves it in the details, or removes the overlay.

### 8.5 Multiple nodes

These appear with the setup in [6.](#6-multiple-nodes-and-groups).

| What you see | Why | What to do |
|---|---|---|
| 409 `target_conflict` | A rule with the same key is already on a place whose nodes overlap | Choose another node / group |
| 400 `target_required` | No place (node / group) was given | Choose a node / group |
| 400 `unknown_target` | A name not in `nodes.yaml` was given | Choose the name again and check `nodes.yaml` |
| 409 `readonly_node` | A write to a Kubernetes Gateway's rproxy (read-only) | Change the Gateway API resources instead |

### 8.6 The DB and migrations

| What you see | Why | What to do |
|---|---|---|
| "The usage_* tables are missing (…010_usage.sql)", "usage_hourly and usage_daily have no attr column (…011_usage_attr.sql)" | The usage migrations are missing | Apply `010` and `011` (`migrate.mjs`) |
| 500 `nodes_db` ("Cannot update forward_rule_targets …") | The migrations for several nodes (`006`, `007`) are missing, or rights are missing | Apply them and grant rights to the UI's user |

Errors with the overlay tables (`014`, `015`) are in [8.4](#84-overlays-on-static-rules).

### 8.7 Startup and versions

| What you see | Why | What to do |
|---|---|---|
| The UI does not start | Errors in `nodes.yaml`, the token file's owner or mode, DB TLS settings, an `http://` URL with `RPROXY_API_TLS_*`, and so on | Read the reason in `journalctl -u rproxy-ui` and fix it ([7.4](#74-logs)) |
| A version notice on the dashboard | rproxy-api is older than v0.3.5, or does not return its version (before v0.3.18) | Upgrade rproxy-api |
