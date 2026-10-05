import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

// next/core-web-vitals の .ts / .tsx 用の parser（typescript-eslint）
const tsParser = nextVitals.find((c) => c.name === 'next/typescript')?.languageOptions?.parser;
if (!tsParser) throw new Error('eslint-config-next: next/typescript の parser が見つからない');

// Next.js 16 では next lint がなくなったので、ESLint の flat config で同じ規則（next/core-web-vitals）を使う
export default defineConfig([
  ...nextVitals,
  {
    // ESLint 10 向けの手当て（eslint-config-next 16.3 が ESLint 10 に追いつくまで）
    // - eslint-plugin-react 7.37 は react.version が 'detect' のとき、ESLint 10 でなくなった context.getFilename() を呼んで止まる。
    //   バージョンを書いて検出を飛ばす（package.json の react に合わせる）
    settings: { react: { version: '19.3' } },
  },
  {
    // - next に同梱の Babel の parser は ESLint 10 の scopeManager.addGlobals() を持たず、.js / .mjs / .mts（next/typescript は .ts / .tsx だけ）で止まる。
    //   ESLint 10 に対応した typescript-eslint の parser で読む（このリポジトリの JS は設定・スクリプトだけで JSX はない）
    files: ['**/*.{js,jsx,mjs,cjs,mts,cts}'],
    languageOptions: { parser: tsParser },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'coverage/**']),
]);
