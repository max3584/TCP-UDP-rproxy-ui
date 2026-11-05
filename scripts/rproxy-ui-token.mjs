#!/usr/bin/env node
// UI のサインインのトークン（#179。RPROXY_UI_AUTH=token・both）を作る・一覧する・消す。
//
//   rproxy-ui-token new --name <名前> --role admin|user [--sub <sub>] [--file <パス>] [--owner <ユーザー>]
//   rproxy-ui-token new --name <名前> --role admin|user [--sub <sub>] --stdout
//   rproxy-ui-token list [--file <パス>]
//   rproxy-ui-token remove --name <名前> [--file <パス>]
//
// （リポジトリでは npm run token -- new ...、.deb では rproxy-ui-token、イメージでは node /app/rproxy-ui-token.mjs）
// - new：ランダムなトークン（rpui_ + 32 バイト）を作り、標準出力に 1 回だけ出す。ファイルには sha256 だけを書く（平文は残さない）。
//   --stdout はファイルに書かず、トークンと tokens: の行（YAML）を出す（Kubernetes の Secret に入れるとき）。
// - ファイルは --file か RPROXY_UI_TOKENS_FILE。新しく作るときは 0600。置き換えは同じディレクトリの一時ファイルから rename（UI は
//   次のセッションの確認で読み直す）。root で新しく作るときは --owner で持ち主（.deb では rproxy-ui）を決める（既にあれば既定は今の持ち主）。
// - 既にあるファイルは、UI と同じく持ち主が自分（root なら誰でも）で group・other の権限がないものだけ書き換える。
// 規則（name の形・role・同じ name や sha256 を断る）は components/tokenauth.ts の parseTokensFile と同じ（tests/tokenauth.test.ts が比べる）。
// 依存は yaml だけ（UI と同じもの。.deb では /usr/lib/rproxy-ui/node_modules から読む）
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fchownSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TOKEN_PREFIX = 'rpui_';

export const newToken = () => TOKEN_PREFIX + randomBytes(32).toString('base64url');
export const sha256Hex = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const HEADER = `# rproxy-ui のサインインのトークン（RPROXY_UI_TOKENS_FILE。README の「トークンでのサインイン」）。
# 平文のトークンは置かない（sha256 だけ）。行を消すとそのトークンのセッションは次の確認で切れる。
# rproxy-ui-token new / remove で書き換えられる（手で書き換えてもよい）
`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd: cmd ?? '', name: '', role: '', sub: '', file: '', owner: '', stdout: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} の値がありません`);
      return v;
    };
    if (a === '--name') opts.name = value();
    else if (a === '--role') opts.role = value();
    else if (a === '--sub') opts.sub = value();
    else if (a === '--file') opts.file = value();
    else if (a === '--owner') opts.owner = value();
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`知らない引数です: ${a}`);
  }
  if (opts.cmd === '-h' || opts.cmd === '--help') opts.help = true;
  return opts;
}

// yaml：ふつうに import（リポジトリ・イメージ）、だめなら .deb の UI の node_modules（RPROXY_UI_LIB、既定 /usr/lib/rproxy-ui）
async function loadYaml() {
  try {
    return await import('yaml');
  } catch (first) {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const base of [process.env.RPROXY_UI_LIB, '/usr/lib/rproxy-ui', join(here, '..'), here].filter(Boolean)) {
      if (!existsSync(join(base, 'node_modules', 'yaml'))) continue;
      const path = createRequire(join(base, 'package.json')).resolve('yaml');
      return await import(pathToFileURL(path).href);
    }
    throw new Error(`yaml が見つかりません（UI の node_modules のあるディレクトリを RPROXY_UI_LIB に指定してください）: ${first instanceof Error ? first.message : String(first)}`);
  }
}

// 書き換えてよいファイルか（UI の tokenFileModeProblem より厳しい：Kubernetes の Secret はこのコマンドで書き換えない）
export function writableProblem(st, uid) {
  const perm = st.mode & 0o777;
  if (uid !== 0 && st.uid !== uid) return `持ち主（uid ${st.uid}）が自分（uid ${uid}）ではありません`;
  if ((perm & 0o077) !== 0) return `権限が ${perm.toString(8).padStart(4, '0')} です（chmod 600 にしてください）`;
  return null;
}

// tokens: の一覧（YAML の Document）に行を足す・消す。comments は残す
export function entryFor({ name, role, sub }, token) {
  if (!TOKEN_NAME.test(name)) throw new Error('--name は英数字で始まる 64 文字までの英数字・. _ - にしてください');
  if (role !== 'admin' && role !== 'user') throw new Error('--role は admin か user にしてください');
  const entry = { name, sha256: sha256Hex(token), role };
  if (sub) {
    if (sub.trim() === '' || sub.length > 255 || /[\u0000-\u001f\u007f]/.test(sub)) throw new Error('--sub は 255 文字までの文字列にしてください');
    entry.sub = sub.trim();
  }
  return entry;
}

export function addEntry(YAML, text, entry) {
  const doc = YAML.parseDocument(text === '' ? `${HEADER}tokens: []\n` : text);
  if (doc.errors.length > 0) throw new Error(`YAML として読めません: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.contents === null) doc.contents = doc.createNode({ tokens: [] });
  if (!YAML.isMap(doc.contents)) throw new Error('先頭は tokens: の一覧にしてください');
  let list = doc.get('tokens');
  if (list === undefined || list === null) {
    doc.set('tokens', doc.createNode([]));
    list = doc.get('tokens');
  }
  if (!YAML.isSeq(list)) throw new Error('tokens は一覧にしてください');
  const rows = list.toJSON() ?? [];
  if (rows.some((r) => r && r.name === entry.name)) throw new Error(`同じ name（${entry.name}）のトークンがあります（先に remove してください）`);
  if (rows.some((r) => r && typeof r.sha256 === 'string' && r.sha256.toLowerCase() === entry.sha256)) throw new Error('同じ sha256 の行があります');
  list.flow = false;
  list.add(doc.createNode(entry));
  return doc.toString();
}

