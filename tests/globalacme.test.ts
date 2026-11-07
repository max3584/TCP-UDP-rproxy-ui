// global の geoip・acme のフォーム（components/globalacme.ts。rproxy-api v0.4.22 の PATCH /config/global、#345。UI #189）と、
// 印のない rproxy での読み取り専用・秘密の伏せ方（components/globalsettings.ts）
import { describe, expect, it } from 'vitest';
import {
  GlobalPatchError, apiDirFile, buildAcme, buildGeoip, emptyAccount, emptyProvider, emptyResolver, secretHeaderValue, toAcmeForm, toGeoipForm,
} from '@/components/globalacme';
import type { AcmeForm } from '@/components/globalacme';
import {
  buildGlobalValue, editBlock, gateLiveItems, globalSettingsView, hasMasked, keptNote, maskSecrets, maskUrl, redactRestartItems, toGlobalForm,
} from '@/components/globalsettings';
import type { GlobalItem } from '@/components/globalsettings';

const item = (over: Partial<GlobalItem>): GlobalItem => ({ value: null, source: 'default', apply: 'live', unix_only: true, settable: true, ...over });

const DIR = '/etc/rproxy/acme-api';

function acmeForm(over: Partial<AcmeForm> = {}): AcmeForm {
  return {
    ...toAcmeForm(undefined),
    accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com, *.example.com', contact: 'mailto:admin@example.com' }],
    resolvers: [{ ...emptyResolver(), name: 'le-http', account: 'le', challenge: 'http-01' }],
    ...over,
  };
}

function refuses(f: () => unknown, text: string) {
  expect(f).toThrow(GlobalPatchError);
  expect(f).toThrow(text);
}

describe('geoip form', () => {
  it('turns the API value into fields and back', () => {
    const f = toGeoipForm({ country_db: '/var/lib/GeoIP/C.mmdb', asn_db: '/var/lib/GeoIP/A.mmdb', check_interval: '5m', log_country: true });
    expect(buildGeoip(f)).toEqual({ country_db: '/var/lib/GeoIP/C.mmdb', asn_db: '/var/lib/GeoIP/A.mmdb', check_interval: '5m', log_country: true });
    expect(buildGlobalValue('geoip', toGlobalForm('geoip', item({ api_value: { asn_db: '/g/a.mmdb' } })))).toEqual({ asn_db: '/g/a.mmdb' });
  });

  it('accepts only file names in one directory (RPROXY_API_GEOIP_DIR) and a duration', () => {
    const f = toGeoipForm(undefined);
    refuses(() => buildGeoip(f), 'country_db と asn_db の少なくとも一方');
    refuses(() => buildGeoip({ ...f, country_db: 'GeoLite2-Country.mmdb' }), '絶対パス');
    refuses(() => buildGeoip({ ...f, country_db: '/var/lib/GeoIP/' }), 'ファイルの名前で終わる');
    refuses(() => buildGeoip({ ...f, country_db: '/var/lib/GeoIP/.hidden' }), 'ファイルの名前で終わる');
    refuses(() => buildGeoip({ ...f, country_db: '/var/lib/GeoIP/..' }), 'ファイルの名前で終わる');
    refuses(() => buildGeoip({ ...f, country_db: '/var/lib/GeoIP/a\nb.mmdb' }), '制御文字');
    refuses(() => buildGeoip({ ...f, country_db: '/a/c.mmdb', asn_db: '/b/a.mmdb' }), '同じディレクトリ');
    // spaces are allowed, and the directories are compared after //, . and .. are resolved (rproxy compares the real paths)
    expect(buildGeoip({ ...f, country_db: '/srv/geo ip/c.mmdb', asn_db: '/srv/./geo ip//a.mmdb' })).toEqual({ country_db: '/srv/geo ip/c.mmdb', asn_db: '/srv/./geo ip//a.mmdb' });
    expect(buildGeoip({ ...f, country_db: '/srv/x/../geo/c.mmdb', asn_db: '/srv/geo/a.mmdb' })).toMatchObject({ asn_db: '/srv/geo/a.mmdb' });
    refuses(() => buildGeoip({ ...f, country_db: '/a/c.mmdb', check_interval: '1 minute' }), 'check_interval');
    expect(buildGeoip({ ...f, country_db: '/a/c.mmdb', check_interval: '0s' })).toEqual({ country_db: '/a/c.mmdb', check_interval: '0s' });
  });

  it('apiDirFile returns the directory', () => {
    expect(apiDirFile('x', '/var/lib/GeoIP/C.mmdb')).toBe('/var/lib/GeoIP');
    expect(apiDirFile('x', '/C.mmdb')).toBe('/');
    expect(apiDirFile('x', '/var//lib/./GeoIP/C.mmdb')).toBe('/var/lib/GeoIP');
  });
});

