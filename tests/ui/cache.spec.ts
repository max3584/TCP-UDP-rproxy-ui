// L7 の応答のキャッシュ（rproxy-api #340）をフォームで作り、rproxy-api に反映されて効くこと（2 回目はメモリから）、
// 置き場所の誤りを保存の前に知らせること、詳細画面に設定と数が出ること、編集画面で読み直せることを確かめる。
// rproxy の features.middlewares に cache がなければ飛ばす
import http from 'node:http';
import net from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const L7_PORT = 19591;
const BACKEND = 19592;

async function hasCache(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return false;
  const caps = await res.json() as { features?: { middlewares?: string[] } };
  return (caps.features?.middlewares ?? []).includes('cache');
}

async function deleteRule(page: Page): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: L7_PORT } });
}

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function get(path: string): Promise<{ status: number; body: string; cache: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: L7_PORT, path: path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cache: String(res.headers['x-cache'] ?? '') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('response cache from the form', async ({ page }) => {
  test.skip(!(await hasCache(page)), 'rproxy-api does not run the cache middleware yet');
  let calls = 0;
  const backend = await listen(http.createServer((req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ n: calls, path: req.url }));
  }), BACKEND);
  await deleteRule(page);
  try {
    await page.goto('/rules/new');
    await page.locator('#rule-protocol').selectOption('tcp');
    await page.locator('#rule-src-addr').selectOption('127.0.0.1');
    await page.locator('#rule-src-port').fill(String(L7_PORT));
    await page.locator('#rule-l7').check();
    await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
    await page.getByLabel('サービス backend の転送先 1 の URL').fill(`http://127.0.0.1:${BACKEND}`);

    const addMiddleware = page.getByLabel('ミドルウェアを追加');
    await addMiddleware.selectOption('cache');
    await page.locator('#http-mw-0-ttl').fill('1h');
    await page.locator('#http-mw-0-vary').fill('Accept-Language');
    await page.locator('#http-mw-0-status-404').check();
    // cache の後ろに IP の許可リストを置くと、保存の前に断る
    await addMiddleware.selectOption('ip_allow');
    await page.getByLabel('ルート all にミドルウェアを足す').selectOption('cache');
    await page.getByLabel('ルート all にミドルウェアを足す').selectOption('ip-allow');
    await page.getByRole('button', { name: 'ルールを追加' }).click();
    await expect(page.getByText('「ip-allow」（ip_allow）が cache「cache」より後ろにあります', { exact: false }).first()).toBeVisible();
    await page.getByTestId('http-middleware').nth(1).getByRole('button', { name: '削除' }).click();

    await page.getByRole('button', { name: 'ルールを追加' }).click();
    await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${L7_PORT}$`));
    await expect(page.getByText('稼働中').first()).toBeVisible();

    // 1 回目は転送先から、2 回目はメモリから（転送先へは 1 回）
    await expect.poll(() => get('/state.json').then((r) => r.cache, (e) => String(e))).toBe('MISS');
    const second = await get('/state.json');
    expect(second.cache).toBe('HIT');
    expect(JSON.parse(second.body)).toEqual({ n: 1, path: '/state.json' });
    expect(calls).toBe(1);

    // 詳細画面：設定と数
    await expect(page.getByTestId('http-summary')).toContainText('応答のキャッシュ');
    await expect(page.getByTestId('http-summary')).toContainText('ttl: 1h');
    await expect.poll(async () => {
      await page.reload();
      return page.getByTestId('http-cache-stats').textContent({ timeout: 2000 }).catch(() => '');
    }).toContain('ヒット 1');
    await expect(page.getByTestId('http-cache-stats')).toContainText('ミス 1');
    await expect(page.getByTestId('http-route-cache').first()).toContainText('cache: ヒット 1');

    // 編集画面で読み直せる
    await page.getByRole('link', { name: '編集' }).click();
    await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
    await expect(page.locator('#http-mw-0-ttl')).toHaveValue('1h');
    await expect(page.locator('#http-mw-0-vary')).toHaveValue('Accept-Language');
    await expect(page.locator('#http-mw-0-status-404')).toBeChecked();
    await expect(page.locator('#http-mw-0-status-200')).toBeChecked();
    await expect(page.getByTestId('http-preserved')).toHaveCount(0);
  } finally {
    await deleteRule(page);
    backend.close();
  }
});
