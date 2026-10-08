#!/usr/bin/env node
// ノードごとのデータベースと forward_rules ビュー（#98）の SQL を出す。
//
//   node db/node-view.mjs <ノード名> [--database rproxy] [--view-database rproxy_node_<ノード名>]
//                         [--user rproxy_<ノード名>] [--host 127.0.0.1] [--password <パスワード>] [--without-rproxy-rules] [--without-rproxy-rule-sets]
//
// 出した SQL は、UI のテーブルを読める管理者（root など）で流す（ビューはその人の権限で元のテーブルを読む）:
//   node db/node-view.mjs node1 --password 'secret' | mariadb -u root -p
// その rproxy の RPROXY_DATABASE_URL は mysql://<user>:<password>@<host>/<view-database> にする。
// rproxy は起動時に SELECT ... FROM forward_rules を読むだけなので、ビューを読めれば変更は要らない。
// ノードごとの上書き（forward_rule_overrides。#98）は、ビューが重ねてから出す（待ち受けアドレス・転送先は列を置き換え、
// options は JSON_MERGE_PATCH で重ねる。UI の components/overrides.ts と同じ重ね方）。
// ビューは forward_rule_targets（UI が RPROXY_UI_NODES に合わせて書き直す）で絞るので、
// グループの構成を変えてもビューを作り直す必要はない（ノードを足したときだけ、そのノードの分を流す）。
// --password を付けなければ CREATE USER は出さない（ユーザーは別に作る）。
// rproxy-api v0.4 が API で作ったルールを保存する rproxy_rules（migration 009）も、そのノードの行だけの書けるビュー
// （WITH CHECK OPTION）にして、読み書きの権限を渡す（rproxy の RPROXY_NODE_NAME をノードの名前にする）。
// 009 を適用していなければ --without-rproxy-rules で出さない。
// rproxy-api v0.4.2 がルールの組を保存する rproxy_rule_sets（migration 012）も同じく、そのノードの行だけの書けるビューにする。
// 012 を適用していなければ --without-rproxy-rule-sets で出さない（--without-rproxy-rules でも出さない）。
// 依存のない JavaScript（.deb の /usr/share/rproxy-ui/db/ からも node で動く）。テストは tests/nodeview.test.ts

// components/nodes.ts の NAME_PATTERN と同じ（データベース名・ユーザー名に使うので英小文字・数字・_ だけ）
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;
const IDENT = /^[A-Za-z0-9_]{1,64}$/;
const HOST = /^[A-Za-z0-9_.:%-]{1,255}$/;

// rproxy-api（src/config/db.rs）が forward_rules から読む列。ビューはこの列だけを出す
export const RPROXY_COLUMNS = ['protocol', 'src_addr', 'src_port', 'src_port_end', 'dist_addr', 'dist_port', 'source_ip', 'udp_idle_secs', 'options'];

// rproxy_rules の列（migration 009。rproxy-api の src/config/persist.rs）
export const RPROXY_RULES_COLUMNS = ['node', 'protocol', 'listen_addr', 'listen_port', 'spec', 'spec_version', 'created_by', 'created_at', 'updated_by', 'updated_at'];

// rproxy_rule_sets の列（migration 012。rproxy-api の src/config/persist.rs）
export const RPROXY_RULE_SETS_COLUMNS = ['node', 'name', 'generation', 'etag', 'owner', 'rules', 'spec_version', 'updated_by', 'updated_at'];