describe('acme form', () => {
  it('builds the shape of global.acme with files right in one directory', () => {
    const v = buildAcme(acmeForm({
      storage: `${DIR}/storage`,
      http01_listen: '0.0.0.0:80\n[::]:80',
      rate_orders: '5', rate_period: '1h', renew_before: '30d',
      accounts: [{ ...emptyAccount(), name: 'zerossl', allowed_names: 'example.com', eab_kid: 'kid', eab_hmac_key_file: `${DIR}/eab.key`, ca_file: `${DIR}/ca.pem`, contact: 'mailto:a@example.com' }],
      providers: [
        { ...emptyProvider(), name: 'pdns', type: 'powerdns', api_url: 'http://127.0.0.1:8081', api_key_file: `${DIR}/pdns.key`, zones: 'acme.example.net', allowed_names: '*.example.com' },
        {
          ...emptyProvider(), name: 'relay', type: 'http', secret_file: `${DIR}/relay.token`, allowed_names: 'example.com',
          add: { method: 'POST', url: 'https://relay.example:8443/present?zone={zone}', headers: 'Authorization: Bearer {secret}\nContent-Type: application/json', body: '{"fqdn":"{fqdn}"}' },
          remove: { method: 'DELETE', url: 'https://relay.example:8443/cleanup/{fqdn}', headers: 'Authorization: Bearer {secret}', body: '' },
          // zones of an http provider are kept; ttl is not used with http and is not sent
          ttl: '60',
        },
        { ...emptyProvider(), name: 'bind', type: 'rfc2136', server: '10.0.0.53', tsig_key_name: 'k', tsig_algorithm: 'hmac-sha512', tsig_secret_file: `${DIR}/tsig.key`, allowed_names: 'example.org' },
        // zones and ttl are not used with acme_dns: not sent even when left in the form
        { ...emptyProvider(), name: 'adns', type: 'acme_dns', api_url: 'https://auth.example', credentials_file: `${DIR}/acme-dns.json`, allowed_names: 'vpn.example.com', zones: 'x.example', ttl: '5' },
      ],
      resolvers: [
        { name: 'z-http', account: 'zerossl', challenge: 'http-01', dns_provider: '' },
        { name: 'z-dns', account: 'zerossl', challenge: 'dns-01', dns_provider: 'pdns' },
      ],
    }));
    expect(v).toEqual({
      storage: `${DIR}/storage`,
      accounts: { zerossl: { contact: ['mailto:a@example.com'], allowed_names: ['example.com'], eab: { kid: 'kid', hmac_key_file: `${DIR}/eab.key` }, ca_file: `${DIR}/ca.pem` } },
      dns_providers: {
        pdns: { type: 'powerdns', api_url: 'http://127.0.0.1:8081', api_key_file: `${DIR}/pdns.key`, zones: ['acme.example.net'], allowed_names: ['*.example.com'] },
        relay: {
          type: 'http', secret_file: `${DIR}/relay.token`, allowed_names: ['example.com'],
          add: { method: 'POST', url: 'https://relay.example:8443/present?zone={zone}', headers: { Authorization: 'Bearer {secret}', 'Content-Type': 'application/json' }, body: '{"fqdn":"{fqdn}"}' },
          remove: { method: 'DELETE', url: 'https://relay.example:8443/cleanup/{fqdn}', headers: { Authorization: 'Bearer {secret}' } },
        },
        bind: { type: 'rfc2136', server: '10.0.0.53', tsig_key_name: 'k', tsig_algorithm: 'hmac-sha512', tsig_secret_file: `${DIR}/tsig.key`, allowed_names: ['example.org'] },
        adns: { type: 'acme_dns', api_url: 'https://auth.example', credentials_file: `${DIR}/acme-dns.json`, allowed_names: ['vpn.example.com'] },
      },
      resolvers: { 'z-http': { account: 'zerossl', challenge: 'http-01' }, 'z-dns': { account: 'zerossl', challenge: 'dns-01', dns_provider: 'pdns' } },
      rate_limit: { orders: 5, period: '1h' },
      renew_before: '30d',
      http01_listen: ['0.0.0.0:80', '[::]:80'],
    });
    // the form reads it back
    expect(buildAcme(toAcmeForm(v))).toEqual(v);
  });

  it('only accepts {secret} or "<Scheme> {secret}" in headers or the body, never in the URL, as rproxy enforces', () => {
    const call = { method: '', url: 'https://relay.example/p', headers: 'Authorization: Bearer {secret}', body: '' };
    const relay = (add: Partial<typeof call>, remove: Partial<typeof call> = {}) => acmeForm({
      providers: [{ ...emptyProvider(), name: 'r', type: 'http', secret_file: `${DIR}/t`, allowed_names: 'example.com', add: { ...call, ...add }, remove: { ...call, ...remove } }],
    });
    // rproxy's AcmeGlobal::check: no {secret} anywhere in the URL (URLs end up in logs), the query included
    refuses(() => buildAcme(relay({ url: 'https://relay.example/p?token={secret}' })), 'URL に置けません');
    refuses(() => buildAcme(relay({ url: 'https://relay.example/p?x={secret}' })), 'URL に置けません');
    refuses(() => buildAcme(relay({ url: 'https://relay.example/{secret}/p' })), 'URL に置けません');
    // a query parameter named like a credential, whatever its value
    refuses(() => buildAcme(relay({ url: 'https://relay.example/p?api_key=abc' })), 'api_key');
    refuses(() => buildAcme(relay({}, { url: 'https://relay.example/p?a=1&token' })), 'token');
    // split once: '=' in the value is not a second pair
    expect(() => buildAcme(relay({ url: 'https://relay.example/p?q=a=b' }))).not.toThrow();
    refuses(() => buildAcme(relay({ url: 'https://user:pw@relay.example/p' })), '利用者');
    refuses(() => buildAcme(relay({ url: 'https://relay.example:70000/p' })), '1〜65535');
    refuses(() => buildAcme(relay({ method: 'GET X' })), 'method');
    refuses(() => buildAcme(relay({ headers: 'Authorization: Bearer abc123' })), 'Authorization');
    refuses(() => buildAcme(relay({ headers: 'X-API-Key: abc' })), 'X-API-Key');
    refuses(() => buildAcme(relay({ headers: 'X-Custom: x{secret}' })), 'X-Custom');
    refuses(() => buildAcme(relay({ body: '{"token":"abc"}' })), '本文');
    expect(() => buildAcme(relay({ headers: 'X-Auth-Token: {secret}', body: '{"token":"{secret}","fqdn":"{fqdn}"}' }))).not.toThrow();
    // type http needs both add and remove
    refuses(() => buildAcme(relay({}, { url: '', headers: '', method: '', body: '' })), 'add と remove');
    // {secret} needs secret_file
    const noFile = relay({});
    noFile.providers[0].secret_file = '';
    refuses(() => buildAcme(noFile), 'secret_file');
    expect(secretHeaderValue('Bearer {secret}')).toBe(true);
    expect(secretHeaderValue('{secret}')).toBe(true);
    expect(secretHeaderValue('Bearer  {secret}')).toBe(false);
    expect(secretHeaderValue('Bearer x{secret}')).toBe(false);
  });

  it('account names follow rproxy\'s safe_name; provider and resolver names are not restricted', () => {
    refuses(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: 'le.prod', allowed_names: 'example.com' }], resolvers: [] })), '64 文字');
    refuses(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: 'a'.repeat(65), allowed_names: 'example.com' }], resolvers: [] })), '64 文字');
    expect(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: '-le_1', allowed_names: 'example.com' }], resolvers: [] }))).not.toThrow();
    const v = buildAcme(acmeForm({
      providers: [{ ...emptyProvider(), name: 'pdns.main', type: 'rfc2136', server: '10.0.0.53', tsig_key_name: 'k', tsig_secret_file: `${DIR}/k`, allowed_names: 'example.com', ttl: '4294967295' }],
      resolvers: [{ name: 'le.dns', account: 'le', challenge: 'dns-01', dns_provider: 'pdns.main' }],
    }));
    expect(v.resolvers).toEqual({ 'le.dns': { account: 'le', challenge: 'dns-01', dns_provider: 'pdns.main' } });
    expect((v.dns_providers as Record<string, { ttl: number }>)['pdns.main'].ttl).toBe(4294967295);
    refuses(() => buildAcme(acmeForm({
      providers: [{ ...emptyProvider(), name: 'p', type: 'powerdns', api_url: 'http://127.0.0.1:8081', api_key_file: `${DIR}/k`, allowed_names: 'example.com', ttl: '4294967296' }],
    })), 'ttl');
    refuses(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com', contact: 'admin@example.com' }] })), 'mailto:');
    refuses(() => buildAcme(acmeForm({ http01_listen: '0.0.0.0:99999' })), 'http01_listen');
  });

  it('refuses files outside one directory, a storage outside it, and hidden (***) values', () => {
    refuses(() => buildAcme(acmeForm({
      accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com', ca_file: '/a/ca.pem', eab_kid: 'k', eab_hmac_key_file: '/b/eab' }],
      resolvers: [],
    })), '同じディレクトリ');
    refuses(() => buildAcme(acmeForm({
      storage: '/srv/acme',
      accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com', ca_file: `${DIR}/ca.pem` }],
      resolvers: [],
    })), 'acme.storage');
    expect(buildAcme(acmeForm({ storage: '/var/lib/rproxy/acme' })).storage).toBe('/var/lib/rproxy/acme');
    refuses(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com', ca_file: '***' }] })), '***');
  });

  it('checks names, references between resolvers, accounts and providers, and the other fields', () => {
    refuses(() => buildAcme(acmeForm({ accounts: [], resolvers: [] })), 'アカウントが 1 つ以上');
    refuses(() => buildAcme(acmeForm({ accounts: [{ ...emptyAccount(), name: 'le' }] })), 'allowed_names');
    refuses(() => buildAcme(acmeForm({ resolvers: [{ name: 'r', account: 'other', challenge: 'http-01', dns_provider: '' }] })), 'アカウント other');
    refuses(() => buildAcme(acmeForm({ resolvers: [{ name: 'r', account: 'le', challenge: 'dns-01', dns_provider: '' }] })), 'dns-01');
    refuses(() => buildAcme(acmeForm({ resolvers: [{ name: 'r', account: 'le', challenge: 'http-01', dns_provider: 'x' }] })), 'dns-01 だけ');
    refuses(() => buildAcme(acmeForm({ resolvers: [emptyResolver(), emptyResolver()] })), '名前が空');
    refuses(() => buildAcme(acmeForm({ http01_listen: 'example.com:80' })), 'http01_listen');
    refuses(() => buildAcme(acmeForm({ rate_period: '1h' })), 'orders');
    refuses(() => buildAcme(acmeForm({ rate_orders: '0' })), 'orders');
    refuses(() => buildAcme(acmeForm({ providers: [{ ...emptyProvider(), name: 'p', type: 'powerdns', allowed_names: 'example.com' }] })), 'api_url');
    refuses(() => buildAcme(acmeForm({
      accounts: [{ ...emptyAccount(), name: 'le', allowed_names: 'example.com', eab_kid: 'k' }],
    })), 'eab');
  });

  it('keeps hidden (***) values in the fields so the admin sees what to enter again', () => {
    const f = toAcmeForm({
      accounts: { le: { allowed_names: ['example.com'], eab: { kid: '***', hmac_key_file: '***' } } },
      dns_providers: { r: { type: 'http', add: { url: 'https://relay.example/***', headers: { Authorization: '***' } }, secret_file: '***', allowed_names: ['example.com'] } },
    });
    expect(f.accounts[0].eab_kid).toBe('***');
    expect(f.providers[0].add.headers).toBe('Authorization: ***');
    expect(hasMasked(f)).toBe(true);
    refuses(() => buildAcme(f), '***');
  });
});

