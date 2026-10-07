#!/usr/bin/env bash
# rproxy-ui の .deb をこの機械に実際に入れて確かめる（sudo と systemd が要る。CI では systemd を init にした debian:trixie-slim のコンテナで動かす）。
#
#   scripts/test-deb.sh dist/rproxy-ui_<version>-1_all.deb
#
# nodejs (>= 22.19.0) を apt で入れられること（NodeSource。scripts/install-nodejs.sh）が前提。
# rproxy-ui を本番で動かしている機械では実行しない。
set -euo pipefail

deb=$(realpath "$1")
ENV_FILE=/etc/rproxy-ui/rproxy-ui.env

fail() { echo "FAIL: $*" >&2; sudo journalctl -u rproxy-ui --no-pager -n 50 >&2 || true; exit 1; }
set_env() { sudo sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; }
code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$1"; }

# the group shared with rproxy-api (rproxy-api:rproxy files, group-readable)
in_rproxy_group() { id -nG rproxy-ui | tr ' ' '\n' | grep -qx rproxy; }
apt_install() { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
# rproxy-api's files on the same host
rproxy_files() {
	sudo install -d -m 0750 /etc/rproxy
	echo 'from-rproxy-token' | sudo tee /etc/rproxy/tokens >/dev/null
	sudo chmod 0640 /etc/rproxy/tokens
	echo 'RPROXY_API_PORT=8099' | sudo tee /etc/rproxy/rproxy.env >/dev/null
}
# as the rproxy-api package leaves them: root:rproxy, 0750 / 0640 (the group exists once either package is installed)
rproxy_perms() { sudo chgrp rproxy /etc/rproxy /etc/rproxy/tokens; }

# the UI may run on another host than rproxy-api: apt must not pull rproxy-api in
[ -z "$(dpkg-deb --field "$deb" Recommends)" ] || fail "rproxy-api must not be a Recommends (apt installs those)"

# an upgrade from the last release before the rproxy group (v0.3.21): the copied token stays, the user joins the group
prev=${PREV_DEB:-}
if [ -z "$prev" ] && [ "${SKIP_UPGRADE_TEST:-}" != 1 ]; then
	prev=$(mktemp --suffix=.deb)
	curl -fsSL -o "$prev" https://github.com/max3584/TCP-UDP-rproxy-ui/releases/download/v0.3.21/rproxy-ui_0.3.21-1_all.deb || prev=
fi
if [ -n "$prev" ]; then
	echo "== upgrade from $(dpkg-deb --field "$prev" Version)"
	rproxy_files
	apt_install "$prev"
	sudo grep -qx 'RPROXY_API_TOKEN=from-rproxy-token' $ENV_FILE || fail "old package: token not copied"
	# --reinstall: until the version is raised, the new package has the same version as v0.3.21
	apt_install --reinstall "$deb"
	getent group rproxy >/dev/null || fail "upgrade: no rproxy group"
	in_rproxy_group || fail "upgrade: rproxy-ui is not in the rproxy group"
	sudo grep -qx 'RPROXY_API_TOKEN=from-rproxy-token' $ENV_FILE || fail "upgrade: the copied token was lost"
	systemctl cat rproxy-ui | grep -qx 'SupplementaryGroups=rproxy' || fail "upgrade: unit without SupplementaryGroups=rproxy"
	sudo apt-get purge -y rproxy-ui
	sudo rm -rf /etc/rproxy
fi

echo "== install: rproxy-api's token file on the same host is used through the rproxy group"
# without the upgrade test the group does not exist yet: the UI's postinst creates it (install order does not matter)
rproxy_files
apt_install "$deb"
getent passwd rproxy-ui >/dev/null || fail "no rproxy-ui user"
getent group rproxy >/dev/null || fail "no rproxy group"
in_rproxy_group || fail "rproxy-ui is not in the rproxy group"
rproxy_perms
[ "$(sudo stat -c '%a %U:%G' $ENV_FILE)" = "600 root:root" ] || fail "env file mode/owner"
sudo grep -Eq '^NEXTAUTH_SECRET=[0-9a-f]{64}$' $ENV_FILE || fail "NEXTAUTH_SECRET not generated"
sudo grep -qx 'RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens' $ENV_FILE || fail "rproxy token file not picked up"
sudo grep -qx 'RPROXY_API_TOKEN=' $ENV_FILE || fail "the token was copied instead of referenced"
sudo grep -qx 'RPROXY_API_URL=http://127.0.0.1:8099' $ENV_FILE || fail "rproxy URL not picked up"
[ "$(sudo -u rproxy-ui cat /etc/rproxy/tokens)" = from-rproxy-token ] || fail "rproxy-ui cannot read the group-readable token file"
! systemctl is-active --quiet rproxy-ui || fail "started before it was configured"
ex=/usr/share/doc/rproxy-ui/examples/keepalived
if [ ! -x $ex/rproxy-ui-ready.sh ] || [ ! -x $ex/rproxy-ui-notify.sh ] || [ ! -f $ex/keepalived.conf.example ]; then fail "keepalived examples not installed"; fi
secret=$(sudo sed -n 's/^NEXTAUTH_SECRET=//p' $ENV_FILE)

echo "== start"
set_env NEXTAUTH_URL http://127.0.0.1:3000
set_env KEYCLOAK_ISSUER http://keycloak.invalid/realms/test
set_env KEYCLOAK_CLIENT_SECRET test
sudo systemctl enable --now rproxy-ui
for _ in $(seq 60); do [ "$(code /)" = 200 ] && break; sleep 0.5; done
[ "$(code /)" = 200 ] || fail "UI does not answer"
pid=$(systemctl show -p MainPID --value rproxy-ui)
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = rproxy-ui ] || fail "not running as rproxy-ui"
grep -Eq "^Groups:.*\\b$(getent group rproxy | cut -d: -f3)\\b" "/proc/$pid/status" || fail "the service does not have the rproxy group"
[ "$(code /api/auth/providers)" = 200 ] || fail "NextAuth is not configured"
[ "$(code /api/forward/capabilities)" = 401 ] || fail "API answered without a session"
# keepalived の口は RPROXY_UI_HA_TOKEN_FILE がなければ使えない（404）。スクリプトは 503 のときだけ優先度を下げる
[ "$(code '/api/forward/ha/ready?node=x')" = 404 ] || fail "ha/ready without RPROXY_UI_HA_TOKEN_FILE"
$ex/rproxy-ui-ready.sh x http://127.0.0.1:3000 /nonexistent || fail "ready script must not fail when the token is missing"
css=$(curl -s http://127.0.0.1:3000/ | grep -o '/_next/static/[^"]*\.css' | head -n1)
if [ -z "$css" ] || [ "$(code "$css")" != 200 ]; then fail "static files are not served"; fi
# listens on 127.0.0.1 only by default
! ss -Hltn 'sport = :3000' | grep -v '127.0.0.1' | grep -q . || fail "listening beyond 127.0.0.1"

echo "== reinstall keeps the settings"
apt_install --reinstall "$deb"
[ "$(sudo sed -n 's/^NEXTAUTH_SECRET=//p' $ENV_FILE)" = "$secret" ] || fail "reinstall replaced NEXTAUTH_SECRET"
for _ in $(seq 60); do [ "$(code /)" = 200 ] && break; sleep 0.5; done
[ "$(code /)" = 200 ] || fail "not running after reinstall"

echo "== purge"
sudo apt-get purge -y rproxy-ui
! systemctl is-active --quiet rproxy-ui || fail "still running after purge"
[ ! -e /etc/rproxy-ui ] || fail "/etc/rproxy-ui left behind"
[ ! -e /usr/lib/rproxy-ui ] || fail "/usr/lib/rproxy-ui left behind"
# the rproxy group is shared with rproxy-api: purging the UI keeps it
getent group rproxy >/dev/null || fail "purge removed the shared rproxy group"
sudo rm -rf /etc/rproxy
echo "OK"
