// 動いている Node.js が、組み込みの Brotli の伸長の脆弱性（CVE-2026-111497）の直った版かを確かめる。
// 直った版は 22.23.4・24.22.1・26.12.1。23・25 は直らない（サポートが終わった）。
// サーバ側の fetch はノード・IdP の応答の `Content-Encoding: br` を伸長するので、古い Node.js は警告する。

const FIXED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };

/** 直っていない版なら理由の文、直った版（と 27 以降）なら undefined。 */
export function nodeVersionProblem(version: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return undefined;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > 26) return undefined;
  const fixed = FIXED[major];
  if (fixed && (minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]))) return undefined;
  const want = fixed ? `${major}.${fixed[0]}.${fixed[1]}` : '22.23.4, 24.22.1, 26.12.1';
  return `Node.js ${version} は Brotli の脆弱性（CVE-2026-111497）が直っていない。${want} 以上に上げる`;
}

export function warnNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) console.warn(`rproxy-ui: ${problem}`);
}
