// ルールの追加（/rules/new）
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import RuleForm from '@/components/RuleForm';
import type { ForwardRule } from '@/components/lib';
import { ruleHref, ruleKeyOf } from '@/components/dashboard';
import { ErrorBanner, goBack, postRule } from '@/components/ui';

const NewRulePage: React.FC = () => {
  const router = useRouter();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (rule: ForwardRule) => {
    setSubmitting(true);
    setError('');
    try {
      await postRule('add', rule);
      await router.push(ruleHref(ruleKeyOf(rule)));
    } catch (err) {
      setError(`ルールの追加に失敗しました: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <nav aria-label="パンくず" className="text-sm text-gray-700">
        <Link href="/" className="link">ダッシュボード</Link>
        <span aria-hidden="true" className="mx-2">/</span>
        <span>新規ルール</span>
      </nav>
      <h1 className="text-2xl font-bold text-gray-900">新規ルール</h1>
      {error && <ErrorBanner message={error} onClose={() => setError('')} />}
      <RuleForm submitting={submitting} onSubmit={handleSubmit} onCancel={() => goBack(router, '/')} />
    </div>
  );
};

export default NewRulePage;
