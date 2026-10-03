// README のスクリーンショット（scripts/screenshots）に出すサンプルのデータ。
// アドレスは文書用のもの（192.0.2.0/24・198.51.100.0/24・2001:db8::/32）と example.com だけを使う
import type { ForwardRule, ForwardRules } from '@/components/lib';
import type { HistoryEntry } from '@/components/history';

// 画面の時刻を固定する（自動更新の「最終更新」・稼働時間・履歴の日時が毎回同じになる）
export const NOW = new Date('2026-10-01T10:00:00+09:00');
const now = Math.floor(NOW.getTime() / 1000);
const ago = (secs: number) => now - secs;
const iso = (secsAgo: number) => new Date((now - secsAgo) * 1000).toISOString();
const DAY = 86400;

const base: Omit<ForwardRule, 'protocol' | 'srcAddr' | 'srcPort' | 'distAddr' | 'distPort'> = {
  srcPortEnd: null,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
  tls: { mode: 'passthrough' },
  starttls: null,
  starttlsRequired: false,
  allowFrom: [],
  http: null,
  crowdsec: false,
  targets: [],
  balance: 'round_robin',
  healthCheck: null,
  extraListenAddrs: [],
};

const live = { origin: 'dynamic' as const, state: 'running' as const, error: null };

// L7（HTTP）：ホスト名とパスでサービスへ振り分ける。証明書の期限が近い
const l7: ForwardRules = {
  ...base,
  ...live,
  id: 1,
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 443,
  distAddr: '',
  distPort: 0,
  extraListenAddrs: ['::'],
  tls: {
    mode: 'terminate',
    certificates: [{ cert_file: '/etc/rproxy/certs/example.com/fullchain.pem', key_file: '/etc/rproxy/certs/example.com/privkey.pem' }],
    alpn: ['h2', 'http/1.1'],
  },
  http: {
    routes: [
      { name: 'web', match: 'Host(`www.example.com`) || Host(`example.com`)', service: 'web' },
      { name: 'api', match: 'Host(`api.example.com`) && PathPrefix(`/v1`)', service: 'api', middlewares: ['api-ratelimit'] },
      { name: 'admin', match: 'Host(`admin.example.com`)', service: 'web', middlewares: ['office-only'] },
    ],
    default: { status: 404 },
    services: {
      web: {
        servers: [{ url: 'http://192.0.2.21:8080' }, { url: 'http://192.0.2.22:8080' }],
        balance: 'round_robin',
        health_check: { path: '/healthz', interval: '10s' },
      },
      api: { servers: [{ url: 'http://192.0.2.31:9000' }] },
    },
    middlewares: {
      'api-ratelimit': { rate_limit: { average: 100, period: '1m', burst: 50, source: 'ip' } },
      'office-only': { ip_allow: { source_range: ['198.51.100.0/24'] } },
    },
  },
  connections: 37,
  stats: {
    total_connections: 48213,
    rx_bytes: 3_482_113_024,
    tx_bytes: 21_904_551_936,
    tls_failures: 12,
    denied: 4,
    http: {
      requests: 182_340,
      by_status: { '2xx': 170_112, '3xx': 8_204, '4xx': 3_724, '5xx': 300 },
      routes: {
        web: { requests: 121_000, by_status: { '2xx': 114_500, '3xx': 6_100, '4xx': 300, '5xx': 100 } },
        api: { requests: 58_998, by_status: { '2xx': 55_612, '3xx': 2_104, '4xx': 1_082, '5xx': 200 }, limited: { 'api-ratelimit': 412 } },
        admin: { requests: 1_000, by_status: { '2xx': 1_000 } },
        '(none)': { requests: 1_342, by_status: { '4xx': 1_342 } },
      },
      limited: 412,
    },
  },
  startedAt: ago(9 * DAY + 3 * 3600),
  resolved: ['192.0.2.21:8080', '192.0.2.22:8080', '192.0.2.31:9000'],
  certStatus: [{
    role: 'certificate',
    file: '/etc/rproxy/certs/example.com/fullchain.pem',
    not_after: iso(-12 * DAY),
    days_left: 12,
    state: 'expiring',
  }],
};

// TLS の SNI で振り分ける（終端しない）
const sni: ForwardRules = {
  ...base,
  ...live,
  id: 2,
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8443,
  distAddr: '192.0.2.40',
  distPort: 443,
  sourceIp: 'proxy_v2',
  tls: {
    mode: 'sni',
    routes: [
      { server_name: 'git.example.com', remote_addr: '192.0.2.41', remote_port: 443 },
      { server_names: ['chat.example.com', '*.chat.example.com'], remote_addr: '192.0.2.42', remote_port: 443 },
    ],
  },
  connections: 12,
  stats: { total_connections: 9_120, rx_bytes: 812_003_840, tx_bytes: 4_120_098_816, tls_failures: 3, denied: 0 },
  startedAt: ago(9 * DAY + 3 * 3600),
  resolved: ['192.0.2.40:443', '192.0.2.41:443', '192.0.2.42:443'],
};

