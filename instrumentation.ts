// サーバの起動時に一度だけ呼ばれる（Next.js の instrumentation）。
// RPROXY_UI_NODES（複数の rproxy の設定ファイル。#98）を読み、誤りがあれば理由を出して起動をやめる（components/nodes.ts）。
// active_standby のグループがあれば、stb を DB の定義に揃える自動の送り直しを始める（components/hasync.ts。#109）
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // 各ノードの rproxy-api の版を確かめてログに出す（#106）。待たない・失敗しても起動を止めない
  void import('./components/versioncheck').then((m) => m.logVersions()).catch(() => undefined);
  if (!(process.env.RPROXY_UI_NODES ?? '').trim()) return;
  const { checkNodesAtStartup } = await import('./components/nodes');
  checkNodesAtStartup();
  const { startHaSync } = await import('./components/hasync');
  startHaSync();
}
