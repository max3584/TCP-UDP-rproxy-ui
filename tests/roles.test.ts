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
    // #155: without a user role nobody is a plain user (only admins); up to v0.4.8 everyone who signed in was a user
    expect(accessOf([], roleConfig({}))).toBe('none');
    expect(accessOf(['rproxy-user'], roleConfig({}))).toBe('none');
    expect(accessOf(['rproxy-admin'], roleConfig({}))).toBe('admin');
    const cfg = roleConfig({ RPROXY_UI_USER_ROLE: 'rproxy-user' });
    expect(accessOf(['rproxy-admin'], cfg)).toBe('admin');
    expect(accessOf(['rproxy-user', 'rproxy-admin'], cfg)).toBe('admin');
    expect(accessOf(['rproxy-user'], cfg)).toBe('user');
    expect(accessOf([], cfg)).toBe('none');
    const custom = roleConfig({ RPROXY_UI_ADMIN_ROLE: 'ops', RPROXY_UI_USER_ROLE: 'dev' });
    expect([accessOf(['ops'], custom), accessOf(['dev'], custom), accessOf(['rproxy-user'], custom)]).toEqual(['admin', 'user', 'none']);
    expect(accessOf([], roleConfig({ RPROXY_UI_USER_ROLE: '' }))).toBe('none');
    expect(accessOf(['rproxy-admin'], roleConfig({ RPROXY_UI_USER_ROLE: ' ' }))).toBe('admin');
  });

  it('reads the destinations (RPROXY_UI_USER_TARGETS) and certificate names (RPROXY_UI_USER_CERTS) users may use', () => {
    expect(roleConfig({}).userTargets).toBeNull();
    expect(roleConfig({}).userCerts).toBeNull();
    const cfg = roleConfig({ RPROXY_UI_USER_TARGETS: ' 10.0.0.0/8, 192.0.2.7 ,Backend.Example.com,*.svc.example.', RPROXY_UI_USER_CERTS: 'tenant-, shared.' });
    expect(cfg.userTargets).toEqual({ cidrs: ['10.0.0.0/8', '192.0.2.7/32'], names: ['backend.example.com', '*.svc.example'] });
    expect(cfg.userCerts).toEqual(['tenant-', 'shared.']);
    for (const bad of ['10.0.0.0/33', 'a b', 'http://x', '*.', '1.2.3']) {
      expect(() => roleConfig({ RPROXY_UI_USER_TARGETS: bad }), bad).toThrow(RoleConfigError);
    }
    expect(() => roleConfig({ RPROXY_UI_USER_CERTS: 'Bad' })).toThrow(RoleConfigError);
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
