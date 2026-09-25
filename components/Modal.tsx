import React, { useState, useEffect, useMemo } from 'react';
import { DEFAULT_UDP_IDLE_SECS, ForwardRule, Protocol, SourceIp, TCP_ONLY_SOURCE_IPS } from './lib';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ForwardRule) => void;
  initialData?: ForwardRule | null;
}

const SOURCE_IP_LABELS: Record<SourceIp, string> = {
  proxy: 'proxy（送信元 IP を引き渡さない）',
  proxy_v1: 'proxy_v1（PROXY protocol v1）',
  proxy_v2: 'proxy_v2（PROXY protocol v2）',
  transparent: 'transparent（透過プロキシ）',
};

const ipv4Pattern = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const ipv6Pattern = /^[0-9A-Fa-f:.]+$/;
const domainPattern = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*$/;

const isIPv4 = (address: string) => ipv4Pattern.test(address);
const isIPv6 = (address: string) => address.includes(':') && ipv6Pattern.test(address);

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, onSubmit, initialData }) => {
  const [protocol, setProtocol] = useState<Protocol>(initialData?.protocol || 'tcp');
  const [srcAddr, setSrcAddr] = useState(initialData?.srcAddr || '');
  const [srcPort, setSrcPort] = useState<number | ''>(initialData?.srcPort || '');
  const [distAddr, setDistAddr] = useState(initialData?.distAddr || '');
  const [distPort, setDistPort] = useState<number | ''>(initialData?.distPort || '');
  const [sourceIp, setSourceIp] = useState<SourceIp>(initialData?.sourceIp || 'proxy');
  const [udpIdleSecs, setUdpIdleSecs] = useState<number | ''>(initialData?.udpIdleSecs || DEFAULT_UDP_IDLE_SECS);
  const [supportedSourceIps, setSupportedSourceIps] = useState<SourceIp[]>(['proxy']);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const editMode = initialData ? true : false;

  const [errors, setErrors] = useState({
    srcAddr: '',
    srcPort: '',
    distAddr: '',
    distPort: '',
    sourceIp: '',
    udpIdleSecs: '',
  });

  useEffect(() => {
    if (initialData) {
      setProtocol(initialData.protocol);
      setSrcAddr(initialData.srcAddr);
      setSrcPort(initialData.srcPort);
      setDistAddr(initialData.distAddr);
      setDistPort(initialData.distPort);
      setSourceIp(initialData.sourceIp);
      setUdpIdleSecs(initialData.udpIdleSecs);
    }
  }, [initialData]);

  useEffect(() => {
    if (editMode) return;
    const getCapabilities = async () => {
      try {
        const res = await fetch('/api/forward/capabilities');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        setSupportedSourceIps(Array.isArray(data.source_ip) && data.source_ip.length > 0 ? data.source_ip : ['proxy']);
      } catch (err) {
        setCapabilitiesError(`rproxy の対応機能を取得できませんでした（proxy のみ選択できます）: ${err instanceof Error ? err.message : err}`);
      }
    };
    getCapabilities();
  }, [editMode]);

  // proxy_v1 / proxy_v2 は TCP のみ、transparent は IPv4 のみ
  const availableSourceIps = useMemo(() => supportedSourceIps.filter((s) => {
    if (protocol === 'udp' && TCP_ONLY_SOURCE_IPS.includes(s)) return false;
    if (s === 'transparent' && isIPv6(srcAddr)) return false;
    return true;
  }), [supportedSourceIps, protocol, srcAddr]);

  useEffect(() => {
    if (!editMode && !availableSourceIps.includes(sourceIp)) {
      setSourceIp('proxy');
    }
  }, [editMode, availableSourceIps, sourceIp]);

  if (!isOpen) return null;

  const validateSrcAddress = (address: string): string => {
    if (isIPv4(address) || isIPv6(address)) {
      return '';
    }
    return 'IP アドレスを指定してください。';
  };

  const validateDistAddress = (address: string): string => {
    if (isIPv4(address) || isIPv6(address) || domainPattern.test(address)) {
      return '';
    }
    return '無効なアドレス形式です。';
  };

  const validatePort = (port: number | ''): string => {
    if (port !== '' && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return '';
    }
    return 'ポート番号は1から65535の範囲で指定してください。';
  };

  const validateUdpIdleSecs = (secs: number | ''): string => {
    if (protocol !== 'udp' || (secs !== '' && Number.isInteger(secs) && secs >= 1 && secs <= 86400)) {
      return '';
    }
    return '1から86400秒の範囲で指定してください。';
  };

  const handleSubmit = () => {
    const newErrors = {
      srcAddr: validateSrcAddress(srcAddr),
      srcPort: validatePort(srcPort),
      distAddr: validateDistAddress(distAddr),
      distPort: validatePort(distPort),
      sourceIp: editMode || availableSourceIps.includes(sourceIp) ? '' : 'この送信元 IP の扱いは選択できません。',
      udpIdleSecs: validateUdpIdleSecs(udpIdleSecs),
    };

    if (Object.values(newErrors).some((e) => e !== '')) {
      setErrors(newErrors);
      return;
    }

    const rule: ForwardRule = {
      protocol: protocol,
      srcAddr: srcAddr,
      srcPort: Number(srcPort),
      distAddr: distAddr,
      distPort: Number(distPort),
      sourceIp: sourceIp,
      udpIdleSecs: protocol === 'udp' ? Number(udpIdleSecs) : DEFAULT_UDP_IDLE_SECS,
    };

    onSubmit(rule);
    onClose();
  };

  const toNumber = (value: string): number | '' => (value === '' ? '' : Number(value));

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="bg-white p-4 rounded shadow-lg w-1/3">
        <h2 className="text-xl mb-4">{editMode ? 'Edit Forward Rule' : 'Add Forward Rule'}</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Protocol:</label>
          {editMode ?
            <input type='text' value={protocol} className='border rounded px-2 py-1 w-full' readOnly /> :
            <select
              className="border rounded px-2 py-1 w-full"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as Protocol)}
            >
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          }
        </div>
        <div className="mb-4">

          <label className="block text-sm font-medium mb-1">Source Address:</label>
          {editMode ?
            <input type='text' value={srcAddr} className='border rounded px-2 py-1 w-full' readOnly /> :
            <input
              type="text"
              value={srcAddr}
              onChange={(e) => setSrcAddr(e.target.value.trim())}
              className="border rounded px-2 py-1 w-full"
              placeholder="例: 0.0.0.0 または ::"
            />
          }
          {errors.srcAddr && <p className="text-red-500 text-xs">{errors.srcAddr}</p>}

        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Source Port:</label>
          {editMode ?
            <input type='number' value={srcPort} className='border rounded px-2 py-1 w-full' readOnly /> :
            <input
              type="number"
              value={srcPort}
              onChange={(e) => setSrcPort(toNumber(e.target.value))}
              className="border rounded px-2 py-1 w-full"
              placeholder="ポート番号（1-65535）"
              min="1"
              max="65535"
            />
          }
          {errors.srcPort && <p className="text-red-500 text-xs">{errors.srcPort}</p>}
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Destination Address:</label>
          <input
            type="text"
            value={distAddr}
            onChange={(e) => setDistAddr(e.target.value.trim())}
            className="border rounded px-2 py-1 w-full"
            placeholder="例: 192.168.1.1 または example.com"
          />
          {errors.distAddr && <p className="text-red-500 text-xs">{errors.distAddr}</p>}
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Destination Port:</label>
          <input
            type="number"
            value={distPort}
            onChange={(e) => setDistPort(toNumber(e.target.value))}
            className="border rounded px-2 py-1 w-full"
            placeholder="ポート番号（1-65535）"
            min="1"
            max="65535"
          />
          {errors.distPort && <p className="text-red-500 text-xs">{errors.distPort}</p>}
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Source IP:</label>
          {editMode ?
            <input type='text' value={sourceIp} className='border rounded px-2 py-1 w-full' readOnly /> :
            <select
              className="border rounded px-2 py-1 w-full"
              value={sourceIp}
              onChange={(e) => setSourceIp(e.target.value as SourceIp)}
            >
              {availableSourceIps.map((s) => (
                <option key={s} value={s}>{SOURCE_IP_LABELS[s] ?? s}</option>
              ))}
            </select>
          }
          {capabilitiesError && <p className="text-yellow-600 text-xs">{capabilitiesError}</p>}
          {errors.sourceIp && <p className="text-red-500 text-xs">{errors.sourceIp}</p>}
        </div>
        {protocol === 'udp' && (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">UDP Idle Timeout (秒):</label>
            <input
              type="number"
              value={udpIdleSecs}
              onChange={(e) => setUdpIdleSecs(toNumber(e.target.value))}
              className="border rounded px-2 py-1 w-full"
              placeholder="秒数（1-86400）"
              min="1"
              max="86400"
            />
            {errors.udpIdleSecs && <p className="text-red-500 text-xs">{errors.udpIdleSecs}</p>}
          </div>
        )}
        <div className="flex justify-end space-x-2">
          <button
            type="button"
            onClick={handleSubmit}
            className="bg-blue-500 text-white px-4 py-2 rounded"
          >
            {initialData ? 'Save Changes' : 'Add Rule'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="bg-gray-300 px-4 py-2 rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default Modal;
