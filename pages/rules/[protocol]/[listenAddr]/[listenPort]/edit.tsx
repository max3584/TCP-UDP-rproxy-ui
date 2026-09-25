// ルールの変更（/rules/{protocol}/{listen_addr}/{listen_port}/edit）
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import RuleForm from '@/components/RuleForm';
import type { ForwardRule } from '@/components/lib';
import { hostPort, parseRuleKey, portsLabel, ruleHref, toRule } from '@/components/dashboard';
import { ErrorBanner, goBack, postRule, useRule } from '@/components/ui';

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
      await postRule('modify', data);
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
      {initial && key && (
        <RuleForm
          initialData={initial}
          submitting={submitting}
          onSubmit={handleSubmit}
          onCancel={() => goBack(router, ruleHref(key))}
        />
      )}
    </div>
  );
};

export default EditRulePage;
