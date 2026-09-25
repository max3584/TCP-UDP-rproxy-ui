import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/Modal';
import { ForwardRules, ForwardRule, RuleState } from '@/components/lib';


interface FetchResult {
  message?: string | null;
  error?: string | null;
  code?: string | null;
}

type Action = 'add' | 'modify' | 'delete';

const ACTION_LABELS: Record<Action, string> = {
  add: '追加',
  modify: '変更',
  delete: '削除',
};

const STATE_STYLES: Record<RuleState, { label: string; className: string }> = {
  running: { label: 'running', className: 'bg-green-100 text-green-800' },
  failed: { label: 'failed', className: 'bg-red-100 text-red-800' },
  missing: { label: 'missing', className: 'bg-yellow-100 text-yellow-800' },
  unknown: { label: 'unknown', className: 'bg-gray-200 text-gray-700' },
};

const toRule = (rule: ForwardRule): ForwardRule => ({
  protocol: rule.protocol,
  srcAddr: rule.srcAddr,
  srcPort: rule.srcPort,
  distAddr: rule.distAddr,
  distPort: rule.distPort,
  sourceIp: rule.sourceIp,
  udpIdleSecs: rule.udpIdleSecs,
});

const IndexPage: React.FC = () => {
  const [rules, setRules] = useState<ForwardRules[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ForwardRule | null>(null);
  const [error, setError] = useState('');

  const getlist = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/forward/list');
      const data = await res.json();
      if (!res.ok) {
        setError(`ルール一覧を取得できませんでした: ${(data as FetchResult).error || res.statusText}`);
        return;
      }
      setRules(data as ForwardRules[]);
    } catch (err) {
      setError(`ルール一覧を取得できませんでした: ${err instanceof Error ? err.message : err}`);
    }
  }, []);

  const sendRule = async (action: Action, rule: ForwardRule): Promise<void> => {
    setError('');
    try {
      const res = await fetch(`/api/forward/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(toRule(rule))
      });
      if (!res.ok) {
        const result: FetchResult = await res.json().catch(() => ({}));
        const detail = result.error || res.statusText;
        setError(`ルールの${ACTION_LABELS[action]}に失敗しました: ${detail}${result.code ? ` (${result.code})` : ''}`);
      }
    } catch (err) {
      setError(`ルールの${ACTION_LABELS[action]}に失敗しました: ${err instanceof Error ? err.message : err}`);
    }
    await getlist();
  };

  const handleAddRule = (rule: ForwardRule) => sendRule('add', rule);
  const handleEditRule = (rule: ForwardRule) => sendRule('modify', rule);
  const handleDeleteRule = (rule: ForwardRules) => sendRule('delete', rule);

  const handleModifyRule = (rule: ForwardRules) => {
    setEditingRule(toRule(rule));
    setShowModal(true);
  };

  useEffect(() => {
    getlist();
  }, [getlist]);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">TCP/UDP Forwarding Dashboard</h1>
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 flex justify-between items-start">
          <span className="break-all">{error}</span>
          <button onClick={() => setError('')} className="ml-4 font-bold" aria-label="close">×</button>
        </div>
      )}
      <button
        onClick={() => {
          setEditingRule(null);
          setShowModal(true);
        }}
        className="bg-blue-500 text-white px-4 py-2 rounded mb-4"
      >
        New Forward
      </button>
      <div className="space-y-4">
        {rules.map((rule) => (
          <div key={rule.id} className="bg-white text-gray-900 border p-4 rounded shadow-sm flex items-center justify-between">
            <div>
              <p>
                <strong>Protocol:</strong> {rule.protocol}
                <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${STATE_STYLES[rule.state].className}`}>
                  {STATE_STYLES[rule.state].label}
                </span>
                {rule.connections !== null && (
                  <span className="ml-2 text-xs text-gray-600">
                    {rule.protocol === 'udp' ? 'sessions' : 'connections'}: {rule.connections}
                  </span>
                )}
              </p>
              <p><strong>Source:</strong> {rule.srcAddr}:{rule.srcPort}</p>
              <p><strong>Destination:</strong> {rule.distAddr}:{rule.distPort}</p>
              <p className="text-sm text-gray-600">
                source_ip: {rule.sourceIp}
                {rule.protocol === 'udp' && <> / udp_idle_secs: {rule.udpIdleSecs}</>}
              </p>
              {rule.error && <p className="text-sm text-red-600 break-all">{rule.error}</p>}
              {rule.state === 'missing' && (
                <p className="text-sm text-yellow-700">rproxy でこのルールが動いていません。</p>
              )}
            </div>
            <div className="flex space-x-2">
              <button
                onClick={() => handleModifyRule(rule)}
                className="bg-yellow-500 text-white px-4 py-2 rounded"
              >
                Modify
              </button>
              <button
                onClick={() => handleDeleteRule(rule)}
                className="bg-red-500 text-white px-4 py-2 rounded"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <Modal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSubmit={editingRule ? handleEditRule : handleAddRule}
          initialData={editingRule}
        />
      )}
    </div>
  );
};

export default IndexPage;
