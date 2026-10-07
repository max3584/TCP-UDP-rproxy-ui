// rproxy の API を直接呼んで作ったルール（UI の DB にない。#76）を、管理者が画面で見て、rproxy の API で変え・消せること。
// 利用者には見えないこと。rproxy の版を問わない（v0.4 より前の rproxy では origin が dynamic のメモリだけのルール）
import { expect, test, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { NEXTAUTH_SECRET, baseURL } from '../../playwright.config';

const PORT = Number(process.env.UI_E2E_API_RULE_PORT ?? 19471);
const API = (process.env.RPROXY_API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const headers = { 'Content-Type': 'application/json', ...(process.env.RPROXY_API_TOKEN ? { Authorization: `Bearer ${process.env.RPROXY_API_TOKEN}` } : {}) };
const rulePath = `${API}/rules/tcp/127.0.0.1/${PORT}`;

async function asAdmin(context: BrowserContext): Promise<void> {
  const token = await encode({ token: { sub: 'ui-e2e-admin', name: 'Admin', email: 'admin@example.invalid', roles: ['rproxy-admin'] }, secret: NEXTAUTH_SECRET, maxAge: 3600 });
  await context.clearCookies();
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

test.describe('rules created through the rproxy API', () => {
  test.skip(API.startsWith('unix:'), 'needs the TCP control API');
  test.beforeEach(async () => {
    await fetch(rulePath, { method: 'DELETE', headers }).catch(() => undefined);
    const res = await fetch(`${API}/rules`, {
      method: 'POST', headers,
      body: JSON.stringify({ protocol: 'tcp', listen_addr: '127.0.0.1', listen_port: PORT, remote_addr: '127.0.0.1', remote_port: 19481 }),
    });
    expect(res.status, await res.text()).toBe(201);
  });
  test.afterEach(async () => {
    await fetch(rulePath, { method: 'DELETE', headers }).catch(() => undefined);
  });

  test('users do not see them', async ({ page }) => {
    const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${PORT}`);
    expect(res.status()).toBe(404);
  });

  test('admins see, edit and delete them through rproxy', async ({ page, context }) => {
    await asAdmin(context);
    await page.goto('/');
    const row = page.getByRole('row').filter({ hasText: String(PORT) });
    await expect(row.getByText(/^API/)).toBeVisible();

    await page.goto(`/rules/tcp/127.0.0.1/${PORT}`);
    await expect(page.getByTestId('api-rule')).toBeVisible();
    await page.getByRole('link', { name: '編集' }).click();
    await expect(page.getByTestId('api-edit-note')).toBeVisible();
    await page.locator('#rule-dist-port').fill('19482');
    await page.getByRole('button', { name: '変更を保存' }).click();
    await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PORT}$`));
    const changed = await (await fetch(rulePath, { headers })).json() as { remote_port: number };
    expect(changed.remote_port).toBe(19482);

    await page.getByRole('button', { name: '削除' }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect((await fetch(rulePath, { headers })).status).toBe(404);
  });
});
