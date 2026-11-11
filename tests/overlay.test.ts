// 固定ルールに重ねる分（rproxy-api v0.4.23 の #397、UI #193）の純粋な部分（components/overlay.ts）
import { describe, expect, it } from 'vitest';
import {
  coversPattern,
  fileItemsUsed,
  fileNames,
  fileSecretItems,
  forwardingIdentityProblems,
  isEmptyOverlay,
  isForwardingHeader,
  overlayAsRule,
  overlayChanges,
  overlayConflicts,
  overlayFromLogOptions,
  overlayShape,
  overlaySpecOf,
  restoreHidden,
  secretFileItemsUsed,
} from '@/components/overlay';
import { overlayProblems } from '@/components/OverlayEditor';
import type { ForwardRules } from '@/components/lib';

const fileHttp = {
  routes: [{ name: 'site', match: 'Host(`a.example.com`)', service: 'web', middlewares: ['auth'] }],
  services: {
    web: { servers: [{ url: 'http://10.0.0.5:80' }] },
    // クライアントの鍵を持つ
    secure: { servers: [{ url: 'https://10.0.0.6' }], tls: { cert_file: '/etc/c.pem', key_file: '/etc/c.key' } },
    // 秘密を持つミドルウェアを転送先ごとに使う
    via: { servers: [{ url: 'http://10.0.0.8', middlewares: ['hdr'] }] },
  },
  middlewares: {
    auth: { basic_auth: { users_file: '/etc/users' } },
    sso: { oidc: { issuer: 'https://id.example.com', client_id: 'x', client_secret_file: '/etc/oidc' } },
    hdr: { headers: { request: { set: { 'X-A': '1' } } } },
    // 秘密のサービスに写しを送る
    copy: { mirror: { service: 'secure' } },
  },
};

const rule = (over: Partial<ForwardRules> = {}): ForwardRules => ({
  id: -1, origin: 'static', protocol: 'tcp', srcAddr: '0.0.0.0', srcPort: 8443, srcPortEnd: null, distAddr: '', distPort: 0,
  sourceIp: 'proxy', udpIdleSecs: 30, tls: { mode: 'terminate', certificates: [{ cert_file: '/c', key_file: '/k' }] }, starttls: null, starttlsRequired: true,
  allowFrom: [], http: fileHttp as never, crowdsec: false, targets: [], balance: 'round_robin', healthCheck: null, extraListenAddrs: [],
  state: 'running', error: null, connections: 0, stats: null, startedAt: null, resolved: [], ...over,
}) as ForwardRules;

describe('overlay shape (rproxy の merge と同じ条件)', () => {
  it('http needs an http rule; tls.routes need sni, or terminate without http and client_auth', () => {
    expect(overlayShape(rule())).toEqual({ http: true, tlsRoutes: false });
    expect(overlayShape(rule({ http: null, tls: { mode: 'sni' } }))).toEqual({ http: false, tlsRoutes: true });
    expect(overlayShape(rule({ http: null }))).toEqual({ http: false, tlsRoutes: true });
    expect(overlayShape(rule({ http: null, tls: { mode: 'terminate', client_auth: { mode: 'required', ca_file: '/ca' } } as never }))).toEqual({ http: false, tlsRoutes: false });
    expect(overlayShape(rule({ http: null, tls: { mode: 'passthrough' } }))).toEqual({ http: false, tlsRoutes: false });
  });
});

describe('names the settings file has', () => {
  it('finds routes, services, middlewares and covered server names (409 overlay_conflict)', () => {
    const names = fileNames(rule({ tls: { mode: 'sni', routes: [{ server_name: '*.wild.test', remote_addr: '10.0.0.1', remote_port: 443 }, { server_names: ['**.deep.test'], remote_addr: '10.0.0.2', remote_port: 443 }] } }));
    expect(names.services).toEqual(['web', 'secure', 'via']);
    const c = overlayConflicts(names, {
      http: { routes: [{ name: 'site', match: 'Path(`/`)' }], services: { web: { servers: [] } }, middlewares: { hdr: {} } },
      tls: { routes: [{ server_name: 'x.wild.test' }, { server_name: 'y.x.wild.test' }, { server_name: '*.a.deep.test' }, { server_name: 'ok.test' }] },
    });
    expect(c.map((x) => `${x.kind}:${x.name}`)).toEqual(['route:site', 'service:web', 'middleware:hdr', 'tls_route:x.wild.test', 'tls_route:*.a.deep.test']);
  });

  it('covers like rproxy (core::overlay::covers)', () => {
    expect(coversPattern('*.wild.test', 'x.wild.test')).toBe(true);
    expect(coversPattern('*.wild.test', 'x.y.wild.test')).toBe(false);
    expect(coversPattern('**.test', '*.a.test')).toBe(true);
    expect(coversPattern('**.test', '**.a.test')).toBe(true);
    expect(coversPattern('**.a.test', '*.a.test')).toBe(true);
    expect(coversPattern('*.a.test', '**.a.test')).toBe(false);
    expect(coversPattern('a.test', '*.test')).toBe(false);
    expect(coversPattern('A.test', 'a.test')).toBe(true);
    expect(coversPattern('**.test', 'x.y.test')).toBe(true);
  });
});

