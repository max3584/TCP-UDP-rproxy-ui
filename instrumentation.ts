// サーバの起動時に一度だけ呼ばれる（Next.js の instrumentation）。
// RPROXY_UI_NODES（複数の rproxy の設定ファイル。#98）を読み、誤りがあれば理由を出して起動をやめる
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!(process.env.RPROXY_UI_NODES ?? '').trim()) return;
  const { loadNodes } = await import('./components/nodes');
  try {
    const config = loadNodes();
    console.log(`rproxy-ui: RPROXY_UI_NODES: nodes ${config.nodes.map((n) => n.name).join(', ')}; groups ${config.groups.map((g) => `${g.name}(${g.nodes.join(',')})`).join(', ') || '-'}`);
  } catch (err) {
    console.error(`rproxy-ui: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
