// React の JSX の実行時（tsconfig の jsxImportSource）。React に渡す前に、子のテキストと
// 文字列の属性（title・placeholder・aria-label など）を、今の言語に訳す（i18n/core.ts）。
// 入力の値（value・defaultValue）や識別子（id・name・href・className・key・data-*）は訳さない。
import * as runtime from 'react/jsx-runtime';
import { translateProps } from './props';

export const Fragment = runtime.Fragment;
export type { JSX } from 'react/jsx-runtime';

export function jsx(type: Parameters<typeof runtime.jsx>[0], props: Record<string, unknown>, key?: string) {
  return runtime.jsx(type, translateProps(props), key);
}

export function jsxs(type: Parameters<typeof runtime.jsxs>[0], props: Record<string, unknown>, key?: string) {
  return runtime.jsxs(type, translateProps(props), key);
}
