# 設定と運用の手引き

English: [en/GUIDE.md](en/GUIDE.md)

この手引きは、rproxy-ui を入れて、最初の設定をし、毎日の作業と運用を続けていくための道案内です。rproxy-ui を動かす人で、rproxy（rproxy-api）を使うのは初めて、という人を読み手に想定しています。Linux のパッケージの入れ方や MariaDB の基本的な使い方は知っている前提で書いています。

この手引きは全体の道筋と考え方を説明し、項目ごとの細かい決まりは [README](../README.md) の各節に任せて、そこへリンクします。困ったときに画面に出るコードの調べ方は [8. 困ったとき](#8-困ったとき) にまとめています。

## この手引きの読み方

やりたいことに合わせて、次の章を読んでください。

| 場面 | 読む章 |
|---|---|
| はじめて入れる | [1.](#1-rproxy-ui-とは) で全体の形と言葉をつかみ、[2.](#2-入れる) のうち自分の置き場所の節だけを読んで入れます。続けて [3.](#3-最初の設定) で DB・設定ファイル・rproxy-api への接続を整え、[4.](#4-サインイン) でサインインの方法を決めます |
| 毎日使う（ルールを足す・直す・戻す） | [5.](#5-毎日の使い方) を読みます。管理者でない人（利用者）は、自分にできることの範囲を [4.4](#44-ロール) と [4.5](#45-利用者にできること) で確かめておいてください |
| rproxy を複数台で動かす・act / stb で冗長にする | [6.](#6-複数のノードとグループ) でノードとグループを設定し、[5.6](#56-ずれと送り直し) でずれの直し方を、[7.3](#73-keepalived-と組むact--stb) で keepalived との組み方を読みます |
| 版を上げる・バックアップを取る・守りを固める | [7.](#7-運用) を読みます |
| うまく動かない | 画面の誤りの文の後ろに出るコード（`no_role` など）で [8.](#8-困ったとき) を探します。見つからないときは [7.4](#74-ログ) のログを見ます |

## 目次

1. [rproxy-ui とは](#1-rproxy-ui-とは)
2. [入れる](#2-入れる)
3. [最初の設定](#3-最初の設定)
4. [サインイン](#4-サインイン)
5. [毎日の使い方](#5-毎日の使い方)
6. [複数のノードとグループ](#6-複数のノードとグループ)
7. [運用](#7-運用)
8. [困ったとき](#8-困ったとき)

## 1. rproxy-ui とは

この章では、rproxy-ui が何をするもので、rproxy-api や MariaDB とどうつながっているかを説明します。あとの章に出てくる言葉もここでまとめて説明するので、はじめての人は最初に読んでください。

### 1.1 しくみ

rproxy-ui は、[rproxy-api](https://github.com/max3584/rproxy-api) の転送ルールをブラウザから管理するための Web UI です。rproxy-api は Rust で書かれた TCP / UDP のリバースプロキシで、決まったポートで接続を待ち受け、それを別のサーバ（転送先）へ中継します。どのポートで待ち受けて、どこへ中継するかを決めたものを**転送ルール**（この手引きでは単に「ルール」）と呼びます。

3 つの部品は、次のようにつながっています。

```
ブラウザ ──▶ rproxy-ui ──制御 API（トークン）──▶ rproxy-api ──▶ 転送先
                 │
                 └──▶ MariaDB（ルール・履歴・利用量）◀── rproxy-api（起動時に読むだけ）
```

- **ルールの正（正しい内容の置き場所）は、MariaDB の `forward_rules` という表です。** 画面でルールを保存すると、UI はまず DB に書き、それから rproxy-api の制御 API に送ります。rproxy が断ったときは、DB に書いた分も元に戻すので、DB と rproxy の中身が食い違ったまま残ることはありません。
- **rproxy-api は、起動するときに `forward_rules` を読んでルールを戻します。** rproxy が UI に問い合わせることはないので、UI が止まっていても転送は止まりません。UI はルールを変えるときにだけ要る道具です。
- **変更はすべて `forward_rules_log` という表に残ります。** だれがいつ何を変えたかの履歴と、前の版への巻き戻し（[5.4](#54-履歴と巻き戻し)）に使います。
- **rproxy の設定ファイルに書いたルール（固定ルール）は DB に入りません。** 画面には読み取り専用で出ます。固定ルールを変えるには設定ファイルを直しますが、ファイルはそのままに画面から足せる部分もあります（[5.2](#52-固定ルールに重ねる分)）。
- **rproxy-ui と rproxy-api の版は別々に進みます。** UI が必要とする rproxy-api の最小の版は、UI のリリースノートに書きます（[7.1](#71-上げる)）。

### 1.2 この手引きに出てくる言葉

ここでは、あとの章で何度も出てくる言葉を説明します。いま全部を覚える必要はありません。分からない言葉に出会ったら、ここに戻ってきてください。

**rproxy-api と制御 API**：rproxy-api は、実際に通信を中継するプロキシの本体です（この手引きでは短く「rproxy」とも書きます）。rproxy-api は、ルールの追加・変更・削除を受け付ける HTTP の API を持っていて、これを**制御 API** と呼びます。rproxy-ui は、この制御 API を通して rproxy を操作します。

**2 種類のトークン**：この手引きには、役目の違う 2 種類のトークンが出てきます。取り違えやすいので、最初に区別しておきます。

- **UI が rproxy-api に送るトークン**：UI が制御 API を呼ぶときの合い言葉です。rproxy-api のトークンファイル（`/etc/rproxy/tokens`）に登録し、UI の設定（`RPROXY_API_TOKEN` か `RPROXY_API_TOKEN_FILE`）に書きます。UI 全体で 1 つです（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。
- **人が UI にサインインするためのトークン**：Keycloak を使わないときに、人がサインインのページに貼る合い言葉です。`rproxy-ui-token` で作り、UI のトークンのファイル（`RPROXY_UI_TOKENS_FILE`）に登録します。人ごとに 1 つです（[4.1](#41-keycloak-なしトークン)）。

**スコープ**：rproxy-api のトークンに付ける権限の印です（`rules:read`・`rules:write`・`admin` など）。そのトークンで何ができるかを決めます。UI のトークンには `admin` を付けます（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。

**ルールのキー**：ルールは、プロトコル（tcp か udp）・待ち受けアドレス・ポートの組で見分けます。この組をキーと呼びます。同じキーのルールは同じ場所に 2 つ置けません。

**固定ルール・API のルール・組**：rproxy が動かしているルールには、UI が作ったもののほかに、出どころの違うものがあります。**固定ルール**は rproxy の設定ファイル（`RPROXY_STATIC_RULES`）に書いたルールです。**API のルール**は、UI を通さずに rproxy の制御 API を直接呼んで作ったルール（CI・スクリプト・Kubernetes のコントローラなどが作るもの）で、管理者の画面に「API」の印で出ます。**組**（ルールの組、`ruleset`）は、Kubernetes のコントローラなどがまとめて丸ごと渡すルールの集まりで、画面では読み取り専用です。

**管理者と利用者（ロール）**：UI を使う人には、管理者と利用者の 2 つの立場があります。**管理者**（ロール `rproxy-admin`）は、すべての人のルールと rproxy 全体の設定を扱えます。**利用者**（`RPROXY_UI_USER_ROLE` で決めたロール）は、自分が作ったルールだけを扱え、使えるポートや転送先を管理者が絞れます。どちらのロールもない人は UI を使えません（[4.4](#44-ロール)）。

**持ち主**：UI で作ったルールには、作った人が持ち主として記録されます。持ち主は Keycloak の利用者の ID（`sub`）か、トークンでのサインインなら `token:<名前>` です。利用者は、自分が持ち主のルールだけを見て、直せます。

**ノードとグループ**：1 つの UI で、複数の rproxy を管理できます。UI から見た 1 台の rproxy を**ノード**と呼びます。同じルールを持たせたいノードのまとまりが**グループ**で、グループに置いたルールは、そのすべてのノードに送られます（[6.](#6-複数のノードとグループ)）。rproxy が 1 台なら、ノードとグループのことは気にしなくて構いません。

**重ねる分（overlay）**：固定ルールは画面から変えられませんが、設定ファイルはそのままに、HTTP のルートや、サーバ名ごとの転送先を画面から足せます。この足した部分を「重ねる分」と呼びます（[5.2](#52-固定ルールに重ねる分)）。

**ずれと送り直し**：UI の DB にある正しい内容と、rproxy で実際に動いている内容が食い違っている状態を**ずれ**と呼びます。複数のノードで 1 台だけ古い内容のまま残った、rproxy を再起動して重ねる分が消えた、といったときに起きます。UI はずれを画面に出し、DB の内容を rproxy にもう一度送って揃えます。これを**送り直し**と呼びます（[5.6](#56-ずれと送り直し)）。

**act / stb**：2 台の rproxy で 1 つのアドレス（VIP、仮想 IP アドレス）を引き継ぎ合って冗長にする構成です。いま VIP を持って通信を受けているほうを **act**（active）、控えているほうを **stb**（standby）と呼びます。VIP を動かすのは keepalived で、UI は stb が act と同じルールを持っているかを見張ります（[7.3](#73-keepalived-と組むact--stb)）。

**persist**：rproxy-api のトークンに付ける印の 1 つで、付けたトークンで作ったルールを rproxy が自分の DB の表に保存し、再起動しても戻すようにします。UI のトークンにはふつう付けません。付けるかどうかの引き換えは [3.3](#33-rproxy-api-への接続とトークンのスコープ) で説明します。

**migration**：UI が使う DB の表を作ったり、形を変えたりする SQL です。`db/migrations/` に `001` から順に番号の付いたファイルとして入っていて、新しい機能が新しい表を必要とするたびに 1 つ増えます。この手引きで「migration `015`」と書いたら、`015_forward_rule_overlays.sql` のことです。当て方は [3.1](#31-dbmariadbと-migration) で説明します。

**features**：rproxy-api は、自分が使える機能の一覧を `GET /capabilities` の `features` で返します。UI はこれを見て、その rproxy で使える欄やボタンだけを出します。この手引きで「`features.static_overlay` があれば」と書いたら、rproxy がその機能を使えると答えたとき、という意味です。

## 2. 入れる

この章では、rproxy-ui を入れる手順を置き場所ごとに説明します。どの入れ方でも、中身は同じもの（Next.js の standalone の形にまとめたアプリ）です。自分の置き場所の節だけを読めば足ります。

| 置き場所 | 入れ方 | 詳しく |
|---|---|---|
| Debian / Ubuntu の VM | apt（`rproxy-ui`） | 下の 2.1、[PRODUCTION.md](PRODUCTION.md) |
| Raspberry Pi | apt（arm64） | 下の 2.2 |
| Kubernetes | Helm chart | 下の 2.3、[KUBERNETES.md](KUBERNETES.md) |
| コンテナ（Docker など） | `ghcr.io/max3584/rproxy-ui` | 下の 2.4 |

### 2.1 Debian / Ubuntu（VM）

この節では、Debian や Ubuntu の VM に apt で入れる手順を説明します。rproxy-api と同じホストに置くのが、いちばん簡単な形です。

rproxy-ui は Node.js で動くので、先に Node.js を入れます。要る版は 22.23.4 以上です（24 系なら 24.22.1 以上、26 系なら 26.12.1 以上）。Debian 13 が標準で持っている nodejs は 20、Ubuntu 24.04 のものは 18 で、どちらも古くて使えません。そこで、[NodeSource](https://github.com/nodesource/distributions) が配っている nodejs を入れます。次のコマンドは、NodeSource の apt リポジトリを足し、ディストリの nodejs ではなく NodeSource のものが選ばれるようにしてから、nodejs を入れます。

```shell
NODE_MAJOR=24
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSLo /etc/apt/keyrings/nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' \
  | sudo tee /etc/apt/preferences.d/nodejs
sudo apt update && sudo apt install nodejs
node --version      # v24.x.x
```

- `NODE_MAJOR=24` で、入れる Node.js のメジャー版を決めます。リポジトリの URL にこの版が入るので、apt が勝手に次のメジャー版へ上げることはありません。
- `printf 'Package: nodejs ...'` の行は、apt の pin（優先度の設定）です。NodeSource から来た nodejs の優先度を 600 にして、ディストリの nodejs より先に選ばれるようにします。
- 最後の `node --version` で、`v24.` で始まる版が出れば入っています。

メジャー版の上げ方と pin の意味は、[README の「インストール」](../README.md#インストールdebian--ubuntu) で詳しく説明しています。

続けて、rproxy-ui を入れます。rproxy-ui は rproxy-api と同じ apt リポジトリで配っているので、次のコマンドでリポジトリを足してから入れます。rproxy-api も同じホストに置くなら、ここで一緒に入れます。

```shell
sudo curl -fsSLo /usr/share/keyrings/rproxy-archive-keyring.gpg https://max3584.github.io/rproxy-api/rproxy-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/rproxy-archive-keyring.gpg] https://max3584.github.io/rproxy-api stable main" \
  | sudo tee /etc/apt/sources.list.d/rproxy-api.list
sudo apt update && sudo apt install rproxy-api   # 同じホストに置くなら先に入れる
sudo apt install rproxy-ui
```

入れた後のことを、いくつか説明しておきます。

- **入れただけでは起動しません。** 設定がまだ空なので、[3. 最初の設定](#3-最初の設定)を済ませてから `sudo systemctl enable --now rproxy-ui` で起動します。
- **rproxy-api を先に入れておくと、設定の一部が自動で入ります。** rproxy-ui を入れるとき、同じホストに rproxy-api があれば、制御 API の URL と、トークンファイルの場所（`RPROXY_API_TOKEN_FILE=/etc/rproxy/tokens`）を env ファイルに書きます。ただし、rproxy-ui は rproxy-api を「あれば使う」（Suggests）としているだけなので、2 つを一度に入れても、apt は入れる順番を決めません。上のコマンドのように rproxy-api を先に入れてください。自動で入らなかったときは、`RPROXY_API_URL` と `RPROXY_API_TOKEN_FILE`（か `RPROXY_API_TOKEN`）を手で書きます（[3.2](#32-env-ファイル)）。
- **`rproxy-ui` ユーザーは、rproxy-api と共有するグループ `rproxy` に入ります。** そのため、rproxy-api のトークンファイルや Unix ソケットを、コピーせずにそのまま読めます。
- **既定では `127.0.0.1:3000` で待ち受けます。** つまり、そのホストの中からしか開けません。ほかのマシンのブラウザから使うときは、rproxy の固定ルールで TLS を終端して UI の前に置きます。手順は [PRODUCTION.md の「ダッシュボードの公開（固定ルール）」](PRODUCTION.md#ダッシュボードの公開固定ルール) にあります。

### 2.2 Raspberry Pi

Raspberry Pi でも、手順は 2.1 と同じです。

- パッケージ `rproxy-ui` は、CPU の種類を問わない 1 つの .deb（アーキテクチャ `all`）です。arm64 でも 2.1 と同じ手順で入ります。
- arm64 では、NodeSource の nodejs で動きます。Raspberry Pi では、64 ビットの OS（Raspberry Pi OS の 64 ビット版など）を使ってください。
- Kubernetes やコンテナで動かす場合も、イメージは amd64 と arm64 の両方があります。

### 2.3 Kubernetes（Helm）

この節では、Kubernetes に Helm の chart で入れるときの要点を説明します。秘密の作り方や values の例など、手順の全体は [KUBERNETES.md](KUBERNETES.md) にあります。

次のコマンドで、namespace `rproxy-ui` に、`values.yaml` の設定で入れます。`<版>` には入れる版を書きます。

```shell
helm install rproxy-ui oci://ghcr.io/max3584/charts/rproxy-ui --version <版> -n rproxy-ui -f values.yaml
```

- **chart は秘密を作りません。** DB のパスワードや `NEXTAUTH_SECRET` などを入れた Secret を先に自分で作り、その名前を `existingSecret` で chart に渡します。
- **DB は、クラスタの外の MariaDB を使うのが既定です。** 試しに動かすだけなら、`mariadb.enabled: true` で chart に同梱の MariaDB を入れられます。ただし同梱のものは 1 台だけで、冗長にはなりません。
- **migration は自動で当たります。** Helm のフック（`post-install`・`pre-upgrade`）で動く Job が、`db/migrate.mjs` で当てます。手で当てる必要はありません。
- Keycloak なしで入れる方法と、Kubernetes の Gateway の rproxy を UI から見る方法も [KUBERNETES.md](KUBERNETES.md) にあります。

### 2.4 コンテナ（Docker など）

この節では、Docker などでイメージをそのまま動かすときの要点を説明します。

イメージは `ghcr.io/max3584/rproxy-ui:<版>` です。中のプロセスは uid 65532 で動き、ポート 3000 で、すべてのアドレス（`HOSTNAME=0.0.0.0`）で待ち受けます。ファイルを書くのは `/tmp` と `/app/.next/cache` だけなので、ルートのファイルシステムを読むだけにして動かせます。次のコマンドは、その形で、権限をできるだけ落として起動する例です。

```shell
docker run -d --name rproxy-ui --env-file rproxy-ui.env -p 3000:3000 \
  --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=65532,gid=65532 \
  --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/max3584/rproxy-ui:<版>
```

- `--env-file rproxy-ui.env` で、設定を渡します。
- `--read-only` でルートを読むだけにし、書く 2 か所だけを `--tmpfs` でメモリの上に用意します。`/app/.next/cache` は uid 65532 が書けるようにしています。
- `--cap-drop ALL` と `--security-opt no-new-privileges` で、コンテナの権限を落とします。

コンテナで動かすときに気をつけることは、次のとおりです。

- **env ファイルの中身は、[3.2](#32-env-ファイル) と同じです。** ただし `docker --env-file` は値の引用符をそのまま値の一部として読むので、引用符を付けずに書きます。`HOSTNAME` は書かず、イメージの `0.0.0.0` のままにします（`127.0.0.1` にすると、コンテナの外から届かなくなります）。
- **migration は、イメージの中の `node db/migrate.mjs` で当てます**（[3.1](#31-dbmariadbと-migration)）。**サインインのトークン**は `node rproxy-ui-token.mjs new --name admin --role admin --stdout` で作ります。
- **トークンのファイルをマウントするとき**は、uid 65532 の持ち物でモード 600 にするか、root の持ち物・グループ 65532・モード 0440 にして `--group-add 65532` を付けます。それ以外の持ち主やモードだと、UI は起動しません（[4.1](#41-keycloak-なしトークン)）。
- **生きているかは `GET /api/healthz` で確かめます。** サインインなしで `{"ok":true}` を返します。DB や rproxy には問い合わせないので、UI のプロセスが動いているかだけが分かります。

## 3. 最初の設定

この章では、入れた後、起動する前に済ませておく設定を説明します。次の順に進めます。

1. DB を用意し、表を作る（3.1）
2. env ファイルに設定を書く（3.2）
3. rproxy-api への接続を整える（3.3）
4. サインインの方法を決める（[4.](#4-サインイン)）
5. 起動して確かめる（3.3 の終わり）

### 3.1 DB（MariaDB）と migration

この節では、UI が使う MariaDB を用意し、表を作る手順を説明します。UI はルール・履歴・利用量をここに保存し、rproxy-api も起動時にここからルールを読みます。

DB を UI と同じホストに置くなら、`sudo apt install mariadb-server` で入れれば足ります。その場合は `DB_HOST=127.0.0.1` で接続し、DB への通信がホストの外に出ないので、TLS は要りません。

表は、DB の管理者の権限で作ります。UI がふだん使う DB ユーザーには、表を作ったり変えたりする権限（DDL）を渡さず、ふだんの読み書きに要る権限だけにします。この作業は `migrate.mjs` に任せるのがいちばん楽です。`migrate.mjs` は、新しい DB なら `schema.sql` で表を作り、UI の DB ユーザーを作って、要る権限だけを渡します。前からある DB なら、まだ当てていない migration だけを番号の順に当てます。当てたものは `schema_migrations` という表に記録するので、何度流しても同じものを 2 回当てることはありません。

`migrate.mjs` は、`DB_HOST`・`DB_PORT` に TCP でつなぎ、`DB_ADMIN_USER`・`DB_ADMIN_PASSWORD` のユーザーとパスワードで入ります。Unix ソケットからは入りません。この管理者には、DDL を流す権限が要ります。後で説明する `DB_APP_USER` で UI のユーザーも作らせるなら、ユーザーを作って権限を渡す権限（`CREATE USER` と `GRANT OPTION`）も要ります。

MariaDB の root がパスワードで TCP から入れるかどうかは、環境によって違います。root をソケットの認証だけにしている環境（Debian の既定など）では入れません。その場合は、パスワードで入れる管理者を作ります。次のコマンドは、`127.0.0.1` からパスワードで入れる管理者 `rproxy_admin` を作る例です。

```shell
sudo mariadb -e "CREATE USER 'rproxy_admin'@'127.0.0.1' IDENTIFIED BY '<管理者のパスワード>';
  GRANT ALL PRIVILEGES ON *.* TO 'rproxy_admin'@'127.0.0.1' WITH GRANT OPTION;"
```

この例は試しやすさを優先してすべての権限を渡しているので、環境に合わせて狭めて構いません。

管理者ができたら、`migrate.mjs` を流します。次のコマンドは、env ファイルの `DB_*` を読み込んだうえで、DB がなければ作り、表を作り、UI のユーザー `rproxy_ui` を作って権限を渡します。

```shell
sudo sh -c 'set -a; . /etc/rproxy-ui/rproxy-ui.env; \
  DB_ADMIN_USER=rproxy_admin DB_ADMIN_PASSWORD=<管理者のパスワード> \
  DB_APP_USER=rproxy_ui DB_APP_PASSWORD=<UI のパスワード> DB_APP_HOST=127.0.0.1 \
  node /usr/share/rproxy-ui/db/migrate.mjs --create-database'
```

- `set -a; . /etc/rproxy-ui/rproxy-ui.env` で、env ファイルの `DB_HOST`・`DB_PORT`・`DB_DATABASE` を読み込みます。接続先はここから決まるので、**先に env ファイルの `DB_*` を書いておいてください**（[3.2](#32-env-ファイル)）。
- `DB_ADMIN_USER`・`DB_ADMIN_PASSWORD` は、上で作った管理者です。
- `DB_APP_USER`・`DB_APP_PASSWORD` は、UI がふだん使うユーザーです。`DB_APP_PASSWORD` は、env ファイルの `DB_PASSWORD` と同じにします。`DB_APP_HOST` は、UI がつないでくるホストです（同じホストなら `127.0.0.1`）。
- `--create-database` は、`DB_DATABASE` の DB がまだなければ作ります。

同じコマンドで `--create-database` の代わりに `--status` を付けると、当てた migration とまだのものが出ます。`--dry-run` を付けると、何をするかを出すだけで、何も変えません。

そのほか、DB について知っておくことは次のとおりです。

- **手で表を作ることもできます。** `mariadb ... < /usr/share/rproxy-ui/db/schema.sql` で表を作り、[db/README.md の「DB ユーザー」](../db/README.md#db-ユーザー)の GRANT を流します。その場合、利用量の表（`usage_*`）の権限を渡し忘れないでください。
- **rproxy-api には、別の DB ユーザーを作ります。** rproxy-api は起動時にルールを読むだけなので、`GRANT SELECT ON rproxy.forward_rules` の読むだけのユーザーで足ります。rproxy-api v0.4 で、API のルール・global の値・固定ルールに重ねる分を rproxy 自身に保存させるなら、その表の権限も渡します（同じ節に書いてあります）。
- **前から手で migration を当ててきた DB** には `schema_migrations` の表がないので、`migrate.mjs` はどこまで当てたかが分からず、そのままでは断ります。その場合は、最初の 1 回だけ `--baseline <最後に当てた番号>` を付けて流します（[db/README.md の「migrate.mjs」](../db/README.md#migratemjs)）。
- **DB を別のホストに置くなら、DB への接続を TLS にします**（`DB_SSL=true`。社内の CA で DB の証明書を出しているなら `DB_SSL_CA` も。[README の「DB への接続（TLS）」](../README.md#db-への接続tls)）。

### 3.2 env ファイル

この節では、UI の設定を書く env ファイルの主な変数を説明します。UI の設定は、すべて環境変数で渡します。.deb で入れた場合、env ファイルは `/etc/rproxy-ui/rproxy-ui.env`（持ち主 `root:root`、モード 600）です。書き換えたら `sudo systemctl restart rproxy-ui` で UI を再起動すると効きます。

まず、どの構成でも書く変数です。

| 変数 | 何を決めるか | 既定 |
|---|---|---|
| `HOSTNAME`・`PORT` | UI が待ち受けるアドレスとポート | .deb は `127.0.0.1`・`3000`（コンテナのイメージは `0.0.0.0`。[2.4](#24-コンテナdocker-など)） |
| `NEXTAUTH_URL` | 利用者がブラウザで開く URL | なし（必ず書きます） |
| `NEXTAUTH_SECRET` | サインインのセッションを暗号にする鍵 | .deb はインストール時に作ります |
| `DB_HOST`・`DB_PORT`・`DB_DATABASE`・`DB_USER`・`DB_PASSWORD` | UI がつなぐ MariaDB | `DB_PORT` は 3306 |
| `RPROXY_API_URL` | rproxy-api の制御 API の場所 | 同じホストの rproxy-api があれば、インストール時に入ります |
| `RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` | UI が rproxy-api に送るトークン | 同上（`RPROXY_API_TOKEN_FILE`） |

- **`HOSTNAME`・`PORT`**：.deb の env ファイルの既定（`HOSTNAME=127.0.0.1`）では、そのホストの中からだけ開けます。前に rproxy の固定ルールを置いて外に見せる形（[2.1](#21-debian--ubuntuvm)）なら、このままにします。ほかのホストから直接開かせたいときだけ変えますが、その場合も TLS を終端する前段を置くのが基本です（[7.5](#75-セキュリティの注意)）。
- **`NEXTAUTH_URL`**：利用者がブラウザのアドレス欄に入れる URL を、そのまま書きます（例 `https://dashboard.example.com`）。UI はこれを、ほかのサイトからの要求を見分ける確認（CSRF）、HSTS のヘッダ（`https://` のとき）、Keycloak からの戻り先に使います。CSRF の確認では、ブラウザが送る `Origin` を、要求の `Host`・`X-Forwarded-Host`・`NEXTAUTH_URL` と比べます。前のプロキシが `Host` を書き換える構成で `NEXTAUTH_URL` も違っていると、保存のたびに 403 `csrf` で断られるので、必ず利用者が開く URL にしてください。
- **`NEXTAUTH_SECRET`**：.deb はインストール時にランダムな値を作って書くので、ふだんは触りません。変えると、今のセッションはすべて読めなくなり、全員がサインインし直しになります。UI を複数台で動かすなら、全台で同じ値にします（違うと、別の台に届いた要求でセッションが読めません）。
- **`DB_*`**：[3.1](#31-dbmariadbと-migration) で作った DB と UI のユーザーを書きます。`DB_USER` は `DB_APP_USER` に、`DB_PASSWORD` は `DB_APP_PASSWORD` に合わせます。
- **`RPROXY_API_URL`**：`http://`・`https://` の URL か、Unix ソケットの `unix:/run/rproxy/api.sock` を書きます。同じホストならどちらでも動きますが、守りに関わる global の設定を UI から変えるにはソケットが要ります（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。
- **`RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE`**：`RPROXY_API_TOKEN` にはトークンそのものを、`RPROXY_API_TOKEN_FILE` にはトークンを書いたファイルのパスを書きます。両方を書くと `RPROXY_API_TOKEN` が使われます。ファイルにしておくと、トークンを入れ替えるときに UI の設定を書き換えずに済みます（ファイルは書き換えれば次の問い合わせから使います）。どのトークンを使うかは [3.3](#33-rproxy-api-への接続とトークンのスコープ) で説明します。

次は、サインインと使う人に関わる変数です。どれを書くかは [4.](#4-サインイン) で決めます。

| 変数 | 何を決めるか | 既定 |
|---|---|---|
| `RPROXY_UI_AUTH` | サインインの方法（`keycloak`・`token`・`both`） | `keycloak` |
| `KEYCLOAK_ISSUER`・`KEYCLOAK_CLIENT_ID`・`KEYCLOAK_CLIENT_SECRET` | Keycloak でサインインさせるときの接続先とクライアント | なし |
| `RPROXY_UI_TOKENS_FILE` | トークンでサインインさせるときの、トークンのファイル | なし |
| `RPROXY_UI_USER_ROLE` | 利用者として扱うロールの名前 | 空（管理者しか使えません） |

- **`RPROXY_UI_AUTH`**：Keycloak を使うなら `keycloak`、Keycloak を置かずにトークンだけでサインインさせるなら `token`、両方を使えるようにするなら `both` にします（[4.](#4-サインイン)）。
- **`RPROXY_UI_USER_ROLE`**：空のままだと、管理者のロールを持つ人しか UI を使えません。管理者でない人にも自分のルールを作らせたいときに、`rproxy-user` などのロールの名前を書きます（[4.4](#44-ロール)）。

最後に、rproxy を複数台使うときの変数です。

| 変数 | 何を決めるか | 既定 |
|---|---|---|
| `RPROXY_UI_NODES` | 複数の rproxy を書いた `nodes.yaml` の場所 | なし（rproxy は 1 台） |

`RPROXY_UI_NODES` を書くと、rproxy の接続先とトークンは `nodes.yaml` から読むので、`RPROXY_API_URL`・`RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` は使われなくなります（[6.](#6-複数のノードとグループ)）。

ここに載せた変数のほかに、必要になったときに書く変数があります。どれも書かなければ既定のまま動きます。

| 変数 | 何を決めるか | 既定 | 説明 |
|---|---|---|---|
| `RPROXY_UI_SESSION_MAX_AGE` | サインインしてからセッションが切れるまでの秒数 | 28800（8 時間） | [4.2](#42-keycloak) |
| `RPROXY_UI_ROLE_REFRESH_SECS` | Keycloak にロールを聞き直す間隔（秒） | 300 | [4.2](#42-keycloak) |
| `RPROXY_UI_USER_*`・`RPROXY_UI_PROTECTED_TARGETS` | 利用者に許す範囲 | 制限なし（応答のキャッシュの上限 `RPROXY_UI_USER_CACHE_MAX_MEMORY`・`RPROXY_UI_USER_CACHE_MAX_ENTRIES` だけは 16 MiB・1024） | [4.5](#45-利用者にできること) |
| `RPROXY_UI_USAGE_SECS` | 利用量を集める間隔（秒。0 で止める） | 300 | [README の「利用量」](../README.md#利用量通信量の集計) |
| `RPROXY_UI_USAGE_HOURLY_DAYS`・`RPROXY_UI_USAGE_DAILY_DAYS` | 時間ごと・日ごとの利用量を残す日数 | 32・400 | 同上 |
| `RPROXY_API_TLS_CERT`・`RPROXY_API_TLS_KEY`・`RPROXY_API_TLS_CA` | 制御 API にクライアント証明書（mTLS）でつなぐとき | なし | [3.3](#33-rproxy-api-への接続とトークンのスコープ) |
| `RPROXY_UI_HA_SYNC_SECS`・`RPROXY_UI_HA_TOKEN_FILE` | act / stb の自動の送り直しの間隔と、keepalived が使うトークン | 30・なし | [7.3](#73-keepalived-と組むact--stb) |
| `RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS`・`RPROXY_UI_TOKEN_LOCKOUT_SECS`・`RPROXY_UI_TRUSTED_PROXIES` | 誤ったサインインのトークンの締め出しと、送信元の見分け方 | 5・900・なし | [7.5](#75-セキュリティの注意) |

変数の全部は、env ファイルの中のコメントと、[README の「開発」の環境変数の一覧](../README.md#開発)にあります。

### 3.3 rproxy-api への接続とトークンのスコープ

この節では、UI が rproxy-api の制御 API とつながるための設定と、UI のトークンに付ける権限（スコープ）を説明します。ここを誤ると、画面は開けてもルールの保存が 502 で断られます。

UI は、どの人が操作しても、rproxy-api とは UI の 1 つのトークンで話します。だれがどのルールを直してよいかは、rproxy ではなく UI が自分で確かめます。そのため、UI のトークンには、UI が使う操作をすべて許す権限が要ります。

まず、自分の rproxy-api のトークンファイルがどちらの書き方かを確かめます。

- **1 行に 1 トークンの書き方**（同じホストに入れたときの既定）：この書き方のトークンは、もともと `admin` の権限を持っています。何もしなくて構いません。
- **権限付きの書き方（YAML）**：トークンごとにスコープを書く書き方です。この場合は、**UI のトークンを `scopes: [admin]` にしてください。**

YAML の書き方では、UI のトークンを次のように書きます。rproxy-api のトークンファイルには、トークンそのものではなく SHA-256 の値だけを置きます。

```yaml
# /etc/rproxy/tokens（rproxy-api の RPROXY_TOKEN_FILE。SHA-256 だけを置く）
tokens:
  - name: rproxy-ui
    sha256: <printf %s "$TOKEN" | sha256sum の値>
    scopes: [admin]
```

- `name` は、rproxy のログなどでトークンを見分けるための名前です。
- `sha256` には、UI に持たせるトークンの SHA-256 を書きます。`$TOKEN` に UI のトークンを入れて、`printf %s "$TOKEN" | sha256sum` の出力の値を貼ります。
- `scopes: [admin]` で、このトークンにすべての操作を許します。

なぜ `admin` が要るのかは、UI が使う操作ごとに要るスコープを並べると分かります。

| UI が使う操作 | 要るスコープ |
|---|---|
| ルールの一覧・詳細 | `rules:read` |
| ルールの追加・変更・削除・一時停止 | `rules:write` |
| ACME の証明書を使うルール | `acme:write` |
| 利用者が選ぶ登録済みの証明書 | `certs:read` |
| global の設定（`/global`） | `admin` |
| rproxy の API で作ったルールの編集・削除（管理者の画面）と、複数のノードの送り直し | `admin`（rproxy-api v0.4.23 から） |

最後の 2 行が `admin` を必要とします。特に最後の行は、rproxy-api v0.4.23（rproxy-api #401）で変わったところです。この版から、`admin` でないトークンは、自分が作ったルール・重ねる分・組しか直せなくなりました（ほかは `403 not_owner` で断られます）。UI の「API のルール」の画面と送り直しは、ほかのトークンが作ったルールを UI のトークンで変える操作なので、UI のトークンが `admin` でないと止まります。

API のルールの画面も送り直しも使わず、UI が rproxy の再起動のときに戻したルールだけを直せればよい構成なら、`admin` の代わりに `rules:read`・`rules:write` と `allow_restored: true` でも足ります（rproxy-api の docs/API.md）。ただし、`allow_restored` は rproxy-api v0.4.23 以上でだけ足してください。v0.4.22 以前の rproxy-api は、知らない項目があるとトークンファイル全体を読まず、すべてのトークンが通らなくなります。rproxy-api の版を戻すときは、戻す前にこの行を外してください。

**UI のトークンに `persist: true` を付けるか**は、次の引き換えで決めます。ふつうは付けません。

- **付けない場合（ふつう）**：UI から作った「固定ルールに重ねる分」（[5.2](#52-固定ルールに重ねる分)）は、rproxy ではメモリの上にだけあり、rproxy を再起動すると消えます（再起動を伴わない更新では引き継がれます）。ただし、UI は重ねる分の正しい形を自分の DB（`forward_rule_overlays`、migration `015`）に持っているので、消えたり違ったりした重ねる分を「ずれ」として画面に出します。出る場所は、ダッシュボードの「要確認のルール」と、ルールの詳細の「重ねる分」です。管理者は「重ねる分のずれ N 件をまとめて送り直す」か、詳細の「UI の DB の内容を送り直す」で元に戻せます。なお、重ねる分はノードごとのもので、act / stb のグループでも act の分を stb に写しません。自動の送り直しが戻すのは、そのノード自身の行だけで、昇格してよいかの判定にも入れません。1 行に 1 トークンの書き方のトークンにも、`persist` はありません。ふつうはこの形で困りません。
- **付ける場合**：UI が作るふつうのルールまで、rproxy の API のルール（`origin: api`）として扱われ、rproxy 自身の表 `rproxy_rules` にも保存されます（UI の DB と二重に持つことになります）。すると UI は、それを「同じキーを API のルールが使っている」と見て、変更・再開・送り直しを 409 `shadowed` で断ります。UI でルールを管理できなくなるので、勧めません。

接続まわりの設定は、次のとおりです。

- **トークンファイルを変えたら**、`sudo systemctl reload rproxy-api` で rproxy-api に読み直させます。
- **UI の側にトークンを持たせる方法**は 2 つあります。`RPROXY_API_TOKEN` に平文で書くか、UI だけが読めるファイル（`root:rproxy-ui`、モード 0640）に 1 行で書いて `RPROXY_API_TOKEN_FILE` で指します。YAML のトークンファイルには SHA-256 しかなく、トークンそのものが書いてないので、UI から `/etc/rproxy/tokens` を指すことはできません。
- **Unix ソケットでつなぐ場合**は、rproxy 側で `RPROXY_API_SOCKET=/run/rproxy/api.sock` と `RPROXY_API_SOCKET_GROUP=rproxy` を、UI 側で `RPROXY_API_URL=unix:/run/rproxy/api.sock` を書きます。ソケットでもトークンは TCP と同じく要ります。ソケットを使う理由は、global の設定のうち守りに関わる項目（`trusted_proxies`・`access_log`・`crowdsec`・`geoip`・`acme`）が、既定では Unix ソケットからしか変えられないためです。rproxy-api の `RPROXY_API_RELOAD_UNIX_ONLY=false` で TCP からも変えられるようになりますが、勧めません。
- **UI を別のホストに置く場合**は、制御 API を `https://` にします。さらにクライアント証明書（mTLS）でつなぐなら、`RPROXY_API_TLS_CERT`（UI の証明書）・`RPROXY_API_TLS_KEY`（その鍵）・`RPROXY_API_TLS_CA`（rproxy の証明書を確かめる CA）を書きます。

ここまで済んだら、サインインの方法（[4.](#4-サインイン)）を決めてから、UI を起動します。次のコマンドは、UI を起動し、OS の起動時にも立ち上がるようにしてから、ログを流し続けて様子を見ます。

```shell
sudo systemctl enable --now rproxy-ui
journalctl -u rproxy-ui -f
```

設定に誤りがあると、UI は理由をログに出して止まります（[7.4](#74-ログ)）。起動したら、ブラウザで `NEXTAUTH_URL` を開いてサインインします。ダッシュボードの「rproxy」の欄に「接続できます」と出て、サイドバーの下に UI と rproxy-api の版が出れば、rproxy-api とつながっています。

## 4. サインイン

この章では、人が UI にサインインする方法と、サインインした人に何を許すかを説明します。最初の設定のときに、4.1〜4.3 のどれか 1 つを選んで設定します。そのあと 4.4・4.5 で、管理者と利用者の分け方を決めます。

サインインの方法は、`RPROXY_UI_AUTH` で次の 3 つから選びます。

| `RPROXY_UI_AUTH` | サインインの方法 | 向いている場合 |
|---|---|---|
| `keycloak`（既定） | Keycloak だけ | 社内に Keycloak があり、利用者の管理をそちらに任せたい |
| `token` | 管理者が配るトークンだけ | Keycloak を置かず、UI・MariaDB・rproxy だけで小さく始めたい |
| `both` | どちらでも | Keycloak に移る途中や、Keycloak が止まったときの入り口を残したい |

`RPROXY_UI_AUTH` を書かなかった場合は、`KEYCLOAK_ISSUER` がなく `RPROXY_UI_TOKENS_FILE` があれば `token`、それ以外は `keycloak` として動きます。

### 4.1 Keycloak なし（トークン）

この節では、Keycloak を置かずに、管理者が配るトークンでサインインさせる方法を説明します。UI・MariaDB・rproxy の 3 つだけで動く、いちばん小さい構成です。

ここで扱うのは、人が UI にサインインするためのトークンです。[3.3](#33-rproxy-api-への接続とトークンのスコープ) の「UI が rproxy-api に送るトークン」とは別のものなので、混ぜないでください。

トークンは、管理者が `rproxy-ui-token` コマンドで作ります。作ったトークンは画面に 1 回だけ出るので、その場で使う人に渡してください。トークンのファイルにはトークンそのものではなく SHA-256 の値だけが書かれるので、ファイルから元のトークンを取り出すことはできません。なくしたら作り直します。

次のコマンドは、管理者 `admin` と利用者 `alice` のトークンを作り、一覧を見て、`alice` を消す例です。

```shell
sudo rproxy-ui-token new --name admin --role admin --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token new --name alice --role user  --file /etc/rproxy-ui/tokens.yaml --owner rproxy-ui
sudo rproxy-ui-token list   --file /etc/rproxy-ui/tokens.yaml
sudo rproxy-ui-token remove --name alice --file /etc/rproxy-ui/tokens.yaml
```

- `new` はトークンを 1 つ作ってファイルに足します。`--name` はトークンの名前で、ファイルの中で重ならないようにします。`--role` は `admin`（管理者）か `user`（利用者）です。
- `--file` はトークンのファイルの場所です。ファイルがなければ作ります。`--owner rproxy-ui` で、ファイルの持ち主を UI を動かすユーザーにします。
- `list` は、ファイルに登録してあるトークンの名前を並べます。`remove` は、その名前の行を消します。

続けて、env ファイルに次のように書き、トークンでサインインさせるようにします。

```shell
# /etc/rproxy-ui/rproxy-ui.env
RPROXY_UI_AUTH=token
RPROXY_UI_TOKENS_FILE=/etc/rproxy-ui/tokens.yaml
RPROXY_UI_USER_ROLE=rproxy-user        # role: user のトークンを使うなら
```

- `RPROXY_UI_AUTH=token` で、サインインの方法をトークンだけにします。`KEYCLOAK_*` は要りません。
- `RPROXY_UI_TOKENS_FILE` で、上で作ったファイルを指します。
- `RPROXY_UI_USER_ROLE` は、`role: user` のトークンを使うときだけ書きます。書かないと `role: user` のトークンではサインインできても UI を使えません（下で説明します）。

サインインするときは、サインインのページ（`/signin`）の「アクセストークン」の欄にトークンを貼り、「トークンでサインイン」を押します。

トークンのファイルについて、知っておくことは次のとおりです。

- **ファイルは `rproxy-ui` の持ち物で、モード 600 にします。** ほかの持ち主やモードだと、UI はファイルを読まずに起動を止めます。`rproxy-ui-token` で作ればこの形になります。
- **ファイルは、変わればその場で読み直します。** トークンを足したり消したりしても、UI の再起動は要りません。行を消すと、そのトークンでサインインしていた人のセッションは、次の確認のときに切れます。
- **`role: user` のトークンは、`RPROXY_UI_USER_ROLE` が空だと使えません。** サインインしても 403 `no_role` になります（[4.4](#44-ロール)）。
- **行に `sub` を書くと、その値がルールの持ち主になります。** 書かなければ持ち主は `token:<name>` です。Keycloak の利用者の `sub` と同じ値にすると、その人が Keycloak でサインインしたときと同じルールを、トークンでも扱えます。`sub` は、トークンを作るときに `rproxy-ui-token new` の `--sub <sub>` で付けます。

ファイルの書き方や締め出しのしくみなど、詳しくは [README の「トークンでのサインイン（Keycloak なし）」](../README.md#トークンでのサインインkeycloak-なし)にあります。

### 4.2 Keycloak

この節では、Keycloak でサインインさせる方法を説明します。Keycloak の側でクライアントを 1 つ作り、その情報を env ファイルに書きます。

env ファイルには、次の 3 つを書きます。

```shell
KEYCLOAK_ISSUER=https://sso.example.com/realms/rproxy
KEYCLOAK_CLIENT_ID=rproxy-ui
KEYCLOAK_CLIENT_SECRET=<クライアントの Credentials>
```

- `KEYCLOAK_ISSUER` は、使うレルムの URL です（`https://<Keycloak のホスト>/realms/<レルムの名前>`）。
- `KEYCLOAK_CLIENT_ID` は、Keycloak に作ったクライアントの ID です。
- `KEYCLOAK_CLIENT_SECRET` は、そのクライアントの「Credentials」のタブに出るシークレットです。

Keycloak の側で設定することは、次のとおりです。

- **クライアントは Confidential にします**（Keycloak の画面では「Client authentication」を有効にします）。「Valid redirect URIs」には `${NEXTAUTH_URL}/api/auth/callback/keycloak` を入れます。`NEXTAUTH_URL` が `https://dashboard.example.com` なら、`https://dashboard.example.com/api/auth/callback/keycloak` です。
- **ロールは realm ロールとして作ります。** UI は、アクセストークンの `realm_access.roles` からロールを読みます。クライアントロールを使いたい場合は、`RPROXY_UI_ROLES_CLAIM` でロールを読む場所を変えます（[README の「ロール（権限）」](../README.md#ロール権限)）。
- **レルムは `keycloak/realm-rproxy-dev.json` から作れますが、これは開発用です。** パスワードの決まりや OTP がなく、URI も http のままです。本番では、パスワードの決まり・OTP・https の URI・セッションの時間を直してください（[PRODUCTION.md の「3. Keycloak」](PRODUCTION.md#3-keycloak)）。

サインインした後のセッションは、次の 2 つの変数で決まります。

- **`RPROXY_UI_SESSION_MAX_AGE`**（既定 8 時間）：サインインしてからこの時間がたつと、セッションが切れてサインインし直しになります。使い続けても延びません。もっと短くしたいときに減らします。
- **`RPROXY_UI_ROLE_REFRESH_SECS`**（既定 300 秒）：この間隔で Keycloak にロールを聞き直します。Keycloak でロールを外したり利用者を無効にしたりすると、遅くともこの間隔のあとで UI に反映されます。

詳しくは [README の「セッション」](../README.md#セッション)にあります。

### 4.3 両方（`both`）

この節では、Keycloak とトークンの両方でサインインできるようにする方法を説明します。Keycloak に移る途中で、まだトークンを使う人が残っている場合などに使います。

`RPROXY_UI_AUTH=both` にすると、サインインのページ（`/signin`）に、トークンの欄と「Keycloak でサインイン」のボタンが並びます。設定は 4.1 と 4.2 の両方が要るので、`KEYCLOAK_*` と `RPROXY_UI_TOKENS_FILE` の両方を書きます。

なお、`RPROXY_UI_AUTH` を書かず、`KEYCLOAK_ISSUER` もなく `RPROXY_UI_TOKENS_FILE` だけがある場合は、`both` ではなく `token` として動きます。

### 4.4 ロール

この節では、サインインした人を管理者と利用者に分けるしくみ（ロール）を説明します。ロールによって、見えるルールと使える画面が変わります。

| ロール | どう決まるか | できること |
|---|---|---|
| 管理者 | Keycloak のロール `rproxy-admin`、トークンでは `role: admin` | すべての人のルールを扱えます。どのポート・ノードでも使えます |
| 利用者 | `RPROXY_UI_USER_ROLE` に書いたロール、トークンでは `role: user` | 自分のルールだけを扱えます。4.5 の制限がかかります |
| どちらもない | — | UI を使えません（403 `no_role`） |

管理者だけが使える画面には、API のルールの編集、global の設定（[5.3](#53-global-の設定acmegeoipタイムアウト)）、act / stb の画面（[7.3](#73-keepalived-と組むact--stb)）があります。

ロールの名前は、次の 2 つの変数で決めます。

- **`RPROXY_UI_ADMIN_ROLE`**（既定 `rproxy-admin`）：管理者として扱うロールの名前です。Keycloak ですでに別の名前のロールを使っているときに変えます。
- **`RPROXY_UI_USER_ROLE`**（既定は空）：利用者として扱うロールの名前です。空のままだと利用者はいないことになり、管理者のロールがない人は UI を使えません。管理者でない人にも使わせるときは、`RPROXY_UI_USER_ROLE=rproxy-user` のように書き、その人に Keycloak でそのロールを付けます。

この「空なら管理者しか使えない」という既定は、v0.4.9 からです。v0.4.8 までは、空ならサインインできる人がだれでも利用者として扱われていました。

### 4.5 利用者にできること

この節では、利用者（管理者でない人）にできることと、管理者がその範囲をどう絞るかを説明します。利用者を作らない（`RPROXY_UI_USER_ROLE` が空の）構成なら、読み飛ばして構いません。

利用者は、自分が持ち主のルールだけを作り、見て、変え、消せます。ほかの人のルールは見えません。ただし、固定ルールはだれにでも見えます。そのとき、サーバのファイルのパスは `<hidden>` と伏せて出します。

管理者は、利用者に何を許すかを env ファイルで決めます。下の表の変数は、どれも書かなければ制限はかかりません。

| 変数 | 何を決めるか | 範囲の外のとき |
|---|---|---|
| `RPROXY_UI_USER_PORTS` | 利用者が待ち受けに使えるポート | 403 `port_not_allowed` |
| `RPROXY_UI_USER_NODES` | 利用者が触れるノード | 403 `node_not_allowed` |
| `RPROXY_UI_USER_TARGETS` | 利用者が転送先に使えるアドレスと名前 | 403 `target_not_allowed` |
| `RPROXY_UI_USER_CERTS`（`_BY_ROLE`・`_BY_SUB`） | 利用者が選べる登録済みの証明書 | 403 `cert_not_allowed` |
| `RPROXY_UI_PROTECTED_TARGETS` | 許可リストに書いても使わせない宛先 | 403 `target_not_allowed` |

- **`RPROXY_UI_USER_PORTS`**：`1024-65535` のように範囲で書きます。管理者のサービスが使う 443 などのポートを、利用者に取られないようにするときに使います。
- **`RPROXY_UI_USER_NODES`**：`node1,node2` のようにノードの名前を並べます。rproxy を複数台使っていて、利用者に触らせるノードを分けたいときに使います（[6.](#6-複数のノードとグループ)）。
- **`RPROXY_UI_USER_TARGETS`**：CIDR・IP アドレス・ホスト名（`*.example.com` のような書き方も）を並べます。利用者が社内のどのサーバへでも転送できてしまうのを防ぐため、本番では書くことを勧めます。
- **`RPROXY_UI_USER_CERTS`**：管理者が rproxy に登録した証明書のうち、利用者が選べるものを名前の先頭で絞ります。テナントごとに分けたいときは、ロールごと（`_BY_ROLE`）・人ごと（`_BY_SUB`）に割り当てます。
- **`RPROXY_UI_PROTECTED_TARGETS`**：別のホストの DB など、許可リストに入ってしまう範囲の中でも守りたい宛先を書きます。

ほかに、変数によらずかかる決まりがあります。

- **既定で断る転送先があります。** 制限を書かなくても、ループバック・リンクローカル（クラウドのメタデータのアドレスを含みます）・未指定・マルチキャスト・ブロードキャストのアドレスは転送先に使えません。どうしても使わせたいときは、`RPROXY_UI_USER_TARGETS` にその範囲の中だけの CIDR（例 `127.0.0.1/32`）を書くと使えます（`0.0.0.0/0` のような広い範囲では使えません）。
- **いつも断る転送先もあります。** 制御 API・UI・DB のアドレスとポートの組は、許可リストに書いても使えません。利用者が rproxy を通してそれらに届くのを防ぐためです。`RPROXY_UI_PROTECTED_TARGETS` に書いた宛先も同じ扱いです。
- **利用者は、サーバのファイルのパス（`*_file` の項目）を書けません**（403 `file_not_allowed`）。rproxy は自分が読めるどの鍵でも使えるので、利用者がほかの人の証明書の鍵を指せないようにするためです。TLS の証明書は、管理者が rproxy の証明書の API に登録したものから選びます。
- **OIDC のミドルウェアは足せません。** 応答のキャッシュは、上限（既定で 1 つのミドルウェアにつき 16 MiB・1024 件。`RPROXY_UI_USER_CACHE_MAX_MEMORY`・`RPROXY_UI_USER_CACHE_MAX_ENTRIES`）の内でだけ使えます。
- **前からある値は、変えなければそのまま保存できます。** 制限を後から狭めても、利用者が自分のルールのほかの項目を直すことはできます。

全部の決まりは [README の「利用者の制限（ファイルのパス・転送先）」](../README.md#利用者の制限ファイルのパス転送先)にあります。

## 5. 毎日の使い方

この章では、サインインした後にふだん行う作業を説明します。ルールを足す・直す、固定ルールに足す、rproxy 全体の設定を変える、履歴から戻す、書き出して読み込む、ずれを直す、の順に並べています。画面の一覧は [README の「使い方」](../README.md#使い方) にあります。

### 5.1 ルールを足す・変える

この節では、ルールを作ったり直したりするフォームの使い方を説明します。

新しいルールは、ダッシュボードの「新規ルール」（`/rules/new`）から作ります。今あるルールを直すときは、ルールの詳細を開いて「編集」を押します。どちらも同じフォームで、中身はタブに分かれています。

| タブ | 何を決めるか |
|---|---|
| 基本 | どのポートで待ち受け、どこへ転送するか |
| L7 (HTTP) | HTTP のリクエストを、中身を見てどこへ送るか |
| TLS / DTLS | 暗号の通信をどう扱うか |
| メール (STARTTLS) | メールの STARTTLS をどう扱うか |
| 制限・GeoIP | 接続数・帯域・国による制限などの守り |
| 詳細 | 送信元のアドレスの扱いや時間切れなど、細かい調整 |

それぞれのタブにある主な欄は、次のとおりです。

- **基本**：プロファイル（用途別のひな形）、プロトコル（tcp / udp）、待ち受けアドレス・待ち受けポート（範囲の終わりは任意）、転送先アドレス・転送先ポート、「宛先を追加」（転送先を複数にし、振り分け方を選ぶ）、「L7（HTTP）で振り分ける」があります。プロファイルを選ぶと、HTTPS・メール・TURN など用途に合ったポートや設定が入るので、そこから直すと早く作れます。
- **L7 (HTTP)**：ルート（どのリクエストかを決める `match` の式）・サービス（転送先）・ミドルウェア（途中で行う処理）・どのルートにも一致しないときの扱いを書きます。
- **TLS / DTLS**：モード（下で説明します）、サーバ名ごとの転送先、どのサーバ名にも一致しない接続の扱い、サーバ証明書・中間 CA・秘密鍵（「＋ ACME の証明書を追加」「＋ 登録済みの証明書を追加」も使えます）、クライアント証明書の検証（mTLS）、ALPN、転送先への再暗号化を設定します。
- **メール (STARTTLS)**：SMTP / IMAP / POP3 の STARTTLS を扱います。TCP のルールで TLS を終端するときだけ使えます。
- **制限・GeoIP**：ラベル、L4 の制限、帯域の上限、GeoIP、受け身のヘルスチェックを設定します。
- **詳細**：送信元 IP の扱い（source_ip。転送先にクライアントのアドレスをどう伝えるか）、UDP のアイドルタイムアウト、TCP の中継の時間切れ、宛先への接続の時間、接続を許可する送信元（allow_from）、PROXY protocol の受け取りを設定します。

作るルールの種類ごとに、どのタブを使うかの道筋を示します。

- **L4（TCP / UDP をそのまま中継する）**：中身を見ずに、届いたものをそのまま転送先へ流すルールです。「基本」だけで作れます。つないでよい相手を絞るなら、「詳細」の allow_from に 1 行に 1 件ずつ CIDR か IP を書きます。
- **TLS**：「TLS / DTLS」でモードを選びます。モードは 3 つあります。passthrough は暗号を解かずにそのまま流します。sni は、接続の最初に届くサーバ名（SNI）を見て、名前ごとに転送先を変えます。終端（terminate）は、rproxy が証明書を持って暗号を解きます。終端するなら、証明書と鍵（rproxy-api のホストの上のパスで、持ち主は `rproxy-api`）を指すか、ACME で取ります。名前で振り分けるなら「サーバ名ごとの転送先」を使います。
- **HTTP（L7）**：Host やパスなど、HTTP のリクエストの中身で転送先を選ぶルールです。TCP のルールで「L7（HTTP）で振り分ける」を選び、「L7 (HTTP)」タブでルートとサービスを作ります。プロファイル「HTTPS リバースプロキシ（L7）」がひな形になります。L4 にするか L7 にするかは、ルールを作るときにしか選べません。

フォームを使うときに覚えておくことは、次のとおりです。

- **出る欄は、つないでいる rproxy によって変わります。** UI は rproxy-api の `GET /capabilities` の `features` を見て、その rproxy が使えると言う欄だけを出します。古い rproxy で新しい欄が出なくても、その項目に値があれば読み取り専用で残し、そのまま送るので、保存しても消えません。
- **送信元 IP の扱いとポート範囲は、作った後で変えられません。** 変えたいときは、ルールを作り直します。
- **保存の前に、何が変わるかを確かめられます。** rproxy が `features.dry_run` を返すなら、「差分を見る」で、保存したら rproxy で何が変わるかを見られます。
- **ルールは消さずに止められます。** 一覧や詳細の「一時停止」で止め、「再開」で同じ内容のまま戻せます（[README の「ルールの一時停止」](../README.md#ルールの一時停止)）。

項目ごとの詳しい説明は、README の次の節にあります。[L7](../README.md#l7httpのルール)・[Gateway API 向けの項目](../README.md#gateway-api-向けの-l7tls-の項目)・[応答のキャッシュ](../README.md#応答のキャッシュcache)・[宛先を複数にする](../README.md#宛先を複数にする)・[SNI の passthrough](../README.md#一部のサーバ名だけ終端せずに流すsni-の-passthrough)・[PROXY protocol](../README.md#前段の-proxy-protocol-を受け取る名前ごとに送信元-ip-の渡し方を変える)・[TCP の中継の時間切れ](../README.md#tcp-の中継の時間切れidle_timeouthalf_close_timeout)・[宛先への接続の時間](../README.md#宛先への接続の時間connect_timeout)・[UDP のサーバ名](../README.md#udp-をサーバ名で振り分けるdtlsquic)・[ACME](../README.md#acme-で証明書を取る)・[v0.4 の項目](../README.md#v04-のルールの項目制限帯域geoipラベル)。

### 5.2 固定ルールに重ねる分

この節では、rproxy の設定ファイルに書いた固定ルールに、画面から HTTP のルートなどを足す方法を説明します。管理者が設定ファイルで用意した HTTPS の入り口に、利用者が自分のサービスのルートを足す、といった使い方を想定しています。

固定ルールそのものは、画面から変えられません。rproxy-api v0.4.23 以上（`features.static_overlay`）なら、固定ルールの詳細の「重ねる分」から、ファイルはそのままに中身を足せます。

**何を足せるか**

- ルールに `http` があるときは、http のルート・サービス・ミドルウェアを足せます。
- `http` がないときは、TLS のモードが sni か、クライアント証明書の検証のない終端（terminate）なら、サーバ名ごとの転送先（`tls.routes`）を足せます。

**どう効くか**

- 重ねる分のルートは、ファイルのルートのどれにも当たらなかったリクエストだけを受けます。ファイルのルートの横取りはできません。
- ファイルにすでにある名前は使えません（409 `overlay_conflict`）。
- 重ねる分はノードごとのものです。グループにまとめることはせず、各ノードは自分の行だけを持ちます。

**保存のしかた**

- 保存は、重ねる分を丸ごと置き換えます。画面を開いた後に、ほかの人が先に変えていた場合は 412 で断られます。そのときは「読み直す」で今の内容を読み込んでから、やり直します。
- 管理者でない人は、自分が作った重ねる分だけを直せます。設定ファイルのサービスと、秘密のファイルを持つものは使えません。

**rproxy を再起動したとき（ずれと送り直し）**

UI は、重ねる分の正しい形を自分の DB（`forward_rule_overlays`、migration `015`）に持っています。ふつうの UI のトークン（`persist` なし）では、rproxy を再起動すると重ねる分は rproxy から消えますが、UI がそれをずれ（「UI の DB にある重ねる分が rproxy にありません」）として出し、送り直せます（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。

- **送り直せる人**：その重ねる分を直せる人、つまり管理者と、作った本人です。いくつもまとめて送り直すのは管理者だけです。
- **送り直す前の確かめ**：だれがどう送り直すかで、次の 3 つに分かれます。
  - **管理者が詳細画面から 1 件を送り直す**：確かめずに送ります。
  - **利用者が詳細画面から自分の 1 件を送り直す**：送り直す人（本人）の今の決まりで確かめます。前の内容には rproxy の今の重ねる分を使うので、rproxy に残っている値は変えなければそのまま通ります。許可リストを後から狭めていて、新しい決まりに合わない値があれば送りません。
  - **まとめての送り直し（管理者）と、act / stb の自動の送り直し**：最後に書いたのが利用者なら、作った人として前の内容なしで確かめ直します。そのため、利用者が「前からあったから残せただけ」の値（管理者が付けた値など）も断ります。そのときは、管理者が詳細画面で直して保存します。最後に書いたのが管理者なら確かめません。作った人が分からないものは送りません。

  `RPROXY_UI_USER_ROLE` が空（管理者だけ）の構成では、作った人としての確かめはしません。確かめるのは送る直前だけで、keepalived が問い合わせる `ha/ready` では名前解決をしません。
- **答えが返らなかった保存**：rproxy の答えを受け取れなかった保存（時間切れ・5xx）は、UI の DB と履歴に残り、ずれとして送り直されます。
- **外したとき**：重ねる分を外すと、UI の DB の行も消えます。

**act / stb のグループでは**

各ノードは自分の行だけを持ちます。act / stb の自動の送り直しと「このノードを揃える」は、そのノードの行だけを戻し、act の分を stb に写しません。重ねる分のずれは act / stb の画面に出しますが、昇格してよいかの判定（`ha/ready`）には入れません。

**残った行の片付け**

ノードを `nodes.yaml` から外した、固定ルールを設定ファイルから消した、などで UI の DB にだけ残った行は、管理者のダッシュボードの「UI の DB からだけ外す」で消せます。

詳しくは [README の「使い方」の「固定ルールに重ねる分」](../README.md#使い方)にあります。

### 5.3 global の設定（acme・geoip・タイムアウト）

この節では、ルールごとではなく rproxy 全体に効く設定（global の設定）を、画面から変える方法を説明します。HTTP のタイムアウトや UDP のセッション数の上限、ACME・GeoIP の設定などがこれにあたります。管理者だけが使えます。

使うには、rproxy-api v0.4.19 以上（`features.global_api`）と、UI のトークンの `admin`（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）が要ります。「rproxy の機能と設定」（`/system`）から「global の設定」（`/global`）を開きます。

変える手順は、次のとおりです。

1. 画面には、項目ごとに今の値・出どころ（設定ファイル / 環境変数 / API / 既定）・変え方が出ます。設定ファイルと環境変数に書いた項目は、そちらが優先されるので画面からは変えられません。
2. 変えたい値を入れて、「差分を確かめる」（dry run）で、何が変わるかを見ます。この時点ではまだ何も変わりません。
3. 「適用する」で反映します。グループを選んだ場合は、そのすべてのノードに送り、1 台でも断れば全部を元に戻します。項目ごとに「API の値を消す（既定に戻す）」を選んで適用すると、画面で変えた値を消して既定に戻します。

項目について知っておくことは、次のとおりです。

- **変えられるのは、すぐ効く項目です。** `http.timeouts`（タイムアウト）・`udp_max_sessions` などがあります。
- **`geoip`・`acme` は条件があります。** rproxy-api v0.4.22 以上（`features.global_api_geoip`・`global_api_acme`）で、Unix ソケットでつないでいるノードだけで変えられます。GeoIP と ACME の設定が指すファイルは、それぞれ rproxy-api の `RPROXY_API_GEOIP_DIR`・`RPROXY_API_ACME_DIR` のすぐ下にあるものだけです。ACME の `storage` は、既定の場所のままにするか、`RPROXY_API_ACME_DIR` の下のディレクトリにします。
- **秘密の値は `***` で返ります。** `acme` を変えるときは、秘密の欄を入れ直してください。
- **値は rproxy が保存します。** 画面で変えた値は、rproxy が DB の `rproxy_global`（migration 013）に保存し、再起動しても戻します。

詳しくは [README の「v0.4 のルールの項目」](../README.md#v04-のルールの項目制限帯域geoipラベル)の「global の設定」にあります。

### 5.4 履歴と巻き戻し

この節では、ルールの変更の履歴を見て、前の版に戻す方法を説明します。誤って変えたり消したりしたルールを元に戻すときに使います。

「変更の履歴」（`/history`）に、いつ・だれが・何を変えたかが並びます。ルールの詳細にも、そのルールの履歴が出ます。

- **戻し方**：戻したい行の「この版に戻す」を押すと、その時点の内容に戻ります。消したルールも作り直せます。巻き戻したことも履歴に残ります。
- **見える範囲**：利用者は、自分が操作した履歴と、今自分が持っているルールの履歴を見られます。管理者はすべてを見られます。
- **戻せないもの**：ノードの上書き（`OVERRIDE`、[6.](#6-複数のノードとグループ)）と重ねる分（`OVERLAY`、[5.2](#52-固定ルールに重ねる分)）の変更は、履歴には出ますが巻き戻せません。

詳しくは [README の「変更の履歴と巻き戻し」](../README.md#変更の履歴と巻き戻し)にあります。

### 5.5 エクスポートとインポート

この節では、ルールをファイルに書き出したり、ファイルから読み込んだりする方法を説明します。控えを取るとき、別の UI へ移すとき、rproxy の設定ファイルのルールを UI の管理に移すときに使います。

**書き出す**：ダッシュボードの「エクスポート（JSON）」で、自分のルール（管理者はすべてのルール）を JSON で書き出します。

**読み込む**：「インポート」（`/rules/import`）で、UI のエクスポートか、rproxy の設定ファイル（YAML / JSON）を読み込みます。次の 3 段で進みます。

1. 「確かめる」を押すと、1 件ずつ検証します。この段階ではまだ何も変えません。
2. すでに同じキーのルールがある行は、置き換えるかどうかを行ごとに「置き換える」で選びます。
3. 「インポートする」を押すと、1 件ずつ足したり置き換えたりします。

詳しくは [README の「エクスポートとインポート」](../README.md#エクスポートとインポート)にあります。

### 5.6 ずれと送り直し

この節では、複数のノードを使っているときに、あるノードのルールが UI の DB の内容と食い違ってしまったのを直す方法を説明します。rproxy が 1 台だけなら、この節は読み飛ばして構いません（重ねる分のずれは [5.2](#52-固定ルールに重ねる分) を見てください）。

複数のノードでは、UI は各ノードで実際に動いているルールを UI の定義（DB）と比べ、違う項目を「ずれ」として出します。あるノードだけ保存に失敗した、ノードを手で操作した、などで起きます。

- **見つけ方と直し方**：ルールの詳細のノードのタブで「UI の定義との違い」を見ます。「このノードに送り直す」を押すと、UI の定義をそのノードだけに送り、揃えます。
- **送り直しで何が起きるか**：部分の変更（PATCH）で直せない違いは、ルールを作り直して揃えます。ノードにないルールは作ります。UI では停止中なのにノードで動いているルールは消します。
- **使える人**：そのルールの持ち主と管理者です。送り直すと、履歴に `RESEND` と送ったノードが残ります。
- **トークンの権限**：rproxy-api v0.4.23 以上では、UI のトークンに `admin` が要ります（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。

## 6. 複数のノードとグループ

この章では、1 つの UI で複数の rproxy をまとめて管理する設定を説明します。拠点ごとに rproxy を置く場合や、2 台で冗長にする場合に使います。rproxy が 1 台なら、この章は要りません。

UI から見た 1 台の rproxy をノード、同じルールを持たせるノードのまとまりをグループと呼びます（[1.2](#12-この手引きに出てくる言葉)）。ノードとグループは、`nodes.yaml` というファイルに書きます。次の例は、2 台のノード `node1`・`node2` を、act / stb で冗長にするグループ `ha` にまとめたものです。

```yaml
# /etc/rproxy-ui/nodes.yaml（RPROXY_UI_NODES=/etc/rproxy-ui/nodes.yaml）
nodes:
  - name: node1
    url: http://10.0.0.11:8080
    token_file: /etc/rproxy-ui/tokens/node1
  - name: node2
    url: http://10.0.0.12:8080
    token_file: /etc/rproxy-ui/tokens/node2
groups:
  - name: ha
    nodes: [node1, node2]
    mode: active_standby      # single（既定）か active_standby
    vip: 192.0.2.10
default_target: ha
```

- **`nodes`**：ノードを並べます。`name` はノードの名前、`url` はその rproxy の制御 API（`http(s)://` か `unix:/run/rproxy/api.sock`）、`token_file` はそのノードに送るトークンを書いたファイルです。トークンは DB には置かず、ファイルから読みます。ファイルは UI を動かすユーザー（.deb では `rproxy-ui`）が読めるようにします。
- **`groups`**：グループを並べます。`nodes` に、まとめるノードの名前を書きます。
- **`mode`**：グループの動き方です。`single`（既定）は、すべてのノードが同じルールで同時に動く形です。`active_standby` は、keepalived などで VIP を持つ 1 台（act）だけが通信を受け、ほかは控える（stb）形です（[7.3](#73-keepalived-と組むact--stb)）。`active_standby` にはノードが 2 つ以上要ります。
- **`vip`**：`active_standby` のグループの VIP です。UI は、各ノードがこのアドレスを持っているかを見て、どちらが act かを画面に出します。書かなければルールの待ち受けアドレスで判断しますが、stb は VIP を持たないので、ルールはふつう `0.0.0.0` で待ち受けます。そのため `vip` を書いておくのがおすすめです。`active_standby` のグループにだけ書けます。
- **`default_target`**：ルールを追加する画面で、最初に選ばれているノードかグループです。書かなくても構いません。

グループには、ほかに `auto_resend` を書けます（[7.3](#73-keepalived-と組むact--stb)）。

設定は、次の順に進めます。

1. **DB に migration `006`〜`009` を当てます。** `migrate.mjs` で当てていれば、もう済んでいます。
2. **各ノードの rproxy が読むビューを作ります。** rproxy は起動時に `forward_rules` を丸ごと読むので、ノードごとに「自分のノードと、自分を含むグループの行だけ」が見えるビューを用意します。SQL は `db/node-view.mjs` が出します（[README の「rproxy の起動時の復元（ノードごとのビュー）」](../README.md#rproxy-の起動時の復元ノードごとのビュー)）。
3. **各 rproxy の `RPROXY_NODE_NAME` を、`nodes.yaml` のノードの名前に揃えます。**
4. **UI の env ファイルに `RPROXY_UI_NODES` を書いて、UI を再起動します。** `nodes.yaml` に誤りがあると、UI は理由をログに出して起動しません。

設定すると、画面は次のように変わります。

- **選ぶ欄とタブが増えます。** ノードが 2 つ以上あると、追加の画面に「ノード／グループ」の選択が、ダッシュボードとルールの詳細に「全体 / ノードごと」のタブが出ます。
- **グループのルールは、すべてのノードに送ります。** 1 台でも失敗すれば、ほかのノードも元に戻します。
- **ノードごとに一部を変えられます。** ルールの詳細のノードのタブの「このノードだけの設定（上書き）」で、待ち受けアドレス・転送先・allow_from をノードごとに変えられます。
- **ルールを移したり、まとめて止めたりできます。** 「コピー・移動」で、ほかのノード／グループへルールを移せます。ノードのタブの「すべて一時停止」で、そのノードのルールをまとめて止められます。

詳しくは [README の「複数の rproxy（ノードとグループ）」](../README.md#複数の-rproxyノードとグループ)にあります。

## 7. 運用

この章では、動かし始めた後に続ける作業を説明します。版を上げる、バックアップを取る、keepalived と組む、ログを見る、守りを確かめる、の順に並べています。

### 7.1 上げる

この節では、rproxy-ui の版を上げる手順と、そのときに気をつける組み合わせを説明します。

.deb で入れた場合は、ほかのパッケージと同じく apt で上げます。

```shell
sudo apt update && sudo apt upgrade
```

- **設定とトークンは保たれます。** 動いていたサービスは、上げた後に再起動されます。
- **表の形が変わる版では、migration を先に当てます。** そういう版のリリースノートには、要る migration が書いてあります。`migrate.mjs` を流せば、まだ当てていないものだけが当たります（[3.1](#31-dbmariadbと-migration)）。Kubernetes では、`helm upgrade` のときに Job が当てます。
- **rproxy-api の版も見ます。** UI が必要とする rproxy-api の最小の版は **v0.3.5** です。それより新しい項目は、rproxy-api の `features` を見て、なければ出しません。今の版はサイドバーの下とダッシュボードに出ます。rproxy-api が古い、または版が分からないときは、ダッシュボードに注意が出ます。

上げるときに特に気をつける組み合わせは、次の 3 つです。

- **rproxy-api を v0.4.23 以上に上げるとき**は、先に UI のトークンを `admin` にしておきます（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。そうしないと、API のルールの画面と送り直しが止まります。
- **UI を v0.4.9 以上に上げるとき**は、`RPROXY_UI_USER_ROLE` を確かめます。v0.4.9 から、これが空なら管理者しか使えません。これまで管理者でない人にも使わせていたなら、上げる前に設定してください（[4.4](#44-ロール)）。
- **Node.js** は 22.23.4 以上（24 系なら 24.22.1 以上）が要ります。古いと、起動時に警告が出ます。

詳しくは [PRODUCTION.md の「7. 更新」](PRODUCTION.md#7-更新)にあります。

### 7.2 バックアップ

この節では、何を控えておけば UI を元に戻せるかを説明します。

- **DB**：いちばん大事なのは、`forward_rules`（ルールの正）と `forward_rules_log`（履歴）です。ほかの表も含めて、`mariadb-dump --single-transaction` で DB を丸ごと取るのが楽です。`--single-transaction` を付けると、UI を止めずに、ある時点で揃った内容を取れます。
- **ファイル**：`/etc/rproxy-ui/rproxy-ui.env`（`NEXTAUTH_SECRET` やパスワードなどの秘密が入っています）、`tokens.yaml`、`nodes.yaml`、ノードのトークン、`ha.tokens` を控えます。rproxy の側では `/etc/rproxy` を控えます。
- **エクスポート**：ダッシュボードの「エクスポート（JSON）」も、ルールの控えになります（[5.5](#55-エクスポートとインポート)）。

取り方・戻す順番・戻した後の確かめ方は、rproxy-api の [docs/BACKUP.md](https://github.com/max3584/rproxy-api/blob/master/docs/BACKUP.md) にあります。Kubernetes の場合は [KUBERNETES.md の「バックアップと戻し方」](KUBERNETES.md#バックアップと戻し方)にあります。

### 7.3 keepalived と組む（act / stb）

この節では、`active_standby` のグループ（[6.](#6-複数のノードとグループ)）を keepalived と組み合わせて、VIP を自動で切り替える構成を説明します。2 台の rproxy で 1 つのアドレスを引き継ぎ合い、1 台が落ちても通信を続けたいときに使います。

この構成で困るのは、stb のルールが act（つまり DB の定義）とずれたまま、stb が昇格して VIP を受け取ってしまうことです。そうなると、切り替わった途端に古いルールで動いてしまいます。UI は、次の 2 つのしくみでこれを防ぎます。

**自動の送り直し**：UI は `RPROXY_UI_HA_SYNC_SECS`（既定 30 秒）ごとに `active_standby` のグループを調べ、ずれた stb に自動でルールを送り直します。止めたいグループには、`nodes.yaml` で `auto_resend: false` を書きます。そのグループでは、ずれを画面に出すだけになります。

**keepalived からの問い合わせ**：keepalived の track_script と notify_master から、UI の `/api/forward/ha/ready` と `/api/forward/ha/notify` を呼びます。`ha/ready` は、そのノードが揃っていれば 200、揃っていなければ 503 を返すので、track_script はそれを見て、揃っていないノードの優先度を下げます。`ha/notify` は、昇格した直後にそのノードへすぐ送り直させます。どちらも、サインインのセッションの代わりに `RPROXY_UI_HA_TOKEN_FILE` のトークンで呼びます。

設定の例と確かめ方は、次のとおりです。

- **スクリプトと設定の例**は [contrib/keepalived](../contrib/keepalived/README.md) にあります（.deb では `/usr/share/doc/rproxy-ui/examples/keepalived/`）。
- **画面で確かめる**：「act / stb」の画面（`/ha`。管理者だけ）で、各ノードが揃っているかを見られます。揃っていないノードは「このノードを揃える」で送り直せます。元の act に戻す（failback）手順も、この画面に案内があります。
- **UI 自身の冗長**：UI そのものは何台でも動かせます。利用量の集計と送り直しは、DB のロックで 1 台だけが行うので、重なりません。複数台で動かすときは、`NEXTAUTH_SECRET` を全台で同じにしてください（[3.2](#32-env-ファイル)）。

### 7.4 ログ

この節では、うまく動かないときにどこのログを見ればよいかを説明します。

- **.deb**：`journalctl -u rproxy-ui` で見ます（`-f` を付けると流し続けます）。起動時に設定の誤り（`nodes.yaml`、トークンのファイルの権限、DB の TLS、mTLS の組み合わせ）があると、理由を出して止まります。起動時には、各ノードの rproxy-api の版も出ます。
- **rproxy が UI のトークンを断ったとき**（401・403・429）は、UI のログに、断られた理由と確かめるものが出ます。
- **Kubernetes**：`kubectl -n rproxy-ui logs deploy/rproxy-ui` で見ます。migration に失敗したときは `kubectl -n rproxy-ui logs job/rproxy-ui-migrate` で見ます（リリース名が `rproxy-ui` のときの名前です。名前の決まりは [KUBERNETES.md の「バックアップと戻し方」](KUBERNETES.md#バックアップと戻し方)の終わりにあります）。
- **rproxy-api のログ**：ルールの作成・変更・削除の記録（`event: "audit"`）など、rproxy の側で起きたことは、rproxy-api のログ（`/var/log/rproxy/`）にあります。

### 7.5 セキュリティの注意

この節では、UI を外から使えるようにするときに、特に気をつけることを説明します。

- **ほかのサイトからの要求（CSRF）**：状態を変える API は、ほかのサイトから送られた要求を 403 `csrf` で断ります。ほかのサイトのページから、サインイン中の人のブラウザを使って勝手にルールを変えられないようにするためです。UI の前にリバースプロキシを置くなら、`Host` か `X-Forwarded-Host` を UI に渡し、`Origin`・`Referer`・`Sec-Fetch-*` のヘッダを落とさないでください。`NEXTAUTH_URL` は利用者が開く URL にします。
- **トークンの締め出し**：同じ送信元から誤ったトークンが 15 分の間に 5 回を超えると、その送信元からの誤ったトークンは 15 分の間 429 で断られます（回数と時間は `RPROXY_UI_TOKEN_LOCKOUT_ATTEMPTS`・`RPROXY_UI_TOKEN_LOCKOUT_SECS`）。正しいトークンは、締め出し中でも通します。同じ送信元に見えるほかの人を、誤りを送り続ける人が締め出せないようにするためです。そのため、推測の回数を限る守りにはならず、守りはトークンの強さだけです。トークンは必ず `rproxy-ui-token` で作ってください。
- **HTTP のプロキシの後ろに置くとき**：nginx や Ingress などの後ろでは、そのプロキシのアドレスだけを `RPROXY_UI_TRUSTED_PROXIES` に書きます。UI はそこから届いた `X-Forwarded-For` を信じて送信元を見分けるので、広く書くと、送信元を偽れるようになります。前が rproxy（L4）なら、`X-Forwarded-For` を付けないので要りません。
- **公開のしかた**：.deb で入れた UI は、既定で `127.0.0.1` だけで待ち受けます。外に見せるときは、rproxy の固定ルールで TLS を終端し、`allow_from` で使う人のアドレスの範囲に絞ります。
- **ファイルの持ち主**：rproxy-api は、自分（`rproxy-api`）が持ち主の証明書・鍵・秘密のファイルだけを読みます（`rproxy-api:rproxy`、モード 0640。[PRODUCTION.md の「ファイルの持ち主」](PRODUCTION.md#ファイルの持ち主os-のユーザーとグループ)）。

レスポンスのヘッダ・セッション・利用者の制限の全体は、[README の「セキュリティ」](../README.md#セキュリティ)にあります。

## 8. 困ったとき

この章では、画面に誤りが出たときに、原因と直し方を探す方法を説明します。

画面の誤りの文の後ろには、`no_role` や `not_owner` のようなコードが出ます。下の表をそのコードで探してください。表は、原因のありかごとに分けています。

- 8.1 サインインと権限
- 8.2 rproxy が UI のトークンを断った（502）
- 8.3 rproxy に届かない・rproxy が断った
- 8.4 固定ルールに重ねる分
- 8.5 複数のノード
- 8.6 DB と migration
- 8.7 起動と版

rproxy が UI のトークンを断ったとき、UI はそれを 502 にして画面に返します。画面の 502 は「rproxy と UI の間の問題」と読み、UI のトークンを確かめてください。

ここにないコードは、画面に説明が出ます。分からないときは、UI のログ（[7.4](#74-ログ)）と rproxy-api のログを合わせて見てください。

### 8.1 サインインと権限

| 出るもの | わけ | すること |
|---|---|---|
| 403 `no_role`（「権限がありません」） | 管理者のロールがなく、`RPROXY_UI_USER_ROLE` が空か、その人にそのロールがない | その人にロールを付けるか、`RPROXY_UI_USER_ROLE` を書きます。トークンなら、ファイルの行の `role` を見ます（[4.4](#44-ロール)） |
| サインインで 429 | 誤ったトークンが続いたための締め出し | 時間がたつのを待つか、正しいトークンで入ります（正しいトークンは通ります。[7.5](#75-セキュリティの注意)） |
| 403 `csrf` | ほかのサイトからの要求と見なした | 画面を開き直します。前のプロキシが `Host`・`Origin` を渡しているか、`NEXTAUTH_URL` が利用者の開く URL かを見ます（[7.5](#75-セキュリティの注意)） |
| 403 `port_not_allowed`・`file_not_allowed`・`target_not_allowed`・`cert_not_allowed`・`node_not_allowed`・`middleware_not_allowed`・`cache_limit` | 利用者に許した範囲の外 | [4.5](#45-利用者にできること) を見ます。必要なら、管理者が許す範囲を広げます |

### 8.2 rproxy が UI のトークンを断った（502）

この表のコードは、UI のトークン（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）の設定で直します。

| 出るもの | わけ | すること |
|---|---|---|
| 502 `forbidden`（「UI が使う rproxy のトークンに、この操作の権限がありません」） | UI のトークンのスコープが足りないか、操作がトークンの `allow_listen_ports`・`allow_certs` の外 | UI のトークンを `admin` にします。`allow_listen_ports`・`allow_certs` は `admin` でも効くので、広げるか外します |
| 502 `not_owner` | rproxy-api v0.4.23 以上で、UI のトークンが `admin` でない | 下で説明します |
| 502 `global_forbidden` | global の設定に要る `admin` が、UI のトークンにない | UI のトークンを `admin` にします |
| 502 `rproxy_unauthorized` | UI のトークンが違う、または期限が切れた | `RPROXY_API_TOKEN`・`RPROXY_API_TOKEN_FILE` と、rproxy のトークンファイルを見比べます |
| 502 `rproxy_locked_out` | UI の認証の失敗が続き、rproxy が UI を一時的に止めた | トークンやクライアント証明書を直します。止める時間が過ぎれば解けます |

**502 `not_owner`** は、rproxy-api v0.4.23 以上で、UI のトークンが `admin` でないときに出ます。API のルールの編集・削除、送り直し、rproxy の再起動で戻したルールの変更で起きます。UI のトークンを `admin` にして、`sudo systemctl reload rproxy-api` で読み直させてください。それらの操作を使わない構成なら、`admin` の代わりに `allow_restored: true` でも足ります。ただし、`allow_restored` は rproxy-api v0.4.23 以上でだけ足してください。v0.4.22 以前の rproxy-api は、知らない項目があるとトークンファイル全体を読まず、すべてのトークンが通らなくなります。版を戻すときは、戻す前に外してください。

### 8.3 rproxy に届かない・rproxy が断った

| 出るもの | わけ | すること |
|---|---|---|
| `unreachable`（「rproxy に接続できませんでした」） | rproxy-api が止まっている、URL が誤っている、またはソケットのグループの設定 | `systemctl status rproxy-api` で動いているかを見ます。`RPROXY_API_URL` と、`rproxy-ui` がソケットのグループに入っているかを確かめます |
| 400 `unsupported` | rproxy が使えない組み合わせ | 下で説明します |
| 403 `global_unix_only` | 守りに関わる global の項目を、TCP でつないだノードから変えようとした | そのノードの url を `unix:/…` のソケットにします（[3.3](#33-rproxy-api-への接続とトークンのスコープ)） |
| 409 `static` | 固定ルールと同じキー。固定ルールは画面から変えられない | rproxy の設定ファイルを直すか、重ねる分を使います（[5.2](#52-固定ルールに重ねる分)） |
| 409 `shadowed` | 同じキーを、rproxy では API のルール・組のルールが使っている | どちらかを消すか、キーを変えます |
| 409 `file_in_use` | 重ねる分で、秘密のファイルを持つ設定ファイルのサービス・ミドルウェアを利用者が使った。または、ほかのトークン（か設定ファイル）のルールが使う鍵・秘密のファイルを指したので、rproxy が断った | 管理者に頼むか、自分のサービスや別のファイルを使います |
| `tls_config`、ファイルの持ち主の断り | 証明書・鍵のパスや中身、持ち主・モードの誤り | ファイルを `rproxy-api:rproxy`、モード 0640 にします。画面に直し方が出ます |

**400 `unsupported`** は、rproxy が受け付けない組み合わせを送ったときに出ます。L4 と L7 の切り替え、送信元 IP の扱いやポート範囲の変更、古い rproxy への `connect_timeout`、古い rproxy での UDP の sni などです。作った後で変えられない項目なら、新しいルールとして作り直します。rproxy が古いためなら、rproxy-api を上げます。どれにあたるかは、誤りの文の続きに出ます。

### 8.4 固定ルールに重ねる分

[5.2](#52-固定ルールに重ねる分) の重ねる分で出るものです。

| 出るもの | わけ | すること |
|---|---|---|
| 409 `overlay_conflict` | 重ねる分に、設定ファイルと同じ名前を使った | 別の名前にします |
| 412 `precondition_failed` | 画面を開いた後に、ほかの人が重ねる分を作った・変えた | 「読み直す」で今の内容にしてから、やり直します |
| 403 `overlay_not_owner` | 利用者が、ほかの人が作った重ねる分を直そうとした | 管理者に頼みます |
| 403 `file_service_not_allowed` | 利用者が、重ねる分から設定ファイルのサービスを使った | 重ねる分の中に自分のサービスを作ります |
| 500 `overlay_db`（「forward_rule_overlays がありません」）か、権限の誤り | migration `015` がないか、UI のユーザーに権限がない | `015` を当てて、UI のユーザーに権限を渡します。このとき rproxy には何も送っていません |

ほかに、表に収まらない 3 つの場合があります。

**rproxy を再起動したら、重ねる分が消えた**：UI のトークンに `persist` がない（ふつうの形の）ためで、重ねる分は rproxy のメモリにだけありました。migration `014` の問題ではありません。ダッシュボードの「要確認のルール」の「重ねる分のずれ N 件をまとめて送り直す」か、ルールの詳細の「UI の DB の内容を送り直す」で戻せます（[3.3](#33-rproxy-api-への接続とトークンのスコープ)）。

**重ねる分の保存で「DB（rproxy_rule_overlays）に保存できませんでした」と出る**：`persist: true` のトークンで作った重ねる分を rproxy が自分の DB に保存しようとして、migration `014` がないか、rproxy の DB ユーザーに権限がなかったためです。重ねる分はいま効いていますが、rproxy を再起動すると消えます。`014` を当て、rproxy のユーザーに権限を渡してください。

**act / stb の画面で、重ねる分に「作った人として確かめ直して断った」と出る**：重ねる分を作った利用者の決まり（許可リスト・ノード・ポートなど）が保存の後で変わったか、作った人が分からなくなったため、送り直さずに止めています。管理者が詳細画面で直して保存するか、重ねる分を外してください。

### 8.5 複数のノード

[6.](#6-複数のノードとグループ) の構成で出るものです。

| 出るもの | わけ | すること |
|---|---|---|
| 409 `target_conflict` | ノードが重なる置き場所に、同じキーのルールがある | 別のノード／グループを選びます |
| 400 `target_required` | 置き場所（ノード／グループ）を指定していない | ノード／グループを選びます |
| 400 `unknown_target` | `nodes.yaml` にない名前を指定した | 名前を選び直し、`nodes.yaml` を見ます |
| 409 `readonly_node` | Kubernetes の Gateway の rproxy（読むだけ）に書こうとした | Gateway API のリソースの側で変えます |

### 8.6 DB と migration

| 出るもの | わけ | すること |
|---|---|---|
| 「usage_* の表がありません（…010_usage.sql…）」・「attr 列がありません（…011…）」 | 利用量の migration がない | `010`・`011` を当てます（`migrate.mjs`） |
| 500 `nodes_db`（「forward_rule_targets を更新できません」） | 複数のノードの migration（`006`・`007`）がないか、権限がない | 当てて、UI のユーザーに権限を渡します |

重ねる分の表（`014`・`015`）で出るものは [8.4](#84-固定ルールに重ねる分) にあります。

### 8.7 起動と版

| 出るもの | わけ | すること |
|---|---|---|
| UI が起動しない | `nodes.yaml` の誤り、トークンのファイルの持ち主・権限、DB の TLS の設定、`http://` の URL と `RPROXY_API_TLS_*` の組み合わせ など | `journalctl -u rproxy-ui` で理由を見て直します（[7.4](#74-ログ)） |
| ダッシュボードに版の注意 | rproxy-api が v0.3.5 より古いか、版を返さない（v0.3.18 より前） | rproxy-api を上げます |
