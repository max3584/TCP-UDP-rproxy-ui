// トークンでのサインイン（#179）。Keycloak のクッキーを作らず、画面のサインインのページからトークンでサインインする。
// playwright.config.ts の 2 つめの UI（TOKEN_BASE_URL。RPROXY_UI_AUTH=both、トークンは tests/ui/token-fixture.cjs）を相手にする。
// サインインのページが CSP の下で動くこと（違反がないこと）、取り消し（ファイルから行を消す）で次の確認からセッションが切れること、
// 誤ったトークンの続く送信元の誤ったトークンが 429 になり、正しいトークンは通ることも確かめる
import { expect, test, type Page } from '@playwright/test';
import { TOKEN_BASE_URL } from '../../playwright.config';
import { E2E_TOKENS, E2E_USER_SUB, writeTokens } from './token-fixture.cjs';

test.use({ baseURL: TOKEN_BASE_URL, storageState: { cookies: [], origins: [] } });

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

// 送ってから答えが来るまで待つ（答えの status を返す）
async function signIn(page: Page, token: string): Promise<number> {
  await page.getByLabel('アクセストークン').fill(token);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/callback/token') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'トークンでサインイン' }).click(),
  ]);
  return res.status();
}

const session = async (page: Page) => (await page.request.get('/api/auth/session')).json() as Promise<{ user?: { id: string; name: string; access: string } }>;

test.describe('token sign-in', () => {
  test.afterEach(() => writeTokens());

  test('an unauthenticated page leads to the sign-in page; a token signs in and comes back (no CSP violations)', async ({ page, context }) => {
    const violations = await watchCsp(page);
    await page.goto('/history');
    await page.waitForURL((url) => url.pathname === '/signin');
    expect(new URL(page.url()).searchParams.get('callbackUrl')).toBe(`${TOKEN_BASE_URL}/history`);
    // both：Keycloak のボタンもある
    await expect(page.getByRole('button', { name: 'Keycloak でサインイン' })).toBeVisible();
    await expect(page.getByLabel('アクセストークン')).toHaveAttribute('type', 'password');
    await signIn(page, E2E_TOKENS.admin);
    await page.waitForURL((url) => url.pathname === '/history');
    await expect(page.getByText('サインインを確認しています…')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await session(page)).toMatchObject({ user: { id: 'token:e2e-admin', name: 'e2e-admin', access: 'admin' } });
    // the session cookie: the same flags as with Keycloak (httpOnly, SameSite=Lax; Secure only on https://)
    const cookie = (await context.cookies()).find((c) => c.name === 'next-auth.session-token');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false });
    // the token is in no cookie and nowhere on the page
    for (const c of await context.cookies()) expect(c.value).not.toContain(E2E_TOKENS.admin);
    expect(await page.content()).not.toContain(E2E_TOKENS.admin);
    // the API works with the token session
    expect((await page.request.get('/api/forward/nodes')).status()).toBe(200);
    expect(violations).toEqual([]);
  });

  test('a role: user token is a user with its sub', async ({ page }) => {
    await page.goto('/signin');
    await signIn(page, E2E_TOKENS.user);
    await page.waitForURL((url) => url.pathname === '/');
    expect(await session(page)).toMatchObject({ user: { id: E2E_USER_SUB, name: 'e2e-user', access: 'user' } });
  });

  test('a wrong token is refused and the field is cleared', async ({ page }) => {
    await page.goto('/signin');
    expect(await signIn(page, 'rpui_wrong-token')).toBe(401);
    await expect(page.locator('main').getByRole('alert')).toHaveText('トークンが違います。');
    await expect(page.getByLabel('アクセストークン')).toHaveValue('');
    expect(await session(page)).toEqual({});
  });

  test('removing the token from the file ends its session at the next check', async ({ page }) => {
    await page.goto('/signin');
    await signIn(page, E2E_TOKENS.revoke);
    await page.waitForURL((url) => url.pathname === '/');
    // wait until the dashboard has finished its own session check (RequireAuth shows the page only after
    // useSession's GET /api/auth/session). Removing the token before that makes the dashboard itself go to
    // /signin, and that navigation aborts the goto below (net::ERR_ABORTED)
    await expect(page.getByText('サインインを確認しています…')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    expect((await session(page)).user?.name).toBe('e2e-revoke');
    writeTokens(['admin', 'user']);
    expect(await session(page)).toEqual({});
    expect((await page.request.get('/api/forward/nodes')).status()).toBe(401);
    // /history's own check sends it to /signin: wait for that URL instead of the load of /history,
    // and make sure it is /history (not the dashboard) that went there
    await page.goto('/history', { waitUntil: 'commit' });
    await page.waitForURL((url) => url.pathname === '/signin');
    expect(new URL(page.url()).searchParams.get('callbackUrl')).toBe(`${TOKEN_BASE_URL}/history`);
    // the removed token no longer signs in
    await signIn(page, E2E_TOKENS.revoke);
    await expect(page.locator('main').getByRole('alert')).toHaveText('トークンが違います。');
  });

  test('a cross-site sign-in POST is refused', async ({ page }) => {
    const res = await page.request.post('/api/auth/callback/token', {
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      form: { token: E2E_TOKENS.admin, csrfToken: 'x', json: 'true' },
    });
    expect(res.status()).toBe(403);
  });

  test('a source with repeated wrong tokens gets 429 for wrong tokens; the right token still signs in', async ({ page }) => {
    // this test's own source (X-Forwarded-For through the trusted 127.0.0.1): the other tests keep their count
    await page.route('**/api/auth/callback/token', (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '198.51.100.77' } }));
    await page.goto('/signin');
    for (let i = 0; i < 5; i++) {
      expect(await signIn(page, `rpui_wrong-${i}`)).toBe(401);
      await expect(page.locator('main').getByRole('alert')).toHaveText('トークンが違います。');
    }
    expect(await signIn(page, 'rpui_wrong-5')).toBe(429);
    await expect(page.locator('main').getByRole('alert')).toContainText('しばらく断っています');
    expect(await session(page)).toEqual({});
    expect(await signIn(page, E2E_TOKENS.admin)).toBe(200);
    await page.waitForURL((url) => url.pathname === '/');
    expect((await session(page)).user?.name).toBe('e2e-admin');
  });
});
