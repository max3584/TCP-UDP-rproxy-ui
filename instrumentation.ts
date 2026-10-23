// サーバの起動時に一度だけ呼ばれる（Next.js の instrumentation）。中身は instrumentation-node.ts。
// proxy.ts があると Next は instrumentation を Edge 向けにもビルドするので、Node.js の API を使うものは
// NEXT_RUNTIME の条件の中で import する（Edge 向けのビルドから外れ、process.exit などの警告が出ない）
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
