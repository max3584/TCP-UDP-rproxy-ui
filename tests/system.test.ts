import { describe, expect, it } from 'vitest';
import { nodeSystemView } from '@/components/system';

describe('rproxy の機能と設定（/system）', () => {
  it('v0.4 の rproxy の features と performance と設定ファイル', () => {
    const v = nodeSystemView('n1', {
      version: '0.4.0', source_ip: ['proxy'], build: { version: '0.4.0', sha256: 'ab' },
      features: { http: true, http3: true, acme: true, tls_options: true, middlewares: ['geoip'], services: ['outlier_detection'], limits: true, dry_run: false, performance: ['workers'] },
    }, { configured: true, path: '/etc/rproxy/rproxy.yaml', rules: 3, error: null, restart_needed: ['global.performance'] }, null);
    expect(v.reachable).toBe(true);
    expect(v.features?.limits).toBe(true);
    expect(v.features?.dry_run).toBe(false);
    expect(v.features?.handoff).toBe(false);
    expect(v.performance).toEqual(['workers']);
    expect(v.config).toEqual({ readable: true, configured: true, path: '/etc/rproxy/rproxy.yaml', rules: 3, error: null, restartNeeded: ['global.performance'] });
    expect(v.build?.sha256).toBe('ab');
  });

  it('v0.3 の rproxy・届かない rproxy・設定ファイルを読めない', () => {
    const old = nodeSystemView('n1', { version: '0.3.21', source_ip: ['proxy'], features: { http: true, http3: true, acme: true, tls_options: true, middlewares: [] } }, null, null);
    expect(old.features).toBeNull();
    expect(old.performance).toBeNull();
    expect(old.config.readable).toBe(false);
    const down = nodeSystemView('n2', null, null, 'rproxy に接続できません');
    expect(down.reachable).toBe(false);
    expect(down.error).toBe('rproxy に接続できません');
  });
});
