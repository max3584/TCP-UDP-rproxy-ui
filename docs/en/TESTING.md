# List of tests (TCP-UDP-rproxy-ui)

日本語: [../TESTING.md](../TESTING.md)

| How to run | Target | CI job |
|---|---|---|
| `npx tsc --noEmit` / `npm run lint` / `npm run build` | Types, lint, build | `check` |
| `npm test` | Unit tests (DB, rproxy and NextAuth are mocked) | `check` |
| `RUN_E2E=1 npx vitest run tests/e2e.test.ts` | E2E connected to a real MariaDB and rproxy-api. Skipped without the variable | `e2e` (builds and uses the rproxy-api branch with the same name, or master if there is none) |

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
| parseCidr: normalizes … (18 cases) | The same normalization as rproxy's `src/cidr.rs` (a single IP is /32 or /128, host bits dropped, IPv6 compressed form, IPv4-mapped becomes IPv4, `[ ]` ignored, embedded IPv4) |
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

## Not yet tested

- Screen interaction (E2E in a browser). The appearance was checked manually with screenshots (1280px and 768px; for the form, only the rendered HTML was looked at).
  The dashboard, details and change pages themselves (data fetching and auto refresh) have no unit tests (the aggregation and formatting are checked in `components/dashboard.ts`)
- TLS termination with intermediate CAs is not in the E2E tests. With a three-level certificate chain (root → two intermediates → server certificate), it was checked manually that a rule added from the UI sends the intermediate CAs and that verification passes for a client that trusts only the root
- Actual traffic with certificate-based TLS termination, STARTTLS and DTLS (the E2E tests have no certificates; checked by the rproxy-side tests).
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
