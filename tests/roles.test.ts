import { describe, expect, it } from 'vitest';
import { RoleConfigError, accessOf, portsAllowed, roleConfig, rolesFromToken } from '@/components/roles';

const token = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('roles', () => {
  it('reads roles from realm_access.roles by default, or a configured claim', () => {
    const t = token({ realm_access: { roles: ['rproxy-user', 1] }, resource_access: { ui: { roles: ['rproxy-admin'] } } });
    expect(rolesFromToken(t, roleConfig({}).claim)).toEqual(['rproxy-user']);
    expect(rolesFromToken(t, 'resource_access.ui.roles')).toEqual(['rproxy-admin']);
    expect(rolesFromToken(t, 'nope.roles')).toEqual([]);
    expect(rolesFromToken('garbage', 'realm_access.roles')).toEqual([]);
  });

  it('decides admin, user or none', () => {
    const cfg = roleConfig({});
    expect(accessOf(['rproxy-admin'], cfg)).toBe('admin');
    expect(accessOf(['rproxy-user', 'rproxy-admin'], cfg)).toBe('admin');
    expect(accessOf(['rproxy-user'], cfg)).toBe('user');
    expect(accessOf([], cfg)).toBe('none');
    const custom = roleConfig({ RPROXY_UI_ADMIN_ROLE: 'ops', RPROXY_UI_USER_ROLE: 'dev' });
    expect([accessOf(['ops'], custom), accessOf(['dev'], custom), accessOf(['rproxy-user'], custom)]).toEqual(['admin', 'user', 'none']);
    expect(accessOf([], roleConfig({ RPROXY_UI_USER_ROLE: '' }))).toBe('user');
  });

  it('limits user ports when RPROXY_UI_USER_PORTS is set', () => {
    expect(roleConfig({}).userPorts).toBeNull();
    const cfg = roleConfig({ RPROXY_UI_USER_PORTS: ' 1024 - 65535 ' });
    expect(cfg.userPorts).toEqual([1024, 65535]);
    expect(portsAllowed('user', cfg, 1024, 2000)).toBe(true);
    expect(portsAllowed('user', cfg, 443, 443)).toBe(false);
    expect(portsAllowed('user', cfg, 1000, 1100)).toBe(false);
    expect(portsAllowed('admin', cfg, 443, 443)).toBe(true);
    expect(roleConfig({ RPROXY_UI_USER_PORTS: '8080' }).userPorts).toEqual([8080, 8080]);
    for (const bad of ['0-10', '10-5', 'abc', '1-70000']) {
      expect(() => roleConfig({ RPROXY_UI_USER_PORTS: bad })).toThrow(RoleConfigError);
    }
  });
});
