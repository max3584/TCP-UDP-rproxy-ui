// rproxy-api v0.4.3 の tcp のルールの connect_timeout（UI #184）をフォームから使い、rproxy-api に渡ること（差分（dry run）で
// rproxy の今の値と比べる）、変更の画面でそのまま保存しても消えないこと、空にすると外れることを確かめる。
// 欄は rproxy が UI の DB から戻せる（features.db_connect_timeout、rproxy-api v0.4.21、#379）ときだけなので、なければ飛ばす
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const RULE_PORT = 19611;
const BACKEND = 19612;
const DETAIL = new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`);

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

async function deleteRule(page: Page): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT } });
}

async function storedRule(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${RULE_PORT}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

// connect_timeout を value にする変更を rproxy に dry run で聞き、rproxy の今の値と同じか（action が none）を返す
async function rproxyHas(page: Page, value: string): Promise<boolean> {
  const res = await page.request.post('/api/forward/plan', {
    headers: SAME_ORIGIN,
    data: { action: 'modify', protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT, distAddr: '127.0.0.1', distPort: BACKEND, connectTimeout: value },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json() as { results: { plan?: { action: string } }[] };
  return body.results[0].plan?.action === 'none';
}

test.describe('TCP connect timeout', () => {
  test('connect_timeout from the form reaches rproxy, an edit keeps it, and clearing removes it', async ({ page }) => {
    const f = await features(page);
    test.skip(f.db_connect_timeout !== true || f.dry_run !== true, 'rproxy-api does not restore connect_timeout from the UI database yet');
    await deleteRule(page);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(RULE_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKEND));
      await page.getByRole('tab', { name: '詳細' }).click();
      // 100ms 未満は rproxy と同じく断る
      await page.locator('#rule-connect-timeout').fill('50ms');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByTestId('connect-timeout')).toContainText('100ms〜10m にしてください');
      await page.locator('#rule-connect-timeout').fill('1500ms');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(DETAIL);
      await expect(page.getByTestId('connect-timeout')).toHaveText('1500ms');
      expect((await storedRule(page)).connectTimeout).toBe('1500ms');
      expect(await rproxyHas(page, '1500ms')).toBe(true);

      // 変更の画面で何も変えずに保存しても残る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await expect(page.locator('#rule-connect-timeout')).toHaveValue('1500ms');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(DETAIL);
      expect((await storedRule(page)).connectTimeout).toBe('1500ms');

      // rproxy の 120s のような書き方とも揃う
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await page.locator('#rule-connect-timeout').fill('120s');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(DETAIL);
      await expect(page.getByTestId('connect-timeout')).toHaveText('2m');
      expect(await rproxyHas(page, '2m')).toBe(true);

      // 空にすると外れる（rproxy へは 0s を送る。DB からも消える）
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await page.locator('#rule-connect-timeout').fill('');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(DETAIL);
      await expect(page.getByTestId('connect-timeout')).toHaveText('既定（ほかに宛先があれば 5s、なければ 30s）');
      expect((await storedRule(page)).connectTimeout).toBeUndefined();
      expect(await rproxyHas(page, '2m')).toBe(false);
    } finally {
      await deleteRule(page);
    }
  });
});
