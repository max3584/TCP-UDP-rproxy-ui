// 画面から追加・変更・削除を行い、DB と rproxy-api に反映され、実際に転送されることを確かめる
import http from 'node:http';
import net from 'node:net';
import { expect, test } from '@playwright/test';

const LISTEN_PORT = Number(process.env.UI_E2E_LISTEN_PORT ?? 19401);
const BACKEND_PORTS = [19411, 19412];

function echoServer(port: number, prefix: string): Promise<net.Server> {
  const server = net.createServer((s) => s.on('data', (d) => s.end(`${prefix}:${d}`)));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function through(port: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(msg));
    c.setTimeout(3000, () => reject(new Error('timeout')));
    c.on('data', (d) => { resolve(d.toString()); c.end(); });
    c.on('error', reject);
    c.on('close', () => reject(new Error('closed without a reply')));
  });
}

const HTTP_BACKEND_PORTS = [19413, 19414];

// 受けたパスを「<名前> <パス>」で返す HTTP の転送先
function httpServer(port: number, name: string): Promise<http.Server> {
  const server = http.createServer((req, res) => res.end(`${name} ${req.url}`));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test.describe('rules from the UI', () => {
  const servers: net.Server[] = [];
  test.beforeAll(async () => {
    servers.push(await echoServer(BACKEND_PORTS[0], 'A'), await echoServer(BACKEND_PORTS[1], 'B'));
  });
  test.afterAll(() => servers.forEach((s) => s.close()));

  test('add, change and delete a TCP rule', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('接続できます')).toBeVisible();

    // add
    await page.getByRole('link', { name: '新規ルール' }).first().click();
    await expect(page).toHaveURL(/\/rules\/new$/);
    await page.locator('#rule-protocol').selectOption('tcp');
    await page.locator('#rule-src-addr').selectOption('127.0.0.1');
    await page.locator('#rule-src-port').fill(String(LISTEN_PORT));
    await page.locator('#rule-dist-addr').fill('127.0.0.1');
    await page.locator('#rule-dist-port').fill(String(BACKEND_PORTS[0]));
    await page.getByRole('button', { name: 'ルールを追加' }).click();
    await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${LISTEN_PORT}$`));
    await expect(page.getByText('稼働中').first()).toBeVisible();
    await expect.poll(() => through(LISTEN_PORT, 'hi').catch((e) => String(e))).toBe('A:hi');

    // change the target
    await page.getByRole('link', { name: '編集' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await page.locator('#rule-dist-port').fill(String(BACKEND_PORTS[1]));
    await page.getByRole('button', { name: '変更を保存' }).click();
    await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${LISTEN_PORT}$`));
    await expect(page.getByText(`127.0.0.1:${BACKEND_PORTS[1]}`).first()).toBeVisible();
    await expect.poll(() => through(LISTEN_PORT, 'hi').catch((e) => String(e))).toBe('B:hi');

    // delete
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => through(LISTEN_PORT, 'hi').then(() => 'open', () => 'closed')).toBe('closed');
    await expect(page.getByText(`:${LISTEN_PORT}`)).toHaveCount(0);
  });

  // L7（HTTP）のルールをフォームで作り、転送先のサービスを変え、削除する
  test('add, change and delete an L7 (HTTP) rule', async ({ page }) => {
    const port = LISTEN_PORT + 1;
    const backends = await Promise.all(HTTP_BACKEND_PORTS.map((p, i) => httpServer(p, i === 0 ? 'A' : 'B')));
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(port));
      // rproxy の features.http を取得してから出る
      await page.locator('#rule-l7').check();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await page.getByLabel('サービス backend の転送先 1 の URL').fill(`http://127.0.0.1:${HTTP_BACKEND_PORTS[0]}`);
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${port}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();
      await expect(page.getByTestId('http-summary')).toBeVisible();
      await expect.poll(() => httpGet(port, '/hello').catch((e) => String(e))).toBe('A /hello');

      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await page.getByLabel('サービス backend の転送先 1 の URL').fill(`http://127.0.0.1:${HTTP_BACKEND_PORTS[1]}`);
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${port}$`));
      await expect.poll(() => httpGet(port, '/again').catch((e) => String(e))).toBe('B /again');

      await page.getByRole('button', { name: '削除', exact: true }).click();
      await page.getByRole('button', { name: '削除する' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect.poll(() => httpGet(port, '/').then(() => 'open', () => 'closed')).toBe('closed');
    } finally {
      backends.forEach((s) => s.close());
    }
  });

  test('signed-out visitors do not get the form', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/rules/new');
    await expect(page).not.toHaveURL(/\/rules\/new$/, { timeout: 10_000 });
    await expect(page.locator('#rule-protocol')).toHaveCount(0);
    await context.close();
  });
});
