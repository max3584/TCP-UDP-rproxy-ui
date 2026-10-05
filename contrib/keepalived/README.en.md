# Working with keepalived (syncing before an act / stb promotion)

日本語: [README.md](README.md)

Scripts and an example configuration for moving the VIP with keepalived in an rproxy-ui active_standby group (`groups[].mode: active_standby` in `RPROXY_UI_NODES`) (rproxy-ui #109).
The .deb installs them in `/usr/share/doc/rproxy-ui/examples/keepalived/`.

| File | Use |
|---|---|
| `rproxy-ui-ready.sh` | A `vrrp_script` (track_script). Exits 1 when `GET /api/forward/ha/ready?node=` returns 503 (not in line with the DB definition), so keepalived lowers the priority by `weight`. Exits 0 when the UI cannot be reached or for any other response (never blocks a promotion) |
| `rproxy-ui-notify.sh` | `notify_master`. Right after a promotion, calls `POST /api/forward/ha/notify?node=` in the background so the UI resends that node's drifted / missing rules at once. Exits 0 even when the UI cannot be reached |
| `keepalived.conf.example` | An example for node1 (track_script weight, notify_master, preempt / nopreempt) |

## Setup

1. Set `RPROXY_UI_HA_TOKEN_FILE=/etc/rproxy-ui/ha.tokens` for the UI and write one token per line (e.g. `openssl rand -hex 32`). This token can only read whether a node is in sync and make the UI resend the DB definition.
2. Put the same token on one line in `/etc/keepalived/rproxy-ui-ha.token` (mode 600, readable by root only) on each node.
3. Adapt the node name, the UI URL and the VIP from `keepalived.conf.example` (the VIP is the same as `groups[].vip`).
4. Check: `/usr/share/doc/rproxy-ui/examples/keepalived/rproxy-ui-ready.sh node1 http://10.0.0.5:3000; echo $?` (0 means in sync, or the UI cannot be reached).

The UI checks groups whose `auto_resend` is not false every `RPROXY_UI_HA_SYNC_SECS` (30 seconds by default) and resends to a drifted stb automatically. The track_script guards between those checks, and notify_master right after a promotion.
To go back to the original act (failback), check on the UI's "act / stb" screen that the node is in sync, then move it back with keepalived.
