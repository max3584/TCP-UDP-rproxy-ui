// v0.4 のルールの項目（ラベル・L4 の制限）と変更前の差分を画面から使い、rproxy-api に反映されて効くことを確かめる。
// rproxy の GET /capabilities の features が対応していないとき（v0.4 の中身がまだの rproxy）は飛ばす
import net from 'node:net';
import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.UI_E2E_V04_PORT ?? 19451);
const BACKEND_PORT = 19461;

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

async function deleteRule(page: Page): Promise<void> {
  await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: PORT } });
}

// 接続して閉じられるまで（または timeout まで）待つ。閉じられたら true
function closedSoon(port: number, ms: number): Promise<{ socket: net.Socket; closed: Promise<boolean> }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      resolve({ socket: s, closed: new Promise((r) => { const t = setTimeout(() => r(false), ms); s.on('close', () => { clearTimeout(t); r(true); }); }) });
    });
    s.on('error', reject);
  });
}

test.describe('v0.4 rule settings', () => {
  let backend: net.Server;
  test.beforeAll(async () => {
    backend = net.createServer((s) => s.on('data', (d) => s.write(d)));
    await new Promise<void>((r) => backend.listen(BACKEND_PORT, '127.0.0.1', r));
  });
  test.afterAll(() => backend.close());

  test('labels and per-source limits from the form', async ({ page }) => {
    const f = await features(page);
    test.skip(f.labels !== true || f.limits !== true, 'rproxy-api does not run labels / limits yet');
    await deleteRule(page);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKEND_PORT));
      await page.getByRole('tab', { name: '制限・GeoIP' }).click();
      await page.getByRole('button', { name: '＋ ラベルを追加' }).click();
      await page.getByLabel('ラベル 1 のキー').fill('tenant');
      await page.getByLabel('ラベル 1 の値').fill('e2e');
      await page.locator('#v04-source-max-connections').fill('1');
      if (f.dry_run === true) {
        await page.getByRole('button', { name: '差分を見る' }).click();
        await expect(page.getByTestId('plan-view')).toBeVisible();
        await expect(page.getByTestId('plan-view')).toContainText('作成');
      }
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PORT}$`));
      await expect(page.getByTestId('v04-section')).toContainText('tenant=e2e');

      // 送信元ごとの同時接続 1：2 本目はすぐ閉じられる
      const first = await closedSoon(PORT, 1500);
      const second = await closedSoon(PORT, 1500);
      expect(await second.closed).toBe(true);
      first.socket.destroy();
    } finally {
      await deleteRule(page);
    }
  });

  test('the plan shows what a change does before saving', async ({ page }) => {
    const f = await features(page);
    test.skip(f.dry_run !== true || f.labels !== true, 'rproxy-api does not answer dry runs yet');
    await deleteRule(page);
    const res = await page.request.post('/api/forward/add', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: PORT, distAddr: '127.0.0.1', distPort: BACKEND_PORT } });
    expect(res.ok(), await res.text()).toBe(true);
    try {
      await page.goto(`/rules/tcp/127.0.0.1/${PORT}/edit`);
      await page.getByRole('tab', { name: '制限・GeoIP' }).click();
      await page.getByRole('button', { name: '＋ ラベルを追加' }).click();
      await page.getByLabel('ラベル 1 のキー').fill('tenant');
      await page.getByLabel('ラベル 1 の値').fill('plan');
      await page.getByRole('button', { name: '差分を見る' }).click();
      await expect(page.getByTestId('plan-change')).toHaveText('接続を切らずに変わる');
      await expect(page.getByTestId('plan-diff')).toContainText('labels');
    } finally {
      await deleteRule(page);
    }
  });
});
