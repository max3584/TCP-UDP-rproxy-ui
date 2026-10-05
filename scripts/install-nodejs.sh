#!/bin/sh
# Debian / Ubuntu に NodeSource の nodejs をメジャー版を指定して入れる（README の「インストール」と同じ手順）。
# CI の .deb の作成・確かめ（debian:trixie-slim のコンテナ）で使う。root で動かす（curl と ca-certificates が要る）。
#
#   NODE_MAJOR=24 scripts/install-nodejs.sh
#
# apt の pin（優先度 600）で NodeSource の nodejs を選ばせ、ディストリの nodejs（Debian 13 は 20、Ubuntu 24.04 は 18）は使わない。
set -eu

NODE_MAJOR=${NODE_MAJOR:-24}

install -d -m 0755 /etc/apt/keyrings
curl -fsSLo /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
	> /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
apt-get update
apt-get install -y nodejs

# the pin must have picked NodeSource's build of the requested major
case "$(node --version)" in
v"${NODE_MAJOR}".*) node --version ;;
*)
	echo "expected Node.js ${NODE_MAJOR}.x, got $(node --version)" >&2
	exit 1
	;;
esac
