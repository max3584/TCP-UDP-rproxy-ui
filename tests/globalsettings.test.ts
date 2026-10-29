import { describe, expect, it } from 'vitest';
import {
  GlobalPatchError, buildGlobalValue, editBlock, formatGlobalValue, globalPatchBody, globalSettingsView, normalizeGlobalValues, redactRestartItems, sameValue,
  toGlobalForm,
} from '@/components/globalsettings';
import type { GlobalItem } from '@/components/globalsettings';

const item = (over: Partial<GlobalItem>): GlobalItem => ({ value: null, source: 'default', apply: 'live', unix_only: false, settable: true, ...over });

describe('components/globalsettings', () => {
  it('puts dotted item names into the shape of global', () => {
    expect(globalPatchBody({ 'http.timeouts': { idle: '5m' }, udp_max_sessions: 4096, access_log: null }))
      .toEqual({ http: { timeouts: { idle: '5m' } }, udp_max_sessions: 4096, access_log: null });
  });

  it('checks only the shape of the values (rproxy checks the contents)', () => {
    expect(normalizeGlobalValues({ trusted_proxies: [], 'http.timeouts': null })).toEqual({ trusted_proxies: [], 'http.timeouts': null });
    expect(() => normalizeGlobalValues({})).toThrow(GlobalPatchError);
    expect(() => normalizeGlobalValues([])).toThrow(GlobalPatchError);
    expect(() => normalizeGlobalValues({ 'Bad Name': 1 })).toThrow(GlobalPatchError);
    // an item the UI does not know is passed on (a newer rproxy may have it)
    expect(normalizeGlobalValues({ new_item: { a: 1 } })).toEqual({ new_item: { a: 1 } });
  });

  it('reads the answer of GET /config/global and keeps unknown items', () => {
    const v = globalSettingsView({
      items: {
        trusted_proxies: { value: ['10.0.0.0/8'], source: 'api', apply: 'live', unix_only: true, settable: true, api_value: ['10.0.0.0/8'], shadowed: false },
        future: { value: 1, source: 'file', apply: 'restart', unix_only: false, settable: false, shadowed: true, api_value: 2, error: 'x' },
        crowdsec: { value: { lapi_url: 'http://127.0.0.1:8080' }, source: 'file', apply: 'live', unix_only: true, settable: false, kept: true },
        bad: 3,
      },
      storage: 'database', persisted: true, updated_by: 'ui', updated_at: 1790000000, warnings: [{ code: 'config.global_shadowed', item: 'future', message: 'm' }],
    });
    expect(Object.keys(v!.items)).toEqual(['trusted_proxies', 'future', 'crowdsec']);
    expect(v!.items.crowdsec.kept).toBe(true);
    expect(v!.loaded).toBe(true);
    expect(globalSettingsView({ items: {}, loaded: false })!.loaded).toBe(false);
    expect(v!.items.trusted_proxies.unix_only).toBe(true);
    expect(v!.items.future).toMatchObject({ shadowed: true, api_value: 2, error: 'x' });
    expect(v!.persisted).toBe(true);
    expect(globalSettingsView({})).toBeNull();
  });

  it('tells why an item cannot be changed from rproxy flags', () => {
    expect(editBlock(item({ source: 'file' }), 'unix')).toBe('設定ファイルで固定');
    expect(editBlock(item({ source: 'env' }), 'unix')).toBe('環境変数で固定');
    expect(editBlock(item({ apply: 'restart', settable: false }), 'unix')).toContain('再起動');
    expect(editBlock(item({ settable: false }), 'unix')).toBe('API では変えられません');
    expect(editBlock(item({ unix_only: true }), 'tcp')).toContain('Unix ソケット');
    expect(editBlock(item({ unix_only: true }), 'unix')).toBeNull();
    expect(editBlock(item({ source: 'api' }), 'tcp')).toBeNull();
  });

  it('pre-fills only from the API value (not from defaults in force), and nothing when told so', () => {
    expect(toGlobalForm('udp_max_sessions', item({ value: 16384 }))).toEqual({ kind: 'number', text: '' });
    expect(toGlobalForm('udp_max_sessions', item({ value: 16384, api_value: 2048 }))).toEqual({ kind: 'number', text: '2048' });
    expect(toGlobalForm('udp_max_sessions', undefined)).toEqual({ kind: 'number', text: '' });
  });

  it('refuses overlapping item names', () => {
    expect(() => normalizeGlobalValues({ http: null, 'http.timeouts': { idle: '1s' } })).toThrow(GlobalPatchError);
    expect(normalizeGlobalValues({ http: null, httpx: 1 })).toEqual({ http: null, httpx: 1 });
  });

  it('hides the contents of restart-only items, keeping their keys and scalars', () => {
    const s = redactRestartItems(globalSettingsView({
      items: {
        acme: { value: { contact: ['mailto:a@example.com'], eab: { kid: 'k' } }, source: 'file', apply: 'restart', unix_only: true, settable: false, api_value: { x: 1 } },
        performance: { value: 4, source: 'env', apply: 'restart', unix_only: false, settable: false },
        trusted_proxies: { value: ['10.0.0.0/8'], source: 'api', apply: 'live', unix_only: true, settable: true },
      },
      storage: 'memory', persisted: null, warnings: [],
    })!);
    expect(s.items.acme).toMatchObject({ value: null, redacted: true, keys: ['contact', 'eab'] });
    expect(s.items.acme.api_value).toBeUndefined();
    expect(s.items.performance.value).toBe(4);
    expect(s.items.trusted_proxies.value).toEqual(['10.0.0.0/8']);
    expect(JSON.stringify(s)).not.toContain('mailto');
  });

  it('compares values regardless of key order', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('a stored value that cannot be read leaves the form empty', () => {
    expect(toGlobalForm('trusted_proxies', item({ api_value: 'not a list', error: 'bad' }))).toEqual({ kind: 'lines', text: '' });
    expect(toGlobalForm('udp_max_sessions', item({ api_value: 'x' }))).toEqual({ kind: 'number', text: '' });
  });

  it('turns form fields into values and back', () => {
    const tp = toGlobalForm('trusted_proxies', item({ value: [], api_value: ['10.0.0.0/8', '192.0.2.1/32'] }));
    expect(tp).toEqual({ kind: 'lines', text: '10.0.0.0/8\n192.0.2.1/32' });
    expect(buildGlobalValue('trusted_proxies', { kind: 'lines', text: '10.0.0.5\n 172.16.9.9/16 \n\n' })).toEqual(['10.0.0.5/32', '172.16.0.0/16']);
    expect(() => buildGlobalValue('trusted_proxies', { kind: 'lines', text: 'nope' })).toThrow(GlobalPatchError);
    expect(buildGlobalValue('access_log', { kind: 'text', text: ' ' })).toBeNull();
    expect(() => buildGlobalValue('access_log', { kind: 'text', text: 'rel/path' })).toThrow(GlobalPatchError);
    expect(buildGlobalValue('udp_max_sessions', { kind: 'number', text: '4096' })).toBe(4096);
    expect(() => buildGlobalValue('udp_max_sessions', { kind: 'number', text: '-1' })).toThrow(GlobalPatchError);
    const t = toGlobalForm('http.timeouts', item({ value: { idle: '1s' }, api_value: { idle: '90s' } }));
    expect(t.kind).toBe('fields');
    expect(buildGlobalValue('http.timeouts', t)).toEqual({ idle: '90s' });
    expect(buildGlobalValue('http.timeouts', { kind: 'fields', keys: ['idle'], fields: { idle: '' } })).toBeNull();
    expect(() => buildGlobalValue('crowdsec', { kind: 'fields', keys: ['lapi_url', 'api_key_file'], fields: { lapi_url: 'http://127.0.0.1:8080', api_key_file: '' } })).toThrow(GlobalPatchError);
    // unknown items are edited as JSON
    const j = toGlobalForm('future', item({ api_value: { a: [1] } }));
    expect(j.kind).toBe('json');
    expect(buildGlobalValue('future', j)).toEqual({ a: [1] });
    expect(() => buildGlobalValue('future', { kind: 'json', text: '{' })).toThrow(GlobalPatchError);
  });

  it('formats values', () => {
    expect(formatGlobalValue(null)).toBe('-');
    expect(formatGlobalValue(['a', 'b'])).toBe('a, b');
    expect(formatGlobalValue({ idle: '5m' })).toBe('{"idle":"5m"}');
  });
});
