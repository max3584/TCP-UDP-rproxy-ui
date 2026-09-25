import React, { useState, useEffect, useMemo } from 'react';
import {
  CLIENT_AUTH_MODES,
  ClientAuthMode,
  DEFAULT_MAX_RANGE_PORTS,
  DEFAULT_UDP_IDLE_SECS,
  ForwardRule,
  Protocol,
  SourceIp,
  StartTls,
  TCP_ONLY_SOURCE_IPS,
  TlsCertificate,
  TlsMode,
  TlsSpec,
} from './lib';
import { checkTls, normalizeStartTlsRequired, normalizeTls, portCount } from './tls';
import { PROFILES } from './profiles';

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

const tlsModeLabel = (mode: TlsMode, protocol: Protocol): string => {
  switch (mode) {
    case 'passthrough': return 'passthrough（復号せずにそのまま流す）';
    case 'sni': return 'sni（サーバ名で転送先を選ぶ。復号しない）';
    case 'terminate': return protocol === 'udp' ? '終端 (DTLS)' : '終端（rproxy で TLS を復号する）';
  }
};

const CLIENT_AUTH_LABELS: Record<ClientAuthMode, string> = {
  none: 'none（検証しない）',
  optional: 'optional（送られてきたら検証する）',
  required: 'required（必須。mTLS）',
};

const ipv4Pattern = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const ipv6Pattern = /^[0-9A-Fa-f:.]+$/;
const domainPattern = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*$/;

const isIPv4 = (address: string) => ipv4Pattern.test(address);
const isIPv6 = (address: string) => address.includes(':') && ipv6Pattern.test(address);

interface RouteRow {
  server_name: string;
  remote_addr: string;
  remote_port: number | '';
}

interface Caps {
  sourceIps: SourceIp[];
  tlsModes: TlsMode[];
  dtls: boolean;
  starttls: StartTls[];
  maxRangePorts: number;
}

// rproxy の対応機能を取得できなかったときは、既定の動作（proxy / passthrough）だけを選べるようにする
const FALLBACK_CAPS: Caps = {
  sourceIps: ['proxy'],
  tlsModes: ['passthrough'],
  dtls: false,
  starttls: [],
  maxRangePorts: DEFAULT_MAX_RANGE_PORTS,
};

type TabId = 'basic' | 'tls' | 'mail' | 'advanced';
const TAB_IDS: TabId[] = ['basic', 'tls', 'mail', 'advanced'];

type FieldErrors = {
  srcAddr: string;
  srcPort: string;
  srcPortEnd: string;
  distAddr: string;
  distPort: string;
  sourceIp: string;
  udpIdleSecs: string;
  tls: string;
};

// どのタブにどの入力欄があるか（エラーの印とエラーのあるタブへの移動に使う）
const TAB_FIELDS: Record<TabId, (keyof FieldErrors)[]> = {
  basic: ['srcAddr', 'srcPort', 'srcPortEnd', 'distAddr', 'distPort'],
  tls: ['tls'],
  mail: [],
  advanced: ['sourceIp', 'udpIdleSecs'],
};

const EMPTY_ERRORS: FieldErrors = {
  srcAddr: '',
  srcPort: '',
  srcPortEnd: '',
  distAddr: '',
  distPort: '',
  sourceIp: '',
  udpIdleSecs: '',
  tls: '',
};

const errorCount = (errors: FieldErrors, tab: TabId): number => TAB_FIELDS[tab].filter((f) => errors[f] !== '').length;

