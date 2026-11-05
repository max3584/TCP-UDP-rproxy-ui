// トークンでのサインインの E2E（tests/ui/token-signin.spec.ts、#179）のトークンのファイル。
// playwright.config.ts の 2 つめの webServer（RPROXY_UI_AUTH=both）が起動の前に `node tests/ui/token-fixture.cjs` で書く。
// 試験用のトークン（本番では使わない）。ファイルには sha256 だけを書き、UI と同じく 0600 にする
// （CommonJS：Playwright が読む spec からも、webServer の node からも使う）
const { createHash } = require('node:crypto');
const { chmodSync, mkdirSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const TOKENS_FILE = join(__dirname, '.auth', 'tokens.yaml');
const E2E_TOKENS = {
  admin: 'rpui_e2e-admin-token-not-for-production-0000000000',
  user: 'rpui_e2e-user-token-not-for-production-11111111111',
  revoke: 'rpui_e2e-revoke-token-not-for-production-222222222',
};
// role: user の行は sub を書く（履歴の auth_id と、ルールの持ち主）
const E2E_USER_SUB = 'ui-e2e-token-user';

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// names：書く行（既定は全部）。rename で置き換える（UI は次のセッションの確認で読み直す）
function writeTokens(names = Object.keys(E2E_TOKENS)) {
  const rows = names.map((n) => `  - name: e2e-${n}\n    sha256: ${sha(E2E_TOKENS[n])}\n    role: ${n === 'admin' ? 'admin' : 'user'}\n${n === 'user' ? `    sub: ${E2E_USER_SUB}\n` : ''}`);
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  const tmp = `${TOKENS_FILE}.tmp`;
  writeFileSync(tmp, `tokens:\n${rows.join('')}`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, TOKENS_FILE);
}

module.exports = { TOKENS_FILE, E2E_TOKENS, E2E_USER_SUB, writeTokens };

if (require.main === module) writeTokens();
