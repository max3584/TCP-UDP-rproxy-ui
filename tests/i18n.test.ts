import { describe, expect, it } from 'vitest';
import { extract } from '../i18n/extract.mjs';
import { en } from '@/i18n/en';
import { detectLocale, localeFromCookie, normalize, t, translate } from '@/i18n/core';
import { localizeBody, requestLocale } from '@/i18n/server';

// ソースにない（extract.mjs が取り出さない）が辞書に置くもの
const EXTRA_KEYS = new Set(['日本語']);

// 差し込む値：{0} {1}…（テンプレート）と {name}（t() の引数）
const placeholders = (s: string) => [...s.matchAll(/\{(\d+|[a-z][a-zA-Z]*)\}/g)].map((m) => m[0]).sort();

describe('英語の辞書', () => {
  const keys = new Map<string, string>(extract(process.cwd()));

  it('画面の日本語の文言がすべて辞書にある', () => {
    const missing = [...keys].filter(([k]) => !(k in en)).map(([k, at]) => `${at}\t${k}`);
    expect(missing).toEqual([]);
  });

  it('辞書に、ソースにない（古い）文言がない', () => {
    const stale = Object.keys(en).filter((k) => !keys.has(k) && !EXTRA_KEYS.has(k));
    expect(stale).toEqual([]);
  });

  it('差し込む値（{0}・{name}）が日本語と英語で同じ', () => {
    // URL の例の {ポート} などは差し込む値ではないので、英語の側は日本語にあるものだけ比べる
    const mismatched = Object.entries(en).filter(([k, v]) => {
      const ja = placeholders(k);
      return ja.join() !== placeholders(v).filter((p) => ja.includes(p) || /^\{\d+\}$/.test(p)).join();
    });
    expect(mismatched).toEqual([]);
  });

  it('キーは正規化した形で、訳は空でない', () => {
    expect(Object.keys(en).filter((k) => normalize(k) !== k)).toEqual([]);
    expect(Object.entries(en).filter(([, v]) => v.trim() === '')).toEqual([]);
  });
});

describe('translate', () => {
  it('日本語ではそのまま、英語では辞書で訳す', () => {
    expect(translate('ルールを追加', 'ja')).toBe('ルールを追加');
    expect(translate('ルールを追加', 'en')).toBe(en['ルールを追加']);
  });

  it('前後の空白を保ち、中の空白はまとめて引く', () => {
    expect(translate('  ルールを追加 ', 'en')).toBe(`  ${en['ルールを追加']} `);
  });

  it('値を差し込んだ文言は {0} の形で訳す', () => {
    expect(translate('履歴を取得できませんでした: boom', 'en')).toBe(en['履歴を取得できませんでした: {0}'].replace('{0}', 'boom'));
  });

  it('訳のない文言・日本語を含まない文字列はそのまま', () => {
    expect(translate('辞書にない文言です', 'en')).toBe('辞書にない文言です');
    expect(translate('tcp/443', 'en')).toBe('tcp/443');
  });

  it('t は訳してから {名前} を置き換える', () => {
    expect(t('{rule} の転送を一時停止しますか？（既存の接続は切断されます。設定は残ります）', { rule: 'tcp 0.0.0.0:80' }))
      .toBe('tcp 0.0.0.0:80 の転送を一時停止しますか？（既存の接続は切断されます。設定は残ります）');
  });
});

describe('言語の決め方', () => {
  it('Accept-Language / navigator.languages の一番目で決め、なければ日本語', () => {
    expect(detectLocale('en-US,en;q=0.9,ja;q=0.8')).toBe('en');
    expect(detectLocale('ja,en-US;q=0.9')).toBe('ja');
    expect(detectLocale(['fr-FR', 'ja'])).toBe('en');
    expect(detectLocale(undefined)).toBe('ja');
    expect(detectLocale('')).toBe('ja');
  });

  it('cookie で選んだ言語が Accept-Language より先', () => {
    expect(localeFromCookie('a=1; rproxy_ui_lang=en')).toBe('en');
    expect(localeFromCookie('rproxy_ui_lang=xx')).toBeUndefined();
    expect(requestLocale({ headers: { cookie: 'rproxy_ui_lang=ja', 'accept-language': 'en' } })).toBe('ja');
    expect(requestLocale({ headers: { 'accept-language': 'en-GB' } })).toBe('en');
  });

  it('API の応答は error / message だけを訳し、code は変えない', () => {
    const body = { error: '同じプロトコル・アドレス・ポートのルールが既に存在します。', code: 'already_exists' };
    expect(localizeBody(body, 'en')).toEqual({ error: en[body.error], code: 'already_exists' });
    expect(localizeBody(body, 'ja')).toBe(body);
  });
});
