import { describe, expect, it } from 'vitest';
import { DEFAULT_TLS, optionsJson, parseOptions } from '@/components/tls';
import { settingsRuleToBody, toRproxyRule, toSettingsRule } from '@/components/settingsdoc';
import { ruleChanges } from '@/components/history';
import type { ForwardRule } from '@/components/lib';

const rule: ForwardRule = {
  protocol: 'tcp',
  srcAddr: '0.0.0.0',
  srcPort: 8888,
  srcPortEnd: null,
  distAddr: 'example.com',
  distPort: 80,
  sourceIp: 'proxy',
  udpIdleSecs: 30,
  tls: { ...DEFAULT_TLS },
  starttls: null,
  starttlsRequired: true,
  allowFrom: [],
  http: null,
  crowdsec: false,
  targets: [],
  balance: 'round_robin',
  healthCheck: null,
};

// 一時停止（#63）：options の enabled
describe('options enabled (pause)', () => {
  it('stores only enabled: false and reads a missing key as enabled', () => {
    expect(optionsJson({ ...DEFAULT_TLS }, null, true)).toBeNull();
    const paused = optionsJson({ ...DEFAULT_TLS }, null, true, [], null, false, undefined, [], false);
    expect(JSON.parse(paused!)).toMatchObject({ enabled: false });
    expect(parseOptions(paused).enabled).toBe(false);
    expect(parseOptions(null).enabled).toBe(true);
    expect(parseOptions(JSON.stringify({ tls: { mode: 'passthrough' }, enabled: true })).enabled).toBe(true);
    expect(() => parseOptions(JSON.stringify({ enabled: 'no' }))).toThrow(/enabled/);
  });

  it('is never sent to rproxy, but exported and imported', () => {
    expect(toRproxyRule({ ...rule, enabled: false })).not.toHaveProperty('enabled');
    expect(toSettingsRule({ ...rule, enabled: false })).toMatchObject({ enabled: false });
    expect(toSettingsRule(rule)).not.toHaveProperty('enabled');
    expect(settingsRuleToBody({ protocol: 'tcp', listen_addr: '0.0.0.0', listen_port: 8888, enabled: false })).toMatchObject({ enabled: false });
  });

  it('shows pause and resume in the history diff', () => {
    expect(ruleChanges(rule, { ...rule, enabled: false })).toEqual(['状態: 有効 → 停止中']);
    expect(ruleChanges({ ...rule, enabled: false }, { ...rule, enabled: true })).toEqual(['状態: 停止中 → 有効']);
    expect(ruleChanges(rule, { ...rule, enabled: true })).toEqual([]);
  });
});
