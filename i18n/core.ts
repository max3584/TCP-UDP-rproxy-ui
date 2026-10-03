// 画面の言語（日本語 / 英語）。文言は日本語のままソースに書き、表示するときに辞書（i18n/en.ts）で訳す。
// - JSX の文字列（子のテキストと title・placeholder・aria-label などの属性）は、jsx-runtime.ts が自動で訳す
// - JSX を通らない文字列（window.confirm など）は t() で訳す
// - キーは日本語の文言そのもの（空白はまとめる）。値を差し込んだ文言は、辞書の {0} {1}… の形と照らし合わせて訳す
// - 訳がなければ日本語のまま出す
import { en } from './en';

export type Locale = 'ja' | 'en';
export const LOCALES: Locale[] = ['ja', 'en'];
export const LOCALE_COOKIE = 'rproxy_ui_lang';

const JA = /[぀-ヿ㐀-鿿！-｠]/;

let current: Locale = 'ja';
// サーバ側（API route）はリクエストごとに言語が違うので、AsyncLocalStorage で決める（i18n/server.ts が登録する）
let resolver: (() => Locale | undefined) | null = null;

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return resolver?.() ?? current;
}

export function setLocaleResolver(f: (() => Locale | undefined) | null): void {
  resolver = f;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'en';
}

// Accept-Language（サーバ）か navigator.languages（ブラウザ）から決める。一番目に来る言語が日本語なら ja、ほかの言語なら en。
// 何もなければ ja
export function detectLocale(languages: string | readonly string[] | undefined | null): Locale {
  const list = typeof languages === 'string'
    ? languages.split(',').map((s) => s.split(';')[0].trim())
    : [...(languages ?? [])];
  const first = list.find((s) => s && s !== '*');
  if (!first) return 'ja';
  return first.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

// cookie の文字列から言語を読む
export function localeFromCookie(cookie: string | undefined | null): Locale | undefined {
  const m = /(?:^|;\s*)rproxy_ui_lang=([^;]+)/.exec(cookie ?? '');
  const v = m ? decodeURIComponent(m[1]) : undefined;
  return isLocale(v) ? v : undefined;
}

// 日付・数の書式に使う BCP 47 の言語タグ
export function localeTag(locale: Locale = getLocale()): string {
  return locale === 'en' ? 'en-US' : 'ja-JP';
}

export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface Template {
  re: RegExp;
  en: string;
  literal: number;
}

const exact = new Map<string, string>();
const templates: Template[] = [];
for (const [key, value] of Object.entries(en)) {
  const k = normalize(key);
  if (/\{\d+\}/.test(k)) {
    const parts = k.split(/(\{\d+\})/);
    const order: number[] = [];
    const src = parts
      .map((p) => {
        const m = /^\{(\d+)\}$/.exec(p);
        if (m) {
          order.push(Number(m[1]));
          return '([\\s\\S]+?)';
        }
        return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    // 差し込む値の順番は、日本語と英語で違ってよい（{1} が先に来るなど）。捕まえた順を {番号} に戻す
    const re = new RegExp(`^${src}$`);
    templates.push({ re: Object.assign(re, { order }), en: value, literal: k.replace(/\{\d+\}/g, '').length });
  } else {
    exact.set(k, value);
  }
}
// 固定の文字が多い（具体的な）ものから試す
templates.sort((a, b) => b.literal - a.literal);

const cache = new Map<string, string>();

function translateCore(s: string, depth: number): string | undefined {
  const hit = exact.get(s);
  if (hit !== undefined) return hit;
  if (depth > 3) return undefined;
  for (const t of templates) {
    const m = t.re.exec(s);
    if (!m) continue;
    const order = (t.re as RegExp & { order: number[] }).order;
    const values: Record<number, string> = {};
    order.forEach((n, i) => {
      const v = m[i + 1];
      // 差し込まれた値が、それ自体訳せる文言（状態の名前など）なら訳す
      values[n] = JA.test(v) ? translateCore(normalize(v), depth + 1) ?? v : v;
    });
    return t.en.replace(/\{(\d+)\}/g, (_, n) => values[Number(n)] ?? '');
  }
  return undefined;
}

// 文字列を言語に合わせて訳す（日本語・訳のないものはそのまま）。前後の空白は保つ
export function translate(s: string, locale: Locale = getLocale()): string {
  if (locale === 'ja' || !JA.test(s)) return s;
  const cached = cache.get(s);
  if (cached !== undefined) return cached;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  const core = translateCore(normalize(m[2]), 0);
  const out = core === undefined ? s : `${m[1]}${core}${m[3]}`;
  if (cache.size > 5000) cache.clear();
  cache.set(s, out);
  return out;
}

// JSX を通らない文字列を訳す。{名前} は params で置き換える（置き換えは訳した後）
export function t(text: string, params?: Record<string, string | number>): string {
  let out = translate(text);
  if (params) out = out.replace(/\{(\w+)\}/g, (all, k) => (k in params ? String(params[k]) : all));
  return out;
}
