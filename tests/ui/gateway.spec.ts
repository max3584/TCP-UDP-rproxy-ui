// Gateway API 向けの L7・TLS の項目（rproxy-api #237）をフォームで作り、rproxy-api に反映されて効くこと、
// 詳細画面に出ること、編集画面で読み直せることを確かめる。rproxy の features が対応していなければ飛ばす
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { expect, test, type Page } from '@playwright/test';

const L7_PORT = 19521;
const SNI_PORT = 19522;
const HTTP_BACKEND = 19525;
const SHADOW_BACKEND = 19526;
const TCP_BACKENDS = [19527, 19528];

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

const has = (f: Record<string, unknown>, key: string, names: string[]) => Array.isArray(f[key]) && names.every((n) => (f[key] as string[]).includes(n));

async function deleteRule(page: Page, port: number): Promise<void> {
  await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port } });
}

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test.describe('Gateway API fields from the form', () => {
  test('route timeouts, replace_host, headers add, mirror and a status backend', async ({ page }) => {
    const f = await features(page);
    test.skip(!has(f, 'http_options', ['headers_add', 'route_timeouts', 'server_status']) || !has(f, 'middlewares', ['mirror', 'replace_host']),
      'rproxy-api does not run the Gateway API fields yet');
    const mirrored: string[] = [];
    const backend = await listen(http.createServer((req, res) => res.end(`A ${req.headers.host} ${req.headers['x-added'] ?? '-'} ${req.url}`)), HTTP_BACKEND);
    const shadow = await listen(http.createServer((req, res) => { mirrored.push(req.url ?? ''); res.end('shadow'); }), SHADOW_BACKEND);
    await deleteRule(page, L7_PORT);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(L7_PORT));
      await page.locator('#rule-l7').check();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await page.getByLabel('サービス backend の転送先 1 の URL').fill(`http://127.0.0.1:${HTTP_BACKEND}`);

      // サービス：ミラーの送り先（backend-2）と、418 で答えるだけのもの（backend-3）
      await page.getByRole('button', { name: 'サービスを追加' }).click();
      await page.getByLabel('サービス backend-2 の転送先 1 の URL').fill(`http://127.0.0.1:${SHADOW_BACKEND}`);
      await page.getByRole('button', { name: 'サービスを追加' }).click();
      await page.getByLabel('サービス backend-3 の転送先 1 の種類').selectOption('status');
      await page.getByLabel('サービス backend-3 の転送先 1 の状態コード').fill('418');

      // ミドルウェア：Host の書き換え・ヘッダを足す・ミラー
      const addMiddleware = page.getByLabel('ミドルウェアを追加');
      await addMiddleware.selectOption('replace_host');
      await page.locator('#http-mw-0-host').fill('rewritten.example');
      await addMiddleware.selectOption('headers');
      await page.locator('#http-mw-1-json').fill('{"request": {"add": {"X-Added": "yes"}}}');
      await addMiddleware.selectOption('mirror');
      await page.locator('#http-mw-2-service').selectOption('backend-2');

      // ルート all：時間の上限とミドルウェア。ルート teapot：418 のサービス
      await page.locator('#http-route-0-timeout-request').fill('10s');
      for (const m of ['replace-host', 'headers', 'mirror']) await page.getByLabel('ルート all にミドルウェアを足す').selectOption(m);
      await page.getByRole('button', { name: 'ルートを追加' }).click();
      await page.locator('#http-route-1-match').fill('PathPrefix(`/teapot`)');
      await page.locator('#http-route-1-target').selectOption('service:backend-3');

      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${L7_PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();

      // 効いている：Host は書き換え、ヘッダは足し、写しはミラーへ、/teapot は 418
      await expect.poll(() => httpGet(L7_PORT, '/hello').then((r) => r.body, (e) => String(e))).toBe('A rewritten.example yes /hello');
      await expect.poll(() => mirrored.includes('/hello')).toBe(true);
      await expect.poll(() => httpGet(L7_PORT, '/teapot').then((r) => r.status, () => 0)).toBe(418);

      // 詳細画面
      const summary = page.getByTestId('http-summary');
      await expect(summary.getByTestId('http-route-timeouts')).toHaveText('全体 10s');
      await expect(summary).toContainText('状態コード 418 で答える');
      await expect(summary).toContainText('Host の書き換え');
      await expect(summary).toContainText('ミラー（リクエストの写しを送る）');

      // 編集画面で読み直せる
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await expect(page.locator('#http-route-0-timeout-request')).toHaveValue('10s');
      await expect(page.getByLabel('サービス backend-3 の転送先 1 の状態コード')).toHaveValue('418');
      await expect(page.locator('#http-mw-2-service')).toHaveValue('backend-2');
      await expect(page.getByTestId('http-preserved')).toHaveCount(0);
    } finally {
      await deleteRule(page, L7_PORT);
      backend.close();
      shadow.close();
    }
  });

  test('several destinations for one server name (tls.routes targets)', async ({ page }) => {
    const f = await features(page);
    test.skip(f.tls_route_targets !== true, 'rproxy-api does not run tls.routes targets yet');
    const hits = [0, 0];
    const backends = await Promise.all(TCP_BACKENDS.map((p, i) => listen(net.createServer((s) => { hits[i]++; s.on('data', () => s.destroy()); }), p)));
    const fallback = await listen(net.createServer((s) => s.destroy()), 19529);
    await deleteRule(page, SNI_PORT);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(SNI_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill('19529');
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('sni');
      await page.getByRole('button', { name: '＋ 転送先を追加' }).click();
      await page.getByLabel('サーバ名 1', { exact: true }).fill('a.gateway.test');
      await page.getByRole('button', { name: '転送先 1 を複数の宛先にする' }).click();
      for (const [i, port] of TCP_BACKENDS.entries()) {
        await page.getByLabel(`転送先 1 の宛先 ${i + 1} のアドレス`).fill('127.0.0.1');
        await page.getByLabel(`転送先 1 の宛先 ${i + 1} のポート`).fill(String(port));
      }
      await page.locator('#rule-tls-route-balance-0').selectOption('failover');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${SNI_PORT}$`));

      const targets = page.getByTestId('tls-route-targets');
      await expect(targets).toContainText(`127.0.0.1:${TCP_BACKENDS[0]}`);
      await expect(targets).toContainText(`127.0.0.1:${TCP_BACKENDS[1]}`);
      await expect(targets).toContainText('フェイルオーバー');

      // a.gateway.test の ClientHello は 1 番目の宛先へ（failover）
      await expect.poll(async () => {
        const s = tls.connect({ host: '127.0.0.1', port: SNI_PORT, servername: 'a.gateway.test', rejectUnauthorized: false });
        s.on('error', () => undefined);
        await new Promise((r) => setTimeout(r, 300));
        s.destroy();
        return hits[0];
      }).toBeGreaterThan(0);
      expect(hits[1]).toBe(0);

      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await expect(page.getByLabel('転送先 1 の宛先 2 のポート')).toHaveValue(String(TCP_BACKENDS[1]));
      await expect(page.locator('#rule-tls-route-balance-0')).toHaveValue('failover');
    } finally {
      await deleteRule(page, SNI_PORT);
      backends.forEach((s) => s.close());
      fallback.close();
    }
  });

  // 狭い幅（375px）でもはみ出さず、ライト・ダークのどちらでも白地に白文字がない
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`the new fields fit a phone and stay readable (${colorScheme})`, async ({ page }) => {
      const f = await features(page);
      test.skip(!has(f, 'http_options', ['server_status', 'server_middlewares', 'route_timeouts']) || !has(f, 'services', ['protocol', 'tls']) || f.tls_route_targets !== true,
        'rproxy-api does not run the Gateway API fields yet');
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-l7').check();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      const addMiddleware = page.getByLabel('ミドルウェアを追加');
      for (const kind of ['replace_host', 'cors', 'mirror', 'retry']) await addMiddleware.selectOption(kind);
      await page.getByRole('button', { name: '転送先を追加' }).first().click();
      await page.getByLabel('サービス backend の転送先 2 の種類').selectOption('status');
      await page.getByTestId('service-tls').getByRole('checkbox').first().check();
      await page.getByLabel('サービス backend の転送先 1 にミドルウェアを足す').selectOption('replace-host');
      await expect(page.getByTestId('server-middlewares').first()).toContainText('replace-host');
      await expectFits(page);

      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('terminate');
      await page.getByRole('button', { name: '＋ 転送先を追加' }).click();
      await page.getByRole('button', { name: '転送先 1 を複数の宛先にする' }).click();
      await expect(page.getByTestId('tls-route-targets-editor')).toBeVisible();
      await expectFits(page);
    });
  }
});

async function expectFits(page: Page): Promise<void> {
  const { scrollWidth, innerWidth, unreadable } = await page.evaluate(() => {
    const bgOf = (el: Element | null): string => {
      for (let e = el; e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const bad = [...document.querySelectorAll('body *')]
      .filter((e) => {
        const st = getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const hasText = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        return hasText && st.color === bgOf(e);
      })
      .map((e) => `${e.tagName.toLowerCase()}: ${e.textContent?.trim().slice(0, 40)}`);
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, unreadable: bad };
  });
  expect(scrollWidth, `document is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
  expect(unreadable).toEqual([]);
}
