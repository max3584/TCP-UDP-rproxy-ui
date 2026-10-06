// ACME の証明書（rproxy-api v0.3.21。docs/ACME.md）：名前の検証（rproxy の src/acme/config.rs と同じ規則）、
// GET /acme の取り出し、状態の表示（仮の証明書）、要確認、rproxy の断りの説明、フォームの部品、/api/forward/acme
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ getServerSession: vi.fn(), getAcme: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/pages/api/auth/[...nextauth]', () => ({ authOptions: {} }));
vi.mock('@/components/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/lib')>()),
  Logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/rproxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/rproxy')>()),
  getAcme: mocks.getAcme,
}));

import handler from '@/pages/api/forward/acme';
import { RproxyError } from '@/components/rproxy';
import type { RproxyRuleStatus } from '@/components/rproxy';
import {
  AcmeCertStatus,
  AcmeInfo,
  acmeInfoFromRproxy,
  acmeNameAllowed,
  acmeProblem,
  acmeStatusFor,
  checkAcmeNames,
  normalizeAcmeName,
  servesStandIn,
  splitAcmeDomains,
  validAcmeName,
  worstAcmeState,
} from '@/components/acme';
import AcmeCertificateEditor from '@/components/AcmeCertificateEditor';
import AcmeStatus from '@/components/AcmeStatus';
import { AcmeBadge } from '@/components/ui';
import { aggregateNodeStates, needsAttention, ruleFromStatus } from '@/components/dashboard';
import { ACME_SCOPE_MESSAGE, ACME_UNSUPPORTED_NOTE, explainError } from '@/components/messages';
import { TlsError, checkTls, normalizeTls } from '@/components/tls';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule } from '@/components/settingsdoc';
import type { ForwardRule, ForwardRules, NodeLiveState } from '@/components/lib';

// rproxy の GET /acme の応答（tests/acme.rs の設定と同じ形）。contact・directory・eab・zones は画面に渡さない
const RAW = {
  accounts: [{ name: 'test', directory: 'https://acme.example/dir', contact: ['mailto:admin@example.test'], eab: false, allowed_names: ['**.example.test', 'example.test'], registered: true }],
  dns_providers: [
    { name: 'pdns', type: 'powerdns', zones: ['example.test'], allowed_names: ['**.example.test', 'example.test'] },
    { name: 'relay', type: 'http', zones: [], allowed_names: ['rest.example.test'] },
  ],
  resolvers: [
    { name: 'http', account: 'test', challenge: 'http-01', dns_provider: null },
    { name: 'alpn', account: 'test', challenge: 'tls-alpn-01', dns_provider: null },
    { name: 'dns', account: 'test', challenge: 'dns-01', dns_provider: 'pdns' },
    { name: 'rest', account: 'test', challenge: 'dns-01', dns_provider: 'relay' },
  ],
  certificates: [{ resolver: 'alpn', domains: ['www.example.test'], state: 'pending' }],
  rate_limit: { orders: 10, period_secs: 3600, used: 1 },
};
const INFO: AcmeInfo = acmeInfoFromRproxy(RAW);

