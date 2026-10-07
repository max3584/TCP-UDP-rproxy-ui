# List of tests (TCP-UDP-rproxy-ui)

日本語: [../TESTING.md](../TESTING.md)

| How to run | Target | CI job |
|---|---|---|
| `npx tsc --noEmit` / `npm run lint` / `npm run build` | Types, lint, build | `check` |
| `npm test` | Unit tests (DB, rproxy and NextAuth are mocked) | `check` |
| `RUN_E2E=1 npx vitest run tests/e2e.test.ts` | E2E connected to a real MariaDB and rproxy-api. Skipped without the variable | `e2e` (builds and uses the rproxy-api branch with the same name, or master if there is none) |
| `RUN_E2E_NODES=1 npx vitest run tests/e2e-nodes.test.ts` | E2E for several nodes (#98). Runs two rproxy-api instances (separate containers, Unix sockets) restoring through per-node views. Skipped without the variable | `e2e-nodes` |

The CI jobs run in Alpine containers (`node:24-alpine`). MariaDB is Alpine's mariadb package running in the same container (`scripts/ci-mariadb.sh`), rproxy-api is built with rustup's stable (musl), and Playwright uses Alpine's chromium from apk (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; playwright.config.ts). The two rproxy-api instances of `e2e-nodes` also run in Alpine containers (with iproute2 added; the VIP is added and removed with `ip` through `docker exec`).
Only `deb` (Debian package), which builds, installs and checks the .deb, runs in a `debian:trixie-slim` container with systemd as init, because Debian is what it tests; it installs nodejs 24 from NodeSource (`scripts/install-nodejs.sh`).

## Unit tests: rproxy client (`tests/rproxy.test.ts`)

| Test | What it checks |
|---|---|
| returns parsed rules on success | Reads the list response according to its type |
| posts a rule as JSON | Adding sends JSON to `POST /rules` |
| maps the error body to RproxyError | Turns `{error, code}` into `RproxyError` |
| uses code internal for a non-JSON error body | A non-JSON error response is `internal` |
| reports network failures as unreachable | When it cannot connect, `unreachable` (status 0) |
| sends the bearer token when RPROXY_API_TOKEN is set / omits the Authorization header when RPROXY_API_TOKEN is unset | Adds or omits the `Authorization` header depending on whether there is a token |
| URL-encodes an IPv6 listen address | Encodes the IPv6 address in the path |
| deletes a rule and accepts 204 | Treats a 204 on delete as success |
| posts a range rule with TLS and STARTTLS as JSON | Sends the range, TLS and STARTTLS as they are, and turns `tls_config` into `RproxyError` |

## Unit tests: API route (`tests/forward.test.ts`)

| Test | What it checks |
|---|---|
| returns 401 without a session | Not signed in gives 401 and does not touch the DB |
| add commits when rproxy succeeds | Write to the DB → rproxy → COMMIT. Records `auth_id` in the history |
| add rolls back and returns the rproxy error code | If rproxy fails, ROLLBACK and return rproxy's error code |
| add returns 502 when rproxy is unreachable | 502 when rproxy cannot be reached |
| add returns 409 on a duplicate key without calling rproxy | A duplicate key in the DB gives 409, and rproxy is not called |
| normalizes the protocol to lowercase | Lowercases the protocol name |
| rejects invalid input (9 cases) | Port 0 / 65536 / string / decimal, unknown protocol, host name as listen address, `proxy_v2` with UDP, `udp_idle_secs` out of range |
| accepts ports 1 and 65535 | Accepts the boundary ports |
| modify sends PATCH with udp_idle_secs and keeps source_ip from the DB | Changes use PATCH. `source_ip` keeps the DB value |
| modify returns 404 when the rule is not owned by the user | Someone else's rule gives 404 |
| modify re-creates a rule that rproxy does not have | A rule rproxy does not have (`missing`) is recreated |
| delete treats rproxy not_found as success | If rproxy no longer has it, the delete succeeds |
| delete rolls back on other rproxy errors | Other errors ROLLBACK |
| add undoes the rproxy change when COMMIT fails / modify restores the previous target when COMMIT fails / delete re-adds the rule to rproxy when COMMIT fails | If COMMIT fails, the change on the rproxy side is undone |
| reports but survives a failed undo | Even if the undo fails, the connection is released and an error is returned |
| list merges live state from rproxy | Adds `running` / `failed` / `missing` to the DB rules |
| list returns DB rules with state unknown when rproxy is down | `unknown` when rproxy cannot be reached |
| rejects invalid range / TLS input (18 cases) | Range end before the start / string / target port over 65535, unknown mode / key / STARTTLS, certificate without a key (`invalid`), sni with UDP (`unsupported`), terminate without a certificate, certificates / routes with passthrough, ALPN with sni, client auth without a CA, upstream client certificate without a key, invalid server name, STARTTLS without terminate, STARTTLS with UDP, ALPN with UDP (`tls_config`). Touches neither the DB nor rproxy |
| add stores the range and options JSON and passes them to rproxy | Stores `src_port_end` and `options` (`{tls, starttls, starttls_required}` with default values omitted), and sends `listen_port_end` / `tls` / `starttls` to rproxy |
| forces starttls_required for imap and pop3 | Only SMTP can be made not required |
| treats a range that ends at its start as a single port | End = start is a single port (NULL) |
| passes the rproxy tls_config error through as 400 | `tls_config`, e.g. when a certificate cannot be read, is returned as 400 as is, with ROLLBACK |
| modify replaces the TLS settings with PATCH and stores options | Adds `tls` / `starttls` / `allow_from` to the PATCH and updates `options` |
| modify restores the previous TLS settings when COMMIT fails / modify restores STARTTLS too when COMMIT fails | The undo PATCHes with the original TLS and STARTTLS settings (also when `options` comes back as an object) |
| modify keeps the range from the DB and rejects a changed range | Changing the range gives 400 (`unsupported`) |
| modify checks the new target port against the stored range | Checks the upper limit of the target port with the range in the DB |
| modify re-creates a missing range rule with its range and new TLS settings | Recreating also uses the range and the new TLS settings |
| delete re-adds the range rule with its TLS settings when COMMIT fails | The delete's undo recreates it together with the range and TLS settings. Also recorded in the history |
| list returns the range and TLS settings from the DB | The list includes `srcPortEnd` / `tls` / `starttls` / `starttlsRequired` |
| rejects invalid range / TLS input (5 intermediate CA cases) | Upstream `chain_file` without a certificate, `client_auth.chain_file` with `mode: none` or passthrough (`tls_config`), unknown key in a certificate, non-string `chain_file` (`invalid`) |
| stores certificate, client_auth and upstream chain files in the exact rproxy shape | `chain_file` in `options` and in the `tls` sent to rproxy has the same shape as rproxy's (blank fields omitted, keys in the order `cert_file, chain_file, key_file`) |
| reads chain files back from the options column | Reads `chain_file` back from `options` |
| list passes stats, started_at and resolved through from rproxy | Passes `stats` / `startedAt` / `resolved`. null / empty for `missing` |
| list leaves stats empty when rproxy is unreachable or an old rproxy omits them | null for `unknown` and for an old rproxy that does not return `stats` |
| dashboard reports whether rproxy was reachable | `reachable` / `rproxyError` of `dashboard` |
| rule returns one own rule with its live state (IPv6 address normalized) | Gets one rule. Compresses the IPv6 address and queries the DB filtered by `auth_id` |
| rule returns 404 for a rule of another user (a dynamic rule in rproxy is not shown) | Another user's rule gives 404 (if it is not in the DB, rproxy is queried, but it is not shown unless `origin` is `static`; the same for an old rproxy without `origin`) |
| rule reports missing and unknown like list | rproxy's `not_found` is `missing`, and `unknown` if it cannot connect |
| rule rejects an invalid key (5 cases) / rule returns 401 without a session | An invalid key gives 400, not signed in gives 401. Neither touches the DB |

## Unit tests: allow_from, unmatched, static rules (second half of `tests/forward.test.ts`)

| Test | What it checks |
|---|---|
| add normalizes allow_from, stores it in options and sends it to rproxy | Normalizes e.g. `10.0.0.5` → `10.0.0.5/32`, stores `{tls, starttls, starttls_required, allow_from}` in `options` even when TLS is default, and adds it to the POST |
| add leaves allow_from out of the POST and options when empty | When empty, it is not added to the POST and `options` stays NULL |
| rejects invalid allow_from / unmatched (6 cases) | Not an array, host name, prefix too long (IPv4 / IPv6), 65 entries, unknown `unmatched` (`invalid`). Does not touch the DB |
| rejects unmatched: reject for … (3 cases) | `tls_config` for sni without routes, passthrough, and UDP terminate |
| passes unmatched: reject through and drops the default | `reject` is passed to rproxy and `options` as is; `default` is omitted |
| modify replaces allow_from when given and keeps the stored value when omitted | Replaced when given, otherwise the DB value is kept. `[]` clears it (`[]` in the PATCH too, `options` NULL) |
| modify restores the previous allow_from and tls (with unmatched) when COMMIT fails | The undo PATCHes with the original `allow_from` and `tls` (including `unmatched`) |
| delete re-adds the rule with its allow_from when COMMIT fails | The delete's undo recreates it together with `allow_from` |
| list returns allowFrom, origin dynamic and stats.denied for DB rules, but no static rules | `list` returns only your own DB rules. `origin: dynamic`, `allowFrom`, `stats.denied` |
| dashboard merges static rules from rproxy as read-only rows after the own rules | Adds static rules (negative ids) after your own rules. Does not add other users' dynamic rules. `tls` in the shape with default values omitted |
| dashboard has no static rows when rproxy is unreachable | No static rules when it cannot connect |
| rule returns a static rule that is not in the DB | If it is not in the DB, returns rproxy's static rule |
| rule reports an unreachable rproxy instead of 404 for a rule that is not in the DB | If it is not in the DB and rproxy cannot be reached, 502 `unreachable` |
| rule returns an own DB rule with origin dynamic | A DB row returns the DB settings |
| modify / delete refuses a static rule with 409 static without touching rproxy | Changing or deleting a static rule gives 409 `static` (PATCH / DELETE are not called; ROLLBACK) |
| modify / delete still returns 404 for a rule that is neither own nor static | 404 for another user's dynamic rule, or when rproxy cannot be queried |
| passes a 409 static from rproxy through and rolls back | rproxy's 409 `static` is returned as is |

## Unit tests: CIDR, options, unmatched (`tests/cidr.test.ts`)

| Test | What it checks |
|---|---|
| parseCidr: normalizes … (18 cases) | The same normalization as rproxy's `src/net/cidr.rs` (a single IP is /32 or /128, host bits dropped, IPv6 compressed form, IPv4-mapped becomes IPv4, `[ ]` ignored, embedded IPv4) |
| parseCidr: rejects … (19 cases) | Empty, host name, /33 and /129, non-numeric prefix, octet over 255, leading 0, wrong number of groups, two `::`, zone ID, /104 on IPv4-mapped |
| explains a too long prefix separately / formats IPv6 like RFC 5952 | Error messages, choice of which run of zeros becomes `::` |
| allow_from lists | One entry per line (blank lines ignored), up to 64 entries, returns the first error, `normalizeAllowFrom` gives `invalid` |
| options JSON with allow_from | Omitted when empty and NULL when default, 4 keys when present. Read back from strings and objects, unknown keys rejected |
| tls.unmatched | Keeps `reject` and omits `default`. Allowed only for tcp sni / terminate with routes. rproxy's responses (including fields with default values) can be read too |

## Unit tests: input form and profiles (`tests/ruleform.test.ts`)

| Test | What it checks |
|---|---|
| splits the form into four accessible tabs with the basic tab selected | `role="tablist"` / `tab` / `tabpanel` and `aria-selected`. With tcp + passthrough the STARTTLS tab is `aria-disabled` |
| titles the TLS tab DTLS for UDP and keeps the range read-only when editing | For UDP the tab name is DTLS. When editing the range is read-only and profiles are not shown |
| is a page form with a submit and a cancel button instead of a modal overlay | A `<form>` with no overlay. Add / change / saving buttons |
| labels every visible input | Every input with an id has a `<label for>` |
| shows the chain fields of certificates, client auth and upstream as first-class inputs | Each certificate (including rows without an intermediate CA), client auth and upstream have an intermediate CA field and help text |
| hides the client auth chain field when client auth is none | When client auth is none, its intermediate CA field is not shown |
| <profile name> is a valid rule | Every profile satisfies the range limit and the rules for TLS combinations |
| follows the PROFILES.md warnings | WebRTC media is passthrough, SMTP is passthrough + proxy_v2, etc. |
| puts a labelled allow_from textarea with its help text in the advanced tab | A textarea with `<label for>` and help text (if empty, everything is allowed…) in the "Advanced" tab |
| fills the textarea with one CIDR per line when editing | When editing, one entry per line |
| offers the unmatched choice in the TLS tab for tcp sni / terminate with routes | "Connections matching no server name" (send to the basic target / drop) and the selected value |
| hides the unmatched choice without routes, for passthrough and for UDP | Not shown without routes, for passthrough or for UDP |

## Unit tests: dashboard (`tests/dashboard.test.ts`)

| Test | What it checks |
|---|---|
| summarize | Count of states per protocol, totals of connections, cumulative connections, rx / tx and TLS failures (null is added as 0). Zero rules |
| tlsBreakdown | Counts of passthrough / sni / TLS terminate (tcp) / DTLS terminate (udp), STARTTLS and range rules |
| needsAttention | failed first, then missing |
| filterRules | Filters by protocol and state. Search matches address, port (including within a range and target ranges), SNI server names and their target ports, and `addr:port` |
| formatting | `formatBytes` (1024-based; 1.2 MiB, etc.), `formatDuration` (top 2 units), uptime (never negative), counts, port ranges, `[IPv6]:port`, TLS names |
| donut | `conic-gradient` per state and a breakdown for screen readers. Gray for zero rules |
| rule URLs | URLs of the details and change screens and of the single-rule API (IPv6 encoded), and reading the key from the screen's query (null if invalid) |
| toRule | Drops the live information when sending to the API |
| badges | State badges are also expressed in text, with the text color specified. Display of DTLS and STARTTLS. "Static" and "IP restricted" (not shown when allow_from is empty) |
| summarize: adds up denied connections … and counts static rules | Total of `stats.denied` (0 when missing in an old rproxy) and the number of static rules |
| static rules | `ruleFromStatus` (builds a row from rproxy's response; ranges, old rproxy), `mergeStaticRules` (adds them after your own rules with negative ids; does not add dynamic ones, ones without `origin`, or ones with the same key; included in the totals) |

## E2E (`tests/e2e.test.ts`)

| Test | What it checks |
|---|---|
| adds a rule that forwards traffic | An added rule actually forwards traffic |
| rejects a duplicate and an unresolvable target without leaving rows | A duplicate gives 409, an unresolvable target gives 502, and no rows remain in the DB. The list gets rproxy's `stats` (cumulative connections at least 1, rx at least 2 bytes), `startedAt` and `resolved` |
| returns one rule and the dashboard with live state | `rule` gets one rule (404 if missing), and `reachable` of `dashboard` is true |
| modifies and deletes the rule | Forwarding still works after a change, and after deletion connections fail |
| records who changed what in forward_rules_log | `auth_id` and ADD / UPDATE / DELETE remain in the history |
| forwards a two-port range one to one | A two-port TCP range rule forwards one to one to two consecutive echo servers (`E2E_BACKEND_PORT` + 1 and + 2). `src_port_end` is stored and `options` is NULL |
| round-trips allow_from through the DB and rproxy and drops connections outside it | `allowFrom` is normalized and goes into the DB's `options` and rproxy (`allow_from` of `GET /rules/{key}`, `origin: dynamic`); when set out of range, connections are dropped and `stats.denied` increases. Kept by a change that omits it, cleared with `[]` (`options` NULL) |
| rejects a terminate rule whose certificate cannot be read without leaving rows | terminate with a nonexistent certificate gives 400 `tls_config`, and no rows remain in the DB |
| deletes the range rule | After deleting the range rule, connections fail |

## Several nodes (#98)

- `tests/nodes.test.ts`: reading the `RPROXY_UI_NODES` file and its errors (names, URLs, token_file, groups, default_target), the nodes of a group, overlaps, the `forward_rule_targets` rows, and the single node without the file
- `tests/nodeview.test.ts`: the SQL from `db/node-view.mjs` (the view's columns are those rproxy reads, the filter, the read-only GRANT, name checks)
- `tests/fanout.test.ts`: sending to every node of a group, undoing the nodes that succeeded when one fails, results per node
- `tests/forward-nodes.test.ts`: the API route (adding to a group, undo and ROLLBACK on failure, undo on a COMMIT failure, target required and checked, 409 on overlaps, aggregated state per node, target in the history)
- `tests/nodestate.test.ts`: aggregating states (the worse one), summing stats, `?target=` in URLs, node tabs (`projectRule`, `nodeTotals`), merging the settings-file warnings of all nodes
- `tests/drift.test.ts`: comparing for drift (defaults and runtime figures ignored, codes of differing fields, a paused rule still running, differences needing a recreate) and act / stb (VIP or listen address, warnings when nobody or several nodes hold it)
- second half of `tests/forward-nodes.test.ts`: drift and act per node, resending (create when missing, PATCH on drift, nothing when equal, RESEND with the node in the history)
- `tests/overrides.test.ts`: per-node override validation, overlaying, DB rows (JSON_MERGE_PATCH patches), round trip of the export form, the targets field, `RPROXY_UI_USER_NODES`
- phase 3 of `tests/forward-nodes.test.ts`: overrides (that node only, recreate when the listen address changes, OVERRIDE in the history), group changes sent with each node's overrides applied, bulk pause, copy / move, node-scoped roles, overrides in export / import, last applied time
- `tests/hasync.test.ts`: whether a node may be promoted (in sync, missing, drift, unreachable), the automatic resend (RESEND recorded by system, auto_resend: false, no history when nothing changed, counting repeated failures, the DB lock, one loop per process), the keepalived endpoints (token, 200 / 503, notify)
- `tests/e2e-nodes.test.ts` (CI `e2e-nodes`): a group rule is created on both nodes and a node rule on that node only, the views' contents, a restarted rproxy restores only its own rules, pause / resume / delete, undo when one node fails,
  act / stb and the warnings change as the VIP is added to / removed from the containers, drift of a rule changed directly on one node and resending, a rule removed from one node shown as missing and resending,
  per-node overrides (that node only, not drift, applied by the view and kept across a restart, exported), pausing a node (not restored by a restart), refusing a copy to an overlapping node and moving,
  ha/ready returning 503 and back to 200 after the automatic resend (RESEND recorded by system), notify recreating rules on the promoted node at once

## Screen E2E (`tests/ui`, Playwright)

Runs in the CI `e2e` job against the same MariaDB and rproxy-api.

- `rules.spec.ts`: adds, changes and deletes TCP and L7 (HTTP) rules from the screen and checks that traffic is forwarded; signed-out visitors do not get the form
- `settings.spec.ts`: TLS options (minimum version 1.3 without a TLS 1.3 suite is refused before sending; once saved, TLS 1.2 clients are refused; the edit page shows the current values), basic_auth realm, user_header and keep_authorization (the 401 `WWW-Authenticate` and the user name the backend receives), and UDP sni offered without the version note. The self-signed certificate is made with openssl (apk's openssl in CI)
- `i18n.spec.ts`: switching to English and the cookie, the space before a parenthetical that is a separate child
- `responsive.spec.ts`, `contrast.spec.ts`, `version.spec.ts`: no overflow at 375px / 768px, no white text on white, the version display
- `api-rules.spec.ts`: a rule created by calling the rproxy API directly is hidden from users (404), shown to administrators as "API" on the dashboard and details, editing changes the target in rproxy and deleting removes it from rproxy (any rproxy version)
- `usage.spec.ts`: traffic through a new rule raises its usage after the UI collects (`RPROXY_UI_USAGE_SECS=30` in E2E) and appears in the detail chart, the usage report and the CSV (skipped without the 010 tables)
- `v04.spec.ts`: v0.4 rule settings (only when rproxy's `features` report them; skipped otherwise). Adds a rule with a label and one concurrent connection per source from the "Limits & GeoIP" tab, checks the label on the details and that a second connection is closed at once. With `features.dry_run`, "Show the difference" shows the create and change plans (changes without cutting connections, `labels`)
- `acme.spec.ts` (only with `UI_E2E_ACME=1`): ACME (rproxy-api v0.3.21). When rproxy-api has `docs/ACME.md`, CI runs apk's pebble (the ACME test CA) in the same container, and `scripts/ci-pebble.sh` makes Pebble's HTTPS certificate (openssl), the names in `/etc/hosts` and rproxy's settings file (`global.acme` in `RPROXY_CONFIG`).
  The form offers the resolvers and refuses wildcards (dns-01 only) and names outside `allowed_names` before saving; for the saved rule rproxy obtains a certificate from Pebble (http-01, `http01_listen`), the details show "valid" and Pebble's certificate is actually served; the edit page shows the resolver and the names.
  rproxy refuses names outside the allowlist with `400 invalid`. With a resolver whose CA cannot be reached, the details show "failed" and the stand-in (`rproxy ACME placeholder` is actually served), and the dashboard's attention list shows "ACME failed" (no overflow at 375px, no white text on white)

## Unit tests: ACME (`tests/acme.test.ts`)

| Test | What it checks |
|---|---|
| names | Normalizing and validating names, `*.` / `**.` in `allowed_names` (the same examples as rproxy's `src/acme/config.rs` tests), the resolver, wildcards and dns-01, names outside the account's and the DNS provider's allowlists, the number of names |
| GET /acme, /api/forward/acme | Only names, challenges and allowed names are passed on; contact, directory, eab and zones are not. rproxy's 404 becomes `configured: false`; unreachable is 502 |
| status | Matching certificates to their state (rproxy sorts the names), the stand-in, the attention text (failures, renewals failing close to expiry, pending while held back by rate_limit), the worst node for a group, the badges |
| rule detail, form | `AcmeStatus` (the stand-in while pending, expiry, renewal time, next attempt, last error, the note for an older rproxy), `AcmeCertificateEditor` (resolvers with their challenge, allowed names, errors while typing) |
| explainError | Explanations of rproxy's refusals (names outside the allowlist, wildcards, resolvers, no `global.acme`, udp, an older rproxy, `acme:write`) |
| TLS, export / import | Normalizing names, ACME on udp is `tls_config`, ACME certificates are the same after export and import |

## Unit tests: v0.4 rule settings (`tests/v04.test.ts`, `tests/forward-v04.test.ts`)

| Test | What it checks |
|---|---|
| Validating v0.4 values | Units (durations, rates, sizes), ranges and combinations of labels, limits, bandwidth, geoip and outlier_detection (L4 and L7), with the same examples as rproxy's `src/core/limits.rs` and others. L7 rules get no rule-level outlier_detection |
| PATCH, DB and rproxy shapes | Written to the POST body and the DB `options` in rproxy's shape and read back; `options` stays NULL when unused; PATCH replaces what is present, removes what disappeared with `{}` and sends nothing else; import from an export; drift, history and display |
| Form fields | Values and fields round-trip; items rproxy cannot run keep their current value; field errors; TCP datagram rates and L7 rule-level outlier_detection are not sent |
| L7 services | A service's `outlier_detection` stays in the stored shape and errors come from `validateHttp` |
| /api/forward (add, modify, plan) | add sends v0.4 settings to rproxy and the DB, malformed values are a 400 without calling rproxy; modify replaces only the fields sent (null removes); `plan` asks rproxy with `?dry_run=true` without changing the DB (the create plan when rproxy lacks the rule, refusals as per-node errors, delete) |
| 429 locked_out | An rproxy lockout is a 502 `rproxy_locked_out` with an explanation (Retry-After seconds), also on the dashboard |

## Unit tests: control API mTLS (`tests/mtls.test.ts`) and rproxy features & settings (`tests/system.test.ts`)

| Test | What it checks |
|---|---|
| Client certificate settings | `RPROXY_API_TLS_*`, `tls_cert` / `tls_key` / `tls_ca` in `nodes.yaml` (https only, certificate and key together, unreadable files are errors), `Retry-After` of a 429 |
| https control API | With a CA, server and client certificate made by openssl, connects to an https server that requires client certificates, and is refused without one (skipped without openssl) |
| /system | Feature flags, performance and settings file of a v0.4 rproxy; a v0.3 rproxy; an unreachable rproxy |

## Unit tests: rproxy API rules (`tests/apirules.test.ts`, `tests/forward-api.test.ts`)

| Test | What it checks |
|---|---|
| Screen shape | API rule rows from rproxy's answer and from `rproxy_rules` rows (stored, creating token and time; unreadable specs are skipped); static rules for everyone, API rules only for administrators; no duplicate keys; rules running instead of a UI rule; badges |
| /api/forward | Administrators' dashboards show running API rules, rule-set rules and stored rules that are not running; users do not see them; works without `rproxy_rules`; `shadowedBy`; getting one rule; `api-modify` only PATCHes (no DB write) and warns when the change is no longer stored; `api-delete`; administrators only; 409 `owned` / `ui_rule`; `plan` with `api-modify` |

`tests/nodeview.test.ts` also checks that the per-node SQL creates an `rproxy_rules` view that can write only that node's rows (`WITH CHECK OPTION`) with its grant (left out with `--without-rproxy-rules`).

## Unit tests: usage (`tests/usage.test.ts`, `tests/usage-route.test.ts`)

| Test | What it checks |
|---|---|
| Differences | Same counting start gives the difference; a changed `counters_since` adds everything; a live upgrade keeps counting; old rproxy uses `started_at`; a newly seen rule is added in full only when created after the previous collection |
| Buckets and chart | Hour, day and month buckets (UTC), empty buckets as 0, totals, axis maximum |
| Report and CSV | Grouping by owner, label and rule; label keys; CSV (not read as formulas); period and settings (environment variables) |
| collectNode | Values added to the hourly and daily tables, owner and marks, updating the baseline, dropping baselines of rules that disappeared |
| /api/forward/usage | Users see only their rules; rule filter; `available: false` without the tables; report and CSV; bad period |

## Not yet tested

- The dashboard, details and change pages themselves (data fetching and auto refresh) have no unit tests (the aggregation and formatting are checked in `components/dashboard.ts`)
- TLS termination with intermediate CAs is not in the E2E tests. With a three-level certificate chain (root → two intermediates → server certificate), it was checked manually that a rule added from the UI sends the intermediate CAs and that verification passes for a client that trusts only the root
- Actual traffic with STARTTLS and DTLS (checked by the rproxy-side tests; TLS termination is checked by `settings.spec.ts` and `tests/e2e.test.ts` with a self-signed certificate from openssl).
  That rproxy can read the `options` written by the UI on restart was checked manually
- Actual sign-in with Keycloak (checked manually)
- Static rules (`--static-rules`) are not in the E2E tests (the CI rproxy starts without static rules; with static rules, the E2E checks of the `dashboard` counts would not match).
  Actual dropping by `unmatched: reject` is not in the E2E tests either (it needs connections with certificates and SNI; checked by the rproxy-side tests)

## Unit tests: listen addresses and error explanations (`tests/listen.test.ts`)

| Test | What it checks |
|---|---|
| listenOptions | All interfaces (0.0.0.0 / ::) first, then each interface, and loopback last. Link-local addresses are not shown |
| reservedClash (8 cases) | Detects overlaps with the same address, wildcards and port ranges as the control API, and does not detect them for a different address, a different port or UDP |
| explainError | Adds an explanation to codes such as `resolve_failed`, keeping the details. Unknown codes are shown as is |
| explains that static rules cannot be changed or deleted from the UI (409 static) | Adds "Static rules are managed in the rproxy settings file, so…" to `static` (not repeated if the details are the same) |