describe('live geoip and acme on rproxy-api v0.4.22', () => {
  const settings = () => globalSettingsView({
    items: {
      acme: { value: { accounts: { le: { contact: ['mailto:a@example.com'], eab: { kid: 'k' } } } }, source: 'api', apply: 'live', unix_only: true, settable: true, api_value: { accounts: {} } },
      geoip: { value: null, source: 'default', apply: 'live', unix_only: true, settable: true },
    },
  })!;

  it('without features.global_api_geoip / global_api_acme the items are read-only and restart-only', () => {
    const s = gateLiveItems(settings(), { global_api: true });
    expect(s.items.acme).toMatchObject({ apply: 'restart', settable: false });
    expect(editBlock(s.items.geoip, 'unix')).toContain('再起動');
    const r = redactRestartItems(s);
    expect(r.items.acme).toMatchObject({ redacted: true, value: null });
    const on = gateLiveItems(settings(), { global_api_geoip: true, global_api_acme: true });
    expect(editBlock(on.items.geoip, 'unix')).toBeNull();
    expect(editBlock(on.items.acme, 'tcp')).toContain('Unix ソケット');
  });

  it('a live acme is passed on with secret-shaped values hidden', () => {
    const r = redactRestartItems(gateLiveItems(settings(), { global_api_acme: true, global_api_geoip: true }));
    expect(r.items.acme.redacted).toBeUndefined();
    expect(r.items.acme.value).toEqual({ accounts: { le: { contact: ['mailto:a@example.com'], eab: { kid: '***' } } } });
  });

  it('masks like rproxy: names of secrets, headers, bodies and URLs\' user, path and query', () => {
    expect(maskSecrets({ api_key_file: '/x', tsig_key_name: 'n', headers: { A: 'b' }, body: 'x', api_url: 'http://h:1/api', allowed_names: ['a'] }))
      .toEqual({ api_key_file: '***', tsig_key_name: '***', headers: { A: '***' }, body: '***', api_url: 'http://h:1/***', allowed_names: ['a'] });
    expect(maskUrl('https://u:p@h/x/y?q=1#f')).toBe('https://***@h/***?***');
    expect(maskUrl('https://h/')).toBe('https://h/');
    expect(maskUrl('https://h')).toBe('https://h');
  });

  it('notes a kept item by what it keeps', () => {
    expect(keptNote('geoip')).toContain('geoip');
    expect(keptNote('acme')).toContain('acme');
    expect(keptNote('crowdsec')).toContain('残しています');
  });
});
