import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TlsError,
  checkBalancing,
  normalizeBalance,
  normalizeHealthCheck,
  normalizeTargets,
  optionsJson,
  parseOptions,
} from '@/components/tls';
import { buildBalancing, healthCheckLabel, moveRow, targetStatus, toHealthCheckRow, toRows } from '@/components/targets';
import { matchesText, ruleFromStatus, targetLabel } from '@/components/dashboard';
import RuleForm from '@/components/RuleForm';
import HttpEditor from '@/components/HttpEditor';
import { cleanHttp, validateHttp } from '@/components/httpspec';
import type { ForwardRule } from '@/components/lib';
import type { RproxyRuleStatus } from '@/components/rproxy';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof TlsError ? `${err.code}: ${err.message}` : String(err);
  }
  return 'ok';
};

describe('targets / balance / health_check', () => {
  it('normalizes targets, dropping default weight and backup', () => {
    expect(normalizeTargets([
      { addr: '10.0.0.11', port: 5432, weight: 2 },
      { addr: 'db2.internal', port: 5432, weight: 1, backup: false },
      { addr: 'fd00::3', port: 5432, backup: true },
    ])).toEqual([
      { addr: '10.0.0.11', port: 5432, weight: 2 },
      { addr: 'db2.internal', port: 5432 },
      { addr: 'fd00::3', port: 5432, backup: true },
    ]);
    expect(normalizeTargets(undefined)).toEqual([]);
  });

  it('refuses malformed targets like rproxy', () => {
    expect(code(() => normalizeTargets([{ addr: 'bad host', port: 1 }]))).toMatch(/invalid: 宛先 1 には IP アドレスかホスト名/);
    expect(code(() => normalizeTargets([{ addr: '10.0.0.1', port: 0 }]))).toMatch(/宛先 1 のポート番号/);
    expect(code(() => normalizeTargets([{ addr: '10.0.0.1', port: 1, weight: 0 }]))).toMatch(/重みは1から1000/);
    expect(code(() => normalizeTargets([{ addr: '10.0.0.1', port: 1, backup: true }]))).toMatch(/予備（backup）でない宛先/);
    expect(code(() => normalizeTargets([{ addr: '10.0.0.1', port: 1, extra: 1 }]))).toMatch(/不明な項目/);
    expect(code(() => normalizeTargets(Array.from({ length: 65 }, () => ({ addr: '10.0.0.1', port: 1 }))))).toMatch(/64 件まで/);
  });

  it('balance defaults to round_robin and health checks take durations', () => {
    expect(normalizeBalance(undefined)).toBe('round_robin');
    expect(normalizeBalance('failover')).toBe('failover');
    expect(code(() => normalizeBalance('random'))).toMatch(/round_robin \/ least_conn \/ failover/);
    expect(normalizeHealthCheck({ interval: '10s', timeout: '500ms', port: 5432 })).toEqual({ interval: '10s', timeout: '500ms', port: 5432 });
    expect(normalizeHealthCheck({ interval: '' })).toEqual({});
    expect(code(() => normalizeHealthCheck({ interval: '10 seconds' }))).toMatch(/10s・500ms・1m/);
    expect(code(() => normalizeHealthCheck({ port: 70000 }))).toMatch(/ポート番号/);
  });

  it('checks ranges, UDP health checks and health checks without targets', () => {
    const t = normalizeTargets([{ addr: '10.0.0.1', port: 65000 }, { addr: '10.0.0.2', port: 5000 }]);
    expect(code(() => checkBalancing('tcp', { targets: t, balance: 'round_robin', healthCheck: null }, 100))).toBe('ok');
    expect(code(() => checkBalancing('tcp', { targets: t, balance: 'round_robin', healthCheck: null }, 1000))).toMatch(/宛先 1 のポートにポート範囲の長さ/);
    expect(code(() => checkBalancing('udp', { targets: t, balance: 'failover', healthCheck: { interval: '5s' } }, 1))).toMatch(/UDP のルールのヘルスチェックには/);
    expect(code(() => checkBalancing('udp', { targets: t, balance: 'failover', healthCheck: { port: 22 } }, 1))).toBe('ok');
    expect(code(() => checkBalancing('tcp', { targets: [], balance: 'round_robin', healthCheck: {} }, 1))).toMatch(/宛先を複数にしたときだけ/);
  });

  it('stores targets in the options column only when used', () => {
    const tls = { mode: 'passthrough' as const };
    expect(optionsJson(tls, null, true)).toBeNull();
    const targets = [{ addr: '10.0.0.11', port: 5432 }, { addr: '10.0.0.12', port: 5432, backup: true }];
    const json = optionsJson(tls, null, true, [], null, false, { targets: targets, balance: 'round_robin', healthCheck: null });
    expect(JSON.parse(json!)).toEqual({ tls: tls, starttls: null, starttls_required: true, targets: targets });
    const lc = optionsJson(tls, null, true, [], null, false, { targets: targets, balance: 'least_conn', healthCheck: { interval: '10s' } });
    expect(JSON.parse(lc!)).toMatchObject({ targets: targets, balance: 'least_conn', health_check: { interval: '10s' } });
    expect(parseOptions(lc).balancing).toEqual({ targets: targets, balance: 'least_conn', healthCheck: { interval: '10s' } });
    // balance / health_check without targets are not written
    expect(optionsJson(tls, null, true, [], null, false, { targets: [], balance: 'failover', healthCheck: {} })).toBeNull();
  });
});

