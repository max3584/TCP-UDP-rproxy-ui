#!/usr/bin/env bash
# rproxy-ui の .deb をこの機械に実際に入れて確かめる（sudo と systemd が要る。GitHub の Ubuntu ランナー用）。
#
#   scripts/test-deb.sh dist/rproxy-ui_<version>-1_all.deb
#
# nodejs (>= 20.18.1) を apt で入れられること（Ubuntu 24.04 なら NodeSource）が前提。
# rproxy-ui を本番で動かしている機械では実行しない。
set -euo pipefail

deb=$(realpath "$1")
ENV_FILE=/etc/rproxy-ui/rproxy-ui.env

fail() { echo "FAIL: $*" >&2; sudo journalctl -u rproxy-ui --no-pager -n 50 >&2 || true; exit 1; }
set_env() { sudo sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; }
code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$1"; }

echo "== a token from rproxy-api on the same host is picked up"
sudo install -d /etc/rproxy
echo 'from-rproxy-token' | sudo tee /etc/rproxy/tokens >/dev/null
echo 'RPROXY_API_PORT=8099' | sudo tee /etc/rproxy/rproxy.env >/dev/null

# the UI may run on another host than rproxy-api: apt must not pull rproxy-api in
[ -z "$(dpkg-deb --field "$deb" Recommends)" ] || fail "rproxy-api must not be a Recommends (apt installs those)"

echo "== install"
sudo apt-get install -y "$deb"
getent passwd rproxy-ui >/dev/null || fail "no rproxy-ui user"
[ "$(sudo stat -c '%a %U:%G' $ENV_FILE)" = "600 root:root" ] || fail "env file mode/owner"
sudo grep -Eq '^NEXTAUTH_SECRET=[0-9a-f]{64}$' $ENV_FILE || fail "NEXTAUTH_SECRET not generated"
sudo grep -qx 'RPROXY_API_TOKEN=from-rproxy-token' $ENV_FILE || fail "rproxy token not picked up"
sudo grep -qx 'RPROXY_API_URL=http://127.0.0.1:8099' $ENV_FILE || fail "rproxy URL not picked up"
! systemctl is-active --quiet rproxy-ui || fail "started before it was configured"
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
[ "$(code /api/auth/providers)" = 200 ] || fail "NextAuth is not configured"
[ "$(code /api/forward/capabilities)" = 401 ] || fail "API answered without a session"
css=$(curl -s http://127.0.0.1:3000/ | grep -o '/_next/static/[^"]*\.css' | head -n1)
if [ -z "$css" ] || [ "$(code "$css")" != 200 ]; then fail "static files are not served"; fi
# listens on 127.0.0.1 only by default
! ss -Hltn 'sport = :3000' | grep -v '127.0.0.1' | grep -q . || fail "listening beyond 127.0.0.1"

echo "== reinstall keeps the settings"
sudo apt-get install -y --reinstall "$deb"
[ "$(sudo sed -n 's/^NEXTAUTH_SECRET=//p' $ENV_FILE)" = "$secret" ] || fail "reinstall replaced NEXTAUTH_SECRET"
for _ in $(seq 60); do [ "$(code /)" = 200 ] && break; sleep 0.5; done
[ "$(code /)" = 200 ] || fail "not running after reinstall"

echo "== purge"
sudo apt-get purge -y rproxy-ui
! systemctl is-active --quiet rproxy-ui || fail "still running after purge"
[ ! -e /etc/rproxy-ui ] || fail "/etc/rproxy-ui left behind"
[ ! -e /usr/lib/rproxy-ui ] || fail "/usr/lib/rproxy-ui left behind"
sudo rm -rf /etc/rproxy
echo "OK"
