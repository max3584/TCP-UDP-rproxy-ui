#!/bin/sh
# CI（node:24-alpine のコンテナ）で、Alpine の mariadb パッケージを同じコンテナの中で動かす。
# 公式の mariadb イメージは Ubuntu が元なので使わない。
#
#   scripts/ci-mariadb.sh <データベース名> <root のパスワード>
#
# 3306 番で 0.0.0.0 に待ち受ける（別のコンテナの rproxy-api からもつなぐ）。root@'%' にパスワードを付ける。
set -eu

db=$1
password=$2

# Alpine's package turns networking off (skip-networking); a later file wins
cat > /etc/my.cnf.d/zz-ci.cnf <<'CNF'
[mysqld]
skip-networking = 0
bind-address = 0.0.0.0
port = 3306
CNF

install -d -o mysql -g mysql /run/mysqld
mariadb-install-db --user=mysql --datadir=/var/lib/mysql --skip-test-db >/dev/null
nohup mariadbd --user=mysql --datadir=/var/lib/mysql > /var/log/mariadb-ci.log 2>&1 &

i=0
until mariadb-admin ping --silent 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -gt 60 ]; then
		cat /var/log/mariadb-ci.log >&2
		exit 1
	fi
	sleep 1
done

# root over the Unix socket (unix_socket auth), then a password for TCP clients
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$db\`;
ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('$password');
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
mariadb --version
