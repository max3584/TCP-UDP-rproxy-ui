# Building a production environment

日本語: [../PRODUCTION.md](../PRODUCTION.md)

Steps to install rproxy-api and the UI (rproxy-ui) on one host (Debian 13 / Ubuntu 24.04) and publish the dashboard over HTTPS through rproxy.
This assumes the DB (MariaDB) and Keycloak are on other hosts.

```
Browser ──HTTPS 443──▶ rproxy-api (TLS termination, only dashboard.example.com passes, allow_from)
                            │ 127.0.0.1:3000
                            ▼
                         rproxy-ui ──▶ control API 127.0.0.1:8080 (token)
                            │  └────▶ MariaDB (UI user)
                            └───────▶ Keycloak (OIDC)
rproxy-api ──restores rules at startup──▶ MariaDB (read-only user)
```

## 1. Installation

rproxy-ui requires Node.js 22.23.4 or later (24.22.1 or later on 24, 26.12.1 or later on 26: the releases with the fix for the bundled Brotli flaw CVE-2026-111497; 23 and 25 get no fix); older releases get a warning at startup. Debian 13 (standard: 20) and Ubuntu 24.04 (standard: 18) do not have it, so first install nodejs from [NodeSource](https://github.com/nodesource/distributions) with a fixed major version (24 below). An apt pin keeps the distribution's nodejs from being chosen.

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
apt policy nodejs   # the Candidate must come from deb.nodesource.com
```

- The steps are the same on Debian 13 and Ubuntu 24.04 (NodeSource's `nodistro` does not depend on the distribution). For 22, use `NODE_MAJOR=22` (22.23.4 or later)
- With the pin in `/etc/apt/preferences.d/nodejs` (priority 600), `apt install nodejs` replaces an already installed distribution nodejs with NodeSource's, and `apt upgrade` never goes back to the distribution's. NodeSource's nodejs includes npm (the distribution's `npm` package is not needed)
- `apt upgrade` only moves within the same major version. To change the major version, change `NODE_MAJOR`, rewrite `nodesource.list`, and run `sudo apt update && sudo apt install nodejs`

Then install rproxy-api and rproxy-ui.

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update
sudo apt install rproxy-api rproxy-ui
```

- If rproxy-api is installed first, installing rproxy-ui puts rproxy-api's token and the control API URL into `/etc/rproxy-ui/rproxy-ui.env`.
- Neither starts just by being installed.
- For permissions (capabilities, file ownership), see rproxy-api's [docs/PERMISSIONS.md](https://github.com/max3584/rproxy-api/blob/master/docs/PERMISSIONS.md).

## 2. DB (MariaDB)

**Create the tables with an administrator user, and do not give the application users DDL privileges.**
In the development environment (`rproxy_dev`) the UI's user was also given the privilege to create tables, but not in production.

```shell
# create the DB and tables as the administrator
mariadb -h db.example.com -u admin -p -e 'CREATE DATABASE rproxy CHARACTER SET utf8mb4'
mariadb -h db.example.com -u admin -p rproxy < /usr/share/rproxy-ui/db/schema.sql
```

```sql
-- for the UI (rule management and change history). Match the host to the UI's host
CREATE USER 'rproxy_ui'@'10.0.0.10' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.10';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.10';

-- for rproxy-api (only reads the rules at startup)
CREATE USER 'rproxy'@'10.0.0.10' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'10.0.0.10';
```

When the DB is on another host, use TLS between the UI and the DB: give MariaDB a certificate (`ssl_cert`, `ssl_key`, `ssl_ca`) and require TLS for the UI's user (`ALTER USER 'rproxy_ui'@'10.0.0.10' REQUIRE SSL;`). Write `DB_SSL=true` in the UI's `rproxy-ui.env` and, for an internal CA, `DB_SSL_CA=/etc/rproxy-ui/db-ca.pem` (readable by the `rproxy-ui` user) (5. and "TLS to the DB" in the README). `db/migrate.mjs` reads the same variables.

### Moving rules from an old environment

To keep using the old environment's tables, take a backup first and then apply `db/migrations/` in order (for details, see [db/README.en.md](../../db/README.en.md)).

```shell
mysqldump -h db.example.com -u admin -p rproxy forward_rules forward_rules_log > rproxy-backup.sql
cd /usr/share/rproxy-ui/db/migrations
mariadb -h db.example.com -u admin -p rproxy < 002_source_ip_udp_idle.sql
mariadb -h db.example.com -u admin -p rproxy < 004_log_auth_id.sql
mariadb -h db.example.com -u admin -p rproxy < 005_ranges_and_tls.sql
```

- `003_auth_id_to_keycloak.sql` is a template used only when moving users from Auth0 to Keycloak. Write the mapping of Auth0 subs to Keycloak subs (the user's "ID") in VALUES, run it inside a transaction as the file describes, confirm that no unconverted rows remain, and then COMMIT.
- Running a migration that was already applied fails (the column already exists). Check how far you have applied with `SHOW COLUMNS FROM forward_rules`.
- If you use usage accounting (`010_usage.sql`), also apply `011_usage_attr.sql` before upgrading the UI to v0.4.0 (it splits usage rows by owner and marks; without it collection stops and `/usage` shows why).

## 3. Keycloak

1. In the admin console, load `keycloak/realm-rproxy-dev.json` (in the repository) with "Create realm" → "Resource file", and change the realm name to one for production (e.g. `rproxy`). The file is for development, so also do "Changes for a production realm" below.
2. Change the settings of the client `rproxy-ui` (confidential) to the production URLs.
   - Valid redirect URIs: `https://dashboard.example.com/api/auth/callback/keycloak`
   - Web origins / Root URL: `https://dashboard.example.com`
3. Set the client secret from "Credentials" as `KEYCLOAK_CLIENT_SECRET`.
4. Create users or federate with an existing IdP, and give administrators the realm role `rproxy-admin` (all rules). To let users (own rules only) in, set `RPROXY_UI_USER_ROLE=rproxy-user` and assign that role (from v0.4.9, when it is empty people without `rproxy-admin` cannot use the UI; "Roles" in the [README](../../README.en.md); the role names, the claim location and the ports users can use can be changed with `RPROXY_UI_ADMIN_ROLE` / `RPROXY_UI_USER_ROLE` / `RPROXY_UI_ROLES_CLAIM` / `RPROXY_UI_USER_PORTS`).
   When you let users in, also write the allow-list of their destinations `RPROXY_UI_USER_TARGETS` (CIDRs and host names; "Limits for users" in the README). Users cannot write server file paths, so store their TLS certificates with rproxy's certificate API (`PUT /certs/{name}`) and give the UI token `certs:read`. Do not put the dashboard's certificate and key (`/etc/rproxy/tls/`) in the certificate API (if you do, leave it out with `RPROXY_UI_USER_CERTS`). To separate certificates per tenant (group of users), assign name prefixes per Keycloak role such as `RPROXY_UI_USER_CERTS_BY_ROLE=tenant-a:tenant-a-,tenant-b:tenant-b-` (per user with `RPROXY_UI_USER_CERTS_BY_SUB`) (with only the shared `RPROXY_UI_USER_CERTS`, users can pick other tenants' certificates; "Limits for users" in the README). Write other destinations to protect, such as a DB on another host, in `RPROXY_UI_PROTECTED_TARGETS`.

### Changes for a production realm

`keycloak/realm-rproxy-dev.json` is set up to make development easy; do not use it as is in production. After loading it, change at least the following.

- **Password policy** ("Authentication" → "Policies" → "Password policy"): length (e.g. 12 characters or more), Not recently used, Not username, hash iterations. The development realm has no policy.
- **OTP (two-factor authentication)** (enable "Configure OTP" under "Authentication" → "Required actions" and make it required for administrators, or make OTP required in the browser flow): `rproxy-admin` can change every user's rules, so always require it at least for administrators. When federating with an existing IdP, enforce two-factor authentication there.
- **https URIs** (client `rproxy-ui`): make Valid redirect URIs, Valid post logout redirect URIs, Web origins, Root URL and Home URL production `https://` URLs only (do not leave the development `http://con0.dev.home:3001` or `*`). Set the realm's "Require SSL" to `all requests` (at least `external requests`).
- **Session times** ("Realm settings" → "Sessions" and "Tokens"): SSO Session Max at most `RPROXY_UI_SESSION_MAX_AGE` (default 8 hours), SSO Session Idle around 30 minutes, Access Token Lifespan around 5 minutes (the UI checks again every `RPROXY_UI_ROLE_REFRESH_SECS`). Do not use offline sessions (the UI does not need offline_access).
- Others: keep user registration and brute force detection ("Realm settings" → "Security defenses" → "Brute force detection") as in the development realm (registration off, detection on), and delete users and clients created for trials.

Set "SSO Session Max" under "Realm settings" → "Sessions" to at most `RPROXY_UI_SESSION_MAX_AGE` (default 8 hours); the UI sends `max_age` in the authorization request and makes Keycloak authenticate again after 8 hours (`keycloak/realm-rproxy-dev.json` uses 8 hours).
The UI checks roles again with the refresh token every 5 minutes (`RPROXY_UI_ROLE_REFRESH_SECS`) and calls end_session on sign-out, so the UI host must reach Keycloak's token endpoint (the same one used for sign-in).
Do not turn on "Revoke Refresh Token" (one-time refresh tokens) for the client. Within one UI process, checks with the same refresh token are merged into one, but with several UI instances, requests with the same cookie can check at the same time on different instances, one is refused, and the user is signed out.

If Keycloak's certificate is from an internal CA, add `NODE_EXTRA_CA_CERTS=/etc/rproxy-ui/ca.pem` to `rproxy-ui.env` so that Node.js trusts that CA (it must be readable by the `rproxy-ui` user; do not put it under `/home`, `/root` or `/tmp`).

## 4. rproxy-api

`/etc/rproxy/rproxy.env`:

```shell
RPROXY_API_ADDR=127.0.0.1           # keep loopback if on the same host as the UI
RPROXY_API_PORT=8080
RPROXY_TOKEN_FILE=/etc/rproxy/tokens   # one is generated at install time
RPROXY_DATABASE_URL=mysql://rproxy:<password>@db.example.com:3306/rproxy
RPROXY_STATIC_RULES=/etc/rproxy/static-rules.json
RPROXY_LOG_FILE=/var/log/rproxy/rproxy.log
```

If the UI and rproxy-api are on the same host, the control API can also be served on a Unix socket (anyone on the same host can connect to loopback TCP, but a socket can be restricted by file mode and group).
On the rproxy side, set `RPROXY_API_SOCKET=/run/rproxy/api.sock` and `RPROXY_API_SOCKET_GROUP=<group>` (the mode is 660 by default; `RPROXY_API_PORT=0` closes TCP);
on the UI side, set `RPROXY_API_URL=unix:/run/rproxy/api.sock` and add the `rproxy-ui` user to that group (`sudo usermod -aG <group> rproxy-ui`, then `systemctl restart rproxy-ui`). The token is still required, as with TCP.
The packaged `rproxy-ui` is in the group `rproxy` shared with rproxy-api (`SupplementaryGroups=rproxy`), so with `RPROXY_API_SOCKET_GROUP=rproxy` nothing needs to be added.

### File owners (OS users and groups)

rproxy-api runs as the OS user `rproxy-api` and has the group `rproxy`, shared with the UI (`rproxy-ui`); either package creates the group when it is missing, so the install order does not matter.
rproxy-api only reads the certificate, private key, CA and secret (htpasswd and so on) files of rules when they are owned by itself (`rproxy-api`), so that a UI user cannot name someone else's key and listen or connect with that identity. With another owner rproxy refuses the rule, and the UI explains why and how to fix it.

| File | Owner and mode |
|---|---|
| Certificates, intermediate CAs, CAs, private keys, htpasswd (`/etc/rproxy/tls/` and so on) | `rproxy-api:rproxy` 0640 (0600 for keys is fine) |
| Token file `/etc/rproxy/tokens` | `root:rproxy` 0640 (the UI reads it through the group `rproxy`; `RPROXY_API_TOKEN_FILE`) |
| The UI's control API client certificate (`RPROXY_API_TLS_*`) | `root:rproxy-ui` 0640, or `rproxy-api:rproxy` 0640 when it belongs to rproxy-api |


If the UI is on a different host, the control API has to listen on something other than loopback, and a token and TLS become mandatory (`RPROXY_TLS_CERT` / `RPROXY_TLS_KEY`; it does not start without them). On the UI side, set `RPROXY_API_URL=https://...`, and for a self-signed certificate or an internal CA, make it trusted with `NODE_EXTRA_CA_CERTS`.

### Publishing the dashboard (static rule)

`/etc/rproxy/static-rules.json` (`root:rproxy` 640). Terminate TLS on 443 and pass only `dashboard.example.com` to the UI. To restrict access to internal ranges, add `allow_from`.

```json
[
  {
    "protocol": "tcp", "listen_addr": "0.0.0.0", "listen_port": 443,
    "remote_addr": "127.0.0.1", "remote_port": 3000,
    "allow_from": ["10.0.0.0/8"],
    "tls": {
      "mode": "terminate",
      "certificates": [{
        "cert_file": "/etc/rproxy/tls/dashboard.pem",
        "chain_file": "/etc/rproxy/tls/intermediates.pem",
        "key_file": "/etc/rproxy/tls/dashboard.key"
      }],
      "routes": [{ "server_name": "dashboard.example.com", "remote_addr": "127.0.0.1", "remote_port": 3000 }],
      "unmatched": "reject"
    }
  }
]
```

Put the certificate and key in `/etc/rproxy/tls/` with `rproxy-api:rproxy` 640 (see "File owners" above; rproxy-api does not read keys owned by other users). From rproxy-api v0.3.21, rproxy can also obtain and renew certificates itself with ACME (`global.acme` in rproxy's settings file; see rproxy-api's docs/en/ACME.md and "Obtaining certificates with ACME" in the README). For files, obtain certificates with certbot, acme.sh or similar (on Kubernetes, mount cert-manager's Secret).
rproxy checks the files' size, modification time and inode every 60 seconds (`RPROXY_CERT_CHECK_SECS`; `0` disables it) and automatically reloads only the certificates that changed (replacing a symbolic link is also detected). To apply a change immediately, run `sudo systemctl reload rproxy-api`.

To obtain certificates with certbot's http-01, use an L7 (`http`) rule on port 80 to route `/.well-known/acme-challenge/` to certbot's standalone server (e.g. `--http-01-port 8888`) or a server that serves the webroot (other paths are redirected to HTTPS):

```yaml
- protocol: tcp
  listen_addr: 0.0.0.0
  listen_port: 80
  http:
    routes:
      - {name: acme, match: 'PathPrefix(`/.well-known/acme-challenge/`)', to: 'http://127.0.0.1:8888'}
      - {name: to-https, match: 'PathPrefix(`/`)', middlewares: [to-https]}
    middlewares:
      to-https: {redirect_scheme: {scheme: https, permanent: true}}
```

For the certificate files, certbot's `/etc/letsencrypt/live/<name>/fullchain.pem` and `privkey.pem` can be specified as they are (rproxy-api does not read files owned by other users, so copy them to `/etc/rproxy/tls/` with certbot's `deploy-hook` and `chown rproxy-api:rproxy`).

## 5. rproxy-ui

`/etc/rproxy-ui/rproxy-ui.env` (`root:root` 600):

```shell
HOSTNAME=127.0.0.1                 # match the target of the rproxy static rule
PORT=3000
NEXTAUTH_URL=https://dashboard.example.com
NEXTAUTH_SECRET=<generated at install time>
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<Keycloak Credentials>
DB_HOST=db.example.com
DB_PORT=3306
DB_DATABASE=rproxy
DB_USER=rproxy_ui
DB_PASSWORD=<password>
# DB_SSL=true                           # TLS when the DB is on another host (checks the DB's certificate); DB_SSL_CA too for an internal CA
# DB_SSL_CA=/etc/rproxy-ui/db-ca.pem
RPROXY_API_URL=http://127.0.0.1:8080   # for a Unix socket, unix:/run/rproxy/api.sock (see 4.)
RPROXY_API_TOKEN=                       # a token copied by an earlier version stays here (used when set)
RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens  # filled in at install time (when it holds one token per line; read through the group rproxy)
# RPROXY_UI_SESSION_MAX_AGE=28800        # length of a sign-in (seconds, default 8 hours; from the Keycloak authentication; using the UI does not extend it)
# RPROXY_UI_ROLE_REFRESH_SECS=300        # how often roles are checked again with Keycloak (seconds; 0 turns it off, and revocations then wait until the session ends)
```

`RPROXY_API_TOKEN_FILE` reads the first non-empty line not starting with `#` as the token and uses a changed file from the next request (no change to the UI's settings needed). A YAML token file (below) holds only SHA-256 values, so then put the UI's token in `RPROXY_API_TOKEN`, or on one line in a file only the UI reads (`root:rproxy-ui` 0640) and point `RPROXY_API_TOKEN_FILE` at it.

If the rproxy token file has permissions (YAML), give the UI's token the scopes `rules:read` and `rules:write` (`metrics:read` is not used; `GET /capabilities` can be read with any token).
With `allow_listen_ports`, rules outside that range cannot be created, changed or deleted from the UI. If something is missing, rproxy returns 403 `forbidden`, and the screen asks you to check the scopes.

```yaml
# /etc/rproxy/tokens (rproxy's RPROXY_TOKEN_FILE; only the SHA-256 is kept in the file)
tokens:
  - name: rproxy-ui
    sha256: <value of printf %s "$TOKEN" | sha256sum>
    scopes: [rules:read, rules:write]
```

`TOKEN` is the value put in the UI's `RPROXY_API_TOKEN` (generate it with e.g. `openssl rand -hex 32`). After changing the token file, run `sudo systemctl reload rproxy-api`.

### Security headers and sessions

- The UI adds to every response a CSP (per-request nonce, `frame-ancestors 'none'`, the origin of `KEYCLOAK_ISSUER` in `form-action`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `NEXTAUTH_URL` is `https://` (values: "Security" in the [README](../../README.en.md)).
- rproxy-api in front works at L4 (TCP and TLS termination) and cannot add HTTP headers. The UI adds them, so nothing is needed in this setup. Set `NEXTAUTH_URL` to the `https://` URL users open so that HSTS is sent.
- A session ends `RPROXY_UI_SESSION_MAX_AGE` (default 8 hours) after the Keycloak authentication, and users then authenticate with Keycloak again. Disabling a user or removing a role in Keycloak reaches the UI within `RPROXY_UI_ROLE_REFRESH_SECS` (default 5 minutes; disabled users are signed out). With `RPROXY_UI_ROLE_REFRESH_SECS=0`, revocations do not take effect until the session ends.
- Signing out also ends the Keycloak SSO session. If Keycloak is unreachable, only the UI signs out and the SSO session remains (the UI logs "SSO のセッションを終わらせられませんでした"; look in `journalctl -u rproxy-ui`).
- To check: `curl -sI https://dashboard.example.com/api/healthz` lists the headers.

### Limits of the systemd unit

The package's unit (`/usr/lib/systemd/system/rproxy-ui.service`) drops the privileges the UI does not need: no capabilities (`CapabilityBoundingSet=`), `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, address families `AF_UNIX`, `AF_INET`, `AF_INET6` and `AF_NETLINK` only (`RestrictAddressFamilies`), `SystemCallFilter=@system-service`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality` and `UMask=0077`. `MemoryDenyWriteExecute` is left out because it does not work with Node.js's JIT.
Check it with `systemd-analyze security rproxy-ui`. Files the UI reads outside `/etc/rproxy-ui` (`NODE_EXTRA_CA_CERTS`, `DB_SSL_CA`, mTLS keys) must not be under `/home`, `/root` or `/tmp`. To change it, override with `systemctl edit rproxy-ui` (do not edit the package's file).

## 6. Starting and checking

```shell
sudo systemctl enable --now rproxy-api rproxy-ui
systemctl status rproxy-api rproxy-ui
journalctl -u rproxy-ui -f
tail -f /var/log/rproxy/rproxy.*.log      # rproxy-api (JSON Lines; if there is "event":"degraded", it is running with restrictions)
```

- Open `https://dashboard.example.com`, sign in with Keycloak, and check that the dashboard appears and shows that rproxy is reachable.
- Check that the static rule (443) appears in the list marked "Static".
- Check that connections from outside the `allow_from` range are not possible (the dashboard's "Refused" count increases).

## 7. Updates

```shell
sudo apt update && sudo apt upgrade   # rproxy-api and rproxy-ui have independent version numbers (the UI release notes state the minimum rproxy-api version)
```

- The settings files (`rproxy.env`, `rproxy-ui.env`) and tokens are kept across updates.
- For versions that change the table shape, the release notes describe the migration. Apply it, then update.
- Services that were running are restarted during the update.

## 8. Backups

- DB: `forward_rules` and `forward_rules_log` (the rules themselves and the history)
- `/etc/rproxy/` (settings, tokens, static rules, certificates) and `/etc/rproxy-ui/rproxy-ui.env`
- The Keycloak realm (admin console "Realm settings" → "Action" → "Partial export")
