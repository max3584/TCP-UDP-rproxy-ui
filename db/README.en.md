# Database (MariaDB)

日本語: [README.md](README.md)

Definitions of the tables shared by the UI and rproxy-api.

| File | Contents |
|---|---|
| `schema.sql` | The current table definitions. When creating a new environment, running only this is enough |
| `migrations/001_initial.sql` | Definitions of the initial state (before `source_ip` / `udp_idle_secs` were added) |
| `migrations/002_source_ip_udp_idle.sql` | Adds the `source_ip` and `udp_idle_secs` columns and lowercases `protocol` |
| `migrations/003_auth_id_to_keycloak.sql` | A template that replaces `auth_id` from the Auth0 sub with the Keycloak sub (run manually, once) |
| `migrations/004_log_auth_id.sql` | Adds a column for the user who performed the operation (`auth_id`) to `forward_rules_log` |
| `migrations/005_ranges_and_tls.sql` | Adds to both tables a column for the end of the port range (`src_port_end`) and one for the TLS / STARTTLS settings (`options`) |

On existing environments, apply them in order starting from `002`. When you change `schema.sql`, also add a migration that makes the same change.

```bash
mariadb -h <host> -P <port> -u <admin> -p <database> < db/migrations/002_source_ip_udp_idle.sql
```

## Tables

- `forward_rules`: forwarding rules. Unique on `(protocol, src_addr, src_port)`. `auth_id` is the IdP's (Keycloak's) `sub`.
  `protocol` is stored as lowercase `tcp` / `udp`, and an IPv6 `src_addr` in compressed form (e.g. `::1`).
  - `src_port_end`: the end of the port range. NULL for a single port. The key of a range rule is the first port, `src_port` (rproxy rejects overlapping ranges).
  - `options`: JSON of the TLS / STARTTLS / allowed sources / L7 settings. Its shape is always `{"tls": <TLS>, "starttls": "smtp" | "imap" | "pop3" | null, "starttls_required": bool, "allow_from": [<CIDR>, ...], "http": <L7>, "crowdsec": bool, "targets": [<target>, ...], "balance": "round_robin" | "least_conn" | "failover", "health_check": {"interval", "timeout", "port"}, "extra_listen_addrs": [<IP>, ...], "enabled": false}`
    (`<TLS>` is the same as "TLS" in `../rproxy-api/docs/API.md`. `allow_from` holds normalized CIDRs (`10.0.0.5/32`, etc.) and is omitted when empty.
    `<L7>` is the rule's `http` from "v0.3 settings" in API.md, present only on L7 rules (for such a rule `dist_addr` is `''` and `dist_port` is `0`). rproxy rejects unknown keys when reading, so do not add other keys.
    `crowdsec` (in L4, drop clients that are in CrowdSec decisions; from rproxy-api v0.3.2) is written only when true.
    `targets` (when there are multiple targets; `<target>` is `{"addr", "port", "weight"?, "backup"?}`; from rproxy-api v0.3.3) is written only when there are several targets,
    and `balance` (omitted when it is the default `round_robin`) and `health_check` are also written only when `targets` is present. For such a rule `dist_addr` is `''` and `dist_port` is `0`
    (because rproxy does not accept `targets` and `remote_addr` together; the first target shown in the list is `targets[0]`).
    `extra_listen_addrs` (an array of IP addresses additionally listened on with the same port, up to 16; from rproxy-api v0.3.3) is omitted when empty.
    `enabled` (pausing in the UI) is written only when `false`. From rproxy-api v0.3.5, rproxy does not create this row at startup (a field not sent to rproxy's API).
    `routes[]` in `<TLS>` has `server_name` or `server_names` (one or the other), and `passthrough` only when true (from rproxy-api v0.3.3).
    A rule that is passthrough with default values, without STARTTLS, allow_from, http or crowdsec, and with a single target stores NULL. The column type does not change, so no migration is needed.)
  - rproxy static rules (the `--static-rules` file) are not stored in this table.
- `forward_rules_log`: history of additions, changes and deletions. `update_action` is `ADD` / `UPDATE` / `DELETE`, and `auth_id` is the user who performed the operation (NULL for rows from before `004`).
  Each row holds the rule's contents after the operation (for `DELETE`, the contents before deletion), so the UI's "Change history" shows the difference from the previous version from these rows, and "Revert to this version" restores those contents (import and revert operations are recorded in the same way).

## DB users

Give the UI's user read and write privileges on both tables.

```sql
CREATE USER 'rproxy_ui'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON rproxy.forward_rules     TO 'rproxy_ui'@'10.0.0.%';
GRANT SELECT, INSERT                 ON rproxy.forward_rules_log TO 'rproxy_ui'@'10.0.0.%';
```

rproxy-api only reads `forward_rules` at startup, so use a read-only user.
The columns it reads are `protocol`, `src_addr`, `src_port`, `src_port_end`, `dist_addr`, `dist_port`, `source_ip`, `udp_idle_secs` and `options`
(old tables without `src_port_end` / `options` are also loaded, with default values).

```sql
CREATE USER 'rproxy'@'127.0.0.1' IDENTIFIED BY '<password>';
GRANT SELECT ON rproxy.forward_rules TO 'rproxy'@'127.0.0.1';
```

(The examples use `rproxy` as the database name. Adjust it to match `DB_DATABASE`.)

## Backup

Back up both tables with `mariadb-dump --single-transaction`. How to take backups, the restore order (including DB users and migrations) and checks after restoring are in [docs/en/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/en/BACKUP.md) of rproxy-api.