describe('file items holding secrets (409 file_in_use for non-admins)', () => {
  it('marks services with a client key, oidc / basic_auth secrets, and what reaches them', () => {
    expect(fileSecretItems(fileHttp)).toEqual({ services: ['secure'], middlewares: ['auth', 'sso', 'copy'] });
  });

  it('follows what the overlay uses by name (its own names first)', () => {
    const names = fileNames(rule());
    const spec = {
      http: {
        routes: [{ name: 'r1', match: 'Path(`/x`)', service: 'secure', middlewares: ['hdr', 'mine'] }, { name: 'r2', match: 'Path(`/y`)', service: 'web' }],
        middlewares: { mine: { mirror: { service: 'secure' } } },
      },
    };
    expect(fileItemsUsed(spec, names)).toEqual({ services: ['secure', 'web'], middlewares: ['hdr'] });
    expect(secretFileItemsUsed(spec, names, fileSecretItems(fileHttp))).toEqual({ services: ['secure'], middlewares: [] });
    // 重ねる分が同じ名前を定義していれば（PUT は断られる）、ファイルのものとは数えない
    expect(fileItemsUsed({ http: { routes: [{ name: 'r', match: 'Path(`/`)', service: 'web' }], services: { web: { servers: [] } } } }, names).services).toEqual([]);
  });
});

describe('forwarding headers are not identity headers (rproxy 400 invalid)', () => {
  it('refuses them in basic_auth user_header and forward_auth response_headers', () => {
    expect(isForwardingHeader('X-Forwarded-For')).toBe(true);
    expect(isForwardingHeader('x_real_ip')).toBe(true);
    expect(isForwardingHeader('X-User')).toBe(false);
    const p = forwardingIdentityProblems({
      a: { basic_auth: { users_file: '/u', user_header: 'X-Forwarded-For' } },
      b: { forward_auth: { address: 'http://auth', response_headers: ['X-User', 'Forwarded'] } },
      c: { basic_auth: { user_header: 'X-User' } },
    });
    expect(p).toHaveLength(2);
    expect(p[0]).toContain('X-Forwarded-For');
    expect(p[1]).toContain('Forwarded');
  });
});

describe('the body and history', () => {
  it('keeps only what PUT takes and knows an empty overlay', () => {
    const view = { rule: 'tcp/0.0.0.0/8443', state: 'applied', etag: '"o-1"', http: { routes: [{ name: 'w', match: 'Path(`/`)' }], services: {}, middlewares: {} }, tls: { routes: [] } };
    expect(overlaySpecOf(view)).toEqual({ http: { routes: [{ name: 'w', match: 'Path(`/`)' }] } });
    expect(isEmptyOverlay({ http: { routes: [] }, tls: { routes: [] } })).toBe(true);
  });

  it('describes changes by kind and reads the log row', () => {
    const a = { http: { routes: [{ name: 'w', match: 'Path(`/`)' }], services: { s: { servers: [{ url: 'http://10.0.0.1' }] } } } };
    const b = { http: { routes: [{ name: 'w', match: 'Path(`/w`)' }, { name: 'x', match: 'Path(`/x`)' }] }, tls: { routes: [{ server_name: 'git.test', remote_addr: '10.0.0.2', remote_port: 22 }] } };
    expect(overlayChanges(null, a)).toEqual(['ルートを追加: w', 'サービスを追加: s']);
    expect(overlayChanges(a, b)).toEqual(['ルートを追加: x', 'ルートを変更: w', 'サービスを削除: s', 'サーバ名ごとの転送先を追加: git.test']);
    expect(overlayChanges(a, null)).toEqual(['重ねる分を外しました']);
    expect(overlayFromLogOptions('{"overlay":null}')).toBeNull();
    expect(overlayFromLogOptions({ overlay: a })).toEqual(a);
    expect(overlayFromLogOptions('{"tls":{}}')).toBeUndefined();
    expect(overlayFromLogOptions('not json')).toBeUndefined();
  });

  it('puts hidden file paths back from the same place, or names where it cannot', () => {
    const current = { http: { middlewares: { auth: { basic_auth: { users_file: '/etc/users' } } } } };
    const ok = restoreHidden({ http: { middlewares: { auth: { basic_auth: { users_file: '<hidden>', realm: 'r' } } } } }, current, '<hidden>');
    expect(ok.missing).toEqual([]);
    expect(ok.value.http.middlewares.auth.basic_auth.users_file).toBe('/etc/users');
    const moved = restoreHidden({ http: { middlewares: { renamed: { basic_auth: { users_file: '<hidden>' } } } } }, current, '<hidden>');
    expect(moved.missing).toEqual(['http.middlewares.renamed.basic_auth.users_file']);
  });

  it('gives the overlay as a rule for the user checks (no file routes, no file targets)', () => {
    const r = overlayAsRule(rule(), { tls: { routes: [{ server_name: 'n.test', remote_addr: '10.0.0.3', remote_port: 443 }] } });
    expect(r.http).toBeNull();
    expect(r.tls).toEqual({ mode: 'terminate', routes: [{ server_name: 'n.test', remote_addr: '10.0.0.3', remote_port: 443 }] });
    expect(r.srcPort).toBe(8443);
  });
});

describe('the editor checks before saving (overlayProblems)', () => {
  it('reports name conflicts, merged http errors and forwarding identity headers, not the file errors', () => {
    const p = overlayProblems(rule(), {
      http: {
        routes: [{ name: 'site', match: 'Path(`/`)', service: 'web' }, { name: 'n', match: 'Path(`/n`)', service: 'nope' }],
        middlewares: { ba: { basic_auth: { user_header: 'X-Real-IP' } } },
      },
    });
    expect(p.some((x) => x.includes('site'))).toBe(true);
    expect(p.some((x) => x.includes('nope'))).toBe(true);
    expect(p.some((x) => x.includes('X-Real-IP'))).toBe(true);
    // ファイルのサービス・ミドルウェアを名前で使うのはよい
    expect(overlayProblems(rule(), { http: { routes: [{ name: 'n', match: 'Path(`/n`)', service: 'web', middlewares: ['hdr'] }] } })).toEqual([]);
  });
});
