// スマホ（375px）とタブレット（768px）の幅：ページ全体が横にはみ出さないこと（はみ出すのは表の中だけ）、
// メニューを開閉できること、狭い幅でもルールを追加できること（#88）
import { expect, test, type Page } from '@playwright/test';

const DETAIL_PORT = Number(process.env.UI_E2E_RESPONSIVE_PORT ?? 19421);
const ADD_PORT = DETAIL_PORT + 1;
const BACKEND_PORT = 19431;

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

async function expectNoPageOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `document is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
}

const detailHref = (port: number) => `/rules/tcp/127.0.0.1/${port}`;

async function addRuleByApi(page: Page, port: number): Promise<void> {
  const res = await page.request.post('/api/forward/add', {
    data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, distAddr: '127.0.0.1', distPort: BACKEND_PORT },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function deleteRuleByApi(page: Page, port: number): Promise<void> {
  await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port } });
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('dashboard fits the width', async ({ page }) => {
      await addRuleByApi(page, DETAIL_PORT);
      try {
        await page.goto('/');
        await expect(page.getByText('接続できます')).toBeVisible();
        // ルールの表は表の中だけで横にスクロールする
        await expect(page.locator(`a[href="${detailHref(DETAIL_PORT)}"]`)).toBeAttached();
        await page.waitForLoadState('networkidle');
        await expectNoPageOverflow(page);
      } finally {
        await deleteRuleByApi(page, DETAIL_PORT);
      }
    });

    test('rule detail fits the width', async ({ page }) => {
      await addRuleByApi(page, DETAIL_PORT);
      try {
        await page.goto(detailHref(DETAIL_PORT));
        await expect(page.getByRole('heading', { name: '概要' })).toBeVisible();
        await expect(page.getByTestId('history-row').first()).toBeVisible();
        await expectNoPageOverflow(page);
      } finally {
        await deleteRuleByApi(page, DETAIL_PORT);
      }
    });

    test('new rule form fits the width on every tab', async ({ page }) => {
      await page.goto('/rules/new');
      await expect(page.locator('#rule-protocol')).toBeVisible();
      await page.locator('#rule-protocol').selectOption('tcp');
      await expectNoPageOverflow(page);

      // 宛先を複数にした形
      await page.getByRole('button', { name: '宛先を追加' }).click();
      await expect(page.getByTestId('targets-editor')).toBeVisible();
      await expectNoPageOverflow(page);

      // TLS（終端）の欄
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('terminate');
      await expectNoPageOverflow(page);

      await page.getByRole('tab', { name: /詳細/ }).click();
      await expect(page.locator('#rule-allow-from')).toBeVisible();
      await expectNoPageOverflow(page);

      // L7（rproxy の features.http を取得してから出る）
      await page.getByRole('tab', { name: /基本/ }).click();
      await page.locator('#rule-l7').check();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await expect(page.getByTestId('http-route').first()).toBeVisible();
      await expectNoPageOverflow(page);
    });

    test('history fits the width', async ({ page }) => {
      await page.goto('/history');
      await expect(page.getByRole('heading', { name: '変更の履歴' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoPageOverflow(page);
    });

    test('import fits the width', async ({ page }) => {
      await page.goto('/rules/import');
      await expect(page.getByRole('heading', { name: 'ルールのインポート' })).toBeVisible();
      await expectNoPageOverflow(page);
      // 確かめた結果の表（dryRun なので何も変えない）
      await page.getByLabel('読み込む YAML / JSON').fill(
        `version: 1\nrules:\n  - protocol: tcp\n    listen_addr: 127.0.0.1\n    listen_port: ${ADD_PORT}\n    remote_addr: 127.0.0.1\n    remote_port: ${BACKEND_PORT}\n`,
      );
      await page.getByRole('button', { name: '確かめる' }).click();
      await expect(page.getByTestId('import-preview')).toBeVisible();
      await expectNoPageOverflow(page);
    });

    test('the menu opens and closes', async ({ page }) => {
      await page.goto('/');
      const toggle = page.getByRole('button', { name: 'メニュー' });
      const menu = page.getByRole('navigation', { name: 'メインメニュー' });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeHidden();

      // キーボードで開いて Esc で閉じる
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(menu).toBeVisible();
      // 言語の切り替えもメニューの中にある
      await expect(menu.getByRole('button', { name: 'English' })).toBeVisible();
      await expectNoPageOverflow(page);
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeHidden();

      // 画面を移ると閉じる
      await toggle.click();
      await menu.getByRole('link', { name: '変更の履歴' }).click();
      await expect(page).toHaveURL(/\/history$/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeHidden();
    });
  });
}

test.describe('phone (375px): add a rule', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('add and delete a TCP rule from the menu', async ({ page }) => {
    try {
      await page.goto('/');
      await expect(page.getByText('接続できます')).toBeVisible();
      await page.getByRole('button', { name: 'メニュー' }).click();
      await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '新規ルール' }).click();
      await expect(page).toHaveURL(/\/rules\/new$/);
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(ADD_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKEND_PORT));
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${ADD_PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();
      await expectNoPageOverflow(page);

      await page.getByRole('button', { name: '削除', exact: true }).click();
      await page.getByRole('button', { name: '削除する' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator(`a[href="${detailHref(ADD_PORT)}"]`)).toHaveCount(0);
    } finally {
      await deleteRuleByApi(page, ADD_PORT);
    }
  });
});

test('desktop keeps the sidebar and has no menu button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'メニュー' })).toBeHidden();
  const menu = page.getByRole('navigation', { name: 'メインメニュー' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: '新規ルール' })).toBeVisible();
  await expectNoPageOverflow(page);
});