// ' は '' にする（sql_mode の NO_BACKSLASH_ESCAPES に関係なく同じ意味になるように、\ は受け付けない）
function quoteString(value) {
  const s = String(value);
  if (s.includes('\\')) throw new Error('値に \\ は使えません');
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * @param {{ node: string, database?: string, viewDatabase?: string, user?: string, host?: string, password?: string, withoutRproxyRules?: boolean, withoutRproxyRuleSets?: boolean }} opts
 * @returns {string}
 */
export function nodeViewSql(opts) {
  const node = opts.node;
  if (typeof node !== 'string' || !NAME_PATTERN.test(node)) {
    throw new Error(`ノード名は英小文字・数字・_ の 32 文字までにしてください: ${String(node)}`);
  }
  const database = opts.database ?? 'rproxy';
  const viewDatabase = opts.viewDatabase ?? `rproxy_node_${node}`;
  const user = opts.user ?? `rproxy_${node}`;
  const host = opts.host ?? '127.0.0.1';
  for (const [name, value] of [['database', database], ['view-database', viewDatabase], ['user', user]]) {
    if (!IDENT.test(value)) throw new Error(`--${name} は英数字と _ の 64 文字までにしてください: ${value}`);
  }
  if (database === viewDatabase) throw new Error('--view-database は UI のデータベースと別にしてください（同じ名前の forward_rules テーブルがあります）。');
  if (!HOST.test(host)) throw new Error(`--host が不正です: ${host}`);

  // 上書きがあればそちらの値（列はそのまま置き換え、options は差分を重ねる）
  const exprs = {
    src_addr: 'COALESCE(o.`src_addr`, r.`src_addr`) AS `src_addr`',
    dist_addr: 'COALESCE(o.`dist_addr`, r.`dist_addr`) AS `dist_addr`',
    dist_port: 'COALESCE(o.`dist_port`, r.`dist_port`) AS `dist_port`',
    options: "CASE WHEN o.`options` IS NULL THEN r.`options` ELSE JSON_MERGE_PATCH(COALESCE(r.`options`, '{}'), o.`options`) END AS `options`",
  };
  const cols = RPROXY_COLUMNS.map((c) => exprs[c] ?? `r.\`${c}\``).join(', ');
  const account = `${quoteString(user)}@${quoteString(host)}`;
  const lines = [
    `-- rproxy のノード ${node} が起動時に読むビュー（db/node-view.mjs が作った SQL）`,
    `-- RPROXY_DATABASE_URL=mysql://${user}:<password>@<DB のホスト>/${viewDatabase}`,
    `CREATE DATABASE IF NOT EXISTS \`${viewDatabase}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE OR REPLACE SQL SECURITY DEFINER VIEW \`${viewDatabase}\`.\`forward_rules\` AS`,
    `  SELECT ${cols}`,
    `    FROM \`${database}\`.\`forward_rules\` r`,
    `    LEFT JOIN \`${database}\`.\`forward_rule_overrides\` o ON o.\`rule_id\` = r.\`id\` AND o.\`node\` = ${quoteString(node)}`,
    `   WHERE r.\`target\` IN (SELECT t.\`target\` FROM \`${database}\`.\`forward_rule_targets\` t WHERE t.\`node\` = ${quoteString(node)});`,
  ];
  if (opts.password !== undefined) {
    lines.push(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quoteString(opts.password)};`);
  }
  lines.push(`GRANT SELECT ON \`${viewDatabase}\`.\`forward_rules\` TO ${account};`);
  if (!opts.withoutRproxyRules) {
    // rproxy が書く rproxy_rules（v0.4）：自分のノードの行だけを見せ、ほかのノードの行は書けない（WITH CHECK OPTION）
    lines.push(
      `CREATE OR REPLACE SQL SECURITY DEFINER VIEW \`${viewDatabase}\`.\`rproxy_rules\` AS`,
      `  SELECT ${RPROXY_RULES_COLUMNS.map((c) => `\`${c}\``).join(', ')}`,
      `    FROM \`${database}\`.\`rproxy_rules\``,
      `   WHERE \`node\` = ${quoteString(node)}`,
      '  WITH CHECK OPTION;',
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${viewDatabase}\`.\`rproxy_rules\` TO ${account};`,
    );
  }
  if (!opts.withoutRproxyRules && !opts.withoutRproxyRuleSets) {
    // rproxy が書く rproxy_rule_sets（v0.4.2）：自分のノードの組だけを見せ、ほかのノードの行は書けない
    lines.push(
      `CREATE OR REPLACE SQL SECURITY DEFINER VIEW \`${viewDatabase}\`.\`rproxy_rule_sets\` AS`,
      `  SELECT ${RPROXY_RULE_SETS_COLUMNS.map((c) => `\`${c}\``).join(', ')}`,
      `    FROM \`${database}\`.\`rproxy_rule_sets\``,
      `   WHERE \`node\` = ${quoteString(node)}`,
      '  WITH CHECK OPTION;',
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${viewDatabase}\`.\`rproxy_rule_sets\` TO ${account};`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const FLAGS = { '--database': 'database', '--view-database': 'viewDatabase', '--user': 'user', '--host': 'host', '--password': 'password' };

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in FLAGS) {
      if (i + 1 >= argv.length) throw new Error(`${a} の値がありません`);
      opts[FLAGS[a]] = argv[++i];
    } else if (a === '--without-rproxy-rules') {
      opts.withoutRproxyRules = true;
    } else if (a === '--without-rproxy-rule-sets') {
      opts.withoutRproxyRuleSets = true;
    } else if (a.startsWith('--')) {
      throw new Error(`知らないオプション: ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1) throw new Error('ノード名を 1 つ指定してください');
  return { node: rest[0], ...opts };
}

if (process.argv[1] && process.argv[1].endsWith('node-view.mjs')) {
  try {
    process.stdout.write(nodeViewSql(parseArgs(process.argv.slice(2))));
  } catch (err) {
    console.error(`node-view.mjs: ${err instanceof Error ? err.message : err}`);
    console.error('使い方: node db/node-view.mjs <ノード名> [--database rproxy] [--view-database rproxy_node_<ノード名>] [--user rproxy_<ノード名>] [--host 127.0.0.1] [--password <パスワード>] [--without-rproxy-rules] [--without-rproxy-rule-sets]');
    process.exit(2);
  }
}
