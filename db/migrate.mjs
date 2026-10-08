#!/usr/bin/env node
// データベースの migration を順に当てる（Kubernetes の chart の migration の Job と、.deb の手作業の両方で使う）。
//
//   node db/migrate.mjs [--baseline <番号>] [--create-database] [--wait <秒>] [--lock-timeout <秒>] [--dry-run | --status]
//
// 接続は環境変数：DB_HOST・DB_PORT（既定 3306）・DB_DATABASE、DDL を流す管理者 DB_ADMIN_USER・DB_ADMIN_PASSWORD
// （なければ DB_USER・DB_PASSWORD）。
// - 当てたものは schema_migrations（version・applied_at・checksum・method）に書く。同時に動かしても GET_LOCK('rproxy-ui-migrate')
//   で 1 つずつになり、2 回目は何もしない。
// - 新しい DB（forward_rules がない）：schema.sql を流し、migrations/ のすべてを当てたことにする（method = schema）。
// - schema_migrations のない古い DB（.deb で手で migration を当ててきた DB）：どこまで当てたか分からないので、
//   --baseline <番号>（当て終わった最後の番号。例 012）がなければ断る。番号までを当てたことにして（baseline）、その後を当てる。
// - 003（Auth0 から Keycloak への一度だけの手作業のテンプレート）は流さずに当てたことにする（skipped）。
// - 当てた後で中身が変わった migration は警告だけ（checksum）。
// --create-database：DB_DATABASE がなければ作る（同梱の MariaDB で root を使うとき）。
// DB_APP_USER・DB_APP_PASSWORD（DB_APP_HOST、既定 %）：UI の DB ユーザーを作り（あればパスワードを合わせ）、db/README.md の権限を渡す。
// DB_BACKUP_USER・DB_BACKUP_PASSWORD（DB_BACKUP_HOST、既定 %）：バックアップ用の読むだけのユーザー（SELECT・LOCK TABLES・SHOW VIEW）。
// --wait <秒>：DB に接続できるまで待つ（Job で DB と一緒に起動するとき）。--dry-run：何をするかを出すだけ。--status：当てたものと残り。
// 依存は mariadb のドライバだけ（UI と同じもの。.deb では /usr/lib/rproxy-ui/node_modules から読む）。テストは tests/migrate.test.ts
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCK_NAME = 'rproxy-ui-migrate';
// 流さないもの（一度だけの手作業のテンプレート）
export const SKIP = new Set([3]);

const DB_DIR = dirname(fileURLToPath(import.meta.url));

export const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL COMMENT 'migrations/ のファイル名（.sql を除く）',
  applied_at DATETIME(3) NOT NULL,
  checksum   CHAR(64)    NOT NULL COMMENT 'ファイルの SHA-256',
  method     VARCHAR(16) NOT NULL DEFAULT 'applied' COMMENT 'applied・schema（schema.sql で作った）・baseline・skipped',
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// UI の DB ユーザーの権限（db/README.md と同じ）
export const APP_GRANTS = [
  ['forward_rules', 'SELECT, INSERT, UPDATE, DELETE'],
  ['forward_rules_log', 'SELECT, INSERT'],
  ['forward_rule_targets', 'SELECT, INSERT, DELETE'],
  ['forward_rule_overrides', 'SELECT, INSERT, UPDATE, DELETE'],
  ['usage_counters', 'SELECT, INSERT, UPDATE, DELETE'],
  ['usage_hourly', 'SELECT, INSERT, UPDATE, DELETE'],
  ['usage_daily', 'SELECT, INSERT, UPDATE, DELETE'],
  ['rproxy_rules', 'SELECT'],
  ['rproxy_rule_sets', 'SELECT'],
];

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// migrations/ の NNN_name.sql を番号の順に
export function readMigrations(dir = join(DB_DIR, 'migrations')) {
  return readdirSync(dir)
    .filter((f) => /^\d+_[A-Za-z0-9_]+\.sql$/.test(f))
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: f.slice(0, -4), number: Number(f.split('_')[0]), checksum: sha256(sql), sql: sql };
    })
    .sort((a, b) => a.number - b.number || a.version.localeCompare(b.version));
}

// 何をするか（DB に触れない）。files は readMigrations の形、applied は schema_migrations の行（version・checksum）。
// 返り値：schema（schema.sql を流すか）、steps（{version, method: applied | schema | baseline | skipped}。applied だけ SQL を流す）、
// warnings。断るときは error
/**
 * @param {{ files: { version: string, number: number, checksum: string, sql: string }[], applied: { version: unknown, checksum: unknown }[],
 *   hasForwardRules: boolean, baseline?: number | null }} args
 */
