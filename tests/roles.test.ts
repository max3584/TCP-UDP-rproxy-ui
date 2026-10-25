import { describe, expect, it } from 'vitest';
import { RoleConfigError, accessOf, certPrefixesFor, portsAllowed, roleConfig, rolesFromToken } from '@/components/roles';

const token = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('roles', () => {
  // #160：登録済みの証明書の名前の先頭を利用者（sub）・ロールごとに割り当てる
  it('reads RPROXY_UI_USER_CERTS_BY_SUB / _BY_ROLE and picks the prefixes of each user', () => {
    const none = roleConfig({});
    expect([none.userCertsBySub, none.userCertsByRole]).toEqual([null, null]);
    // 割り当てがなければ今までどおり（共通の先頭、なければ制限なし）
    expect(certPrefixesFor('user', none, 'u1', ['rproxy-user'])).toBeNull();
    expect(certPrefixesFor('user', roleConfig({ RPROXY_UI_USER_CERTS: 'shared-' }), 'u1', [])).toEqual(['shared-']);

    const cfg = roleConfig({
      RPROXY_UI_USER_CERTS_BY_ROLE: ' tenant-a:tenant-a- , tenant-a:common-, urn:corp:team:team- ',
      RPROXY_UI_USER_CERTS_BY_SUB: '5b1e-uuid:alice-,5b1e-uuid:tenant-a-',
    });
    expect(cfg.userCertsByRole).toEqual(new Map([['tenant-a', ['tenant-a-', 'common-']], ['urn:corp:team', ['team-']]]));
    expect(cfg.userCertsBySub).toEqual(new Map([['5b1e-uuid', ['alice-', 'tenant-a-']]]));
    expect(certPrefixesFor('user', cfg, 'u1', ['rproxy-user', 'tenant-a'])).toEqual(['tenant-a-', 'common-']);
    expect(certPrefixesFor('user', cfg, '5b1e-uuid', ['tenant-a', 'urn:corp:team'])).toEqual(['alice-', 'tenant-a-', 'common-', 'team-']);
    // 割り当てを設定したのに割り当てのない利用者は、共通の先頭があっても何も選べない
    expect(certPrefixesFor('user', cfg, 'u2', ['rproxy-user'])).toEqual([]);
    expect(certPrefixesFor('user', { ...cfg, userCerts: ['shared-'] }, 'u2', ['rproxy-user'])).toEqual([]);
    expect(certPrefixesFor('admin', cfg, 'u2', [])).toBeNull();
    // 先頭は - . _ で終える（tenant-a が tenant-ab-* に一致しないように）
    for (const bad of ['tenant-a', ':tenant-a-', 'tenant-a:', 'tenant-a:Bad-', 'tenant-a:a b-', 'tenant-a:tenant-a']) {
      expect(() => roleConfig({ RPROXY_UI_USER_CERTS_BY_ROLE: bad }), bad).toThrow(RoleConfigError);
      expect(() => roleConfig({ RPROXY_UI_USER_CERTS_BY_SUB: bad }), bad).toThrow(RoleConfigError);
    }
  });

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
    for (const bad of ['tenant', 'tenant-a', 'shared.x']) expect(() => roleConfig({ RPROXY_UI_USER_CERTS: bad }), bad).toThrow(RoleConfigError);
    expect(roleConfig({ RPROXY_UI_USER_CERTS: 'a-,b.,c_' }).userCerts).toEqual(['a-', 'b.', 'c_']);
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
