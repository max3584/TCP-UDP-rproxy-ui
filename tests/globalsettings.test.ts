import { describe, expect, it } from 'vitest';
import {
  GlobalPatchError, buildGlobalValue, editBlock, formatGlobalValue, globalPatchBody, globalSettingsView, normalizeGlobalValues,
  toGlobalForm, undoValues,
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

  it('undoes changes by putting the API values before back (null clears)', () => {
    expect(undoValues([
      { item: 'udp_max_sessions', before: 1024, after: 10, api_before: null, api_after: 10 },
      { item: 'http.timeouts', before: null, after: { idle: '1s' }, api_before: { idle: '9s' }, api_after: { idle: '1s' } },
    ])).toEqual({ udp_max_sessions: null, 'http.timeouts': { idle: '9s' } });
    expect(undoValues([])).toBeNull();
  });

  it('reads the answer of GET /config/global and keeps unknown items', () => {
    const v = globalSettingsView({
      items: {
        trusted_proxies: { value: ['10.0.0.0/8'], source: 'api', apply: 'live', unix_only: true, settable: true, api_value: ['10.0.0.0/8'], shadowed: false },
        future: { value: 1, source: 'file', apply: 'restart', unix_only: false, settable: false, shadowed: true, api_value: 2, error: 'x' },
        bad: 3,
      },
      storage: 'database', persisted: true, updated_by: 'ui', updated_at: 1790000000, warnings: [{ code: 'config.global_shadowed', item: 'future', message: 'm' }],
    });
    expect(Object.keys(v!.items)).toEqual(['trusted_proxies', 'future']);
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

  it('turns form fields into values and back', () => {
    const tp = toGlobalForm('trusted_proxies', item({ value: [], api_value: ['10.0.0.0/8', '192.0.2.1/32'] }));
    expect(tp).toEqual({ kind: 'lines', text: '10.0.0.0/8\n192.0.2.1/32' });
    expect(buildGlobalValue('trusted_proxies', { kind: 'lines', text: '10.0.0.5\n 172.16.9.9/16 \n\n' })).toEqual(['10.0.0.5/32', '172.16.0.0/16']);
    expect(() => buildGlobalValue('trusted_proxies', { kind: 'lines', text: 'nope' })).toThrow(GlobalPatchError);
    expect(buildGlobalValue('access_log', { kind: 'text', text: ' ' })).toBeNull();
    expect(() => buildGlobalValue('access_log', { kind: 'text', text: 'rel/path' })).toThrow(GlobalPatchError);
    expect(buildGlobalValue('udp_max_sessions', { kind: 'number', text: '4096' })).toBe(4096);
    expect(() => buildGlobalValue('udp_max_sessions', { kind: 'number', text: '-1' })).toThrow(GlobalPatchError);
    const t = toGlobalForm('http.timeouts', item({ value: { idle: '90s' } }));
    expect(t.kind).toBe('fields');
    expect(buildGlobalValue('http.timeouts', t)).toEqual({ idle: '90s' });
    expect(buildGlobalValue('http.timeouts', { kind: 'fields', keys: ['idle'], fields: { idle: '' } })).toBeNull();
    expect(() => buildGlobalValue('crowdsec', { kind: 'fields', keys: ['lapi_url', 'api_key_file'], fields: { lapi_url: 'http://127.0.0.1:8080', api_key_file: '' } })).toThrow(GlobalPatchError);
    // unknown items are edited as JSON
    const j = toGlobalForm('future', item({ value: { a: [1] } }));
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
