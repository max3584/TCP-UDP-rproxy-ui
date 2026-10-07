// API のエラーコードを、利用者向けの説明に直す（tests/listen.test.ts）

// 固定ルール（rproxy の --static-rules のファイルにあるルール）は API から変更・削除できない（409 static）
export const STATIC_RULE_MESSAGE = '固定ルールは rproxy の設定ファイルで管理されているため、画面からは変更・削除できません。';
// 詳細画面で、編集・削除のボタンの代わりに出す
export const STATIC_RULE_NOTE = '固定ルール（rproxy の設定ファイルで管理）';

// ACME の証明書（tls.certificates[].acme）を、ACME に対応していない rproxy（GET /capabilities の features.acme が false。v0.3.21 より前）で見たとき
export const ACME_UNSUPPORTED_NOTE =
  'この rproxy は ACME に対応していないため、この証明書は使えません（rproxy-api v0.3.21 以降が必要です）。設定はそのまま保たれます。rproxy を上げるか、certbot などで取得した証明書のファイルを指定してください。';

// rproxy は ACME に対応しているが、設定ファイルに global.acme がない（GET /acme が 404）
export const ACME_NOT_CONFIGURED_NOTE =
  'この rproxy の設定ファイル（RPROXY_CONFIG）に global.acme がないため、ACME の証明書は使えません。アカウント・resolver・取ってよい名前（allowed_names）は rproxy の設定ファイルにだけ書けます（画面からは作れません）。';

// ACME の証明書を使うルールの作成・変更に、UI のトークンの acme:write のスコープが足りない（rproxy の 403）
export const ACME_SCOPE_MESSAGE =
  'UI が使う rproxy のトークンに acme:write のスコープがありません。ACME の証明書を使うルールの作成・変更には、rules:write に加えて acme:write が要ります。rproxy のトークンファイルで UI のトークンに acme:write を足してください。';

// rproxy が ACME の証明書の設定を断った理由（rproxy の src/acme/config.rs・registry.rs の文）を、利用者向けの説明にする。
// 当てはまらなければ null
export function explainAcme(detail: string): string | null {
  let m: RegExpExecArray | null;
  if (/acme:write/.test(detail)) return ACME_SCOPE_MESSAGE;
  if ((m = /acme domains: "([^"]+)" is not in allowed_names of account "([^"]+)"/.exec(detail))) {
    return `名前 ${m[1]} は、ACME のアカウント ${m[2]} で取ってよい名前（rproxy の設定ファイルの global.acme の allowed_names）に含まれていません。名前を直すか、rproxy の管理者に allowed_names へ足してもらってください。`;
  }
  if ((m = /acme domains: "([^"]+)" is not in allowed_names of dns provider "([^"]+)"/.exec(detail))) {
    return `名前 ${m[1]} は、DNS のプロバイダ ${m[2]} で証明してよい名前（rproxy の設定ファイルの global.acme の allowed_names）に含まれていません。名前を直すか、rproxy の管理者に allowed_names へ足してもらってください。`;
  }
  if ((m = /acme domains: the wildcard "([^"]+)" needs a resolver with challenge dns-01/.exec(detail))) {
    return `ワイルドカード ${m[1]} は、challenge が dns-01 の resolver でだけ取れます。dns-01 の resolver を選んでください。`;
  }
  if ((m = /acme domains: "([^"]+)" is not a host name/.exec(detail))) {
    return `${m[1]} は証明書に入れられるホスト名ではありません（例: www.example.com、*.example.com）。`;
  }
  if ((m = /acme resolver "([^"]+)": global\.acme is not configured/.exec(detail))) {
    return ACME_NOT_CONFIGURED_NOTE;
  }
  if ((m = /acme resolver "([^"]+)" is not defined/.exec(detail))) {
    return `resolver ${m[1]} は rproxy の設定ファイル（global.acme.resolvers）にありません。`;
  }
  if (/acme certificates are for tcp rules/.test(detail)) {
    return 'ACME の証明書は TCP のルールでだけ使えます（DTLS では証明書のファイルを指定してください）。';
  }
  if (/an acme certificate holds at most/.test(detail)) {
    return 'ACME の証明書に入れられる名前は 100 個までです。';
  }
  if (/an acme certificate needs at least one name/.test(detail)) {
    return 'ACME の証明書には名前を 1 つ以上指定してください。';
  }
  return null;
}

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

// rproxy が UI の送信元を 429 locked_out で断ったとき（rproxy v0.4 の api_lockout、#167）：UI のトークン・証明書で認証に失敗し続けたので、
// rproxy がこの UI の IP を一時的に止めている。利用者の操作の問題ではないので code は rproxy_locked_out にする
export const RPROXY_LOCKED_OUT_MESSAGE =
  'rproxy が UI からの問い合わせを一時的に止めています（認証の失敗が続いたため）。UI サーバの RPROXY_API_TOKEN・クライアント証明書が rproxy のトークンファイルと合っているかを確かめてください。止める時間が過ぎると自動で解けます。';

// 何秒後に解けるか（rproxy の Retry-After）を添える
export function lockedOutText(retryAfter?: number): string {
  return retryAfter !== undefined ? `${RPROXY_LOCKED_OUT_MESSAGE}（あと約 ${retryAfter} 秒）` : RPROXY_LOCKED_OUT_MESSAGE;
}

