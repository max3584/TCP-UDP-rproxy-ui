import { getLocale, translate } from './core';

// 訳さない属性：入力の値と識別子
const KEEP = new Set(['value', 'defaultValue', 'id', 'name', 'href', 'className', 'key', 'htmlFor', 'type', 'src', 'action', 'method', 'role', 'download', 'target', 'rel', 'lang', 'dangerouslySetInnerHTML']);

// 描画される子か（null・undefined・true / false・'' は何も出さない）
const rendered = (c: unknown) => c !== null && c !== undefined && typeof c !== 'boolean' && c !== '';

// 日本語の文は「。」で終わり、次の文との間に空白を置かない。英語に訳したら、後ろに別の子が続くときは空白を足す
// （「…の履歴です。{説明}「この版に戻す」で…」が "…deletions.Showing…" にならないように）
const SENTENCE_END = /[。！？]$/;

// 子の先頭・末尾の文字（文字列・数・要素の子をたどる）。分からなければ undefined
function edgeText(c: unknown, last: boolean, depth = 0): string | undefined {
  if (typeof c === 'string') return c === '' ? undefined : last ? c[c.length - 1] : c[0];
  if (typeof c === 'number' || typeof c === 'bigint') return last ? String(c).slice(-1) : String(c)[0];
  if (depth > 8) return undefined;
  if (Array.isArray(c)) {
    const list = c.filter(rendered);
    return list.length === 0 ? undefined : edgeText(last ? list[list.length - 1] : list[0], last, depth + 1);
  }
  if (c !== null && typeof c === 'object' && 'props' in c) {
    return edgeText((c as { props?: { children?: unknown } }).props?.children, last, depth + 1);
  }
  return undefined;
}

// 日本語の括弧（「（…）」）は前の語に続けて書くが、英語では前に空白を置く。JSX で別の子になった括弧
// （「宛先{範囲なら '（ポートは範囲の先頭）'}」「{名前}（<span>…</span>）」など）は、訳した後で前の子との間に空白を足す
// （"Backends(the port is …)" にならないように）。文字列の子は日本語の「（」で始まるものだけ、要素の子は中の文字が「(」で始まるもの
function opensParen(original: unknown, translated: unknown): boolean {
  if (typeof original === 'string') return original.startsWith('（') && typeof translated === 'string' && translated.startsWith('(');
  if (original !== null && typeof original === 'object' && 'props' in original) return edgeText(translated, false) === '(';
  return false;
}

function translateChild(child: unknown): unknown {
  if (typeof child === 'string') return translate(child);
  if (Array.isArray(child)) {
    let changed = false;
    const out: unknown[] = [];
    let prev: unknown;
    child.forEach((c, i) => {
      let t = translateChild(c);
      if (typeof c === 'string' && typeof t === 'string' && t !== c && SENTENCE_END.test(c) && !/\s$/.test(t)) {
        const next = child.slice(i + 1).find(rendered);
        if (next !== undefined && !(typeof next === 'string' && /^\s/.test(next))) t += ' ';
      }
      if (prev !== undefined && rendered(t) && opensParen(c, t)) {
        const before = edgeText(prev, true);
        if (before !== undefined && !/[\s([{/'"“‘-]/.test(before)) {
          if (typeof t === 'string') t = ` ${t}`;
          else {
            out.push(' ');
            changed = true;
          }
        }
      }
      if (t !== c) changed = true;
      out.push(t);
      if (rendered(t)) prev = t;
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
