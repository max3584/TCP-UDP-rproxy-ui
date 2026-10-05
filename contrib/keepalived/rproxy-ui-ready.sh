#!/bin/sh
# keepalived の track_script：このノードが rproxy-ui の DB の定義に揃っているかを確かめる（rproxy-ui #109）。
#   rproxy-ui-ready.sh <ノード名> [UI の URL（既定 http://127.0.0.1:3000）] [トークンファイル（既定 /etc/keepalived/rproxy-ui-ha.token）]
# UI が 503（揃っていない）を返したときだけ 1 で終わる（keepalived が weight の分だけ優先度を下げる）。
# UI に届かない・トークンが読めない・ほかの応答（500 など）は 0（昇格を邪魔しない。act が落ちたら古い設定でも昇格する）
node=${1:?usage: rproxy-ui-ready.sh <node> [url] [token-file]}
url=${2:-http://127.0.0.1:3000}
token_file=${3:-/etc/keepalived/rproxy-ui-ha.token}

token=$(head -n 1 "$token_file" 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Authorization: Bearer $token" "$url/api/forward/ha/ready?node=$node") || exit 0
if [ "$code" = "503" ]; then
	exit 1
fi
exit 0
