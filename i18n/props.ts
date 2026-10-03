import { getLocale, translate } from './core';

// 訳さない属性：入力の値と識別子
const KEEP = new Set(['value', 'defaultValue', 'id', 'name', 'href', 'className', 'key', 'htmlFor', 'type', 'src', 'action', 'method', 'role', 'download', 'target', 'rel', 'lang', 'dangerouslySetInnerHTML']);

function translateChild(child: unknown): unknown {
  if (typeof child === 'string') return translate(child);
  if (Array.isArray(child)) {
    let changed = false;
    const out = child.map((c) => {
      const t = translateChild(c);
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
