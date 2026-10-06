// API のエラーコードを、利用者向けの説明に直す（tests/listen.test.ts）

// 固定ルール（rproxy の --static-rules のファイルにあるルール）は API から変更・削除できない（409 static）
export const STATIC_RULE_MESSAGE = '固定ルールは rproxy の設定ファイルで管理されているため、画面からは変更・削除できません。';
// 詳細画面で、編集・削除のボタンの代わりに出す
export const STATIC_RULE_NOTE = '固定ルール（rproxy の設定ファイルで管理）';

// ACME の証明書（tls.certificates[].acme）。rproxy は ACME を内蔵しない方針にしたので、常に unsupported で動かない
export const ACME_UNSUPPORTED_NOTE =
  'この rproxy では使えない設定です（ACME は rproxy に内蔵していません）。certbot や cert-manager で取得した証明書のファイルを指定してください。ファイルが更新されると rproxy が自動で読み直します。';

// rproxy が UI のトークンを 403 forbidden で断ったとき（トークンのスコープか、変更できる待ち受けポートの範囲の外）
export const FORBIDDEN_MESSAGE =
  'UI が使う rproxy のトークンに、この操作の権限がありません。rproxy のトークンファイルで、UI のトークンに rules:read と rules:write のスコープがあるか、allow_listen_ports にこの待ち受けポートが含まれるかを確認してください。';

// rproxy-user / rproxy-admin のロールがない利用者（API は 403 no_role、画面は RequireAuth が出す）
export const NO_ROLE_MESSAGE =
  'rproxy の管理画面を使う権限がありません。管理者に rproxy-user（または rproxy-admin）のロールを付けてもらってください。';

// rproxy が UI のトークンを 401 unauthorized で断ったとき（RPROXY_API_TOKEN の誤りか期限切れ）。
// 利用者のサインインの問題ではないので、code は rproxy_unauthorized にして区別する
export const RPROXY_UNAUTHORIZED_MESSAGE =
  'rproxy が UI のトークンを受け付けませんでした。UI サーバの RPROXY_API_TOKEN が rproxy のトークンファイルにあるか、期限（expires）が切れていないかを確認してください。';

const EXPLAIN: Record<string, string> = {
  resolve_failed: '転送先のホスト名を名前解決できませんでした。DNS に登録されているか、ホスト名の綴りを確認してください（IP アドレスでも指定できます）。',
  bind_failed: '待ち受けポートを開けませんでした。ほかのプログラムがそのポートを使っていないか確認してください。',
  reserved: 'rproxy 自身の制御 API が使っているアドレスとポートです。別のポートを選んでください。',
  already_exists: '同じプロトコル・アドレス・ポート（または重なるポート範囲）のルールが既にあります。',
  tls_config: 'TLS の設定に問題があります。証明書・中間 CA・秘密鍵のパスと内容を確認してください。',
  unreachable: 'rproxy に接続できませんでした。rproxy が起動しているか確認してください。',
  unauthorized: 'ログインし直してください。',
  static: STATIC_RULE_MESSAGE,
  forbidden: FORBIDDEN_MESSAGE,
  rproxy_unauthorized: RPROXY_UNAUTHORIZED_MESSAGE,
  no_role: NO_ROLE_MESSAGE,
  port_not_allowed: 'この待ち受けポートは管理者だけが使えます。',
};

// 1024 未満のポートは、rproxy に CAP_NET_BIND_SERVICE がないと開けない
const PRIVILEGED_PORT =
  '1024 未満のポートを開く権限が rproxy にありません。1024 以上のポートを使うか、rproxy に CAP_NET_BIND_SERVICE を付けてください（setcap cap_net_bind_service=+ep、systemd なら AmbientCapabilities=CAP_NET_BIND_SERVICE）。';

// UDP の sni（DTLS・QUIC のサーバ名での振り分け）を古い rproxy が断ったとき
export const UDP_SNI_OLD_RPROXY =
  'この rproxy は UDP の sni（DTLS・QUIC のサーバ名での振り分け）に対応していません。rproxy を v0.3.8 以降に上げるか、TLS のモードを passthrough か終端（DTLS）にしてください。';

// rproxy がサーバ証明書の期限切れで断った・止めたとき（error は "certificate expired: ..."）
export const CERT_EXPIRED_MESSAGE =
  'サーバ証明書の期限が切れています。certbot / cert-manager などで証明書を更新してください。ファイルが更新されると rproxy が自動で読み直し、ルールは元に戻ります。';

// ルールの error（rproxy の failed の理由）を画面に出す文にする。証明書の期限切れは対処を添える
export function ruleErrorText(error: string): string {
  return /certificate expired/i.test(error) ? `${CERT_EXPIRED_MESSAGE}（詳細: ${error}）` : error;
}

export function explainError(code: string | undefined, detail: string): string {
  if (/certificate expired/i.test(detail)) {
    return `${CERT_EXPIRED_MESSAGE}（詳細: ${detail}）`;
  }
  // v0.3.7 以前の rproxy は UDP の sni を断る（"sni routing is supported for tcp only; use terminate for DTLS"）
  if (code === 'unsupported' && /sni routing is supported for tcp only/i.test(detail)) {
    return `${UDP_SNI_OLD_RPROXY}（詳細: ${detail}）`;
  }
  if (code === 'bind_failed' && /Permission denied|os error 13/.test(detail)) {
    return `${PRIVILEGED_PORT}（詳細: ${detail}）`;
  }
  const text = code ? EXPLAIN[code] : undefined;
  if (!text) return code ? `${detail} (${code})` : detail;
  if (detail === text) return text;
  return `${text}（詳細: ${detail}）`;
}