const inputClass = 'border rounded px-2 py-1 w-full';
const smallButtonClass = 'bg-gray-200 text-gray-800 px-2 py-1 rounded text-sm';

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, onSubmit, initialData }) => {
  const tls: TlsSpec = initialData?.tls ?? { mode: 'passthrough' };
  const [profileId, setProfileId] = useState('');
  const [protocol, setProtocol] = useState<Protocol>(initialData?.protocol || 'tcp');
  const [srcAddr, setSrcAddr] = useState(initialData?.srcAddr || '');
  const [srcPort, setSrcPort] = useState<number | ''>(initialData?.srcPort || '');
  const [srcPortEnd, setSrcPortEnd] = useState<number | ''>(initialData?.srcPortEnd ?? '');
  const [distAddr, setDistAddr] = useState(initialData?.distAddr || '');
  const [distPort, setDistPort] = useState<number | ''>(initialData?.distPort || '');
  const [sourceIp, setSourceIp] = useState<SourceIp>(initialData?.sourceIp || 'proxy');
  const [udpIdleSecs, setUdpIdleSecs] = useState<number | ''>(initialData?.udpIdleSecs || DEFAULT_UDP_IDLE_SECS);
  const [tlsMode, setTlsMode] = useState<TlsMode>(tls.mode);
  const [routes, setRoutes] = useState<RouteRow[]>(tls.routes ?? []);
  const [certificates, setCertificates] = useState<TlsCertificate[]>(tls.certificates ?? []);
  const [clientAuthMode, setClientAuthMode] = useState<ClientAuthMode>(tls.client_auth?.mode ?? 'none');
  const [clientAuthCa, setClientAuthCa] = useState(tls.client_auth?.ca_file ?? '');
  const [alpnText, setAlpnText] = useState((tls.alpn ?? []).join(', '));
  const [upstreamTls, setUpstreamTls] = useState(tls.upstream?.tls ?? false);
  const [upstreamServerName, setUpstreamServerName] = useState(tls.upstream?.server_name ?? '');
  const [upstreamCa, setUpstreamCa] = useState(tls.upstream?.ca_file ?? '');
  const [upstreamInsecure, setUpstreamInsecure] = useState(tls.upstream?.insecure_skip_verify ?? false);
  const [upstreamCert, setUpstreamCert] = useState(tls.upstream?.cert_file ?? '');
  const [upstreamKey, setUpstreamKey] = useState(tls.upstream?.key_file ?? '');
  const [starttls, setStarttls] = useState<StartTls | ''>(initialData?.starttls ?? '');
  const [starttlsRequired, setStarttlsRequired] = useState(initialData?.starttlsRequired ?? true);
  const [caps, setCaps] = useState<Caps>(FALLBACK_CAPS);
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const editMode = initialData ? true : false;

  const [errors, setErrors] = useState<FieldErrors>(EMPTY_ERRORS);
  const [activeTab, setActiveTab] = useState<TabId>('basic');

  // 編集画面でも TLS は変更できるので、対応機能はどちらでも取得する
  useEffect(() => {
    const getCapabilities = async () => {
      try {
        const res = await fetch('/api/forward/capabilities');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        setCaps({
          sourceIps: Array.isArray(data.source_ip) && data.source_ip.length > 0 ? data.source_ip : ['proxy'],
          tlsModes: Array.isArray(data.tls_modes) && data.tls_modes.length > 0 ? data.tls_modes : ['passthrough'],
          dtls: data.dtls === true,
          starttls: Array.isArray(data.starttls) ? data.starttls : [],
          maxRangePorts: typeof data.max_range_ports === 'number' ? data.max_range_ports : DEFAULT_MAX_RANGE_PORTS,
        });
      } catch (err) {
        setCapabilitiesError(`rproxy の対応機能を取得できませんでした（既定の動作だけを選べます）: ${err instanceof Error ? err.message : err}`);
      }
    };
    getCapabilities();
  }, []);

  // proxy_v1 / proxy_v2 は TCP のみ、transparent は IPv4 のみ
  const availableSourceIps = useMemo(() => caps.sourceIps.filter((s) => {
    if (protocol === 'udp' && TCP_ONLY_SOURCE_IPS.includes(s)) return false;
    if (s === 'transparent' && isIPv6(srcAddr)) return false;
    return true;
  }), [caps.sourceIps, protocol, srcAddr]);

  // sni は TCP のみ。UDP の terminate は DTLS（rproxy が対応しているときだけ）。編集中のルールのモードは常に選べる
  const availableTlsModes = useMemo(() => {
    const modes = caps.tlsModes.filter((m) => {
      if (protocol === 'udp' && m === 'sni') return false;
      if (protocol === 'udp' && m === 'terminate' && !caps.dtls) return false;
      return true;
    });
    const current = initialData?.tls.mode;
    if (current && !modes.includes(current)) modes.push(current);
    if (!modes.includes('passthrough')) modes.unshift('passthrough');
    return modes;
  }, [caps.tlsModes, caps.dtls, protocol, initialData]);

  const availableStartTls = useMemo(() => {
    const list = [...caps.starttls];
    if (initialData?.starttls && !list.includes(initialData.starttls)) list.push(initialData.starttls);
    return list;
  }, [caps.starttls, initialData]);

  useEffect(() => {
    if (!editMode && !availableSourceIps.includes(sourceIp)) {
      setSourceIp('proxy');
    }
  }, [editMode, availableSourceIps, sourceIp]);

  useEffect(() => {
    if (!availableTlsModes.includes(tlsMode)) {
      setTlsMode('passthrough');
    }
  }, [availableTlsModes, tlsMode]);

  if (!isOpen) return null;

  const showStartTls = protocol === 'tcp' && tlsMode === 'terminate';
  const profile = PROFILES.find((p) => p.id === profileId);

  const applyProfile = (id: string) => {
    setProfileId(id);
    const p = PROFILES.find((x) => x.id === id);
    if (!p) return;
    setProtocol(p.protocol);
    setSrcPort(p.srcPort);
    setSrcPortEnd(p.srcPortEnd ?? '');
    setDistPort(p.distPort);
    setSourceIp(p.sourceIp ?? 'proxy');
    setUdpIdleSecs(p.udpIdleSecs ?? DEFAULT_UDP_IDLE_SECS);
    setTlsMode(p.tlsMode);
    setStarttls(p.starttls ?? '');
    setStarttlsRequired(p.starttlsRequired ?? true);
  };

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

  // 範囲の終わりが空なら単一ポート
  const rangeEnd = (): number | null => (srcPortEnd === '' || srcPortEnd === srcPort ? null : Number(srcPortEnd));

  const validateRange = (): string => {
    if (editMode || srcPortEnd === '') return '';
    const portError = validatePort(srcPortEnd);
    if (portError) return portError;
    if (validatePort(srcPort) || validatePort(distPort)) return '';
    try {
      portCount(Number(srcPort), rangeEnd(), Number(distPort), caps.maxRangePorts);
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // 選んでいるモードで使う項目だけを組み立てる（隠れている欄の値は送らない）
  const buildTls = (): unknown => {
    const spec: Record<string, unknown> = { mode: tlsMode };
    if (tlsMode === 'sni' || tlsMode === 'terminate') {
      spec.routes = routes.map((r) => ({
        server_name: r.server_name,
        remote_addr: r.remote_addr,
        remote_port: r.remote_port === '' ? 0 : r.remote_port,
      }));
    }
    if (tlsMode === 'terminate') {
      spec.certificates = certificates;
      spec.client_auth = { mode: clientAuthMode, ca_file: clientAuthMode === 'none' ? '' : clientAuthCa };
      if (protocol === 'tcp') {
        spec.alpn = alpnText.split(',').map((a) => a.trim()).filter((a) => a !== '');
      }
      if (upstreamTls) {
        spec.upstream = {
          tls: true,
          server_name: upstreamServerName,
          ca_file: upstreamCa,
          insecure_skip_verify: upstreamInsecure,
          cert_file: upstreamCert,
          key_file: upstreamKey,
        };
      }
    }
    return spec;
  };

  const handleSubmit = () => {
    const newErrors: FieldErrors = {
      srcAddr: validateSrcAddress(srcAddr),
      srcPort: validatePort(srcPort),
      srcPortEnd: validateRange(),
      distAddr: validateDistAddress(distAddr),
      distPort: validatePort(distPort),
      sourceIp: editMode || availableSourceIps.includes(sourceIp) ? '' : 'この送信元 IP の扱いは選択できません。',
      udpIdleSecs: validateUdpIdleSecs(udpIdleSecs),
      tls: '',
    };

    const end = editMode ? initialData?.srcPortEnd ?? null : rangeEnd();
    const starttlsValue = showStartTls && starttls !== '' ? starttls : null;
    let tlsSpec: TlsSpec = { mode: 'passthrough' };
    try {
      tlsSpec = normalizeTls(buildTls());
      const count = newErrors.srcPortEnd || newErrors.srcPort || newErrors.distPort
        ? 1 : portCount(Number(srcPort), end, Number(distPort));
      checkTls(protocol, tlsSpec, starttlsValue, count);
    } catch (err) {
      newErrors.tls = err instanceof Error ? err.message : String(err);
    }

    if (Object.values(newErrors).some((e) => e !== '')) {
      setErrors(newErrors);
      // エラーのある最初のタブを開く
      const first = TAB_IDS.find((t) => errorCount(newErrors, t) > 0);
      if (first) setActiveTab(first);
      return;
    }

    const rule: ForwardRule = {
      protocol: protocol,
      srcAddr: srcAddr,
      srcPort: Number(srcPort),
      srcPortEnd: end,
      distAddr: distAddr,
      distPort: Number(distPort),
      sourceIp: sourceIp,
      udpIdleSecs: protocol === 'udp' ? Number(udpIdleSecs) : DEFAULT_UDP_IDLE_SECS,
      tls: tlsSpec,
      starttls: starttlsValue,
      starttlsRequired: normalizeStartTlsRequired(starttlsRequired, starttlsValue),
    };

    onSubmit(rule);
    onClose();
  };

  const toNumber = (value: string): number | '' => (value === '' ? '' : Number(value));

  const updateRoute = (index: number, patch: Partial<RouteRow>) =>
    setRoutes(routes.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const updateCertificate = (index: number, patch: Partial<TlsCertificate>) =>
    setCertificates(certificates.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  const tabLabel = (tab: TabId): string => {
    switch (tab) {
      case 'basic': return '基本';
      case 'tls': return protocol === 'udp' ? 'DTLS' : 'TLS / DTLS';
      case 'mail': return 'メール (STARTTLS)';
      case 'advanced': return '詳細';
    }
  };
  const tabDisabled = (tab: TabId): boolean => tab === 'mail' && !showStartTls;

  // 矢印キー / Home / End でタブを移る（WAI-ARIA の Tabs パターン）
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = TAB_IDS.indexOf(activeTab);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % TAB_IDS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_IDS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const tab = TAB_IDS[next];
    setActiveTab(tab);
    document.getElementById(`rule-tab-${tab}`)?.focus();
  };

  const tabClass = (tab: TabId): string => {
    const base = 'px-3 py-2 text-sm border-b-2 -mb-px focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
    if (tab === activeTab) return `${base} border-blue-600 text-blue-700 font-semibold bg-white`;
    if (tabDisabled(tab)) return `${base} border-transparent text-gray-400`;
    return `${base} border-transparent text-gray-700 hover:text-gray-900`;
  };

  const panelProps = (tab: TabId) => ({
    role: 'tabpanel',
    id: `rule-panel-${tab}`,
    'aria-labelledby': `rule-tab-${tab}`,
    hidden: activeTab !== tab,
    tabIndex: 0,
    className: 'pt-4 focus:outline-none',
  });

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/40">
      <div className="bg-white text-gray-900 p-4 rounded shadow-lg w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl mb-2">{editMode ? 'Edit Forward Rule' : 'Add Forward Rule'}</h2>

        <div role="tablist" aria-label="ルールの設定" className="flex flex-wrap border-b border-gray-300">
          {TAB_IDS.map((tab) => {
            const count = errorCount(errors, tab);
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`rule-tab-${tab}`}
                aria-selected={activeTab === tab}
                aria-controls={`rule-panel-${tab}`}
                aria-disabled={tabDisabled(tab) || undefined}
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                onKeyDown={handleTabKeyDown}
                className={tabClass(tab)}
              >
                {tabLabel(tab)}
                {count > 0 && (
                  <span className="ml-1 inline-block rounded-full bg-red-600 text-white text-xs leading-4 px-1.5" aria-label={`エラー ${count} 件`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div {...panelProps('basic')}>
          {!editMode && (
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1">プロファイル:</label>
              <select className={inputClass} value={profileId} onChange={(e) => applyProfile(e.target.value)}>
                <option value="">カスタム（手動で入力）</option>
                {PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {profile && (
                <p className="mt-1 text-xs text-gray-700 bg-yellow-50 border border-yellow-300 rounded px-2 py-1">
                  {profile.description}
                  <br />
                  アドレスと証明書のパスは環境に合わせて入力してください（ほかのタブの項目も設定されます）。
                </p>
              )}
            </div>
          )}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Protocol:</label>
            {editMode ?
              <input type='text' value={protocol} className={inputClass} readOnly /> :
              <select
                className={inputClass}
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
              <input type='text' value={srcAddr} className={inputClass} readOnly /> :
              <input
                type="text"
                value={srcAddr}
                onChange={(e) => setSrcAddr(e.target.value.trim())}
                className={inputClass}
                placeholder="例: 0.0.0.0 または ::"
              />
            }
            {errors.srcAddr && <p className="text-red-600 text-xs">{errors.srcAddr}</p>}
          </div>
          <div className="mb-4 flex space-x-2">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Source Port:</label>
              {editMode ?
                <input type='number' value={srcPort} className={inputClass} readOnly /> :
                <input
                  type="number"
                  value={srcPort}
                  onChange={(e) => setSrcPort(toNumber(e.target.value))}
                  className={inputClass}
                  placeholder="ポート番号（1-65535）"
                  min="1"
                  max="65535"
                />
              }
              {errors.srcPort && <p className="text-red-600 text-xs">{errors.srcPort}</p>}
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">範囲の終わり（任意）:</label>
              {editMode ?
                <input type='text' value={srcPortEnd === '' ? '（単一ポート）' : srcPortEnd} className={inputClass} readOnly /> :
                <input
                  type="number"
                  value={srcPortEnd}
                  onChange={(e) => setSrcPortEnd(toNumber(e.target.value))}
                  className={inputClass}
                  placeholder="空欄なら単一ポート"
                  min="1"
                  max="65535"
                />
              }
              {errors.srcPortEnd && <p className="text-red-600 text-xs">{errors.srcPortEnd}</p>}
            </div>
          </div>
          {!editMode && srcPortEnd !== '' && (
            <p className="-mt-3 mb-4 text-xs text-gray-600">
              各ポートを、転送先ポートから順に同じ数だけずらして転送します（最大 {caps.maxRangePorts} ポート）。範囲は作成後に変更できません。
            </p>
          )}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Destination Address:</label>
            <input
              type="text"
              value={distAddr}
              onChange={(e) => setDistAddr(e.target.value.trim())}
              className={inputClass}
              placeholder="例: 192.168.1.1 または example.com"
            />
            {errors.distAddr && <p className="text-red-600 text-xs">{errors.distAddr}</p>}
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Destination Port{srcPortEnd !== '' ? '（範囲の先頭）' : ''}:</label>
            <input
              type="number"
              value={distPort}
              onChange={(e) => setDistPort(toNumber(e.target.value))}
              className={inputClass}
              placeholder="ポート番号（1-65535）"
              min="1"
              max="65535"
            />
            {errors.distPort && <p className="text-red-600 text-xs">{errors.distPort}</p>}
          </div>
        </div>

        <div {...panelProps('tls')}>
          <div className="mb-3">
            <label className="block text-sm font-medium mb-1">モード:</label>
            <select className={inputClass} value={tlsMode} onChange={(e) => setTlsMode(e.target.value as TlsMode)}>
              {availableTlsModes.map((m) => (
                <option key={m} value={m}>{tlsModeLabel(m, protocol)}</option>
              ))}
            </select>
            {protocol === 'udp' && tlsMode === 'terminate' && (
              <p className="text-xs text-yellow-700">WebRTC のメディアには使えません（DTLS-SRTP の鍵がブラウザとメディアサーバの間で結びついているため）。</p>
            )}
            {capabilitiesError && <p className="text-yellow-700 text-xs">{capabilitiesError}</p>}
          </div>

          {(tlsMode === 'sni' || tlsMode === 'terminate') && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">サーバ名ごとの転送先（任意。一致しない名前は「基本」の転送先へ）:</label>
              {routes.map((r, i) => (
                <div key={i} className="flex space-x-1 mb-1">
                  <input type="text" value={r.server_name} onChange={(e) => updateRoute(i, { server_name: e.target.value.trim() })}
                    className={inputClass} placeholder="例: git.example.com / *.example.com" aria-label={`サーバ名 ${i + 1}`} />
                  <input type="text" value={r.remote_addr} onChange={(e) => updateRoute(i, { remote_addr: e.target.value.trim() })}
                    className={inputClass} placeholder="転送先アドレス" aria-label={`転送先アドレス ${i + 1}`} />
                  <input type="number" value={r.remote_port} onChange={(e) => updateRoute(i, { remote_port: toNumber(e.target.value) })}
                    className="border rounded px-2 py-1 w-28" placeholder="ポート" min="1" max="65535" aria-label={`転送先ポート ${i + 1}`} />
                  <button type="button" onClick={() => setRoutes(routes.filter((_, j) => j !== i))} className="text-red-600 text-sm px-1">削除</button>
                </div>
              ))}
              <button type="button" onClick={() => setRoutes([...routes, { server_name: '', remote_addr: '', remote_port: '' }])} className={smallButtonClass}>
                ＋ 転送先を追加
              </button>
            </div>
          )}

          {tlsMode === 'terminate' && (
            <>
              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">証明書（PEM。複数あれば SNI で選び、一致しなければ先頭を使う）:</label>
                {certificates.map((c, i) => (
                  <div key={i} className="flex space-x-1 mb-1">
                    <input type="text" value={c.cert_file} onChange={(e) => updateCertificate(i, { cert_file: e.target.value.trim() })}
                      className={inputClass} placeholder="証明書チェーン 例: /etc/rproxy/certs/example.pem" aria-label={`証明書 ${i + 1}`} />
                    <input type="text" value={c.key_file} onChange={(e) => updateCertificate(i, { key_file: e.target.value.trim() })}
                      className={inputClass} placeholder="秘密鍵 例: /etc/rproxy/certs/example.key" aria-label={`秘密鍵 ${i + 1}`} />
                    <button type="button" onClick={() => setCertificates(certificates.filter((_, j) => j !== i))} className="text-red-600 text-sm px-1">削除</button>
                  </div>
                ))}
                <button type="button" onClick={() => setCertificates([...certificates, { cert_file: '', key_file: '' }])} className={smallButtonClass}>
                  ＋ 証明書を追加
                </button>
                {protocol === 'udp' && <p className="text-xs text-gray-600">DTLS の秘密鍵は PKCS#8（-----BEGIN PRIVATE KEY-----）に限ります。</p>}
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">クライアント証明書の検証（mTLS）:</label>
                <select className={inputClass} value={clientAuthMode} onChange={(e) => setClientAuthMode(e.target.value as ClientAuthMode)}>
                  {CLIENT_AUTH_MODES.map((m) => (
                    <option key={m} value={m}>{CLIENT_AUTH_LABELS[m]}</option>
                  ))}
                </select>
                {clientAuthMode !== 'none' && (
                  <input type="text" value={clientAuthCa} onChange={(e) => setClientAuthCa(e.target.value.trim())}
                    className={`${inputClass} mt-1`} placeholder="CA ファイル 例: /etc/rproxy/clients-ca.pem" aria-label="クライアント証明書の CA ファイル" />
                )}
              </div>

              {protocol === 'tcp' && (
                <div className="mb-3">
                  <label className="block text-sm font-medium mb-1">ALPN（任意。カンマ区切り）:</label>
                  <input type="text" value={alpnText} onChange={(e) => setAlpnText(e.target.value)}
                    className={inputClass} placeholder="例: h2, http/1.1" />
                </div>
              )}

              <div className="mb-3">
                <label className="inline-flex items-center text-sm font-medium">
                  <input type="checkbox" checked={upstreamTls} onChange={(e) => setUpstreamTls(e.target.checked)} className="mr-2" />
                  転送先へ{protocol === 'udp' ? ' DTLS' : ' TLS'} で再暗号化する
                </label>
                {upstreamTls && (
                  <div className="mt-1 space-y-1">
                    <input type="text" value={upstreamServerName} onChange={(e) => setUpstreamServerName(e.target.value.trim())}
                      className={inputClass} placeholder="検証するサーバ名（空欄なら転送先のホスト名）" aria-label="転送先の検証するサーバ名" />
                    <input type="text" value={upstreamCa} onChange={(e) => setUpstreamCa(e.target.value.trim())}
                      className={inputClass} placeholder="CA ファイル（空欄なら Mozilla のルート証明書）" aria-label="転送先の CA ファイル" />
                    <label className="inline-flex items-center text-sm">
                      <input type="checkbox" checked={upstreamInsecure} onChange={(e) => setUpstreamInsecure(e.target.checked)} className="mr-2" />
                      転送先の証明書を検証しない（テスト用）
                    </label>
                    <div className="flex space-x-1">
                      <input type="text" value={upstreamCert} onChange={(e) => setUpstreamCert(e.target.value.trim())}
                        className={inputClass} placeholder="転送先へのクライアント証明書（任意）" aria-label="転送先へのクライアント証明書" />
                      <input type="text" value={upstreamKey} onChange={(e) => setUpstreamKey(e.target.value.trim())}
                        className={inputClass} placeholder="その秘密鍵" aria-label="転送先へのクライアント証明書の秘密鍵" />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          {errors.tls && <p className="text-red-600 text-xs">{errors.tls}</p>}
        </div>

        <div {...panelProps('mail')}>
          {!showStartTls ? (
            <p className="text-sm text-gray-600">
              STARTTLS は TCP で、TLS のモードが「終端」のときだけ使えます（「TLS / DTLS」タブで設定してください）。
            </p>
          ) : (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">STARTTLS:</label>
              <select
                className={inputClass}
                value={starttls}
                onChange={(e) => {
                  const value = e.target.value as StartTls | '';
                  setStarttls(value);
                  if (value !== 'smtp') setStarttlsRequired(true);
                }}
              >
                <option value="">使わない（接続直後から TLS）</option>
                {availableStartTls.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {starttls !== '' && (
                <label className="inline-flex items-center text-sm mt-1">
                  <input
                    type="checkbox"
                    checked={starttlsRequired}
                    disabled={starttls !== 'smtp'}
                    onChange={(e) => setStarttlsRequired(e.target.checked)}
                    className="mr-2"
                  />
                  STARTTLS を必須にする
                  {starttls !== 'smtp' && <span className="ml-1 text-xs text-gray-600">（IMAP / POP3 では常に必須）</span>}
                </label>
              )}
              {starttls === 'smtp' && !starttlsRequired && (
                <p className="text-xs text-yellow-700">STARTTLS をしないクライアントも平文のまま通します（MTA 間の 25 番向け）。</p>
              )}
            </div>
          )}
        </div>

        <div {...panelProps('advanced')}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Source IP:</label>
            {editMode ?
              <input type='text' value={sourceIp} className={inputClass} readOnly /> :
              <select
                className={inputClass}
                value={sourceIp}
                onChange={(e) => setSourceIp(e.target.value as SourceIp)}
              >
                {availableSourceIps.map((s) => (
                  <option key={s} value={s}>{SOURCE_IP_LABELS[s] ?? s}</option>
                ))}
              </select>
            }
            {capabilitiesError && <p className="text-yellow-700 text-xs">{capabilitiesError}</p>}
            {errors.sourceIp && <p className="text-red-600 text-xs">{errors.sourceIp}</p>}
          </div>
          {protocol === 'udp' && (
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1">UDP Idle Timeout (秒):</label>
              <input
                type="number"
                value={udpIdleSecs}
                onChange={(e) => setUdpIdleSecs(toNumber(e.target.value))}
                className={inputClass}
                placeholder="秒数（1-86400）"
                min="1"
                max="86400"
              />
              {errors.udpIdleSecs && <p className="text-red-600 text-xs">{errors.udpIdleSecs}</p>}
            </div>
          )}
        </div>

        <div className="flex justify-end space-x-2 mt-2">
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
            className="bg-gray-300 text-gray-800 px-4 py-2 rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default Modal;