// 宛先を複数にして failover で振り分ける（予備の宛先つき）
const db: ForwardRules = {
  ...base,
  ...live,
  id: 3,
  protocol: 'tcp',
  srcAddr: '192.0.2.1',
  srcPort: 5432,
  distAddr: '',
  distPort: 0,
  targets: [
    { addr: '192.0.2.51', port: 5432 },
    { addr: '192.0.2.52', port: 5432, backup: true },
  ],
  balance: 'failover',
  healthCheck: { interval: '5s', timeout: '2s' },
  allowFrom: ['192.0.2.0/24'],
  connections: 8,
  stats: {
    total_connections: 1_204,
    rx_bytes: 52_428_800,
    tx_bytes: 734_003_200,
    tls_failures: 0,
    denied: 17,
    targets: [
      { addr: '192.0.2.51', port: 5432, up: true, connections: 8, total_connections: 1_190 },
      { addr: '192.0.2.52', port: 5432, up: true, connections: 0, total_connections: 14, backup: true },
    ],
  },
  startedAt: ago(2 * DAY + 5 * 3600),
  resolved: ['192.0.2.51:5432', '192.0.2.52:5432'],
};

// UDP（DNS）。送信元を制限
const dns: ForwardRules = {
  ...base,
  ...live,
  id: 4,
  protocol: 'udp',
  srcAddr: '0.0.0.0',
  srcPort: 53,
  distAddr: '198.51.100.53',
  distPort: 53,
  allowFrom: ['192.0.2.0/24', '2001:db8::/32'],
  connections: 5,
  stats: { total_connections: 220_481, rx_bytes: 18_874_368, tx_bytes: 41_943_040, tls_failures: 0, denied: 96, dropped: 0 },
  startedAt: ago(9 * DAY + 3 * 3600),
  resolved: ['198.51.100.53:53'],
};

// UDP（TURN）を IPv6 の宛先へ
const turn: ForwardRules = {
  ...base,
  ...live,
  id: 5,
  protocol: 'udp',
  srcAddr: '::',
  srcPort: 3478,
  distAddr: 'turn.example.com',
  distPort: 3478,
  udpIdleSecs: 60,
  connections: 3,
  stats: { total_connections: 642, rx_bytes: 1_288_490_188, tx_bytes: 1_181_116_006, tls_failures: 0, denied: 0, dropped: 2 },
  startedAt: ago(4 * DAY),
  resolved: ['[2001:db8::3478]:3478'],
};

// メール（STARTTLS を終端）
const submission: ForwardRules = {
  ...base,
  ...live,
  id: 6,
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 587,
  distAddr: 'mail.example.com',
  distPort: 587,
  sourceIp: 'proxy_v2',
  tls: {
    mode: 'terminate',
    certificates: [{ cert_file: '/etc/rproxy/certs/mail.example.com/fullchain.pem', key_file: '/etc/rproxy/certs/mail.example.com/privkey.pem' }],
  },
  starttls: 'smtp',
  starttlsRequired: true,
  crowdsec: true,
  connections: 1,
  stats: { total_connections: 3_310, rx_bytes: 157_286_400, tx_bytes: 9_437_184, tls_failures: 21, denied: 140 },
  startedAt: ago(9 * DAY + 3 * 3600),
  resolved: ['192.0.2.60:587'],
  certStatus: [{
    role: 'certificate',
    file: '/etc/rproxy/certs/mail.example.com/fullchain.pem',
    not_after: iso(-71 * DAY),
    days_left: 71,
    state: 'ok',
  }],
};

// 一時停止中
const paused: ForwardRules = {
  ...base,
  id: 7,
  origin: 'dynamic',
  state: 'paused',
  error: null,
  enabled: false,
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 2222,
  distAddr: '192.0.2.70',
  distPort: 22,
  allowFrom: ['198.51.100.0/24'],
  connections: null,
  stats: null,
  startedAt: null,
  resolved: [],
};

// UDP のポート範囲（RTP）
const rtp: ForwardRules = {
  ...base,
  ...live,
  id: 8,
  protocol: 'udp',
  srcAddr: '0.0.0.0',
  srcPort: 10000,
  srcPortEnd: 10100,
  distAddr: '192.0.2.80',
  distPort: 10000,
  connections: 14,
  stats: { total_connections: 5_018, rx_bytes: 6_871_947_673, tx_bytes: 6_012_954_214, tls_failures: 0, denied: 0, dropped: 31 },
  startedAt: ago(1 * DAY + 2 * 3600),
  resolved: ['192.0.2.80:10000'],
};

