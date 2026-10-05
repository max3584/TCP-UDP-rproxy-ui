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

rproxy-ui requires Node.js 22.19.0 or later. Debian 13 (standard: 20) and Ubuntu 24.04 (standard: 18) do not have it, so first install nodejs from [NodeSource](https://github.com/nodesource/distributions) with a fixed major version (24 below). An apt pin keeps the distribution's nodejs from being chosen.

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

- The steps are the same on Debian 13 and Ubuntu 24.04 (NodeSource's `nodistro` does not depend on the distribution). For 22, use `NODE_MAJOR=22` (22.19.0 or later)
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

## 3. Keycloak

1. In the admin console, load `keycloak/realm-rproxy-dev.json` (in the repository) with "Create realm" → "Resource file", and change the realm name to one for production (e.g. `rproxy`).
2. Change the settings of the client `rproxy-ui` (confidential) to the production URLs.
   - Valid redirect URIs: `https://dashboard.example.com/api/auth/callback/keycloak`
   - Web origins / Root URL: `https://dashboard.example.com`
3. Set the client secret from "Credentials" as `KEYCLOAK_CLIENT_SECRET`.
4. Create users or federate with an existing IdP, and give administrators the realm role `rproxy-admin` (all rules). Other users can handle only their own rules by default. To restrict users by role, set `RPROXY_UI_USER_ROLE=rproxy-user` and assign that role ("Roles" in the [README](../../README.en.md); the role names, the claim location and the ports users can use can be changed with `RPROXY_UI_ADMIN_ROLE` / `RPROXY_UI_USER_ROLE` / `RPROXY_UI_ROLES_CLAIM` / `RPROXY_UI_USER_PORTS`).

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

Put the certificate and key in `/etc/rproxy/tls/` with `root:rproxy` 640. rproxy has no built-in ACME, so obtain certificates with certbot, acme.sh or similar (on Kubernetes, mount cert-manager's Secret).
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

For the certificate files, certbot's `/etc/letsencrypt/live/<name>/fullchain.pem` and `privkey.pem` can be specified as they are (or copy them to `/etc/rproxy/tls/` with a `deploy-hook` so that the rproxy user can read them).

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
RPROXY_API_URL=http://127.0.0.1:8080   # for a Unix socket, unix:/run/rproxy/api.sock (see 4.)
RPROXY_API_TOKEN=<filled in from /etc/rproxy/tokens at install time>
```

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

## 6. Starting and checking

```shell
sudo systemctl enable --now rproxy-api rproxy-ui
systemctl status rproxy-api rproxy-ui
journalctl -u rproxy-ui -f
tail -f /var/log/rproxy/rproxy.*.log      # rproxy-api (JSON Lines; if there is "event":"degraded", it is running with restrictions)
```

- Open `https://dashboard.example.com`, sign in with Keycloak, and check that the dashboard appears and shows that rproxy is reachable.
- Check that the static rule (443) appears in the list marked "Static".
- Check that connections from outside the `allow_from` range are not possible (the dashboard's "Denied" count increases).

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
