import { describe, expect, it } from 'vitest';
import { apiRuleFromRow, apiRuleFromStatus, mergeExternalRules, shadowedBy, unixSeconds } from '@/components/apirules';
import type { RproxyRuleStatus } from '@/components/rproxy';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiBadge } from '@/components/ui';

const status = (over: Partial<RproxyRuleStatus> & Record<string, unknown> = {}): RproxyRuleStatus => ({
  protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 9000, remote_addr: '10.0.0.9', remote_port: 80, state: 'running', error: null, resolved: [], connections: 0, ...over,
} as RproxyRuleStatus);

describe('API のルール', () => {
  it('rproxy の応答から', () => {
    const r = apiRuleFromStatus(status({ origin: 'api', persisted: true, created_by: 'ci', created_at: 5, labels: { a: 'b' } }), -3);
    expect(r).toMatchObject({ id: -3, origin: 'api', persisted: true, createdBy: 'ci', createdAt: 5, labels: { a: 'b' } });
  });

  it('rproxy_rules の行から（読めない spec は null）', () => {
    const row = { node: 'n', protocol: 'udp', listen_addr: '::', listen_port: 53, spec: { protocol: 'udp', listen_addr: '::', listen_port: 53, remote_addr: 'dns', remote_port: 53 }, created_by: 't', created_at: '2026-10-01 00:00:00.000' };
    expect(apiRuleFromRow(row, -1, 'missing')).toMatchObject({ origin: 'api', state: 'missing', protocol: 'udp', distAddr: 'dns', createdAt: 1790812800, stats: null });
    expect(apiRuleFromRow({ ...row, spec: '{bad' }, -1, 'unknown')).toBeNull();
    expect(unixSeconds(new Date('2026-10-01T00:00:00Z'))).toBe(1790812800);
  });

  it('一覧に足す：固定ルールはだれにでも、API のルールは api のときだけ、同じキーは足さない', () => {
    const live = [status({ origin: 'static', listen_port: 1 }), status({ origin: 'api', listen_port: 2 }), status({ listen_port: 3 })];
    const row = { node: 'n', protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 4, spec: { remote_addr: 'x', remote_port: 1 }, created_by: 't', created_at: 0 };
    expect(mergeExternalRules([], live, { api: false, stored: [row] }).map((r) => r.srcPort)).toEqual([1]);
    const all = mergeExternalRules([], live, { api: true, stored: [row, { ...row, listen_port: 2 }], live: false });
    expect(all.map((r) => [r.srcPort, r.origin, r.state, r.id])).toEqual([[1, 'static', 'running', -1], [2, 'api', 'running', -2], [3, 'api', 'running', -3], [4, 'api', 'unknown', -4]]);
    expect(mergeExternalRules([], live, { api: true, seenKeys: new Set(['tcp|0.0.0.0|2']) }).map((r) => r.srcPort)).toEqual([1, 3]);
  });

  it('UI のルールの代わりに動いているもの', () => {
    expect(shadowedBy(status())).toBeUndefined();
    expect(shadowedBy(status({ origin: 'api', created_by: 'ci' }))).toEqual({ origin: 'api', createdBy: 'ci' });
    expect(shadowedBy(status({ ruleset: 'k8s/a/b' }))).toEqual({ origin: 'dynamic', ruleset: 'k8s/a/b' });
  });

  it('バッジ', () => {
    expect(renderToStaticMarkup(createElement(ApiBadge, { rule: { origin: 'api', persisted: true } }))).toContain('>API<');
    expect(renderToStaticMarkup(createElement(ApiBadge, { rule: { origin: 'api', persisted: false } }))).toContain('保存なし');
    expect(renderToStaticMarkup(createElement(ApiBadge, { rule: { origin: 'api', ruleset: 'k8s/a' } }))).toContain('組: k8s/a');
    expect(renderToStaticMarkup(createElement(ApiBadge, { rule: { origin: 'dynamic' } }))).toBe('');
  });
});
