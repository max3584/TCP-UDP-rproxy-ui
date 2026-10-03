// 画面に出る日本語の文言を、ソースから取り出す（辞書の網羅の確認と、訳の追加に使う）。
// 取り出すもの：日本語を含む文字列リテラル・テンプレート（${} は {0} {1}…）・JSX のテキスト・tc() の「文言|場面」。
// 除くもの：logger / console の引数、i18n/ の中、テスト。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const JA = /[぀-ヿ㐀-鿿！-｠]/;
const ROOTS = ['components', 'pages'];

export function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function skipped(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText();
      if (/^(logger|console|log)\.|^Logger\(|\.(info|warn|error|debug)$/.test(t)) return true;
    }
  }
  return false;
}

export function extract(root = process.cwd()) {
  const keys = new Map();
  for (const r of ROOTS) {
    for (const f of files(path.join(root, r))) {
      const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const add = (k, node) => {
        k = normalize(k);
        if (!k || !JA.test(k) || skipped(node)) return;
        if (!keys.has(k)) keys.set(k, `${path.relative(root, f)}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      };
      const visit = (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) add(node.text, node);
        } else if (ts.isTemplateExpression(node)) {
          let k = node.head.text;
          node.templateSpans.forEach((s, i) => { k += `{${i}}` + s.literal.text; });
          add(k, node);
        } else if (ts.isJsxText(node)) {
          add(node.text, node);
        } else if (ts.isCallExpression(node) && node.expression.getText() === 'tc' && node.arguments.length >= 2
          && ts.isStringLiteral(node.arguments[0]) && ts.isStringLiteral(node.arguments[1])) {
          // 場面つきの訳（i18n/core.ts の tc）：キーは「文言|場面」
          add(`${node.arguments[0].text}|${node.arguments[1].text}`, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
    }
  }
  return keys;
}

if (process.argv[1] && process.argv[1].endsWith('extract.mjs')) {
  const keys = extract();
  if (process.argv.includes('--json')) console.log(JSON.stringify([...keys.keys()], null, 1));
  else { for (const [k, at] of keys) console.log(`${at}\t${k}`); console.error(`${keys.size} keys`); }
}
