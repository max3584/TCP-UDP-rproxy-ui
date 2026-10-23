// すべての応答に付けるセキュリティのヘッダ（proxy.ts から呼ぶ。tests/securityheaders.test.ts）。
// next.config.mjs の headers() はビルドの時に固まるので、実行時の環境変数（KEYCLOAK_ISSUER・NEXTAUTH_URL）で変わる値はここで作る。
// 前段の rproxy は L4（TCP と TLS の終端）なので、HTTP のヘッダは足せない。UI が自分で付ける。

type Env = Record<string, string | undefined>;

// 文字列の URL から origin を取る。読めなければ null
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

// Content-Security-Policy。Next 16 の Turbopack は本番の HTML にも読み込むチャンクの一覧を inline の <script> で書くので、
// script-src 'self' だけでは動かない。proxy.ts が要求ごとに nonce を作り、pages/_document.tsx が <Head>・<NextScript> に付ける。
// 'strict-dynamic' で、nonce の付いたスクリプトが読み込むチャンクも動く（'self' は strict-dynamic を知らない古いブラウザ向け）。
// style 属性（UsageChart など）と NextAuth の組み込みのページの <style> のために style-src は 'unsafe-inline'（nonce を入れると unsafe-inline が無視されるので入れない）。
// form-action には Keycloak の origin を入れる（NextAuth のサインインのページのフォームは Keycloak へリダイレクトし、Chrome はその先にも当てる）。
// 本番が CSP の下で動くこと（違反がないこと）は tests/ui/csp.spec.ts で確かめる。
export function contentSecurityPolicy(env: Env = process.env, nonce?: string): string {
  const dev = env.NODE_ENV === 'development';
  const keycloak = originOf(env.KEYCLOAK_ISSUER);
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    // next dev は React のエラー表示のために eval を使う（本番では使わない）
    ['script-src', ["'self'", ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []), ...(dev ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    // next dev の HMR は同じホストの WebSocket
    ['connect-src', ["'self'", ...(dev ? ['ws:', 'wss:'] : [])]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'", ...(keycloak ? [keycloak] : [])]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

// 付けるヘッダの一覧。HSTS は NEXTAUTH_URL が https:// のときだけ（http で動かしているときに付けると、ブラウザが http で開けなくなる）
export function securityHeaders(env: Env = process.env, nonce?: string): [string, string][] {
  const headers: [string, string][] = [
    ['Content-Security-Policy', contentSecurityPolicy(env, nonce)],
    ['X-Frame-Options', 'DENY'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ];
  if (/^https:\/\//i.test(env.NEXTAUTH_URL?.trim() ?? '')) {
    headers.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);
  }
  return headers;
}

// proxy.ts が nonce を pages/_document.tsx に渡す要求のヘッダ（外から来た同じ名前のヘッダは proxy.ts が上書きする）
export const NONCE_HEADER = 'x-nonce';
