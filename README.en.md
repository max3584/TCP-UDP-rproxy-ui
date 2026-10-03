# TCP-UDP-rproxy-ui

[![CI](https://github.com/max3584/TCP-UDP-rproxy-ui/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/max3584/TCP-UDP-rproxy-ui/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/max3584/TCP-UDP-rproxy-ui)](https://github.com/max3584/TCP-UDP-rproxy-ui/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.18.1-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovatebot)](https://github.com/max3584/TCP-UDP-rproxy-ui/issues?q=is%3Aissue+is%3Aopen+%22Dependency+Dashboard%22)

日本語: [README.md](README.md)

A web UI for managing the forwarding rules of [rproxy-api](https://github.com/max3584/rproxy-api) (Next.js, sign-in with Keycloak, rules stored in MariaDB).
Versions are released with the same numbers as rproxy-api (UI vX.Y.Z is paired with rproxy-api vX.Y.Z; see [docs/en/RELEASING.md](docs/en/RELEASING.md)).

## Installation (Debian / Ubuntu)

It can be installed from the same apt repository as rproxy-api (`rproxy-ui`, a single package for any CPU).
Node.js 20.18.1 or later is required (Next.js 16 needs 20.9, and undici 7, used for Unix sockets, needs 20.18.1). On Debian 13 the standard `nodejs` is fine. Ubuntu 24.04's standard nodejs is 18, so install nodejs (22, for example) from [NodeSource](https://github.com/nodesource/distributions) first.

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-ui
```

- The settings are in `/etc/rproxy-ui/rproxy-ui.env` (600). Fill in `NEXTAUTH_URL`, `KEYCLOAK_*` and `DB_*`, then start it with `sudo systemctl enable --now rproxy-ui` (installing alone does not start it)
- `NEXTAUTH_SECRET` is generated at install time. If rproxy-api is on the same host, its token and API URL are filled in too
- It listens on `127.0.0.1:3000` by default (`HOSTNAME` / `PORT`). To expose it, put an rproxy static rule in front of it (TLS termination, routing by server name, `allow_from`; see "Static rules and exposing the dashboard" in the rproxy-api README)
- Create the DB tables with `/usr/share/rproxy-ui/db/schema.sql` (see [db/README.en.md](db/README.en.md))
- `server.js` in `/usr/lib/rproxy-ui` (the Next.js standalone output) runs as the `rproxy-ui` user. Logs are in `journalctl -u rproxy-ui`

## Development

First, run the development server:

```bash
npm ci        # install dependencies with npm (package-lock.json)
npm run dev
```

Required information:

+ NEXTAUTH settings
+ Database settings (`DB_PORT` defaults to 3306 when omitted)
+ Keycloak settings (a confidential client. Roles are read from the realm roles in the access token's `realm_access.roles`; see "Roles" below)
+ The URL and token of the rproxy-api control API (`RPROXY_API_TOKEN` is needed only when rproxy is started with `--token-file`)
  + If the rproxy tokens have permissions (YAML), the UI's token needs the scopes `rules:read` (list and details) and `rules:write` (add, change and delete). `metrics:read` is not used (`GET /capabilities` can be read with any token).
    With `allow_listen_ports`, rules whose listen ports are outside that range cannot be created, changed or deleted from the UI.
    If a scope is missing, the screen shows "The rproxy token used by the UI does not have permission for this operation" (it is also logged by the UI).

Environment:
```.env.local
NEXTAUTH_URL="http://[hostname]:[port]"
NEXTAUTH_SECRET="secret"

# database data
DB_HOST="[hostname]"
DB_PORT=3307
DB_DATABASE="[database]"
DB_USER="[username]"
DB_PASSWORD="[password]"

# Keycloak
KEYCLOAK_CLIENT_ID="[client_id]"
KEYCLOAK_CLIENT_SECRET="[client_secret]"
KEYCLOAK_ISSUER="https://[keycloak-host]/realms/[realm]"

# rproxy
RPROXY_API_URL="http://127.0.0.1:8080"
RPROXY_API_TOKEN="[token]"
```

`RPROXY_API_URL` is an `http://` / `https://` URL, or `unix:/run/rproxy/api.sock` (the Unix socket of rproxy-api's `RPROXY_API_SOCKET`; the HTTP Host is `localhost`).
By default rproxy-api creates the Unix socket with mode 660, so add the user that runs the UI to the `RPROXY_API_SOCKET_GROUP` group (the token is still required, as with TCP).

The Keycloak realm can be created from `keycloak/realm-rproxy-dev.json` (load it in the admin console with "Create realm" → "Resource file").
The file contains no client secret and no users, so after loading it, check the secret under "Credentials" of the client `rproxy-ui` and set it as `KEYCLOAK_CLIENT_SECRET`. The URLs are for the con0 development environment (`http://con0.dev.home:3001`).

Register `${NEXTAUTH_URL}/api/auth/callback/keycloak` in "Valid redirect URIs" of the Keycloak client.

## Roles (permissions)

Keycloak roles decide who can do what (the API routes check on every request).

| Role | What it can do |
|---|---|
| `rproxy-admin` | List, view, change and delete the rules of all users (the list and details show the owner (Keycloak ID)). Can use any listen port |
| `rproxy-user` | Create, list, change and delete only their own rules. By default, regardless of roles, anyone who can sign in is treated this way (the same as up to v0.3.1) |
| Neither | Only when a role is made mandatory, e.g. `RPROXY_UI_USER_ROLE=rproxy-user`, neither the screens nor the API can be used (403; "You do not have permission" is shown) |

- Roles are read from the access token's `realm_access.roles` (realm roles). To use client roles, change the claim location (dot-separated), e.g. `RPROXY_UI_ROLES_CLAIM=resource_access.rproxy-ui.roles`.
- The role names are set by `RPROXY_UI_ADMIN_ROLE` (default `rproxy-admin`) and `RPROXY_UI_USER_ROLE` (empty by default). If `RPROXY_UI_USER_ROLE` is empty (the default), anyone who can sign in is treated the same as `rproxy-user` (operation without roles). With `RPROXY_UI_USER_ROLE=rproxy-user`, users without that role can no longer use it.
- Writing e.g. `RPROXY_UI_USER_PORTS=1024-65535` restricts the listen ports `rproxy-user` can use (outside the range: 403 `port_not_allowed`; `rproxy-admin` is not restricted). There is no restriction by default.
- Roles are read at sign-in, so after changing a role in Keycloak, have the user sign in again.
- The `auth_id` in the history (`forward_rules_log`) is the user who performed the operation (the administrator, if an administrator changed someone else's rule).

## L7 (HTTP) rules

With rproxy-api v0.3.1 or later (`features.http` in `GET /capabilities` is true), choosing "Route by L7 (HTTP)" in the "Basic" tab of a TCP rule
lets you edit, in the "L7 (HTTP)" tab, the routes (`match` expressions as in Traefik; common conditions can be assembled by selection), services (targets and weights), middlewares (redirect, rate limit, CrowdSec, etc.; only the kinds rproxy supports) and the response when nothing matches.
The profiles "HTTPS reverse proxy (L7)" and "HTTP→HTTPS redirect (port 80, L7)" serve as templates. Switching between L4 and L7 is only possible at creation (rproxy cannot switch it with PATCH).
"Block clients by CrowdSec decisions (L4)" in the "Advanced" tab can be used when the rproxy settings file has `global.crowdsec` (rproxy-api v0.3.2 or later).

For building a production environment (apt, DB users and privileges, Keycloak, publishing over HTTPS, updates and backups), see [docs/en/PRODUCTION.md](docs/en/PRODUCTION.md).

Table definitions and migrations are in `db/` (see [db/README.en.md](db/README.en.md)). On existing environments, apply `db/migrations/005_ranges_and_tls.sql` (columns for port ranges and TLS).
The HTTP API contract with rproxy-api is `../rproxy-api/docs/API.md`.

## Multiple targets

"Add target" in the "Basic" tab lets a rule have multiple targets, with a choice of balancing method (rproxy-api v0.3.3 or later; L4 TCP / UDP rules).

| Balancing method | Behavior |
|---|---|
| Round robin | Rotates in turn in proportion to the weights |
| Least connections | Sends to the target with the smallest current connections (sessions for UDP) ÷ weight |
| Failover | Uses only the first live target from the top (when an upper target comes back, new connections go back to it) |

- Targets marked "Backup" are used only when all non-backup targets are down.
- A health check (checked by a TCP connection; interval, timeout, port) can be added. For UDP rules, the TCP port to check is required. Even without a health check, rproxy takes a target that failed to connect out of rotation for a while.
- The details screen shows the state of each target (up / down, connections) when rproxy returns it.
- For L7 rules, the same three can be chosen as the service's "Balancing method" (failover goes through the servers from the top).

## Listening on IPv4 and IPv6 at the same time

"Additional listen addresses" in the "Basic" tab lets the same port (range) be listened on at other addresses as well (rproxy-api v0.3.3 or later; up to 16).
You can list a representative IPv4 address together with a GUA IPv6 address, or specify `0.0.0.0` and `::` together. Statistics and logs are combined into one rule. The list shows "203.0.113.5:443 and 1 more (2001:db8::5)".

## Passing some server names through without termination (SNI passthrough)

In a rule that terminates TLS (including L7 rules), names set to "Do not terminate" under "Targets by server name" in the TLS tab are not terminated by rproxy; the connection is passed to the target as is, ClientHello included (the target's certificate is used; rproxy-api v0.3.3 or later).
For example, on `:443` rproxy can terminate cdn and gitlab and route them at L7, while passing registry and `**.tenant.example.com` straight to Kubernetes (with cert-manager certificates).

- One line can hold several server names separated by commas (rproxy's `server_names`).
- `*.example.com` matches exactly one level, `**.example.com` matches any number of levels (neither matches `example.com` itself). When several match, the order is: exact match → `*.` → `**.` (longer first) → the line higher up.
- In L7 rules, only "Do not terminate" lines can be used (other names are routed by L7 routes). "Drop unmatched connections" cannot be used either.
- `allow_from`, CrowdSec and statistics also apply to passthrough connections.

## Routing UDP by server name (DTLS, QUIC)

UDP rules can also choose the target by the server name in the first packet when the TLS tab's mode is set to "sni" (from rproxy v0.3.8). Nothing is terminated, so no certificate is needed (the target has it). You can start from the profiles "Route HTTP/3 (QUIC) by server name (UDP 443)" and "Route TURN DTLS by server name (UDP 5349)".

- Only DTLS and QUIC (HTTP/3, etc.) can be routed. UDP whose packets carry no server name, such as IKE (IPsec), WireGuard, RTP and games, gets the "when nothing matches" handling (send to the basic target / drop).
- It cannot be combined with an L7 rule that accepts HTTP/3 (http3) on the same address and port (the form warns about this).
- QUIC connection migration (changes of the client's address) is not followed, and for ECH connections the real server name cannot be read.

## Usage

| Screen | Contents |
|---|---|
| Dashboard (`/`) | Whether rproxy is reachable, the number of rules (including static rules), a card per TCP / UDP (donut of running, failed, missing and unknown, connections, total connections, rx / tx, TLS failures, denied), the TLS breakdown, rules that need attention, and a table of all rules (filter by protocol, state and search; select a row to open its details; static rules are marked "Static" and rules that restrict the source are marked "IP restricted"). Refreshes automatically every 5 seconds (can be toggled) |
| New rule (`/rules/new`) | The add form |
| Rule details (`/rules/{tcp\|udp}/{listen address}/{port}`) | Settings, live state and statistics. "Edit" and "Delete" (not available for static rules) |
| Edit (details URL + `/edit`) | The change form |
| Import (`/rules/import`) | Load rules from YAML / JSON (see "Export and import" below) |
| Change history (`/history`) | History of adding, changing and deleting rules, and reverting to an earlier version (see "Change history and revert" below). The rule details screen also shows the history of that rule |

rx is the number of bytes from the client to the target, tx from the target to the client (cumulative since rproxy started the rule; reset to 0 when rproxy restarts).
"Denied" is the number of connections dropped because they were outside the allowed sources (allow_from), or because of the setting that drops connections matching no server name (unmatched: reject).

Static rules are the rules in the file rproxy loads at startup (`RPROXY_STATIC_RULES` / `--static-rules`; "Static rules" in `../rproxy-api/docs/API.md`) and are not stored in the DB.
They are shown on the dashboard and details screens to anyone who is signed in, but cannot be changed or deleted from the screens (edit the file and restart rproxy).

The form is divided into tabs.

| Tab | Contents |
|---|---|
| Basic | Profile (templates by use case), protocol, listen address, port (the end of a range is optional), target |
| TLS / DTLS | passthrough / sni / terminate (DTLS for UDP), targets by server name and the handling of connections matching no server name (send to the basic target / drop), certificates, client certificate verification (mTLS), ALPN, re-encryption to the target |
| Mail (STARTTLS) | STARTTLS for SMTP / IMAP / POP3 (only for TCP with "terminate") |
| Advanced | Source IP handling (source_ip), UDP idle timeout, allowed sources (allow_from) |

- A profile only fills the form with the recommended settings from `../rproxy-api/docs/PROFILES.md`. Enter the addresses and certificate paths for your environment.
- The certificate, private key and CA paths are paths on the rproxy-api server. If they cannot be read, you get a `tls_config` error.
- Specify certificate files obtained with certbot, cert-manager or similar (rproxy has no built-in ACME. If the settings file contains an ACME certificate, the screen shows "a setting this rproxy cannot use").
  rproxy checks whether the files changed every 60 seconds (rproxy's `RPROXY_CERT_CHECK_SECS`) and reloads renewed certificates automatically, so you do not need to edit the rule on every renewal.
- Intermediate CAs (optional) go in one PEM file, ordered from the CA that issued the server certificate toward the root (the root is not needed). If the order is wrong, rproxy rejects it with `tls_config`.
  For client certificate verification, specify the root CA (trust anchor) in the CA file and the intermediate CA that issued the client certificates as the intermediate CA. Intermediate CAs can also be specified for the client certificate sent to the target.
- A port range (e.g. `8000-8001`) forwards each port in turn starting from the target port. The upper limit is rproxy's `max_range_ports` (default 20000). The range and the source IP handling cannot be changed after creation (TLS settings can be changed).
- WebRTC media cannot connect if DTLS is terminated. Use a passthrough range rule.
- Allowed sources (allow_from) take one entry per line, a CIDR (`172.16.0.0/16`, `fd00::/8`) or a single IP (up to 64). If empty, everything is allowed.
  TCP connections from outside the range are dropped before TLS or the PROXY header, and for UDP, datagrams from sources outside the range are discarded. On save they are normalized, e.g. `10.0.0.5` → `10.0.0.5/32`.
- "Connections matching no server name" can be chosen only for TCP sni / terminate with targets by server name. "Drop" drops connections with an unmatched name or without SNI (with terminate, they are dropped without completing the handshake).

## Pausing a rule

"Pause" on the rule details screen (or on the row in the list) stops a rule without deleting it. "Resume" runs it again with the same contents.

- Pausing keeps the rule in the DB and removes it from rproxy (the listener closes and existing connections are cut). Paused rules are not created even when rproxy restarts (from rproxy-api v0.3.5; it reads `"enabled": false` in the DB's `options` and skips them).
- Paused rules can still be edited (only the DB changes, and the rule is created with those contents on resume). Deleting also touches only the DB.
- The list, details and dashboard show "Paused" and count them separately.
- Pause and resume are recorded in the history as "Change" (the difference shows whether it is paused).
- Exports add `enabled: false` to paused rules (importing restores them as paused). This field is only valid within the UI's export format.
- "Replace" on import and reverting from the history keep the current paused / running state (only the contents change). Reverting a deleted rule recreates it in the state of that version (paused if it was paused).

## Export and import

"Export (JSON)" on the dashboard writes your rules (for `rproxy-admin`, the rules of all users) as JSON (for UI backups and migration).

```json
{"format": "rproxy-ui-export", "version": 1, "exported_at": "...", "rules": [{"protocol": "tcp", "listen_addr": "0.0.0.0", ...}]}
```

- The fields of each rule have the same names as in rproxy's API and settings file (`remote_addr`, `tls`, `http`, `targets`, etc.). Fields with default values (`source_ip: proxy`, `udp_idle_secs` for TCP, `tls` for passthrough, etc.) are omitted. Paused rules get `enabled: false`.
- The leading `format` distinguishes the file from an rproxy settings file. rproxy does not know this field, so even if the exported file is placed as `RPROXY_CONFIG`, it is not loaded by mistake but rejected (when moving to a settings file, use the contents of `rules` and remove paused rules and `enabled`).
- `rproxy-admin` can export only a specific user's rules with `/api/forward/export?owner=<user ID>`.

"Import" (`/rules/import`) loads a UI export (JSON) or an rproxy settings file (YAML / JSON; `version: 1` and `rules:`, or an array of rules). It can also be used to move rules written in a settings file under UI management.

1. "Check" validates each rule the same way as adding it from the screen, and shows the results (add / same key exists / error) in a table. Nothing is changed yet.
2. For rules whose key (protocol, listen address, port) already exists, you can choose "Replace" per row (skipped if not chosen).
   The same key as another user's rule, the same key as an rproxy static rule, and keys that overlap within the loaded content are errors.
3. "Import" adds / replaces the rules one by one. If it fails partway, the successful ones remain (the result is shown per row).

- `global` (CrowdSec, trusted_proxies, etc.) is an rproxy-side setting, so it is skipped.
- On replace, a rule that differs in source IP handling, port range or L4 / L7 is deleted and recreated (existing connections are cut).
- The `RPROXY_UI_USER_PORTS` restriction applies to imports as well.
- Additions and replacements are recorded in the history, the same as operations from the screen.

## Change history and revert

"Change history" (`/history`) shows the history of adding, changing and deleting rules (when, who, what). Changes show the difference from the previous version (target, TLS mode, allowed sources, etc.).
You can filter by protocol, listen address, port, operation and period (`rproxy-admin` can also filter by the user who performed the operation). The rule details screen also shows the history of that rule.

- What you can see: users see the history they performed and the history of the rules they currently own. `rproxy-admin` sees everything.
- "Revert to this version" restores the contents at that point. For change and add rows it restores the contents after that operation; for delete rows, the contents just before deletion.
  If the rule still exists it is replaced (a version that differs in source IP handling, port range or L4 / L7 is recreated); if it was deleted it is recreated. Reverts are also recorded in the history.
- rproxy static rules are not in the DB, so they do not appear in the history (a revert is not possible when a static rule with the same key exists).
- The history is the DB's `forward_rules_log`. No columns were added, so no migration is needed.

## Tests

```bash
npm test
```

The list of tests, and how to run the E2E tests that use a real MariaDB and rproxy-api (`RUN_E2E=1`), are in [docs/en/TESTING.md](docs/en/TESTING.md).
