import React, { useState, useEffect } from 'react';
import { ForwardRule } from './lib';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ForwardRule) => void;
  initialData?: ForwardRule | null;
}

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, onSubmit, initialData }) => {
  const [protocol, setProtocol] = useState(initialData?.protocol || 'tcp');
  const [srcAddr, setSrcAddr] = useState(initialData?.srcAddr || '');
  const [srcPort, setSrcPort] = useState<number | ''>(initialData?.srcPort || '');
  const [distAddr, setDistAddr] = useState(initialData?.distAddr || '');
  const [distPort, setDistPort] = useState<number | ''>(initialData?.distPort || '');
  const [editMode, setEditMode] = useState(initialData ? true : false);

  const [errors, setErrors] = useState({
    srcAddr: '',
    srcPort: '',
    distAddr: '',
    distPort: '',
  });

  useEffect(() => {
    if (initialData) {
      setSrcAddr(initialData.srcAddr);
      setSrcPort(initialData.srcPort);
      setDistAddr(initialData.distAddr);
      setDistPort(initialData.distPort);
    }
  }, [initialData]);

  if (!isOpen) return null;

  const validateAddress = (address: string): string => {
    const ipPattern = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const domainPattern = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})(\.[A-Za-z0-9-]{2,63})*$/;

    if (ipPattern.test(address)) {
      return '';
    } else if (domainPattern.test(address) || address === '') {
      return '';
    } else {
      return '無効なアドレス形式です。';
    }
  };

  const validatePort = (port: number | ''): string => {
    if (port === '' || (port >= 0 && port <= 49151)) {
      return '';
    }
    return 'ポート番号は0から49151の範囲で指定してください。';
  };

  const handleSubmit = () => {
    const srcAddrError = validateAddress(srcAddr);
    const srcPortError = validatePort(srcPort);
    const distAddrError = validateAddress(distAddr);
    const distPortError = validatePort(distPort);

    if (srcAddrError || srcPortError || distAddrError || distPortError) {
      setErrors({
        srcAddr: srcAddrError,
        srcPort: srcPortError,
        distAddr: distAddrError,
        distPort: distPortError,
      });
      return;
    }

    const srcPortNumber = typeof srcPort === 'number' ? srcPort : parseInt(srcPort, 10);
    const distPortNumber = typeof distPort === 'number' ? distPort : parseInt(distPort, 10);

    const rule: ForwardRule = {
      protocol: protocol,
      srcAddr: srcAddr,
      srcPort: srcPortNumber,
      distAddr: distAddr,
      distPort: distPortNumber,
    };

    onSubmit(rule);
    onClose();
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="bg-white p-4 rounded shadow-lg w-1/3">
        <h2 className="text-xl mb-4">{editMode ? 'Edit Forward Rule' : 'Add Forward Rule'}</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Protocol:</label>
          {editMode ? 
            <input type='text' value={protocol} className='border rounded px-2 py-1 w-full' readOnly /> :
            <select className="border rounded px-2 py-1 w-full" onChange={(e) => setProtocol(e.target.value)}>
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
              onChange={(e) => setSrcAddr(e.target.value)}
              className="border rounded px-2 py-1 w-full"
              placeholder="例: 192.168.1.1 または example.com"
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
              value={srcPort === '' ? '' : srcPort}
              onChange={(e) => setSrcPort(Number(e.target.value))}
              className="border rounded px-2 py-1 w-full"
              placeholder="ポート番号（0-49151）"
              min="0"
              max="49151"
            />
          }
          {errors.srcPort && <p className="text-red-500 text-xs">{errors.srcPort}</p>}
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Destination Address:</label>
          <input
            type="text"
            value={distAddr}
            onChange={(e) => setDistAddr(e.target.value)}
            className="border rounded px-2 py-1 w-full"
            placeholder="例: 192.168.1.1 または example.com"
          />
          {errors.distAddr && <p className="text-red-500 text-xs">{errors.distAddr}</p>}
        </div>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">Destination Port:</label>
          <input
            type="number"
            value={distPort === '' ? '' : distPort}
            onChange={(e) => setDistPort(Number(e.target.value))}
            className="border rounded px-2 py-1 w-full"
            placeholder="ポート番号（0-49151）"
            min="0"
            max="49151"
          />
          {errors.distPort && <p className="text-red-500 text-xs">{errors.distPort}</p>}
        </div>
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
