// サーバ側（API route）の言語。リクエストの cookie（rproxy_ui_lang）か Accept-Language で決め、
// AsyncLocalStorage でその処理の間だけ使う（同時に来たリクエストの言語が混ざらない）
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { Locale, detectLocale, localeFromCookie, setLocaleResolver, translate } from './core';

const store = new AsyncLocalStorage<Locale>();
setLocaleResolver(() => store.getStore());

export function requestLocale(req: Pick<IncomingMessage, 'headers'> | undefined): Locale {
  const headers = req?.headers ?? {};
  const cookie = typeof headers.cookie === 'string' ? headers.cookie : undefined;
  const accept = headers['accept-language'];
  return localeFromCookie(cookie) ?? detectLocale(typeof accept === 'string' ? accept : undefined);
}

// fn の間（await の先を含む）、言語を req に合わせる
export function withRequestLocale<T>(req: Pick<IncomingMessage, 'headers'> | undefined, fn: () => T): T {
  return store.run(requestLocale(req), fn);
}

// 応答の JSON の error / message（入れ子の配列・オブジェクトの中も）を、リクエストの言語に訳す。code などほかの項目は変えない
export function localizeBody(body: unknown, locale: Locale): unknown {
  if (locale === 'ja' || body === null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((v) => localizeBody(v, locale));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = (k === 'error' || k === 'message') && typeof v === 'string' ? translate(v, locale) : localizeBody(v, locale);
  }
  return out;
}

interface JsonResponse {
  json: (body: unknown) => unknown;
}

// API route を包む：処理の間の言語をリクエストに合わせ、res.json に渡したメッセージを訳す
export function localizedApi<Req extends Pick<IncomingMessage, 'headers'>, Res extends JsonResponse, R>(
  handler: (req: Req, res: Res) => R,
): (req: Req, res: Res) => R {
  return (req, res) => {
    const locale = requestLocale(req);
    if (locale !== 'ja') {
      const json = res.json.bind(res);
      res.json = (body: unknown) => json(localizeBody(body, locale));
    }
    return store.run(locale, () => handler(req, res));
  };
}
