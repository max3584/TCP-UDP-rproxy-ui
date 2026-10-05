// UI と rproxy-api の版が画面に出ること（#106）。CI の rproxy-api は同じ名前のブランチか既定のブランチから
// ビルドするので、版を返さない古い rproxy-api（「不明」と注意）でも通るようにする
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const UI_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const VERSION_OR_UNKNOWN = /^(v\d+\.\d+\.\d+|不明)$/;

test('the sidebar shows the UI and rproxy-api versions', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByTestId('sidebar-versions');
  await expect(sidebar.getByTestId('ui-version')).toHaveText(`v${UI_VERSION}`);
  await expect(sidebar.getByTestId('rproxy-version').first()).toHaveText(VERSION_OR_UNKNOWN);
});

test('the dashboard lists each node\'s rproxy-api version and warns when it is unknown or too old', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('versions-card');
  await expect(card).toBeVisible();
  const version = card.getByTestId('node-rproxy-version').first();
  await expect(version).toHaveText(VERSION_OR_UNKNOWN);
  if ((await version.textContent()) === '不明') {
    // 版を返さない rproxy-api（v0.3.18 より前）：注意を出す
    await expect(page.getByTestId('version-notice')).toHaveAttribute('data-level', 'warning');
  } else {
    // 版を返す rproxy-api は、この UI が必要とする版以上（注意は出ないか、新しいマイナーの知らせだけ）
    const notice = page.getByTestId('version-notice');
    if (await notice.count() > 0) await expect(notice).toHaveAttribute('data-level', 'info');
  }
});
