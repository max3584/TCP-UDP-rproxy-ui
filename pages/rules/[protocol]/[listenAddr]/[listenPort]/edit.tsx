// ルールの変更（/rules/{protocol}/{listen_addr}/{listen_port}/edit）
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import RuleForm from '@/components/RuleForm';
import type { ForwardRule } from '@/components/lib';
import { hostPort, parseRuleKey, portsLabel, ruleHref, toRule } from '@/components/dashboard';
import { ErrorBanner, goBack, postPlan, postRule, useRule } from '@/components/ui';
import { t } from '@/i18n/core';
import { OWNED_RULE_MESSAGE, STATIC_RULE_MESSAGE } from '@/components/messages';

const EditRulePage: React.FC = () => {
  const router = useRouter();
  const key = useMemo(() => (router.isReady ? parseRuleKey(router.query) : null), [router.isReady, router.query]);
  const { rule, error: loadError, notFound } = useRule(key);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 読み込んだ時点の内容でフォームを作る（あとで取得し直しても入力中の内容は消さない）
  const initial = useMemo(() => (rule ? toRule(rule) : null), [rule]);

  if (router.isReady && key === null) {
    return <ErrorBanner message="URL が正しくありません（/rules/{tcp|udp}/{待ち受けアドレス}/{ポート}/edit）。" />;
  }

  const handleSubmit = async (data: ForwardRule) => {
    if (!key) return;
    setSubmitting(true);
    setError('');
    try {
      // rproxy の API のルール（UI の DB にない）は rproxy の PATCH で変える
      if (rule?.origin === 'api') {
        const out = await postRule('api-modify', { ...data, target: rule.target });
        if (typeof out.warning === 'string') window.alert(t(out.warning));
      } else {
        await postRule('modify', data);
      }
      await router.push(ruleHref(key));
    } catch (err) {
      setError(`ルールの変更に失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        {key && <Link href={ruleHref(key)} className="link">ルールの詳細</Link>}
        <span aria-hidden="true" className="mx-2">/</span>
        <span>編集</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900 break-all">
        ルールの変更{key && rule && <span className="ml-2 font-mono text-xl">{key.protocol.toUpperCase()} {hostPort(key.addr, portsLabel(rule.srcPort, rule.srcPortEnd))}</span>}
      </h1>
      {loadError && <ErrorBanner message={loadError} />}
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      {notFound && (
        <div className="card p-4 text-gray-900">
          <p>このルールは見つかりません（削除されたか、ほかの利用者のルールです）。</p>
          <Link href="/" className="link">ダッシュボードへ戻る</Link>
        </div>
      )}
      {!initial && !notFound && !loadError && <p className="text-gray-700">読み込み中…</p>}
      {rule && key && rule.origin === 'static' && (
        <div className="card p-4 text-gray-900">
          <p>{STATIC_RULE_MESSAGE}</p>
          <Link href={ruleHref(key)} className="link">ルールの詳細へ戻る</Link>
        </div>
      )}
      {rule && key && rule.origin === 'api' && rule.ruleset && (
        <div className="card p-4 text-gray-900">
          <p>{OWNED_RULE_MESSAGE}</p>
          <Link href={ruleHref(key)} className="link">ルールの詳細へ戻る</Link>
        </div>
      )}
      {rule?.origin === 'api' && !rule.ruleset && (
        <p className="text-sm text-gray-800 rounded-sm border border-teal-300 bg-teal-50 px-3 py-2" data-testid="api-edit-note">
          rproxy の API で作ったルールです。保存すると rproxy の API で変えます（UI の DB には入らず、履歴にも残りません）。
        </p>
      )}
      {initial && key && rule?.origin !== 'static' && !(rule?.origin === 'api' && rule.ruleset) && (
        <RuleForm
          initialData={initial}
          submitting={submitting}
          onSubmit={handleSubmit}
          onPlan={(r) => (rule?.origin === 'api' ? postPlan('api-modify', { ...r, target: rule.target }) : postPlan('modify', r))}
          onCancel={() => goBack(router, ruleHref(key))}
        />
      )}
    </div>
  );
};

export default EditRulePage;