export function planMigrations({ files, applied, hasForwardRules, baseline = null }) {
  const warnings = [];
  const done = new Map(applied.map((r) => [String(r.version), String(r.checksum)]));
  for (const f of files) {
    const sum = done.get(f.version);
    if (sum !== undefined && sum !== f.checksum) warnings.push(`${f.version} は当てた後で中身が変わっています（checksum が違う）。必要なら手で確かめてください。`);
  }
  for (const v of done.keys()) {
    if (!files.some((f) => f.version === v)) warnings.push(`${v} は当てたことになっていますが、migrations/ にありません。`);
  }
  if (done.size === 0) {
    if (!hasForwardRules) {
      if (baseline !== null) warnings.push('新しい DB なので --baseline は使いません（schema.sql を流します）。');
      return { schema: true, steps: files.map((f) => ({ version: f.version, checksum: f.checksum, method: 'schema' })), warnings: warnings };
    }
    if (baseline === null) {
      return {
        error: 'schema_migrations がない既存の DB です。どの migration まで当てたかを --baseline <番号>（例 --baseline 012）で指定してください'
          + '（db/README.md の「migration」）。',
        schema: false, steps: [], warnings: warnings,
      };
    }
    const steps = files.map((f) => ({
      version: f.version, checksum: f.checksum, sql: f.sql,
      method: f.number <= baseline ? 'baseline' : SKIP.has(f.number) ? 'skipped' : 'applied',
    }));
    return { schema: false, steps: steps, warnings: warnings };
  }
  if (baseline !== null) warnings.push('schema_migrations があるので --baseline は使いません。');
  const steps = files.filter((f) => !done.has(f.version)).map((f) => ({
    version: f.version, checksum: f.checksum, sql: f.sql, method: SKIP.has(f.number) ? 'skipped' : 'applied',
  }));
  return { schema: false, steps: steps, warnings: warnings };
}