describe('names (the rules of rproxy src/acme/config.rs)', () => {
  it('normalizes, validates and matches allowed_names patterns', () => {
    expect(normalizeAcmeName(' WWW.Example.COM. ')).toBe('www.example.com');
    expect(validAcmeName('*.example.com') && validAcmeName('a-b.example.com')).toBe(true);
    for (const bad of ['example', 'a..b', '*.*.a.b', '127.0.0.1', 'a_b.example.com', '-a.example.com', 'a b.c']) {
      expect(validAcmeName(bad), bad).toBe(false);
    }
    expect(acmeNameAllowed('example.com', 'example.com')).toBe(true);
    expect(acmeNameAllowed('*.example.com', 'a.example.com')).toBe(true);
    expect(acmeNameAllowed('*.example.com', '*.example.com')).toBe(true);
    expect(acmeNameAllowed('*.example.com', 'a.b.example.com')).toBe(false);
    expect(acmeNameAllowed('*.example.com', 'example.com')).toBe(false);
    expect(acmeNameAllowed('*.example.com', 'aexample.com')).toBe(false);
    expect(acmeNameAllowed('**.example.com', 'a.b.example.com')).toBe(true);
    expect(acmeNameAllowed('**.example.com', '*.b.example.com')).toBe(true);
    expect(acmeNameAllowed('**.example.com', 'badexample.com')).toBe(false);
    expect(acmeNameAllowed('**.example.com', 'example.com')).toBe(false);
    expect(splitAcmeDomains('Example.test, www.example.test  www.example.test.')).toEqual(['example.test', 'www.example.test']);
  });

  it('checks the resolver, wildcards against dns-01 and both allowlists, like rproxy check_names', () => {
    expect(checkAcmeNames(INFO, 'http', ['Example.test', 'www.example.test', 'x.y.example.test'])).toBeNull();
    expect(checkAcmeNames(INFO, 'http', ['evil.example.org'])).toMatch(/アカウント test で取ってよい名前/);
    expect(checkAcmeNames(INFO, 'alpn', ['*.example.test'])).toMatch(/ワイルドカード \*\.example\.test は dns-01 の resolver でだけ/);
    expect(checkAcmeNames(INFO, 'dns', ['*.example.test', 'example.test'])).toBeNull();
    expect(checkAcmeNames(INFO, 'rest', ['other.example.test'])).toMatch(/DNS のプロバイダ relay で証明してよい名前/);
    expect(checkAcmeNames(INFO, 'nope', ['example.test'])).toMatch(/resolver nope は rproxy の設定ファイル/);
    expect(checkAcmeNames(INFO, 'http', [])).toMatch(/名前を 1 つ以上/);
    expect(checkAcmeNames(INFO, '', ['example.test'])).toMatch(/resolver を選んで/);
    expect(checkAcmeNames(INFO, 'http', ['exa mple.test'])).toMatch(/ホスト名ではありません/);
    expect(checkAcmeNames(INFO, 'http', Array.from({ length: 101 }, (_, i) => `n${i}.example.test`))).toMatch(/100 個まで/);
    // 一覧を取れないときは rproxy に任せる
    expect(checkAcmeNames({ ...INFO, configured: false }, 'x', ['evil.example.org'])).toBeNull();
  });
});

describe('GET /acme (acmeInfoFromRproxy)', () => {
  it('keeps names, challenges and allowlists only (no contact, directory, eab or zones)', () => {
    expect(INFO.configured).toBe(true);
    expect(INFO.resolvers.map((r) => [r.name, r.challenge, r.dns_provider])).toEqual([
      ['http', 'http-01', null], ['alpn', 'tls-alpn-01', null], ['dns', 'dns-01', 'pdns'], ['rest', 'dns-01', 'relay'],
    ]);
    expect(INFO.accounts).toEqual([{ name: 'test', allowed_names: ['**.example.test', 'example.test'], registered: true }]);
    expect(INFO.dnsProviders[0]).toEqual({ name: 'pdns', type: 'powerdns', allowed_names: ['**.example.test', 'example.test'] });
    expect(INFO.rateLimit).toEqual({ orders: 10, periodSecs: 3600, used: 1 });
    const text = JSON.stringify(INFO);
    for (const hidden of ['mailto:', 'acme.example/dir', 'zones', 'eab']) expect(text).not.toContain(hidden);
  });
});

