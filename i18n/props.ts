import { getLocale, translate } from './core';

// 訳さない属性：入力の値と識別子
const KEEP = new Set(['value', 'defaultValue', 'id', 'name', 'href', 'className', 'key', 'htmlFor', 'type', 'src', 'action', 'method', 'role', 'download', 'target', 'rel', 'lang', 'dangerouslySetInnerHTML']);

// 描画される子か（null・undefined・true / false・'' は何も出さない）
const rendered = (c: unknown) => c !== null && c !== undefined && typeof c !== 'boolean' && c !== '';

// 日本語の文は「。」で終わり、次の文との間に空白を置かない。英語に訳したら、後ろに別の子が続くときは空白を足す
// （「…の履歴です。{説明}「この版に戻す」で…」が "…deletions.Showing…" にならないように）
const SENTENCE_END = /[。！？]$/;

function translateChild(child: unknown): unknown {
  if (typeof child === 'string') return translate(child);
  if (Array.isArray(child)) {
    let changed = false;
    const out = child.map((c, i) => {
      let t = translateChild(c);
      if (typeof c === 'string' && typeof t === 'string' && t !== c && SENTENCE_END.test(c) && !/\s$/.test(t)) {
        const next = child.slice(i + 1).find(rendered);
        if (next !== undefined && !(typeof next === 'string' && /^\s/.test(next))) t += ' ';
      }
      if (t !== c) changed = true;
      return t;
    });
    return changed ? out : child;
  }
  return child;
}

export function translateProps(props: Record<string, unknown>): Record<string, unknown> {
  if (getLocale() === 'ja' || props === null || typeof props !== 'object') return props;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(props)) {
    let t: unknown = v;
    if (k === 'children') t = translateChild(v);
    else if (typeof v === 'string' && !KEEP.has(k) && !k.startsWith('data-')) t = translate(v);
    if (t !== v) {
      out ??= { ...props };
      out[k] = t;
    }
  }
  return out ?? props;
}
