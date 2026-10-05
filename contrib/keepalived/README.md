# keepalived と組む（act / stb の昇格の前に揃える）

English: [README.en.md](README.en.md)

rproxy-ui の active_standby のグループ（`RPROXY_UI_NODES` の `groups[].mode: active_standby`）で、VIP を keepalived で動かすときのスクリプトと設定の例（rproxy-ui #109）。
.deb では `/usr/share/doc/rproxy-ui/examples/keepalived/` に入る。

| ファイル | 使い方 |
|---|---|
| `rproxy-ui-ready.sh` | `vrrp_script`（track_script）。`GET /api/forward/ha/ready?node=` が 503（DB の定義に揃っていない）なら 1 で終わり、keepalived が `weight` の分だけ優先度を下げる。UI に届かないとき・ほかの応答は 0（昇格を邪魔しない） |
| `rproxy-ui-notify.sh` | `notify_master`。昇格した直後に `POST /api/forward/ha/notify?node=` を裏で呼び、UI にそのノードのずれ・未登録をすぐ送り直させる。UI に届かなくても 0 |
| `keepalived.conf.example` | node1 の例（track_script の weight、notify_master、preempt / nopreempt） |

## 準備

1. UI に `RPROXY_UI_HA_TOKEN_FILE=/etc/rproxy-ui/ha.tokens` を設定し、トークンを 1 行に 1 つ書く（`openssl rand -hex 32` など）。このトークンでできるのは、揃っているかを読むことと、DB の定義を送り直させることだけ。
2. 各ノードの `/etc/keepalived/rproxy-ui-ha.token`（root だけが読めるモード 600）に同じトークンを 1 行で置く。
3. `keepalived.conf.example` を参考に、ノード名・UI の URL・VIP を書き換える（VIP は `groups[].vip` と同じ）。
4. 動きの確認：`/usr/share/doc/rproxy-ui/examples/keepalived/rproxy-ui-ready.sh node1 http://10.0.0.5:3000; echo $?`（0 なら揃っている、または UI に届かない）。

UI は `auto_resend` が false でないグループを `RPROXY_UI_HA_SYNC_SECS`（既定 30 秒）ごとに調べ、ずれた stb に自動で送り直す。track_script はその合間の守り、notify_master は昇格した直後の守り。
元の act に戻す（failback）ときは、UI の「act / stb」の画面で戻す先が揃っていることを確かめてから、keepalived で戻す。
