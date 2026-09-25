// API のエラーコードを、利用者向けの説明に直す（tests/listen.test.ts）

const EXPLAIN: Record<string, string> = {
  resolve_failed: '転送先のホスト名を名前解決できませんでした。DNS に登録されているか、ホスト名の綴りを確認してください（IP アドレスでも指定できます）。',
  bind_failed: '待ち受けポートを開けませんでした。ほかのプログラムがそのポートを使っていないか確認してください。',
  reserved: 'rproxy 自身の制御 API が使っているアドレスとポートです。別のポートを選んでください。',
  already_exists: '同じプロトコル・アドレス・ポート（または重なるポート範囲）のルールが既にあります。',
  tls_config: 'TLS の設定に問題があります。証明書・中間 CA・秘密鍵のパスと内容を確認してください。',
  unreachable: 'rproxy に接続できませんでした。rproxy が起動しているか確認してください。',
  unauthorized: 'ログインし直してください。',
};

export function explainError(code: string | undefined, detail: string): string {
  const text = code ? EXPLAIN[code] : undefined;
  if (!text) return code ? `${detail} (${code})` : detail;
  return `${text}（詳細: ${detail}）`;
}
