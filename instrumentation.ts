// サーバの起動時に一度だけ呼ばれる（Next.js の instrumentation）。
// RPROXY_UI_NODES（複数の rproxy の設定ファイル。#98）を読み、誤りがあれば理由を出して起動をやめる（components/nodes.ts）
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!(process.env.RPROXY_UI_NODES ?? '').trim()) return;
  const { checkNodesAtStartup } = await import('./components/nodes');
  checkNodesAtStartup();
}