describe('form rows', () => {
  it('builds rproxy targets from rows and reports mistakes', () => {
    const rows = [
      { addr: ' 10.0.0.11 ', port: 5432 as const, weight: 3 as const, backup: false },
      { addr: 'db2.internal', port: 5432 as const, weight: '' as const, backup: true },
    ];
    expect(buildBalancing(rows, 'least_conn', { enabled: true, interval: '10s', timeout: '', port: '' }, 'tcp', 1)).toEqual({
      targets: [{ addr: '10.0.0.11', port: 5432, weight: 3 }, { addr: 'db2.internal', port: 5432, backup: true }],
      balance: 'least_conn',
      healthCheck: { interval: '10s' },
    });
    expect(buildBalancing(rows, 'round_robin', { enabled: false, interval: '10s', timeout: '', port: '' }, 'tcp', 1).healthCheck).toBeNull();
    expect(code(() => buildBalancing([{ addr: '', port: 1, weight: '', backup: false }], 'round_robin', toHealthCheckRow(null), 'tcp', 1)))
      .toMatch(/宛先 1 のアドレス を指定/);
    expect(code(() => buildBalancing([{ addr: '10.0.0.1', port: '', weight: '', backup: false }], 'round_robin', toHealthCheckRow(null), 'tcp', 1)))
      .toMatch(/宛先 1 のポート番号/);
  });

  it('round-trips rows and moves them (order matters for failover)', () => {
    const targets = [{ addr: 'a', port: 1, weight: 2 }, { addr: 'b', port: 2, backup: true }];
    expect(toRows(targets)).toEqual([{ addr: 'a', port: 1, weight: 2, backup: false }, { addr: 'b', port: 2, weight: '', backup: true }]);
    expect(moveRow(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(toHealthCheckRow({ port: 22 })).toEqual({ enabled: true, interval: '', timeout: '', port: 22 });
  });

  it('finds per-target status by address or position, tolerating missing fields', () => {
    const targets = [{ addr: '10.0.0.11', port: 5432 }, { addr: '10.0.0.12', port: 5432 }];
    expect(targetStatus(targets, undefined, 0)).toBeNull();
    expect(targetStatus(targets, [{ addr: '10.0.0.12', port: 5432, up: false }], 1)).toEqual({ addr: '10.0.0.12', port: 5432, up: false });
    expect(targetStatus(targets, [{ addr: '10.0.0.12', port: 5432, up: false }], 0)).toBeNull();
    expect(targetStatus(targets, [{ up: true }, { up: false, connections: 3 }], 1)).toEqual({ up: false, connections: 3 });
    expect(healthCheckLabel(null)).toMatch(/使わない/);
    expect(healthCheckLabel({ interval: '10s', timeout: '3s', port: 22 })).toBe('10sごと、タイムアウト 3s、ポート 22');
  });
});

describe('display', () => {
  const base = { srcPort: 5432, srcPortEnd: null, distAddr: '', distPort: 0, http: null };

  it('labels multi-target rules with the first target, the count and the method', () => {
    const targets = [{ addr: '10.0.0.11', port: 5432 }, { addr: '10.0.0.12', port: 5432 }, { addr: 'fd00::3', port: 5432 }];
    expect(targetLabel({ ...base, targets: targets, balance: 'least_conn' })).toBe('10.0.0.11:5432 ほか 2 件（最少接続）');
    expect(targetLabel({ ...base, targets: targets.slice(0, 1), balance: 'failover' })).toBe('10.0.0.11:5432（フェイルオーバー）');
    expect(targetLabel({ ...base, srcPortEnd: 5433, targets: targets.slice(2), balance: 'round_robin' })).toBe('[fd00::3]:5432-5433（ラウンドロビン）');
    expect(targetLabel({ ...base, distAddr: '10.0.0.5', distPort: 80 })).toBe('10.0.0.5:80');
  });

  it('reads targets from rproxy responses and finds rules by any target', () => {
    const status = {
      protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 5432, remote_addr: '', remote_port: 0, state: 'running', error: null,
      resolved: [], connections: 0, origin: 'static',
      targets: [{ addr: '10.0.0.11', port: 5432 }, { addr: 'db2.internal', port: 6432, weight: 2 }],
      balance: 'least_conn', health_check: { interval: '5s' },
    } as unknown as RproxyRuleStatus;
    const r = ruleFromStatus(status, -1);
    expect([r.targets.length, r.balance, r.healthCheck]).toEqual([2, 'least_conn', { interval: '5s' }]);
    expect(matchesText(r, 'db2')).toBe(true);
    expect(matchesText(r, '6432')).toBe(true);
    expect(matchesText(r, '7000')).toBe(false);
    // an unreadable shape falls back to a single target
    expect(ruleFromStatus({ ...status, targets: 'x' } as unknown as RproxyRuleStatus, -1).targets).toEqual([]);
  });
});

describe('L7 services', () => {
  const spec = {
    routes: [{ name: 'all', match: 'PathPrefix(`/`)', service: 'app' }],
    services: { app: { servers: [{ url: 'http://10.0.0.1' }, { url: 'http://10.0.0.2' }], balance: 'failover' as const } },
    middlewares: {},
  };

  it('keep balance (round_robin is the default and left out) and validate it', () => {
    expect((cleanHttp(spec).services as Record<string, Record<string, unknown>>).app.balance).toBe('failover');
    const rr = { ...spec, services: { app: { ...spec.services.app, balance: 'round_robin' as const } } };
    expect((cleanHttp(rr).services as Record<string, Record<string, unknown>>).app).not.toHaveProperty('balance');
    const bad = { ...spec, services: { app: { ...spec.services.app, balance: 'random' as never } } };
    expect(validateHttp(bad).join(' ')).toContain('振り分け方は round_robin / least_conn / failover');
  });

  it('offer the balance select when rproxy lists it (or features are unknown)', () => {
    const render = (serviceOptions: string[] | null, value = spec) => renderToStaticMarkup(createElement(HttpEditor, {
      value: value, onChange: () => undefined, middlewares: [], serviceOptions: serviceOptions, httpOptions: [], http3: false,
    }));
    expect(render(null)).toMatch(/<option value="failover" selected="">フェイルオーバー<\/option>/);
    expect(render(['balance'], { ...spec, services: { app: { servers: spec.services.app.servers } } } as never)).toContain('-balance"');
    expect(render([], { ...spec, services: { app: { servers: spec.services.app.servers } } } as never)).not.toContain('-balance"');
    // a stored balance stays visible even if rproxy does not list it
    expect(render([])).toContain('（転送先の上から順）');
  });
});

describe('RuleForm with several targets', () => {
  const render = (initialData?: ForwardRule) =>
    renderToStaticMarkup(createElement(RuleForm, { onCancel: () => undefined, onSubmit: () => undefined, initialData }));
  const multi: ForwardRule = {
    protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 5432, srcPortEnd: null, distAddr: '', distPort: 0, sourceIp: 'proxy', udpIdleSecs: 30,
    tls: { mode: 'passthrough' }, starttls: null, starttlsRequired: true, allowFrom: [], http: null, crowdsec: false,
    targets: [{ addr: '10.0.0.11', port: 5432, weight: 2 }, { addr: '10.0.0.12', port: 5432, backup: true }],
    balance: 'failover', healthCheck: { interval: '10s', port: 5432 },
  };

  it('offers to add targets on a single-target rule', () => {
    const html = render();
    expect(html).toContain('id="rule-dist-addr"');
    expect(html).toContain('宛先を追加');
    expect(html).not.toContain('data-testid="targets-editor"');
  });

  it('edits the list, the method and the health check of a multi-target rule', () => {
    const html = render(multi);
    expect(html).toContain('data-testid="targets-editor"');
    expect(html).not.toContain('id="rule-dist-addr"');
    expect(html).toContain('value="10.0.0.11"');
    expect(html).toContain('value="10.0.0.12"');
    expect(html).toMatch(/<option value="failover" selected="">フェイルオーバー<\/option>/);
    // failover ignores weights, so the weight fields are hidden
    expect(html).not.toContain('id="rule-target-weight-0"');
    expect(html).toContain('上から順に、生きている最初の宛先');
    expect(html).toContain('id="rule-hc-interval"');
    expect(html).toContain('value="10s"');
  });

  it('shows weights for round robin and least connections', () => {
    const html = render({ ...multi, balance: 'least_conn' });
    expect(html).toContain('id="rule-target-weight-0"');
    expect(html).toContain('value="2"');
  });
});
