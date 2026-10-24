// Next.js 16 の Proxy（旧 middleware）。すべての応答にセキュリティのヘッダを付ける（components/securityheaders.ts）。
// 実行時の環境変数（KEYCLOAK_ISSUER・NEXTAUTH_URL）を読むので next.config.mjs の headers()（ビルドの時に固まる）ではなくここで付ける。
// CSP の nonce は要求ごとに作り、要求のヘッダ x-nonce で pages/_document.tsx に渡す（Turbopack の inline の <script> のため）
import { NextResponse, type NextRequest } from 'next/server';
import { NONCE_HEADER, securityHeaders } from './components/securityheaders';

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of securityHeaders(process.env, nonce)) response.headers.set(name, value);
  return response;
}