// rproxy の設定ファイルの固定ルール（画面からは変えられない）
const fixed: ForwardRules = {
  ...base,
  ...live,
  id: -1,
  origin: 'static',
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 80,
  distAddr: '192.0.2.21',
  distPort: 8080,
  connections: 4,
  stats: { total_connections: 30_118, rx_bytes: 104_857_600, tx_bytes: 52_428_800, tls_failures: 0, denied: 0 },
  startedAt: ago(9 * DAY + 3 * 3600),
  resolved: ['192.0.2.21:8080'],
};

export const RULES: ForwardRules[] = [l7, sni, db, dns, turn, submission, paused, rtp, fixed];

export const DETAIL_RULE = l7;

export const CAPABILITIES = {
  source_ip: ['proxy', 'proxy_v1', 'proxy_v2', 'transparent'],
  transparent: true,
  tls_modes: ['passthrough', 'sni', 'terminate'],
  dtls: true,
  starttls: ['smtp', 'imap', 'pop3'],
  max_range_ports: 20000,
  features: {
    http: true,
    http3: true,
    acme: false,
    tls_options: true,
    middlewares: ['redirect_scheme', 'redirect_regex', 'rate_limit', 'in_flight', 'crowdsec', 'ip_allow', 'headers',
      'forward_auth', 'oidc', 'basic_auth', 'strip_prefix', 'add_prefix'],
    services: ['health_check', 'sticky'],
  },
};

export const INTERFACES = {
  interfaces: [
    { name: 'eth0', addr: '192.0.2.1', family: 'ipv4', loopback: false, link_local: false },
    { name: 'eth0', addr: '2001:db8::1', family: 'ipv6', loopback: false, link_local: false },
    { name: 'lo', addr: '127.0.0.1', family: 'ipv4', loopback: true, link_local: false },
  ],
  reserved: [{ protocol: 'tcp', addr: '127.0.0.1', port: 9090, purpose: 'api' }],
};

export const CONFIG_STATUS = { show: false, path: null, error: null, restartNeeded: [] };

function plain(rule: ForwardRules): ForwardRule {
  const { protocol, srcAddr, srcPort, srcPortEnd, distAddr, distPort, sourceIp, udpIdleSecs, tls, starttls, starttlsRequired,
    allowFrom, http, crowdsec, targets, balance, healthCheck, extraListenAddrs, enabled } = rule;
  return { protocol, srcAddr, srcPort, srcPortEnd, distAddr, distPort, sourceIp, udpIdleSecs, tls, starttls, starttlsRequired,
    allowFrom, http, crowdsec, targets, balance, healthCheck, extraListenAddrs, enabled };
}

function entry(id: number, secsAgo: number, actor: string, action: HistoryEntry['action'], rule: ForwardRules, changes: string[]): HistoryEntry {
  return {
    id,
    at: iso(secsAgo),
    actor,
    action,
    protocol: rule.protocol,
    srcAddr: rule.srcAddr,
    srcPort: rule.srcPort,
    rule: plain(rule),
    changes,
    revertible: true,
  };
}

// 新しい順。changes は API（components/history.ts の ruleChanges）が作る文言と同じ形
export const HISTORY: HistoryEntry[] = [
  entry(12, 25 * 60, 'alice', 'UPDATE', l7, ['L7 の設定を変更']),
  entry(11, 3 * 3600, 'bob', 'UPDATE', paused, ['接続を許可する送信元: すべて → 198.51.100.0/24']),
  entry(10, 5 * 3600, 'alice', 'UPDATE', dns, ['接続を許可する送信元: すべて → 192.0.2.0/24, 2001:db8::/32']),
  entry(9, 1 * DAY + 2 * 3600, 'bob', 'ADD', rtp, []),
  entry(8, 2 * DAY + 5 * 3600, 'alice', 'UPDATE', db, ['転送先: 192.0.2.51:5432 → 192.0.2.51:5432, 192.0.2.52:5432（failover）', 'ヘルスチェックを変更']),
  entry(7, 3 * DAY, 'alice', 'UPDATE', sni, ['TLS の設定を変更']),
  entry(6, 4 * DAY, 'bob', 'ADD', turn, []),
  entry(5, 4 * DAY + 3600, 'alice', 'DELETE', { ...turn, srcAddr: '0.0.0.0', srcPort: 3479 }, []),
  entry(4, 6 * DAY, 'alice', 'UPDATE', l7, ['TLS のモード: passthrough → terminate', 'L7 の設定を変更']),
  entry(3, 8 * DAY, 'bob', 'ADD', submission, []),
  entry(2, 9 * DAY, 'alice', 'ADD', sni, []),
  entry(1, 9 * DAY + 600, 'alice', 'ADD', l7, []),
];
