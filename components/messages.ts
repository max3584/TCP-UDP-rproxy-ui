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

// 1024 未満のポートは、rproxy に CAP_NET_BIND_SERVICE がないと開けない
const PRIVILEGED_PORT =
  '1024 未満のポートを開く権限が rproxy にありません。1024 以上のポートを使うか、rproxy に CAP_NET_BIND_SERVICE を付けてください（setcap cap_net_bind_service=+ep、systemd なら AmbientCapabilities=CAP_NET_BIND_SERVICE）。';

export function explainError(code: string | undefined, detail: string): string {
  if (code === 'bind_failed' && /Permission denied|os error 13/.test(detail)) {
    return `${PRIVILEGED_PORT}（詳細: ${detail}）`;
  }
  const text = code ? EXPLAIN[code] : undefined;
  if (!text) return code ? `${detail} (${code})` : detail;
  return `${text}（詳細: ${detail}）`;
}
