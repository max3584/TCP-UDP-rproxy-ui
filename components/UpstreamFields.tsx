import React from 'react';
import type { TlsUpstream } from './lib';

// 転送先への TLS の欄（検証するサーバ名・CA・検証しない・クライアント証明書とその中間 CA・秘密鍵）。
// ルールの tls.upstream と、サーバ名ごとの tls.routes[].upstream（rproxy-api v0.4.7、BackendTLSPolicy）で同じ部品を使う

// 3 階層以上の PKI でも使えるように、中間 CA の欄は常に表示する
export const CHAIN_HELP = '中間 CA（サーバ証明書を発行した CA からルートへ向かう順。ルートは不要）';

// サーバ名ごとの転送先への TLS（tls.routes[].upstream、rproxy-api v0.4.7。rproxy-gateway が BackendTLSPolicy から作る）の説明
export const ROUTE_UPSTREAM_HELP =
  '「転送先への TLS」は、その名前の転送先へ rproxy から TLS でつなぐかと、そのときの検証です（ルールと同じなら「ルールと同じ」のまま）。指定した名前では、下の「転送先へ TLS で再暗号化する」の代わりにその設定を使います（項目ごとには混ぜません）。rproxy が終端する名前（「終端しない」にしていない名前）にだけ指定できます。ファイルはルールを保存したときに rproxy が読みます。';

// 欄の値（空欄は省いて送る。tls は欄の外で選ぶ）
export interface UpstreamForm {
  server_name: string;
  ca_file: string;
  insecure_skip_verify: boolean;
  cert_file: string;
  chain_file: string;
  key_file: string;
}

export const EMPTY_UPSTREAM_FORM: UpstreamForm = {
  server_name: '', ca_file: '', insecure_skip_verify: false, cert_file: '', chain_file: '', key_file: '',
};

export function toUpstreamForm(u: TlsUpstream | undefined): UpstreamForm {
  return {
    server_name: u?.server_name ?? '',
    ca_file: u?.ca_file ?? '',
    insecure_skip_verify: u?.insecure_skip_verify ?? false,
    cert_file: u?.cert_file ?? '',
    chain_file: u?.chain_file ?? '',
    key_file: u?.key_file ?? '',
  };
}

// 欄に値があるか（tls: false でも欄に値があれば、隠さずに出す）
export function upstreamFormUsed(f: UpstreamForm): boolean {
  return f.insecure_skip_verify || [f.server_name, f.ca_file, f.cert_file, f.chain_file, f.key_file].some((v) => v !== '');
}

// 送る形（normalizeTls の前。空欄は normalizeTls が省く）
export function upstreamSpec(tls: boolean, f: UpstreamForm): Record<string, unknown> {
  return { tls: tls, ...f };
}

// 読み取り専用の注記に出す短い説明
export function upstreamSummary(u: TlsUpstream): string {
  const parts: string[] = [u.tls ? 'tls: true' : 'tls: false'];
  if (u.server_name) parts.push(`server_name: ${u.server_name}`);
  if (u.ca_file) parts.push(`ca_file: ${u.ca_file}`);
  if (u.insecure_skip_verify) parts.push('insecure_skip_verify: true');
  if (u.cert_file) parts.push(`cert_file: ${u.cert_file}`);
  if (u.chain_file) parts.push(`chain_file: ${u.chain_file}`);
  if (u.key_file) parts.push(`key_file: ${u.key_file}`);
  return parts.join(', ');
}

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const fieldLabelClass = 'block text-xs font-medium text-gray-800';
const helpClass = 'mt-1 text-xs text-gray-600';

// idPrefix はルールでは rule-upstream、route では rule-route-<n>-upstream（欄の id とラベルの htmlFor）
const UpstreamFields: React.FC<{
  idPrefix: string;
  value: UpstreamForm;
  onChange: (patch: Partial<UpstreamForm>) => void;
}> = ({ idPrefix, value, onChange }) => (
  <div className="mt-2 space-y-2 border-l-2 border-gray-300 pl-3" data-testid={`${idPrefix}-fields`}>
    <div>
      <label htmlFor={`${idPrefix}-name`} className={fieldLabelClass}>検証するサーバ名</label>
      <input id={`${idPrefix}-name`} type="text" value={value.server_name} onChange={(e) => onChange({ server_name: e.target.value.trim() })}
        className={inputClass} placeholder="空欄なら転送先のホスト名" />
    </div>
    <div>
      <label htmlFor={`${idPrefix}-ca`} className={fieldLabelClass}>CA ファイル</label>
      <input id={`${idPrefix}-ca`} type="text" value={value.ca_file} onChange={(e) => onChange({ ca_file: e.target.value.trim() })}
        className={inputClass} placeholder="空欄なら Mozilla のルート証明書" />
    </div>
    <label htmlFor={`${idPrefix}-insecure`} className="inline-flex items-center text-sm text-gray-800">
      <input id={`${idPrefix}-insecure`} type="checkbox" checked={value.insecure_skip_verify}
        onChange={(e) => onChange({ insecure_skip_verify: e.target.checked })} className="mr-2" />
      転送先の証明書を検証しない（テスト用）
    </label>
    <div>
      <label htmlFor={`${idPrefix}-cert`} className={fieldLabelClass}>転送先へのクライアント証明書（任意）</label>
      <input id={`${idPrefix}-cert`} type="text" value={value.cert_file} onChange={(e) => onChange({ cert_file: e.target.value.trim() })}
        className={inputClass} placeholder="例: /etc/rproxy/upstream-client.pem" />
    </div>
    <div>
      <label htmlFor={`${idPrefix}-chain`} className={fieldLabelClass}>その中間 CA（任意）</label>
      <input id={`${idPrefix}-chain`} type="text" value={value.chain_file} onChange={(e) => onChange({ chain_file: e.target.value.trim() })}
        className={inputClass} placeholder="例: /etc/rproxy/upstream-intermediates.pem" aria-describedby={`${idPrefix}-chain-help`} />
      <p id={`${idPrefix}-chain-help`} className={helpClass}>{CHAIN_HELP}。クライアント証明書を指定したときだけ使えます。</p>
    </div>
    <div>
      <label htmlFor={`${idPrefix}-key`} className={fieldLabelClass}>その秘密鍵</label>
      <input id={`${idPrefix}-key`} type="text" value={value.key_file} onChange={(e) => onChange({ key_file: e.target.value.trim() })}
        className={inputClass} placeholder="例: /etc/rproxy/upstream-client.key" />
    </div>
  </div>
);

export default UpstreamFields;
