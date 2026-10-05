#!/bin/sh
# keepalived の notify_master：このノードが昇格した直後に、rproxy-ui に「すぐ揃えて」と知らせる（rproxy-ui #109）。
#   rproxy-ui-notify.sh <ノード名> [UI の URL（既定 http://127.0.0.1:3000）] [トークンファイル（既定 /etc/keepalived/rproxy-ui-ha.token）]
# UI はこのノードのずれ・未登録を DB の定義で送り直す。UI に届かなくても何もせず 0 で終わる（昇格を止めない）。
# 送り直しを待たないように、裏で動かして（&）すぐ戻る
node=${1:?usage: rproxy-ui-notify.sh <node> [url] [token-file]}
url=${2:-http://127.0.0.1:3000}
token_file=${3:-/etc/keepalived/rproxy-ui-ha.token}

token=$(head -n 1 "$token_file" 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
(curl -s -o /dev/null -m 30 -X POST -H "Authorization: Bearer $token" "$url/api/forward/ha/notify?node=$node&state=MASTER" >/dev/null 2>&1 || true) &
exit 0
