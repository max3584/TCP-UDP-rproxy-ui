// 英語の画面に日本語が残らないこと（#94）。組み立てた文字列（差分の文・証明書の期限・並べた語句など）は、
// 辞書の文言と丸ごと一致しないと訳されないので、組み立てる側で訳す。ここでは英語で組み立てた結果に日本語がないことと、
// 日本語の結果が変わらないことを確かめる
import { afterEach, describe, expect, it } from 'vitest';
import { joinList, joinSentences, setLocale, tc, translate } from '@/i18n/core';
import { translateProps } from '@/i18n/props';
import { DEFAULT_BALANCE, ForwardRule, SOURCE_IPS } from '@/components/lib';
import { ruleChanges } from '@/components/history';
import { CERT_STATE_LABELS, certProblem, countsDescription, emptyCounts } from '@/components/dashboard';
import { healthCheckLabel } from '@/components/targets';
import { listenOptions } from '@/components/listen';
import { checkMatch } from '@/components/httpspec';
import { proxyProtocolHint, transparentHint } from '@/components/sourceip';
import { explainError } from '@/components/messages';

const JA = /[぀-ヿ一-鿿]/;

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.1', distPort: 80,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true,
  allowFrom: [], http: null, crowdsec: false, targets: [], balance: DEFAULT_BALANCE, healthCheck: null, extraListenAddrs: [],
};

// できるだけ多くの項目を変えた版
const changed: ForwardRule = {
  ...base, protocol: 'udp', srcPortEnd: 450, distPort: 8080, sourceIp: 'transparent', udpIdleSecs: 60, tls: { mode: 'sni' },
  starttls: 'smtp', allowFrom: ['10.0.0.0/8'], crowdsec: true, extraListenAddrs: ['::'], enabled: false,
  healthCheck: { interval: '5s' },
};
const multi: ForwardRule = { ...base, distAddr: '', distPort: 0, targets: [{ addr: 'a', port: 1 }, { addr: 'b', port: 2 }] };

const certs = {
  certStatus: [
    { role: 'certificate', file: '/a.pem', not_after: '', state: 'expiring', days_left: 12 },
    { role: 'client_ca', file: '/b.pem', not_after: '', state: 'expired', days_left: -3 },
  ],
} as Parameters<typeof certProblem>[0];

const lo = { interfaces: [{ name: 'lo', addr: '127.0.0.1', family: 'ipv4', loopback: true, link_local: false }] } as Parameters<typeof listenOptions>[0];

// 英語で組み立てて画面に出すもの（画面では JSX がもう一度訳すので、translate を通した形で確かめる）
function samples(): string[] {
  return [
    ...ruleChanges(base, changed),
    ...ruleChanges(changed, base),
    ...ruleChanges(base, multi),
    ...ruleChanges(multi, { ...multi, targets: [{ addr: 'a', port: 1, weight: 3 }, { addr: 'b', port: 2 }] }),
    ...ruleChanges({ ...base, starttls: 'smtp' }, { ...base, starttls: 'smtp', starttlsRequired: false, tls: { mode: 'passthrough', alpn: ['h2'] } }),
    certProblem(certs) ?? '',
    countsDescription({ ...emptyCounts(), running: 1, failed: 1, missing: 1, unknown: 1, paused: 1, total: 5 }),
    countsDescription(emptyCounts()),
    healthCheckLabel(null),
    healthCheckLabel({}),
    healthCheckLabel({ interval: '10s', timeout: '3s', port: 5432 }),
    ...listenOptions(lo).map((o) => o.label),
    checkMatch('Foo(`a`)') ?? '',
    ...SOURCE_IPS.map((s) => proxyProtocolHint(s)?.message ?? ''),
    transparentHint({ sourceIp: 'proxy', transparentAvailable: false, listenIsIPv6: false })!.message,
    transparentHint({ sourceIp: 'proxy', transparentAvailable: true, listenIsIPv6: true })!.message,
    transparentHint({ sourceIp: 'transparent', transparentAvailable: true, listenIsIPv6: false })!.message,
    explainError('bind_failed', 'Permission denied (os error 13)'),
    explainError(undefined, 'certificate expired: x'),
  ];
}

afterEach(() => setLocale('ja'));

describe('英語の画面に日本語が残らない', () => {
  it('組み立てた文字列を英語で作ると日本語を含まない', () => {
    setLocale('en');
    const leaks = samples().map((s) => translate(s)).filter((s) => JA.test(s));
    expect(leaks).toEqual([]);
  });

  it('履歴の差分の文は項目と値をそれぞれ訳す（ルールの状態の「有効」は Enabled）', () => {
    setLocale('en');
    const lines = ruleChanges(base, changed);
    expect(lines).toContain('State: Enabled → Paused');
    expect(lines).toContain('CrowdSec: Disabled → Enabled');
    expect(lines).toContain('STARTTLS: (none) → smtp');
    // 証明書の状態の「有効」は Valid のまま
    expect(translate(CERT_STATE_LABELS.ok)).toBe('Valid');
    expect(tc('有効', 'on-off', 'ja')).toBe('有効');
  });

  it('ダッシュボードの件数の「うち固定」は前に空白を入れて訳す', () => {
    setLocale('en');
    expect(`TCP 6 / UDP 3${translate('（うち固定 1）')}`).toBe('TCP 6 / UDP 3 (1 static)');
  });

  it('証明書の期限の文は文ごとに訳して空白でつなぐ', () => {
    setLocale('en');
    expect(certProblem(certs)).toBe('Server certificate (/a.pem): expires in 12 days. Client-auth CA (/b.pem): expired (3 days ago).');
  });

  it('日本語の画面の文言は変わらない', () => {
    expect(ruleChanges(base, changed)).toContain('状態: 有効 → 停止中');
    expect(certProblem(certs)).toBe('サーバ証明書（/a.pem）があと 12 日で期限切れです。クライアント認証の CA（/b.pem）が期限切れです（3 日前）。');
    expect(countsDescription({ ...emptyCounts(), running: 1, paused: 2, total: 3 })).toBe('稼働中 1、停止中 2');
    expect(joinList(['a', 'b'], '・')).toBe('a・b');
    expect(joinSentences(['一。', '二。'])).toBe('一。二。');
    expect(samples().every((s) => typeof s === 'string')).toBe(true);
  });
});

describe('JSX の文と文の間', () => {
  it('英語では「。」で終わる子のあとに続く子との間に空白を入れる', () => {
    setLocale('en');
    const children = ['ルールの追加・変更・削除の履歴です。', 'すべての利用者の履歴を表示しています。', '「この版に戻す」で、その時点の内容に戻せます（rproxy の固定ルールは対象外です）。'];
    const out = translateProps({ children }).children as string[];
    expect(out.join('')).not.toMatch(/\.\S/);
    expect(out[0].endsWith(' ')).toBe(true);
    expect(out[2].endsWith(' ')).toBe(false);
  });

  it('日本語ではそのまま', () => {
    const children = ['ルールの追加・変更・削除の履歴です。', 'すべての利用者の履歴を表示しています。'];
    expect(translateProps({ children }).children).toBe(children);
  });
});
