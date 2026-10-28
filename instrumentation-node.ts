// サーバの起動時に一度だけ呼ばれる（instrumentation.ts から、Node.js の実行環境のときだけ）。
// RPROXY_UI_NODES（複数の rproxy の設定ファイル。#98）を読み、誤りがあれば理由を出して起動をやめる（components/nodes.ts）。
// RPROXY_UI_NODES がなければ RPROXY_API_TLS_* が https:// の RPROXY_API_URL と組になっているかを確かめる。
// active_standby のグループがあれば、stb を DB の定義に揃える自動の送り直しを始める（components/hasync.ts。#109）。
// 利用量の集計を始める（components/usagecollect.ts。#101）
export async function registerNode(): Promise<void> {
  // Brotli の脆弱性（CVE-2026-111497）の直っていない Node.js なら警告する。起動は止めない
  const { warnNodeVersion } = await import('./components/nodeversion');
  warnNodeVersion();
  // 各ノードの rproxy-api の版を確かめてログに出す（#106）。待たない・失敗しても起動を止めない
  void import('./components/versioncheck').then((m) => m.logVersions()).catch(() => undefined);
  // RPROXY_UI_NODES の誤り、RPROXY_API_TLS_* を http:// の RPROXY_API_URL で使おうとしている（トークンが平文で流れる）なら止める
  const { checkNodesAtStartup } = await import('./components/nodes');
  checkNodesAtStartup();
  // DB_SSL・DB_SSL_CA・DB_SSL_VERIFY の誤り（読めない CA など）は起動時に止める（#164）
  const { dbSslOptions } = await import('./components/dbtls');
  try {
    dbSslOptions();
  } catch (err) {
    console.error(`rproxy-ui: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!(process.env.RPROXY_UI_NODES ?? '').trim()) {
    await startUsageCollector();
    return;
  }
  const { startHaSync } = await import('./components/hasync');
  startHaSync();
  await startUsageCollector();
}

// 利用量の集計（#101。components/usagecollect.ts）。RPROXY_UI_USAGE_SECS ごと（既定 300 秒、0 で止める）
async function startUsageCollector(): Promise<void> {
  const { startUsage } = await import('./components/usagecollect');
  startUsage();
}
