// RuleForm の TLS タブの ACME の証明書の 1 件（resolver と名前）。rproxy が ACME に対応し（features.acme）、
// 設定ファイルに global.acme があるとき（GET /acme）だけ使う。resolver・アカウント・秘密は rproxy の設定ファイルにだけあり、ここでは選ぶだけ
import React from 'react';
import { AcmeInfo, challengeHelp, challengeLabel, checkAcmeNames, splitAcmeDomains } from './acme';

export interface AcmeCertificateRow {
  acme: string;
  // 名前の欄（カンマか空白で区切る）
  domainsText: string;
}

interface Props {
  index: number;
  row: AcmeCertificateRow;
  info: AcmeInfo;
  onChange: (patch: Partial<AcmeCertificateRow>) => void;
  onRemove: () => void;
}

const inputClass = 'border border-gray-300 rounded-sm px-2 py-1 w-full bg-white text-gray-900 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500';
const removeButtonClass = 'text-red-700 hover:text-red-900 text-sm px-1 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500 max-lg:min-h-11 max-lg:min-w-11';

// 行の問題（resolver・名前・ワイルドカードと challenge・allowed_names。rproxy と同じ規則）。なければ null
export function acmeRowProblem(info: AcmeInfo, row: AcmeCertificateRow): string | null {
  return checkAcmeNames(info, row.acme, splitAcmeDomains(row.domainsText));
}

const AcmeCertificateEditor: React.FC<Props> = ({ index, row, info, onChange, onRemove }) => {
  const i = index;
  const resolver = info.resolvers.find((r) => r.name === row.acme);
  const account = resolver ? info.accounts.find((a) => a.name === resolver.account) : undefined;
  const provider = resolver?.dns_provider ? info.dnsProviders.find((p) => p.name === resolver.dns_provider) : undefined;
  const help = resolver ? challengeHelp(resolver.challenge) : null;
  // 入力中は、名前を書き始めてから出す（保存するときは RuleForm が空も確かめる）
  const problem = row.domainsText.trim() === '' ? null : acmeRowProblem(info, row);
  // 設定にない resolver（rproxy の設定ファイルから消えた）も、選んだままにできるように選択肢に残す
  const unknown = row.acme !== '' && !resolver;
  return (
    <div className="border border-gray-300 rounded-sm p-3 mb-2 bg-gray-50 text-gray-900" data-testid="certificate-row">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-semibold text-gray-800">証明書 {i + 1}（ACME）</span>
        <button type="button" onClick={onRemove} className={removeButtonClass} aria-label={`証明書 ${i + 1} を削除`}>削除</button>
      </div>
      <label htmlFor={`rule-cert-${i}-acme`} className="block text-xs font-medium text-gray-800">resolver</label>
      <select id={`rule-cert-${i}-acme`} className={`${inputClass} mb-1`} value={row.acme} onChange={(e) => onChange({ acme: e.target.value })}
        aria-describedby={`rule-cert-${i}-acme-help`}>
        <option value="">（選んでください）</option>
        {info.resolvers.map((r) => (
          <option key={r.name} value={r.name}>{r.name}（{challengeLabel(r.challenge)}）</option>
        ))}
        {unknown && <option value={row.acme}>{row.acme}（設定にない resolver）</option>}
      </select>
      <div id={`rule-cert-${i}-acme-help`} className="mb-2 text-xs text-gray-700 space-y-0.5" data-testid="acme-resolver-help">
        {help && <p>{help}</p>}
        {account && (
          <p>
            取ってよい名前（アカウント <span className="font-mono">{account.name}</span>）: <span className="font-mono break-all">{account.allowed_names.join(', ')}</span>
          </p>
        )}
        {provider && (
          <p>
            DNS のプロバイダ <span className="font-mono">{provider.name}</span>（{provider.type}）で証明してよい名前: <span className="font-mono break-all">{provider.allowed_names.join(', ')}</span>
          </p>
        )}
      </div>
      <label htmlFor={`rule-cert-${i}-domains`} className="block text-xs font-medium text-gray-800">名前（カンマか空白で区切る）</label>
      <input id={`rule-cert-${i}-domains`} type="text" value={row.domainsText} onChange={(e) => onChange({ domainsText: e.target.value })}
        className={inputClass} placeholder="例: example.com, www.example.com" aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `rule-cert-${i}-domains-error` : undefined} />
      {problem && <p id={`rule-cert-${i}-domains-error`} className="text-red-700 text-xs mt-1" data-testid="acme-domains-error">{problem}</p>}
      <p className="mt-1 text-xs text-gray-600">
        取れるまでは、rproxy が自己署名の仮の証明書を返します。取れたら接続を切らずに差し替わり、期限の前に rproxy が更新します。
      </p>
    </div>
  );
};

export default AcmeCertificateEditor;