// 証明書・秘密鍵・CA・秘密（htpasswd など）のファイルの持ち主（セキュリティレビュー M2）：rproxy は、rproxy を動かす OS のユーザー
// （パッケージでは rproxy-api）が持つファイルだけを読む。ほかの利用者の鍵のパスを書いて、その身元で接続・待ち受けできないように
export const FILE_OWNER_NOTE =
  'ファイルのパスは rproxy のホストのものです。rproxy は、rproxy を動かす OS のユーザー（rproxy-api）が持つファイルだけを読みます（グループ rproxy の読み取りは構いません）。ほかのユーザーが持つファイルを指定すると、rproxy が断ります。';

export const FILE_OWNER_MESSAGE =
  'rproxy は、証明書・秘密鍵・CA・秘密のファイルを、rproxy を動かす OS のユーザー（rproxy-api）が持ち、グループとほかの人が書けないものだけ読みます（秘密鍵・秘密はほかの人が読めないことも）。ファイルの持ち主を rproxy-api、グループを rproxy にし、グループとほかの人の書き込みを外してください（例: chown rproxy-api:rproxy <ファイル>、chmod 0640 <ファイル>。秘密鍵・秘密は 0600 か 0640）。シンボリックリンクは rproxy-api か root が持つものだけ使えます。ファイルを置けない・変えられない場合は rproxy の管理者に相談してください。';

// rproxy がファイルの持ち主・モードを理由に断ったか（rproxy-api の src/net/files.rs の文）：
// "<path> is owned by uid N, not by the user rproxy runs as (uid M): ..."、"<path> is a symbolic link owned by uid N, not rproxy's (uid M) or root"、
// "<path> may be written by the group or others (mode O): chmod g-w,o-w"、"<path> holds a key or secret and may be read by anyone (mode O): chmod o-r (0600 or 0640)"
export function isFileOwnerRefusal(detail: string): boolean {
  return /\b(not owned by|must be owned by|is owned by|owned by (uid|user|another))\b/i.test(detail)
    || /may be written by the group or others|may be read by anyone/i.test(detail);
}

// ルールの組（ruleset。k8s のコントローラなど）に属するルールは、個別に変えられない（rproxy の 409 owned。v0.4）
export const OWNED_RULE_MESSAGE =
  'このルールは rproxy のルールの組（ruleset）に属しているため、画面からは変更・削除できません。組を管理しているもの（Kubernetes のコントローラなど）で変えてください。';

// 同じキーを rproxy では API で作ったルール・ルールの組のルールが使っている（409 shadowed）。UI のルールの変更をそのまま送ると、
// そのルールを書き換えたり消したりしてしまうので UI が断る
export const SHADOWED_RULE_MESSAGE =
  '同じキーを rproxy では API で作ったルールかルールの組のルールが使っているため、この UI のルールの変更・再開・送り直しは rproxy に送れません。停止・削除は UI のルールだけを変えます。API のルールを消すか、キーを変えるよう管理者に相談してください。';

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
  rproxy_locked_out: RPROXY_LOCKED_OUT_MESSAGE,
  locked_out: RPROXY_LOCKED_OUT_MESSAGE,
  owned: OWNED_RULE_MESSAGE,
  shadowed: SHADOWED_RULE_MESSAGE,
  csrf: 'ほかのサイトからの変更の要求は受け付けません。この画面を開き直してから操作してください。',
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
  if (isFileOwnerRefusal(error)) return `${FILE_OWNER_MESSAGE}（詳細: ${error}）`;
  return /certificate expired/i.test(error) ? `${CERT_EXPIRED_MESSAGE}（詳細: ${error}）` : error;
}

export function explainError(code: string | undefined, detail: string): string {
  if (/certificate expired/i.test(detail)) {
    return `${CERT_EXPIRED_MESSAGE}（詳細: ${detail}）`;
  }
  // ACME の証明書の許可の外の名前・resolver・スコープ（rproxy の 400 invalid / tls_config、403 forbidden）
  if (/acme/i.test(detail)) {
    if (code === 'unsupported') return `${ACME_UNSUPPORTED_NOTE}（詳細: ${detail}）`;
    const acme = explainAcme(detail);
    if (acme) return `${acme}（詳細: ${detail}）`;
  }
  // v0.3.7 以前の rproxy は UDP の sni を断る（"sni routing is supported for tcp only; use terminate for DTLS"）
  if (code === 'unsupported' && /sni routing is supported for tcp only/i.test(detail)) {
    return `${UDP_SNI_OLD_RPROXY}（詳細: ${detail}）`;
  }
  // rproxy がファイルの持ち主で断った（M2。rproxy-api はほかのユーザーのファイルを読まない）
  if (isFileOwnerRefusal(detail)) {
    return `${FILE_OWNER_MESSAGE}（詳細: ${detail}）`;
  }
  if (code === 'bind_failed' && /Permission denied|os error 13/.test(detail)) {
    return `${PRIVILEGED_PORT}（詳細: ${detail}）`;
  }
  const text = code ? EXPLAIN[code] : undefined;
  if (!text) return code ? `${detail} (${code})` : detail;
  if (detail === text) return text;
  return `${text}（詳細: ${detail}）`;
}