export function parseArgs(argv) {
  const opts = { baseline: null, createDatabase: false, wait: 0, lockTimeout: 600, dryRun: false, status: false };
  const num = (flag, v) => {
    if (v === undefined || !/^\d+$/.test(v)) throw new Error(`${flag} には数を書いてください`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') opts.baseline = num(a, argv[++i]);
    else if (a === '--create-database') opts.createDatabase = true;
    else if (a === '--wait') opts.wait = num(a, argv[++i]);
    else if (a === '--lock-timeout') opts.lockTimeout = num(a, argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--status') opts.status = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`知らない引数です: ${a}`);
  }
  return opts;
}

// mariadb のドライバ：ふつうに import（イメージ・リポジトリ）、だめなら .deb の UI の node_modules（RPROXY_UI_LIB、既定 /usr/lib/rproxy-ui）
async function loadDriver() {
  try {
    return await import('mariadb');
  } catch (first) {
    for (const base of [process.env.RPROXY_UI_LIB, '/usr/lib/rproxy-ui', join(DB_DIR, '..')].filter(Boolean)) {
      if (!existsSync(join(base, 'node_modules', 'mariadb'))) continue;
      const path = createRequire(join(base, 'package.json')).resolve('mariadb');
      return await import(pathToFileURL(path).href);
    }
    throw new Error(`mariadb のドライバが見つかりません（UI の node_modules のあるディレクトリを RPROXY_UI_LIB に指定してください）: ${first instanceof Error ? first.message : String(first)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(driver, cfg, waitSecs) {
  const until = Date.now() + waitSecs * 1000;
  for (;;) {
    try {
      return await driver.createConnection(cfg);
    } catch (err) {
      if (Date.now() >= until) throw err;
      console.error(`migrate: DB に接続できません（待ちます）: ${err.message}`);
      await sleep(2000);
    }
  }
}

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

async function tableExists(conn, db, table) {
  const rows = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [db, table]);
  return Number(rows[0].n) > 0;
}

async function ensureUser(conn, db, user, password, host, grants) {
  const account = `${conn.escape(user)}@${conn.escape(host)}`;
  await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${conn.escape(password)}`);
  await conn.query(`ALTER USER ${account} IDENTIFIED BY ${conn.escape(password)}`);
  for (const [table, privs] of grants) {
    if (table === '*') {
      await conn.query(`GRANT ${privs} ON ${conn.escapeId(db)}.* TO ${account}`);
    } else if (await tableExists(conn, db, table)) {
      await conn.query(`GRANT ${privs} ON ${conn.escapeId(db)}.${conn.escapeId(table)} TO ${account}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('node db/migrate.mjs [--baseline <番号>] [--create-database] [--wait <秒>] [--lock-timeout <秒>] [--dry-run | --status]');
    return 0;
  }
  const db = env('DB_DATABASE', '');
  if (db === '') throw new Error('DB_DATABASE を指定してください');
  const driver = await loadDriver();
  const conn = await connect(driver, {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', '3306')),
    user: env('DB_ADMIN_USER', env('DB_USER', 'root')),
    password: env('DB_ADMIN_PASSWORD', env('DB_PASSWORD', '')),
    multipleStatements: true,
    connectTimeout: 10_000,
  }, opts.wait);
  const readOnly = opts.dryRun || opts.status;
  let locked = false;
  try {
    if (opts.createDatabase && !readOnly) {
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${conn.escapeId(db)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
    const got = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, opts.lockTimeout]);
    if (Number(got[0].got) !== 1) throw new Error(`ロック ${LOCK_NAME} を ${opts.lockTimeout} 秒で取れません（ほかの migration が動いています）`);
    locked = true;
    const dbExists = Number((await conn.query('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [db]))[0].n) > 0;
    if (!dbExists) {
      if (readOnly) {
        console.log(`データベース ${db} はまだありません（--create-database で作ります）。`);
        return 0;
      }
      throw new Error(`データベース ${db} がありません（--create-database で作るか、先に作ってください）`);
    }
    await conn.query(`USE ${conn.escapeId(db)}`);
    const hasTable = await tableExists(conn, db, 'schema_migrations');
    if (!hasTable && !readOnly) await conn.query(CREATE_TABLE);
    const applied = hasTable || !readOnly ? await conn.query("SELECT version, checksum, method, DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s UTC') AS applied_at FROM schema_migrations ORDER BY version") : [];
    const files = readMigrations();
    const plan = planMigrations({ files, applied, hasForwardRules: await tableExists(conn, db, 'forward_rules'), baseline: opts.baseline });
    for (const w of plan.warnings) console.warn(`migrate: 警告: ${w}`);
    if (opts.status) {
      for (const r of applied) console.log(`applied  ${r.version}  ${r.method}  ${r.applied_at}`);
      for (const s of plan.steps) console.log(`pending  ${s.version}  ${s.method}`);
      if (plan.error) console.log(`migrate: ${plan.error}`);
      return 0;
    }
    if (plan.error) throw new Error(plan.error);
    if (plan.schema) console.log(`${opts.dryRun ? '(dry run) ' : ''}schema.sql を流します（新しい DB）`);
    for (const s of plan.steps) console.log(`${opts.dryRun ? '(dry run) ' : ''}${s.version}: ${s.method}`);
    if (plan.steps.length === 0) console.log('migrate: 当てるものはありません');
    if (!opts.dryRun) {
      if (plan.schema) await conn.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
      for (const s of plan.steps) {
        if (s.method === 'applied') await conn.query(s.sql);
        await conn.query('INSERT INTO schema_migrations (version, applied_at, checksum, method) VALUES (?, UTC_TIMESTAMP(3), ?, ?)', [s.version, s.checksum, s.method]);
      }
      const appUser = env('DB_APP_USER', '');
      if (appUser !== '') {
        const pw = env('DB_APP_PASSWORD', '');
        if (pw === '') throw new Error('DB_APP_USER には DB_APP_PASSWORD も要ります');
        await ensureUser(conn, db, appUser, pw, env('DB_APP_HOST', '%'), APP_GRANTS);
        console.log(`migrate: UI の DB ユーザー ${appUser} の権限を合わせました`);
      }
      const backupUser = env('DB_BACKUP_USER', '');
      if (backupUser !== '') {
        const pw = env('DB_BACKUP_PASSWORD', '');
        if (pw === '') throw new Error('DB_BACKUP_USER には DB_BACKUP_PASSWORD も要ります');
        await ensureUser(conn, db, backupUser, pw, env('DB_BACKUP_HOST', '%'), [['*', 'SELECT, LOCK TABLES, SHOW VIEW']]);
        console.log(`migrate: バックアップのユーザー ${backupUser} の権限を合わせました`);
      }
    }
    return 0;
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
    await conn.end().catch(() => conn.destroy());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
