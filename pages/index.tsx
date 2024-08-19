import { useState, useEffect } from 'react';
import Modal from '@/components/Modal';
import { ForwardRules, ForwardRule } from '@/components/lib';


interface FetchResult {
  message?: string | null;
  error?: string | null;
}

const IndexPage: React.FC = () => {
  const [rules, setRules] = useState<ForwardRules[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ForwardRule | null>(null);
  const [editRule, setEditRule] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleAddRule = async (rule: ForwardRule) => {
    let latestId = rules.slice(-1)[0]?.id || 0;
    let newRule: ForwardRules = {
      id: latestId + 1,
      protocol: rule.protocol,
      srcAddr: rule.srcAddr,
      srcPort: rule.srcPort,
      distAddr: rule.distAddr,
      distPort: rule.distPort
    };
    let option = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(rule)
    }
    let res = await fetch('/api/forward/add', option);
    if (!res.ok) {
      let result: FetchResult = await res.json();
      if (result.error === null || result.error === undefined || result.error !== '') {
        console.log(result.error);
      } else {
        setRules([...rules, newRule]);
        setShowModal(false);
        fetch
      }
    }
    setLoading(!loading);
  };

  const handleDeleteRule = async (id: number) => {
    let t: any = rules.find(rule => rule.id === id);
    let rule: ForwardRule = {
      protocol: t.protocol,
      srcAddr: t.srcAddr,
      srcPort: t.srcPort,
      distAddr: t.distAddr,
      distPort: t.distPort
    };

    let option = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(rule)
    }
    let res = await fetch('/api/forward/delete', option);
    if (!res.ok) {
      let result: FetchResult = await res.json();
      if (result.error === null || result.error === undefined || result.error !== '') {
        console.log(result.error);
      }
    }
    setRules(rules.filter(rule => rule.id !== id));
    setLoading(!loading);
  };

  const handleModifyRule = (rule: ForwardRules) => {
    let editRule: ForwardRule = {
      protocol: rule.protocol,
      srcAddr: rule.srcAddr,
      srcPort: rule.srcPort,
      distAddr: rule.distAddr,
      distPort: rule.distPort
    }
    setEditingRule(editRule);
    setEditRule(true);
    setShowModal(true);
  };

  const handleEditRule = async (rule: ForwardRule) => {
    let newRule: ForwardRules = {
      id: rules.map((rule) => {if (rule.srcAddr == editingRule?.srcAddr && rule.srcPort == editingRule?.srcPort) return rule?.id;})[0] || 0,
      protocol: rule.protocol,
      srcAddr: rule.srcAddr,
      srcPort: rule.srcPort,
      distAddr: rule.distAddr,
      distPort: rule.distPort
    };
    rules.find
    let option = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(rule)
    }
    let res = await fetch('/api/forward/modify', option);
    if (!res.ok) {
      let result: FetchResult = await res.json();
      if (result.error === null || result.error === undefined || result.error !== '') {
        console.log(result.error);
      } else {
        let newRules = rules.map(rule => rule.id === newRule.id ? newRule : rule);
        setRules(newRules);
        setShowModal(false);
      }
    }
    setLoading(!loading);
  }

  useEffect(() => {
    const getlist = async (): Promise<void> => {
      let res = await fetch('/api/forward/list');
      let data: ForwardRule[] = await res.json();
      if (data.length > 0) {
        let index = 0;
        let rules: Array<ForwardRules> = [];
        for (const rule of data) {
          rules.push({
            id: index++,
            protocol: rule.protocol,
            srcAddr: rule.srcAddr,
            srcPort: rule.srcPort,
            distAddr: rule.distAddr,
            distPort: rule.distPort
          })
        }
        setRules(rules);
      }
    }

    getlist();
  }, [loading]);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">TCP/UDP Forwarding Dashboard</h1>
      <button
        onClick={() => {
          setEditingRule(null);
          setEditRule(false);
          setShowModal(true);
        }}
        className="bg-blue-500 text-white px-4 py-2 rounded mb-4"
      >
        New Forward
      </button>
      <div className="space-y-4">
        {rules.map((rule) => (
          <div key={rule.id} className="border p-4 rounded shadow-sm flex items-center justify-between">
            <div>
              <p><strong>Protocol:</strong> {rule.protocol}</p>
              <p><strong>Source:</strong> {rule.srcAddr}:{rule.srcPort}</p>
              <p><strong>Destination:</strong> {rule.distAddr}:{rule.distPort}</p>
            </div>
            <div className="flex space-x-2">
              <button
                onClick={() => handleModifyRule(rule)}
                className="bg-yellow-500 text-white px-4 py-2 rounded"
              >
                Modify
              </button>
              <button
                onClick={() => handleDeleteRule(rule.id)}
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
          onSubmit={editRule ? handleEditRule : handleAddRule}
          initialData={editingRule}
        />
      )}
    </div>
  );
};

export default IndexPage;
