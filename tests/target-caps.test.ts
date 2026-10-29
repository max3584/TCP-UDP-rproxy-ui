// 宛先ごとの上限（rproxy-api #341 の targets[]・tls.routes[].targets[]・L7 の servers[] の max_connections。UI #171）
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForwardRule, ForwardRules, RuleStats } from '@/components/lib';
import type { RproxyRuleStatus } from '@/components/rproxy';
import { normalizeTargets, normalizeTls, optionsJson, parseOptions } from '@/components/tls';
import { buildBalancing, capUsageLabel, firstRow, fullTargetCount, reportsTargetHealth, rowToTarget, targetCapsOf, targetsAllFull, tlsRouteStatus, toHealthCheckRow, toRows, withoutTargetCaps } from '@/components/targets';
import { buildRouteSpec, routeRow } from '@/components/RuleForm';
import TargetsEditor, { RouteTargetsEditor } from '@/components/TargetsEditor';
import HttpEditor from '@/components/HttpEditor';
import HttpSummary, { serverStatus } from '@/components/HttpSummary';
import { cleanHttp, toHttpRules, validateHttp } from '@/components/httpspec';
import { ruleDrift } from '@/components/drift';
import { ruleChanges } from '@/components/history';
import { formatTargetsText, normalizeOverride, parseTargetsText } from '@/components/overrides';
import { exportDoc, parseDoc, settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { needsAttention, targetFullProblem } from '@/components/dashboard';

const message = (f: () => unknown): string => {
  try {
    f();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
};

const base: ForwardRule = {
  protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 5432, srcPortEnd: null, distAddr: '', distPort: 0,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [],
  http: null, crowdsec: false, balance: 'failover', healthCheck: null, extraListenAddrs: [],
  targets: [{ addr: '10.0.0.11', port: 5432, max_connections: 200 }, { addr: '10.0.0.12', port: 5432, max_connections: 200 }, { addr: '10.0.0.13', port: 5432, backup: true }],
};

describe('targets[].max_connections: checked like rproxy and kept everywhere the targets go', () => {
  it('accepts an integer of at least 1 and refuses others', () => {
    expect(normalizeTargets([{ addr: 'a', port: 1, max_connections: 1 }])).toEqual([{ addr: 'a', port: 1, max_connections: 1 }]);
    expect(normalizeTargets([{ addr: 'a', port: 1, max_connections: null }])).toEqual([{ addr: 'a', port: 1 }]);
    for (const bad of [0, -1, 1.5, '10', 4294967296]) {
      expect(message(() => normalizeTargets([{ addr: 'a', port: 1, max_connections: bad }]))).toMatch(/宛先 1 の同時接続の上限は1以上の整数/);
    }
    // tls.routes[].targets も同じ
    const tls = normalizeTls({ mode: 'sni', routes: [{ server_name: 'a.example.com', targets: [{ addr: '10.0.0.1', port: 443, max_connections: 5 }, { addr: '10.0.0.2', port: 443 }] }] });
    expect(tls.routes?.[0].targets?.[0]).toEqual({ addr: '10.0.0.1', port: 443, max_connections: 5 });
    expect(message(() => normalizeTls({ mode: 'sni', routes: [{ server_name: 'a', targets: [{ addr: '10.0.0.1', port: 443, max_connections: 0 }] }] }))).toMatch(/同時接続の上限/);
  });

  it('is stored in the options column and read back', () => {
    const json = optionsJson(base.tls, null, true, [], null, false, { targets: base.targets, balance: 'failover', healthCheck: null });
    expect(JSON.parse(json!).targets[0]).toEqual({ addr: '10.0.0.11', port: 5432, max_connections: 200 });
    expect(parseOptions(json).balancing.targets).toEqual(base.targets);
  });

  it('is sent to rproxy, exported and imported unchanged', () => {
    expect(toRproxyRule(base).targets).toEqual(base.targets);
    const exported = toSettingsRule(base);
    expect(exported.targets).toEqual(base.targets);
    const doc = parseDoc(JSON.stringify(exportDoc([base], '2026-01-01T00:00:00Z')));
    const body = settingsRuleToBody(doc.rules[0]);
    expect(body.targets).toEqual(base.targets);
  });

  it('form rows carry the cap (empty is no cap)', () => {
    const rows = toRows(base.targets);
    expect(rows.map((r) => r.maxConnections)).toEqual([200, 200, '']);
    expect(rowToTarget({ ...firstRow('10.0.0.1', 80), maxConnections: '' })).toEqual({ addr: '10.0.0.1', port: 80 });
    expect(buildBalancing(rows, 'failover', toHealthCheckRow(null), 'tcp', 1).targets).toEqual(base.targets);
    expect(message(() => buildBalancing([{ ...rows[0], maxConnections: 0 }, rows[1]], 'failover', toHealthCheckRow(null), 'tcp', 1))).toMatch(/同時接続の上限/);
    // tls.routes の行も書き戻す
    const route = routeRow({ server_name: 'a.example.com', targets: [{ addr: '10.0.0.1', port: 443, max_connections: 7 }, { addr: '10.0.0.2', port: 443 }], balance: 'failover' });
    const spec = buildRouteSpec(route, { protocol: 'tcp', tlsMode: 'sni', l7: false, routeSourceIpEditable: false, routeUpstreamEditable: false });
    expect(spec.targets).toEqual([{ addr: '10.0.0.1', port: 443, max_connections: 7 }, { addr: '10.0.0.2', port: 443 }]);
  });

  it('per-node overrides write it as max=N', () => {
    const text = '10.0.0.1:80 2 max=50\n[2001:db8::1]:80 backup';
    expect(parseTargetsText(text)).toEqual([{ addr: '10.0.0.1', port: 80, weight: 2, max_connections: 50 }, { addr: '2001:db8::1', port: 80, backup: true }]);
    expect(formatTargetsText(parseTargetsText(text))).toBe(text);
    expect(message(() => parseTargetsText('10.0.0.1:80 max=x'))).toMatch(/max=上限/);
    const ov = normalizeOverride({ targets: [{ addr: '10.0.0.1', port: 80, max_connections: 9 }] }, base);
    expect(ov?.targets).toEqual([{ addr: '10.0.0.1', port: 80, max_connections: 9 }]);
  });
});

describe('servers[].max_connections (L7)', () => {
  const http = (servers: unknown[]) => toHttpRules({ routes: [{ name: 'a', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers } } });

  it('is checked like rproxy (at least 1, not on a status entry) and kept by cleanHttp', () => {
    expect(validateHttp(http([{ url: 'http://10.0.0.1:80', max_connections: 10 }]))).toEqual([]);
    expect(validateHttp(http([{ url: 'http://10.0.0.1:80', max_connections: 0 }])).join(' ')).toContain('同時に処理する上限は 1 以上の整数');
    expect(validateHttp(http([{ url: 'http://10.0.0.1:80', max_connections: 2.5 }])).join(' ')).toContain('同時に処理する上限は 1 以上の整数');
    expect(validateHttp(http([{ status: 503, max_connections: 5 }])).join(' ')).toContain('状態コードで答える転送先には、同時に処理する上限を付けられません');
    expect(cleanHttp(http([{ url: 'http://10.0.0.1:80', max_connections: 10 }])).services).toEqual({ s: { servers: [{ url: 'http://10.0.0.1:80', max_connections: 10 }] } });
  });

  it('the editor has the field only when rproxy lists target_max_connections, and keeps the value read-only otherwise', () => {
    const value = http([{ url: 'http://10.0.0.1:80', max_connections: 10 }]);
    const render = (targetCaps: boolean) => renderToStaticMarkup(createElement(HttpEditor, {
      value, onChange: () => undefined, http3: false, httpOptions: null, serviceOptions: null, middlewares: null, targetCaps,
    }));
    expect(render(true)).toMatch(/aria-label="サービス s の転送先 1 の同時に処理する上限"[^>]*value="10"/);
    const locked = render(false);
    expect(locked).not.toContain('同時に処理する上限"');
    expect(locked).toMatch(/data-testid="http-preserved">同時に処理する上限: <span class="font-mono">10<\/span>/);
  });

  it('the summary shows requests in progress against the cap and the full badge', () => {
    const spec = cleanHttp(http([{ url: 'http://10.0.0.1:80', max_connections: 10 }, { url: 'http://10.0.0.2:80' }]));
    const live = { s: [{ url: 'http://10.0.0.1:80', up: true, max_connections: 10, in_flight: 10, full: true }, { url: 'http://10.0.0.2:80', up: true }] };
    const html = renderToStaticMarkup(createElement(HttpSummary, { http: spec, services: live }));
    expect(html).toContain('（処理中 10 / 10）');
    expect(html).toContain('data-testid="target-full"');
    const idle = renderToStaticMarkup(createElement(HttpSummary, { http: spec }));
    expect(idle).toContain('（上限 10）');
    expect(idle).not.toContain('target-full');
    expect(serverStatus([{ url: 'http://b' }], [{ url: 'http://a' }, { url: 'http://b', in_flight: 1 }], 0)).toEqual({ url: 'http://b', in_flight: 1 });
  });
});

describe('TargetsEditor / RouteTargetsEditor', () => {
  const rows = toRows(base.targets);
  const props = {
    protocol: 'tcp' as const, rows, onRowsChange: () => undefined, balance: 'failover' as const, onBalanceChange: () => undefined,
    healthCheck: toHealthCheckRow(null), onHealthCheckChange: () => undefined, range: false, onSingle: () => undefined, error: '',
  };

  it('edits the cap with target_max_connections, and shows it read-only (kept) without', () => {
    const editable = renderToStaticMarkup(createElement(TargetsEditor, { ...props, capsEditable: true }));
    expect(editable).toMatch(/id="rule-target-max-0"[^>]*value="200"/);
    expect(editable).toMatch(/id="rule-target-max-2"[^>]*value=""/);
    const locked = renderToStaticMarkup(createElement(TargetsEditor, { ...props, capsEditable: false }));
    expect(locked).not.toContain('rule-target-max-');
    expect(locked).toContain('data-testid="target-max-preserved"');
    expect(locked).toContain('この rproxy では宛先ごとの上限を使えないので編集できません');
  });

  it('route targets have the same field', () => {
    const rp = { index: 0, rows, balance: 'failover' as const, editable: true, onChange: () => undefined, onSingle: () => undefined };
    expect(renderToStaticMarkup(createElement(RouteTargetsEditor, { ...rp, capsEditable: true }))).toMatch(/aria-label="転送先 1 の宛先 1 の同時接続の上限"[^>]*value="200"/);
    expect(renderToStaticMarkup(createElement(RouteTargetsEditor, { ...rp, capsEditable: false }))).toContain('data-testid="route-target-max-preserved"');
    expect(renderToStaticMarkup(createElement(RouteTargetsEditor, { ...rp, editable: false, capsEditable: false }))).toContain('10.0.0.11:5432 max=200');
  });
});

describe('drift and history show cap changes on their own', () => {
  function live(rule: ForwardRule, patch: Partial<RproxyRuleStatus> = {}): RproxyRuleStatus {
    return {
      listen_port_end: null, starttls: null, allow_from: [], crowdsec: false, udp_idle_secs: 30, remote_addr: '', remote_port: 0,
      ...toRproxyRule(rule),
      state: 'running', error: null, resolved: [], connections: 0, stats: { total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0 }, started_at: 1, origin: 'dynamic',
      ...patch,
    } as RproxyRuleStatus;
  }

  it('a node running another cap drifts in target_max_connections only', () => {
    expect(ruleDrift(base, live(base))).toEqual([]);
    const other = { ...base, targets: base.targets.map((t, i) => (i === 0 ? { ...t, max_connections: 100 } : t)) };
    expect(ruleDrift(base, live(other))).toEqual(['target_max_connections']);
    const none = { ...base, targets: base.targets.map(({ addr, port, backup }) => ({ addr, port, ...(backup ? { backup } : {}) })) };
    expect(ruleDrift(base, live(none))).toEqual(['target_max_connections']);
    // L7 の転送先の上限も（http の違いにはしない）
    const l7: ForwardRule = { ...base, targets: [], balance: 'round_robin', http: { routes: [{ name: 'a', match: 'PathPrefix(`/`)', service: 's' }], services: { s: { servers: [{ url: 'http://10.0.0.1:80', max_connections: 3 }] } } } };
    const l7Live = { ...l7, http: { ...l7.http, services: { s: { servers: [{ url: 'http://10.0.0.1:80' }] } } } } as ForwardRule;
    expect(ruleDrift(l7, live(l7Live))).toEqual(['target_max_connections']);
  });

  it('the history says the caps changed', () => {
    const other = { ...base, targets: base.targets.map((t, i) => (i === 1 ? { ...t, max_connections: 50 } : t)) };
    expect(ruleChanges(base, other)).toEqual(['宛先ごとの上限を変更']);
    expect(ruleChanges(base, base)).toEqual([]);
  });

  it('withoutTargetCaps / targetCapsOf', () => {
    expect(withoutTargetCaps(base).targets.some((t) => 'max_connections' in t)).toBe(false);
    expect(targetCapsOf({ ...base, targets: [{ addr: 'a', port: 1 }] })).toBeNull();
    expect(targetCapsOf(base)).toEqual({ targets: [200, 200, 0], routes: [], servers: {} });
  });
});

describe('state: full targets', () => {
  const stats = (targets: RuleStats['targets'], http?: RuleStats['http']): RuleStats => ({ total_connections: 0, rx_bytes: 0, tx_bytes: 0, tls_failures: 0, targets, ...(http ? { http } : {}) });

  it('all full (or down) means new connections are refused', () => {
    expect(targetsAllFull(stats([{ full: true, up: true }, { full: true, up: true }]))).toBe(true);
    expect(targetsAllFull(stats([{ full: true, up: true }, { up: false }]))).toBe(true);
    expect(targetsAllFull(stats([{ full: true, up: true }, { up: true }]))).toBe(false);
    expect(targetsAllFull(stats([{ up: false }]))).toBe(false);
    expect(targetsAllFull(null)).toBe(false);
    const l7 = stats(undefined, { requests: 0, by_status: {}, routes: {}, services: { s: [{ url: 'http://a', up: true, max_connections: 1, in_flight: 1, full: true }] } });
    expect(targetsAllFull(l7)).toBe(true);
    expect(fullTargetCount(stats([{ full: true }, { full: false }]))).toBe(1);
    // up の宛先がすべていっぱいなら、down の宛先（いっぱいでない）は試さずに断る。up がなければ、いっぱいでない down の宛先を試す
    expect(targetsAllFull(stats([{ full: true, up: true }, { full: false, up: false }]))).toBe(true);
    expect(targetsAllFull(stats([{ full: true, up: false }, { full: false, up: false }]))).toBe(false);
    expect(targetsAllFull(stats([{ full: true, up: false }]))).toBe(true);
    // サーバ名ごとの転送先（stats.tls_routes）
    const routes = { ...stats(undefined), tls_routes: [{ server_names: ['a.example'], targets: [{ up: true, full: true }] }, { server_names: ['b.example'], targets: [{ up: true, full: false }] }] };
    expect(targetsAllFull(routes)).toBe(true);
    expect(fullTargetCount(routes)).toBe(1);
    expect(tlsRouteStatus(['B.example'], routes.tls_routes, 0)).toBe(routes.tls_routes[1]);
    expect(tlsRouteStatus(['c.example'], routes.tls_routes, 0)).toBeNull();
    expect(capUsageLabel(3, 200)).toBe('3 / 200');
    expect(capUsageLabel(1234, undefined)).toBe('1,234');
    expect(capUsageLabel(undefined, undefined)).toBeNull();
  });

  it('a single target without a health check reports only its cap state', () => {
    expect(reportsTargetHealth({ targets: [{ addr: 'a', port: 1, max_connections: 5 }], healthCheck: null })).toBe(false);
    expect(reportsTargetHealth({ targets: [{ addr: 'a', port: 1, max_connections: 5 }], healthCheck: {} })).toBe(true);
    expect(reportsTargetHealth(base)).toBe(true);
  });

  it('a running rule with every target full needs attention', () => {
    const rule = (id: number, s: RuleStats): ForwardRules => ({
      ...base, id, origin: 'dynamic', state: 'running', error: null, connections: 0, stats: s, startedAt: 1, resolved: [],
    } as ForwardRules);
    const full = rule(1, stats([{ full: true, up: true }, { full: true, up: true }]));
    const ok = rule(2, stats([{ full: true, up: true }, { up: true }]));
    expect(needsAttention([ok, full]).map((r) => r.id)).toEqual([1]);
    expect(targetFullProblem(full)).toContain('すべての宛先が同時接続の上限');
    expect(targetFullProblem(ok)).toBeNull();
  });
});
