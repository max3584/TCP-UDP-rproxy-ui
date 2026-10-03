// 画面の言語の切り替え：ヘッダーで English を選ぶと英語になり、cookie に残るので次のページ（SSR）も英語のまま
import { expect, test } from '@playwright/test';

test('switch the UI to English', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh now' })).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === 'rproxy_ui_lang')?.value).toBe('en');

  await page.getByRole('link', { name: 'New rule' }).first().click();
  await expect(page).toHaveURL(/\/rules\/new$/);
  await expect(page.getByRole('heading', { name: 'New rule' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add rule' })).toBeVisible();
  await expect(page.getByText('Listen port:', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Basic/ })).toBeVisible();

  // 読み込み直しても（SSR でも）英語
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Listen port:', { exact: true })).toBeVisible();

  // 日本語に戻す（ほかのテストに残さない）
  await page.getByRole('button', { name: '日本語' }).click();
  await expect(page.getByText('待ち受けポート:', { exact: true })).toBeVisible();
});
