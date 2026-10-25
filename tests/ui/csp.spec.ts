// セキュリティのヘッダ（#156、proxy.ts・components/securityheaders.ts）。本番ビルドが CSP の下で動くこと（違反が 1 つもないこと）、
// サインインしていないときの Keycloak へのリダイレクト（RequireAuth と NextAuth の組み込みのページのフォーム）も CSP に止められないことを確かめる。
// Keycloak の代わりに、OIDC の discovery と認可のエンドポイントだけの偽のサーバを動かす（playwright.config.ts の FAKE_ISSUER）
import http from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';
import { FAKE_ISSUER, FAKE_ISSUER_PORT, baseURL } from '../../playwright.config';

const AUTH_ENDPOINT = `${FAKE_ISSUER}/protocol/openid-connect/auth`;
// 詳細・変更の画面に使うルール（テストの中で作って消す）
const RULE_PORT = 19581;
const RULE = `/rules/tcp/127.0.0.1/${RULE_PORT}`;
const PAGES = ['/', '/rules/new', '/rules/import', RULE, `${RULE}/edit`, '/history', '/usage', '/system', '/ha', '/profile', '/no-such-page'];

let issuer: http.Server;

test.beforeAll(async () => {
  issuer = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/realms/e2e/.well-known/openid-configuration') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        issuer: FAKE_ISSUER,
        authorization_endpoint: AUTH_ENDPOINT,
        token_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${FAKE_ISSUER}/protocol/openid-connect/certs`,
        userinfo_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/userinfo`,
        end_session_endpoint: `${FAKE_ISSUER}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }));
    } else if (path === '/realms/e2e/protocol/openid-connect/auth') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>fake keycloak</title><h1>fake keycloak sign-in</h1>');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => issuer.listen(FAKE_ISSUER_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => issuer.close(resolve));
});

// CSP の違反（securitypolicyviolation のイベントと、Chrome がコンソールに出す「Refused to ...」）を集める
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('CSP violation') || text.includes('Content Security Policy')) violations.push(`${page.url()}: ${text}`);
  });
  return violations;
}

// React が動いた（サーバの HTML は「サインインを確認しています…」「Loading...」で、JS がセッションを読んでから画面が出る）
async function expectHydrated(page: Page, path: string): Promise<void> {
  await expect(page.getByText('サインインを確認しています…'), path).toHaveCount(0);
  await expect(page.getByText('Loading...', { exact: true }), path).toHaveCount(0);
  await expect(page.locator('main'), path).not.toBeEmpty();
}

test.describe('security headers and CSP', () => {
  test('every response carries the security headers and no X-Powered-By', async ({ page }) => {
    const doc = await page.goto('/');
    const h = doc!.headers();
    // a fresh nonce for every request
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(h['content-security-policy'])?.[1];
    expect(nonce).toBeTruthy();
    expect(h['content-security-policy']).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src`
      + " 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
      + `connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' ${new URL(FAKE_ISSUER).origin}; frame-ancestors 'none'`,
    );
    for (const res of [doc!, await page.request.get('/api/healthz'), await page.request.get('/api/forward/nodes')]) {
      const headers = res.headers();
      expect(headers['x-frame-options'], res.url()).toBe('DENY');
      expect(headers['x-content-type-options'], res.url()).toBe('nosniff');
      expect(headers['referrer-policy'], res.url()).toBe('strict-origin-when-cross-origin');
      expect(headers['permissions-policy'], res.url()).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      expect(headers['cross-origin-opener-policy'], res.url()).toBe('same-origin');
      expect(headers['cross-origin-resource-policy'], res.url()).toBe('same-origin');
      expect(headers['x-powered-by'], res.url()).toBeUndefined();
      // NEXTAUTH_URL is http:// in the E2E, so no HSTS
      expect(headers['strict-transport-security'], res.url()).toBeUndefined();
    }
    // static files too
    const script = await page.locator('script[src^="/_next/static/"]').first().getAttribute('src');
    const asset = await page.request.get(script!);
    expect(asset.headers()['x-content-type-options']).toBe('nosniff');
    expect(asset.headers()['content-security-policy']).toBeDefined();
  });

  test('the pages work under the CSP (no violations)', async ({ page }) => {
    const violations = await watchCsp(page);
    const rule = { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT };
    await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: rule });
    const add = await page.request.post('/api/forward/add', { headers: SAME_ORIGIN, data: { ...rule, distAddr: '127.0.0.1', distPort: 9 } });
    expect(add.status(), await add.text()).toBe(200);
    try {
      for (const path of PAGES) {
        const res = await page.goto(path);
        if (path === '/no-such-page') expect(res!.status()).toBe(404);
        // networkidle は使わない（ダッシュボードは 5 秒ごとに読み直す）
        await expectHydrated(page, path);
      }
      // the rule pages really rendered the rule (not an error)
      await page.goto(RULE);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(String(RULE_PORT));
      await expect(page.getByText(/127\.0\.0\.1:9\b/).first()).toBeVisible();
    } finally {
      await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: rule });
    }
    // client-side navigation as well
    await page.goto('/');
    await page.getByRole('link', { name: /履歴/ }).first().click();
    await expect(page).toHaveURL(/\/history$/);
    expect(violations).toEqual([]);
  });

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('an unauthenticated page redirects to Keycloak without CSP violations', async ({ page }) => {
      const violations = await watchCsp(page);
      await page.goto('/rules/new');
      await page.waitForURL((url) => url.href.startsWith(AUTH_ENDPOINT));
      const url = new URL(page.url());
      expect(url.searchParams.get('client_id')).toBe('rproxy-ui');
      // Keycloak re-authenticates when the authentication is older than the session (RPROXY_UI_SESSION_MAX_AGE, default 8 h)
      expect(url.searchParams.get('max_age')).toBe('28800');
      expect(url.searchParams.get('redirect_uri')).toBe(`${baseURL}/api/auth/callback/keycloak`);
      await expect(page.getByRole('heading', { name: 'fake keycloak sign-in' })).toBeVisible();
      expect(violations).toEqual([]);
    });

    test('the NextAuth sign-in page form reaches Keycloak (form-action allows the issuer)', async ({ page }) => {
      const violations = await watchCsp(page);
      await page.goto('/api/auth/signin');
      await page.getByRole('button', { name: /Keycloak/ }).click();
      await page.waitForURL((url) => url.href.startsWith(AUTH_ENDPOINT));
      expect(violations).toEqual([]);
    });

    test('the profile page (public) loads without CSP violations', async ({ page }) => {
      const violations = await watchCsp(page);
      await page.goto('/profile');
      await expect(page.getByText('You are not signed in')).toBeVisible();
      expect(violations).toEqual([]);
    });
  });
});
