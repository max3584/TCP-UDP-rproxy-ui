// 入力の検証の誤り（rproxy のエラーコードと同じ invalid / tls_config / unsupported）。tls.ts と v04.ts が使う
export type TlsErrorCode = 'invalid' | 'tls_config' | 'unsupported';

export class TlsError extends Error {
  constructor(message: string, public readonly code: TlsErrorCode) {
    super(message);
    this.name = 'TlsError';
  }
}
