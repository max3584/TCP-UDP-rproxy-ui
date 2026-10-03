// 開発用（next dev）の JSX の実行時。jsx-runtime.ts と同じく、React に渡す前に文字列を訳す
import * as runtime from 'react/jsx-dev-runtime';
import { translateProps } from './props';

export const Fragment = runtime.Fragment;
export type { JSX } from 'react/jsx-dev-runtime';

export function jsxDEV(
  type: Parameters<typeof runtime.jsxDEV>[0],
  props: Record<string, unknown>,
  key: string | undefined,
  isStatic: boolean,
  source?: Parameters<typeof runtime.jsxDEV>[4],
  self?: unknown,
) {
  return runtime.jsxDEV(type, translateProps(props), key, isStatic, source, self);
}
