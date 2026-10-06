#!/bin/sh
# CI（node:24-alpine のコンテナ）で、ACME の試験用の CA の Pebble（Alpine の pebble パッケージ）を同じコンテナの中で動かし、
# rproxy-api の設定ファイル（RPROXY_CONFIG）の global.acme を書く。画面から ACME の証明書を実際に取る E2E（tests/ui/acme.spec.ts）に使う。
#
#   scripts/ci-pebble.sh <作業ディレクトリ>
#
# - Pebble の HTTPS（WFE）の証明書は自分で作る（パッケージにはない）。rproxy は ca_file でそれを信頼する。
# - Pebble は名前を /etc/hosts で引き、HTTP-01 を 5002 番に確かめに来る。rproxy は global.acme.http01_listen（127.0.0.1:5002）で答える。
# - resolver：pebble-http（http-01）、pebble-dns（dns-01。届かない PowerDNS。ワイルドカードの検証の選択肢に使うだけ）、
#   offline（届かない CA。取れないままの状態＝仮の証明書と失敗の表示を確かめる）。
# - 書いた設定ファイルのパスを標準出力に出す。
set -eu

dir=$1
pebble=${PEBBLE:-/usr/bin/pebble}
name_suffix=acme-e2e.test

mkdir -p "$dir/acme"
cd "$dir"

# Pebble の WFE の証明書（127.0.0.1）
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout wfe-ca.key -out wfe-ca.pem -days 2 \
	-subj '/CN=pebble WFE test CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout wfe.key -out wfe.csr -subj '/CN=127.0.0.1' 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' > wfe.ext
openssl x509 -req -in wfe.csr -CA wfe-ca.pem -CAkey wfe-ca.key -CAcreateserial -out wfe.pem -days 2 -extfile wfe.ext 2>/dev/null

cat > pebble.json <<JSON
{"pebble": {
  "listenAddress": "127.0.0.1:14000",
  "managementListenAddress": "127.0.0.1:15000",
  "certificate": "$dir/wfe.pem",
  "privateKey": "$dir/wfe.key",
  "httpPort": 5002,
  "tlsPort": 5001,
  "ocspResponderURL": "",
  "externalAccountBindingRequired": false,
  "retryAfter": {"authz": 1, "order": 1}
}}
JSON

# 名前は Pebble が /etc/hosts で引く（rproxy の待ち受けは 127.0.0.1）
for n in "www.$name_suffix" "offline.$name_suffix"; do
	grep -q " $n\$" /etc/hosts || echo "127.0.0.1 $n" >> /etc/hosts
done

PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 PEBBLE_AUTHZREUSE=0 \
	nohup "$pebble" -config "$dir/pebble.json" -strict=false > "$dir/pebble.log" 2>&1 &

i=0
until curl -sf --cacert wfe-ca.pem https://127.0.0.1:14000/dir >/dev/null; do
	i=$((i + 1))
	if [ "$i" -gt 30 ]; then
		cat "$dir/pebble.log" >&2
		exit 1
	fi
	sleep 1
done

echo 'not-a-real-key' > pdns.key
cat > rproxy.yaml <<YAML
version: 1
global:
  acme:
    storage: $dir/acme
    accounts:
      pebble:
        directory: https://127.0.0.1:14000/dir
        contact: ['mailto:admin@$name_suffix']
        allowed_names: ['**.$name_suffix', '$name_suffix']
        ca_file: $dir/wfe-ca.pem
      offline:
        directory: https://127.0.0.1:1/dir
        allowed_names: ['**.$name_suffix']
    dns_providers:
      pdns:
        type: powerdns
        api_url: http://127.0.0.1:1
        api_key_file: $dir/pdns.key
        allowed_names: ['*.$name_suffix', '$name_suffix']
    resolvers:
      pebble-http: {account: pebble, challenge: http-01}
      pebble-dns: {account: pebble, challenge: dns-01, dns_provider: pdns}
      offline: {account: offline, challenge: http-01}
    http01_listen: ['127.0.0.1:5002']
    rate_limit: {orders: 50, period: 1h}
YAML
echo "$dir/rproxy.yaml"