export function removeEntry(YAML, text, name) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`YAML として読めません: ${doc.errors[0].message.split('\n')[0]}`);
  const list = YAML.isMap(doc.contents) ? doc.get('tokens') : null;
  if (!YAML.isSeq(list)) throw new Error('tokens: の一覧がありません');
  const i = list.items.findIndex((item) => YAML.isMap(item) && item.get('name') === name);
  if (i < 0) throw new Error(`name が ${name} のトークンはありません`);
  list.items.splice(i, 1);
  return doc.toString();
}

function uidOf(user) {
  if (/^[0-9]+$/.test(user)) return { uid: Number(user), gid: -1 };
  const uid = Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim());
  return { uid, gid };
}

// 開いて確かめてから読む。なければ ''（と null の stat）
function readChecked(path, uid) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { text: '', st: null };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} はふつうのファイルではありません`);
    const problem = writableProblem(st, uid);
    if (problem) throw new Error(`${path}: ${problem}`);
    return { text: readFileSync(fd, 'utf8'), st };
  } finally {
    closeSync(fd);
  }
}

// 同じディレクトリの一時ファイル（0600、O_EXCL で新しく作る）に書いて rename。持ち主は開いたファイルに fchown で付ける
// （名前で chown すると、閉じたあとに入れ替えられたファイル・シンボリックリンクの先を変えてしまう）
function writeAtomic(path, text, owner) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      if (owner) fchownSync(fd, owner.uid, owner.gid);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 消せなくても元の誤りを出す */ }
    throw err;
  }
}

const USAGE = `rproxy-ui-token new --name <名前> --role admin|user [--sub <sub>] [--file <パス>] [--owner <ユーザー>]
rproxy-ui-token new --name <名前> --role admin|user [--sub <sub>] --stdout
rproxy-ui-token list [--file <パス>]
rproxy-ui-token remove --name <名前> [--file <パス>]
--file の既定は RPROXY_UI_TOKENS_FILE`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @param {{ write: (s: string) => unknown }} [out]
 * @param {{ write: (s: string) => unknown }} [err]
 */
export async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const opts = parseArgs(argv);
  if (opts.help || !['new', 'list', 'remove'].includes(opts.cmd)) {
    (opts.help ? out : err).write(`${USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  const YAML = await loadYaml();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  if (opts.cmd === 'new' && opts.stdout) {
    const token = newToken();
    const entry = entryFor(opts, token);
    out.write(`token: ${token}\n# tokens: に足す行（平文のトークンはファイルに書かない）:\n${YAML.stringify([entry])}`);
    return 0;
  }
  const given = opts.file || (env.RPROXY_UI_TOKENS_FILE ?? '').trim();
  if (!given) throw new Error('--file か RPROXY_UI_TOKENS_FILE でトークンのファイルを指定してください');
  const file = resolve(given);
  if (opts.owner && uid !== 0) throw new Error('--owner は root で動かすときだけ使えます');
  const { text, st } = readChecked(file, uid);
  if (opts.cmd === 'list') {
    const doc = YAML.parse(text === '' ? '{}' : text) ?? {};
    for (const r of Array.isArray(doc.tokens) ? doc.tokens : []) out.write(`${r?.name}\t${r?.role}\t${r?.sub ?? `token:${r?.name}`}\n`);
    return 0;
  }
  // root で既にあるファイルを書き換えるときは、持ち主を変えない。root で新しく作るときは --owner が要る
  // （root:root 0600 のファイルは UI が読めない）
  if (uid === 0 && !st && !opts.owner && opts.cmd === 'new') {
    throw new Error('root で新しいファイルを作るときは --owner に UI を動かすユーザー（.deb では rproxy-ui）を指定してください');
  }
  const owner = opts.owner ? uidOf(opts.owner) : uid === 0 && st ? { uid: st.uid, gid: st.gid } : null;
  if (owner && owner.gid < 0) owner.gid = st ? st.gid : owner.uid;
  if (opts.cmd === 'remove') {
    if (!opts.name) throw new Error('--name を指定してください');
    writeAtomic(file, removeEntry(YAML, text, opts.name), owner);
    err.write(`rproxy-ui-token: ${opts.name} を ${file} から消しました（そのトークンのセッションは次の確認で切れます）\n`);
    return 0;
  }
  const token = newToken();
  const entry = entryFor(opts, token);
  writeAtomic(file, addEntry(YAML, text, entry), owner);
  err.write(`rproxy-ui-token: ${entry.name}（${entry.role}、sub ${entry.sub ?? `token:${entry.name}`}）を ${file} に足しました。トークンは次の 1 回だけ表示します：\n`);
  out.write(`${token}\n`);
  return 0;
}

// 直接動かしたときだけ（/usr/bin/rproxy-ui-token はこのファイルへのシンボリックリンク）
const invoked = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) : false;
  } catch {
    return false;
  }
})();
if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`rproxy-ui-token: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
