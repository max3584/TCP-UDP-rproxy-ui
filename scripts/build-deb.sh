#!/usr/bin/env bash
# rproxy-ui の Debian パッケージを作る（Architecture: all。Node.js はディストリの nodejs に依存する）。
#
#   scripts/build-deb.sh [出力先のディレクトリ（既定 dist/）]
#
# next build（output: 'standalone'）の結果を /usr/lib/rproxy-ui に置き、node server.js で動かす。
# 必要なもの: node / npm（npm ci 済み）、dpkg-deb。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/dist}
mkdir -p "$out"
out=$(cd "$out" && pwd)
cd "$root"

version=$(node -p "require('./package.json').version")
npm run build >/dev/null

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
lib=$stage/usr/lib/rproxy-ui
mkdir -p "$lib" "$stage/DEBIAN" "$stage/usr/lib/systemd/system" "$stage/etc/rproxy-ui" \
	"$stage/usr/share/doc/rproxy-ui" "$stage/usr/share/rproxy-ui"

cp -a .next/standalone/. "$lib/"
mkdir -p "$lib/.next"
cp -a .next/static "$lib/.next/static"
cp -a public "$lib/public"
# never ship the build machine's settings or secrets
find "$lib" -maxdepth 1 -name '.env*' -delete
# next/image is not used (images.unoptimized): drop the per-CPU native library so the package is arch: all
rm -rf "$lib/node_modules/@img" "$lib/node_modules/sharp"
if [ -n "$(find "$lib" -name '*.node' -print -quit)" ]; then
	echo "native modules found; the package would not be arch-independent:" >&2
	find "$lib" -name '*.node' >&2
	exit 1
fi
# the cache is written at run time; /usr is read-only for the service
rm -rf "$lib/.next/cache"
ln -s /var/cache/rproxy-ui "$lib/.next/cache"

install -m 0644 packaging/debian/rproxy-ui.service "$stage/usr/lib/systemd/system/rproxy-ui.service"
install -m 0600 packaging/debian/rproxy-ui.env "$stage/etc/rproxy-ui/rproxy-ui.env"
install -m 0644 README.md "$stage/usr/share/doc/rproxy-ui/README.md"
install -m 0644 LICENSE "$stage/usr/share/doc/rproxy-ui/copyright"
cp -a db "$stage/usr/share/rproxy-ui/db"
for s in postinst prerm postrm; do install -m 0755 "packaging/debian/$s" "$stage/DEBIAN/$s"; done
echo /etc/rproxy-ui/rproxy-ui.env > "$stage/DEBIAN/conffiles"
# the same modes whatever the umask of the build machine
chmod -R u=rwX,go=rX "$stage"
chmod 0600 "$stage/etc/rproxy-ui/rproxy-ui.env"
chmod 0755 "$stage"/DEBIAN/postinst "$stage"/DEBIAN/prerm "$stage"/DEBIAN/postrm

cat > "$stage/DEBIAN/control" <<CONTROL
Package: rproxy-ui
Version: $version-1
Architecture: all
Maintainer: touka shiro / max3584 <max3584.work@gmail.com>
Installed-Size: $(du -sk --exclude=DEBIAN "$stage" | cut -f1)
Depends: nodejs (>= 20.9), passwd
Recommends: rproxy-api (= $version-1)
Section: web
Priority: optional
Homepage: https://github.com/max3584/TCP-UDP-rproxy-ui
Description: web UI for rproxy-api
 Dashboard and rule editor for rproxy-api, the L4 TCP/UDP forwarder managed
 through an HTTP API. Sign-in with Keycloak; rules are stored in MariaDB.
CONTROL
chmod 0644 "$stage/DEBIAN/control" "$stage/DEBIAN/conffiles"

deb="$out/rproxy-ui_${version}-1_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$stage" "$deb" >/dev/null
echo "$deb"