describe('/api/forward/acme', () => {
  const session = { user: { id: 'user-1', name: 'n', email: 'e', image: '', role: 'rproxy-user', roles: ['rproxy-user'] }, expires: '' };
  const call = (method = 'GET') => {
    const req = { method, query: {}, headers: {} } as unknown as NextApiRequest;
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return handler(req, res as NextApiResponse).then(() => ({ status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }));
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue(session);
  });

  it('returns the names only, and configured: false when rproxy has no global.acme (404)', async () => {
    mocks.getAcme.mockResolvedValue(RAW);
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(ok.body.resolvers).toHaveLength(4);
    expect(JSON.stringify(ok.body)).not.toContain('mailto:');
    mocks.getAcme.mockRejectedValue(new RproxyError('global.acme is not configured', 'not_found', 404));
    expect(await call()).toMatchObject({ status: 200, body: { configured: false, resolvers: [] } });
  });

  it('is 502 when rproxy cannot be reached, and needs a signed-in user and GET', async () => {
    mocks.getAcme.mockRejectedValue(new RproxyError('down', 'unreachable', 0));
    expect((await call()).status).toBe(502);
    expect((await call('POST')).status).toBe(405);
    mocks.getServerSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
});

const NOW = Date.parse('2026-10-06T00:00:00Z');
const status = (over: Partial<AcmeCertStatus>): AcmeCertStatus => ({ resolver: 'alpn', domains: ['example.test', 'www.example.test'], state: 'valid', ...over });

describe('status', () => {
  it('finds the status of a certificate by resolver and names (rproxy sorts the names)', () => {
    const s = status({});
    expect(acmeStatusFor([s], { acme: 'alpn', domains: ['www.example.test', 'Example.test'] })).toBe(s);
    expect(acmeStatusFor([s], { acme: 'dns', domains: ['www.example.test', 'example.test'] })).toBeUndefined();
    expect(acmeStatusFor([s], { cert_file: '/c', key_file: '/k' })).toBeUndefined();
  });

  it('knows when rproxy serves the self-signed stand-in', () => {
    expect(servesStandIn(status({ state: 'pending' }), NOW)).toBe(true);
    expect(servesStandIn(status({ state: 'error', error: 'boom' }), NOW)).toBe(true);
    expect(servesStandIn(status({ not_after: '2026-10-01T00:00:00Z', state: 'error' }), NOW)).toBe(true);
    expect(servesStandIn(status({ not_after: '2027-01-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it('puts failing certificates on the attention list, with the days left when renewals keep failing', () => {
    const pending = status({ state: 'pending' });
    const failing = status({ state: 'error', error: 'connection refused', next_attempt: '2026-10-06T01:00:00Z' });
    const renewalFailing = status({ state: 'error', not_after: '2026-10-11T00:00:00Z', error: 'dns: timeout' });
    const laterFailing = status({ state: 'error', not_after: '2026-12-11T00:00:00Z', error: 'dns: timeout' });
    const limited = status({ state: 'pending', next_attempt: '2026-10-06T02:00:00Z' });
    expect(acmeProblem({ acmeStatus: [pending, status({})] }, NOW)).toBeNull();
    expect(acmeProblem({ acmeStatus: [failing] }, NOW)).toMatch(/まだ取れていないため、自己署名の仮の証明書を返しています。 ?理由: connection refused/);
    expect(acmeProblem({ acmeStatus: [failing] }, NOW)).toContain('次の試み');
    expect(acmeProblem({ acmeStatus: [renewalFailing] }, NOW)).toContain('更新できないまま、あと 5 日で期限が切れます');
    expect(acmeProblem({ acmeStatus: [laterFailing] }, NOW)).toContain('更新に失敗しました');
    expect(acmeProblem({ acmeStatus: [limited] }, NOW)).toContain('まだ取れていません');
    expect(worstAcmeState({ acmeStatus: [status({}), pending] })).toBe('pending');
    expect(worstAcmeState({ acmeStatus: [pending, failing] })).toBe('error');
    expect(worstAcmeState({})).toBeNull();
  });

  it('lists running rules with failing ACME certificates on the dashboard', () => {
    const base = { id: 1, origin: 'dynamic', protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.5', distPort: 80,
      sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'terminate', certificates: [{ acme: 'alpn', domains: ['example.test'] }] }, starttls: null,
      starttlsRequired: true, allowFrom: [], http: null, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null,
      state: 'running', error: null, connections: 0, stats: null, startedAt: 1, resolved: [] } as ForwardRules;
    const ok = { ...base, acmeStatus: [status({})] };
    const bad = { ...base, id: 2, acmeStatus: [status({ state: 'error', error: 'x' })] };
    expect(needsAttention([ok, bad])).toEqual([bad]);
  });

  it('carries rproxy acme into rows, and the worst node for a group', () => {
    const st = { protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 443, remote_addr: '10.0.0.5', remote_port: 80, state: 'running', error: null,
      resolved: [], connections: 0, tls: { mode: 'terminate', certificates: [{ acme: 'alpn', domains: ['example.test'] }] },
      acme: [{ resolver: 'alpn', domains: ['example.test'], state: 'pending', secret: 'x' }] } as unknown as RproxyRuleStatus;
    expect(ruleFromStatus(st, -1).acmeStatus).toEqual([{ resolver: 'alpn', domains: ['example.test'], state: 'pending' }]);
    const node = (name: string, state: AcmeCertStatus['state']): NodeLiveState => ({ node: name, state: 'running', error: null, connections: 0, stats: null,
      startedAt: 1, resolved: [], acmeStatus: [status({ state })] });
    expect(aggregateNodeStates([node('n1', 'valid'), node('n2', 'error'), node('n3', 'pending')]).acmeStatus?.[0].state).toBe('error');
    expect(aggregateNodeStates([node('n1', 'valid')]).acmeStatus?.[0].state).toBe('valid');
  });

  it('badges only pending and failing certificates', () => {
    expect(renderToStaticMarkup(createElement(AcmeBadge, { state: 'error' }))).toContain('ACME 失敗');
    expect(renderToStaticMarkup(createElement(AcmeBadge, { state: 'pending' }))).toContain('ACME 取得待ち');
    expect(renderToStaticMarkup(createElement(AcmeBadge, { state: 'valid' }))).toBe('');
    expect(renderToStaticMarkup(createElement(AcmeBadge, { state: null }))).toBe('');
  });
});

describe('rule detail (AcmeStatus)', () => {
  const render = (props: Parameters<typeof AcmeStatus>[0]) => renderToStaticMarkup(createElement(AcmeStatus, props));

  it('shows the stand-in clearly while the certificate is not issued', () => {
    const html = render({ status: status({ state: 'pending' }), reported: true, ruleState: 'running', nowMs: NOW });
    expect(html).toContain('取得待ち');
    expect(html).toContain('data-testid="acme-stand-in"');
    expect(html).toContain('rproxy ACME placeholder');
  });

  it('shows the expiry, the renewal time, the next attempt and the last error', () => {
    const html = render({ status: status({ state: 'error', not_after: '2026-12-01T00:00:00Z', renew_at: '2026-11-01T00:00:00Z', next_attempt: '2026-10-06T01:00:00Z', error: 'dns: timeout' }),
      reported: true, ruleState: 'running', nowMs: NOW });
    for (const s of ['失敗', '期限', '更新の予定', '次の試み', '最後の誤り', 'dns: timeout', 'それまでの証明書を期限まで使い続けます']) expect(html).toContain(s);
    expect(html).not.toContain('acme-stand-in');
    const valid = render({ status: status({ not_after: '2026-12-01T00:00:00Z', renew_at: '2026-11-01T00:00:00Z' }), reported: true, ruleState: 'running', nowMs: NOW });
    expect(valid).toContain('有効');
    expect(valid).not.toContain('acme-stand-in');
  });

  it('says an older rproxy does not support ACME, and waits for the rule otherwise', () => {
    expect(render({ status: undefined, reported: false, ruleState: 'failed' })).toContain(ACME_UNSUPPORTED_NOTE);
    expect(render({ status: undefined, reported: false, ruleState: 'paused' })).toContain('ルールが rproxy で動いているときに出ます');
  });
});

describe('form (AcmeCertificateEditor)', () => {
  const render = (acme: string, domainsText: string) => renderToStaticMarkup(createElement(AcmeCertificateEditor, {
    index: 0, info: INFO, row: { acme, domainsText }, onChange: () => undefined, onRemove: () => undefined,
  }));

  it('lists the resolvers with their challenge, and the allowed names of the account and the DNS provider', () => {
    const html = render('dns', '*.example.test');
    expect(html).toContain('id="rule-cert-0-acme"');
    expect(html).toContain('http（http-01（80 番の HTTP で確かめる））');
    expect(html).toContain('dns（dns-01');
    expect(html).toContain('**.example.test, example.test');
    expect(html).toContain('DNS のプロバイダ <span class="font-mono">pdns</span>');
    expect(html).not.toContain('acme-domains-error');
  });

  it('shows the problem as the names are typed (wildcards need dns-01, allowlists)', () => {
    expect(render('alpn', '*.example.test')).toContain('dns-01 の resolver でだけ取れます');
    expect(render('http', 'www.evil.example')).toContain('アカウント test で取ってよい名前');
    expect(render('http', '')).not.toContain('acme-domains-error');
    // 設定から消えた resolver も選んだまま残す
    expect(render('gone', 'example.test')).toContain('gone（設定にない resolver）');
  });
});

describe("rproxy's refusals (explainError)", () => {
  it('explains the allowlist, wildcard, resolver, scope and protocol errors of rproxy', () => {
    const cases: [string, string, RegExp][] = [
      ['invalid', 'acme domains: "www.evil.example" is not in allowed_names of account "test"', /アカウント test で取ってよい名前/],
      ['invalid', 'acme domains: "other.example.test" is not in allowed_names of dns provider "relay"', /DNS のプロバイダ relay で証明してよい名前/],
      ['invalid', 'acme domains: the wildcard "*.example.test" needs a resolver with challenge dns-01', /dns-01 の resolver を選んでください/],
      ['invalid', 'acme resolver "nope" is not defined in global.acme.resolvers', /resolver nope は rproxy の設定ファイル/],
      ['invalid', 'acme resolver "le": global.acme is not configured in the settings file (RPROXY_CONFIG)', /global\.acme がない/],
      ['tls_config', 'acme certificates are for tcp rules (DTLS takes cert_file / key_file)', /TCP のルールでだけ/],
      ['unsupported', 'an acme certificate is not supported by this version', /ACME に対応していない/],
    ];
    for (const [code, detail, want] of cases) {
      const text = explainError(code, detail);
      expect(text, detail).toMatch(want);
      expect(text).toContain(`（詳細: ${detail}）`);
    }
    expect(explainError('forbidden', 'rules with acme certificates need the acme:write scope')).toContain(ACME_SCOPE_MESSAGE);
  });
});

describe('TLS settings with ACME certificates', () => {
  it('normalizes the names like rproxy and keeps ACME to tcp', () => {
    const tls = normalizeTls({ mode: 'terminate', certificates: [{ acme: 'alpn', domains: ['WWW.example.test.', 'www.example.test'] }] });
    expect(tls.certificates).toEqual([{ acme: 'alpn', domains: ['www.example.test'] }]);
    expect(() => checkTls('tcp', tls, null, 1)).not.toThrow();
    let err: unknown;
    try { checkTls('udp', tls, null, 1); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TlsError);
    expect((err as TlsError).code).toBe('tls_config');
  });

  it('round-trips ACME certificates through export and import', () => {
    const rule: ForwardRule = {
      protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 443, srcPortEnd: null, distAddr: '10.0.0.5', distPort: 8080, sourceIp: 'proxy', udpIdleSecs: 30,
      tls: { mode: 'terminate', certificates: [{ acme: 'alpn', domains: ['example.test', 'www.example.test'] }, { cert_file: '/c.pem', key_file: '/k.pem' }] },
      starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null,
    };
    const doc = JSON.parse(JSON.stringify(exportDoc([rule])));
    expect(doc.rules[0].tls.certificates[0]).toEqual({ acme: 'alpn', domains: ['example.test', 'www.example.test'] });
    const parsed = parseDoc(JSON.stringify(doc));
    const body = settingsRuleToBody(parsed.rules[0]) as { tls: unknown };
    expect(normalizeTls(body.tls)).toEqual(rule.tls);
    expect(toRproxyRule(rule).tls).toEqual(rule.tls);
  });
});
