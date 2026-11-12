// 固定ルール（設定ファイルのルール）に API で重ねる分（rproxy-api v0.4.23 の #397、UI #193）。
// CI の e2e ジョブが rproxy の設定ファイル（RPROXY_CONFIG）に固定ルールを 2 つ書いたときだけ動く（UI_E2E_OVERLAY=1。.github/workflows/ci.yml）：
// - 127.0.0.1:19730 の http のルール（ルート file-site・file-private、サービス file-web、ミドルウェア file-auth（basic_auth。秘密のファイル）・file-headers）
// - 127.0.0.1:19732 の sni のルール（*.files.overlay-e2e.test）
// 画面から重ねる分を足して実際に転送されること、ファイルの名前との重なり（409）・ETag（412）・利用者の秘密のファイル（409 file_in_use）、
// 履歴、外すことを確かめる。rproxy が features.static_overlay を返さなければ飛ばす
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN, USER_STATE } from './global-setup';

const HTTP_PORT = 19730;
const BACKEND = 19731;
const SNI_PORT = 19732;
const API = (process.env.RPROXY_API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const apiHeaders = { 'Content-Type': 'application/json', ...(process.env.RPROXY_API_TOKEN ? { Authorization: `Bearer ${process.env.RPROXY_API_TOKEN}` } : {}) };
const overlayUrl = (port: number) => `${API}/rules/tcp/127.0.0.1/${port}/overlay`;
const detail = (port: number) => `/rules/tcp/127.0.0.1/${port}`;

async function canOverlay(page: Page): Promise<boolean> {
  if (process.env.UI_E2E_OVERLAY !== '1' || API.startsWith('unix:')) return false;
  const res = await page.request.get(`/api/forward/overlay?protocol=tcp&addr=127.0.0.1&port=${HTTP_PORT}`);
  if (!res.ok()) return false;
  return (await res.json() as { available?: boolean }).available === true;
}

// rproxy の API で直接外す（前の試験の残り）
async function clearOverlay(port: number): Promise<void> {
  await fetch(overlayUrl(port), { method: 'DELETE', headers: apiHeaders }).catch(() => undefined);
}

// UI からも外す（UI の DB の正しい形も消す。#197。残すと次の試験でずれ・作った人として残る）。なければ 404 で何もしない
async function clearUiOverlay(page: Page, port: number): Promise<void> {
  const info = await page.request.get(`/api/forward/overlay?protocol=tcp&addr=127.0.0.1&port=${port}`);
  const etag = info.ok() ? ((await info.json()) as { etag?: string | null }).etag ?? null : null;
  await page.request.post('/api/forward/overlay-delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', addr: '127.0.0.1', port, etag } });
  await clearOverlay(port);
}

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// rproxy の L7 の待ち受けに Host を付けて聞く
function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/', headers: { Host: host }, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test.describe('overlays on static rules (#193)', () => {
  let backend: http.Server | null = null;

  test.beforeAll(async () => {
    // ファイルのサービス file-web の転送先。届いた X-From-File を返す
    backend = await listen(http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ host: req.headers.host, fromFile: req.headers['x-from-file'] ?? null }));
    }), BACKEND);
  });
  test.afterAll(async () => {
    await new Promise((resolve) => backend?.close(resolve));
    await clearOverlay(HTTP_PORT);
    await clearOverlay(SNI_PORT);
  });
  test.beforeEach(async ({ page }) => {
    test.skip(!(await canOverlay(page)), 'needs rproxy-api v0.4.23 (features.static_overlay) and the static rules of the CI e2e job');
    await clearUiOverlay(page, HTTP_PORT);
    await clearUiOverlay(page, SNI_PORT);
  });
  test.afterEach(async ({ page }) => {
    if (!(await canOverlay(page))) return;
    await clearUiOverlay(page, HTTP_PORT);
    await clearUiOverlay(page, SNI_PORT);
  });

  test('shows an overlay rproxy lost (a restart) as drift and resends it, one by one and in bulk (#197)', async ({ page }) => {
    const created = await page.request.post('/api/forward/overlay-put', {
      headers: SAME_ORIGIN,
      data: { protocol: 'tcp', addr: '127.0.0.1', port: HTTP_PORT, overlay: { http: { routes: [{ name: 'lost', match: 'Host(`lost.overlay-e2e.test`)', service: 'file-web' }] } }, etag: null },
    });
    expect(created.status(), await created.text()).toBe(200);
    expect((await get('lost.overlay-e2e.test')).status).toBe(200);
    // rproxy の再起動で消えたのと同じ（UI のトークンは persist なし）：rproxy の API で直接外す
    await clearOverlay(HTTP_PORT);
    expect((await get('lost.overlay-e2e.test')).status).toBe(404);

    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await expect(section.getByTestId('overlay-drift')).toContainText('rproxy にありません');
    await section.getByTestId('overlay-resend').click();
    await expect(section.getByTestId('overlay-notice')).toContainText('送り直しました');
    await expect(section.getByTestId('overlay-drift')).toHaveCount(0);
    await expect(section.getByTestId('overlay-state')).toHaveText('効いています');
    expect((await get('lost.overlay-e2e.test')).status).toBe(200);
    // 履歴には送り直しとして残る
    const history = page.locator('#section-history').locator('..');
    await expect(history.getByTestId('history-overlay-changes').first()).toContainText('送り直しました');

    // ダッシュボードの「要確認のルール」からまとめて
    await clearOverlay(HTTP_PORT);
    await page.goto('/');
    const bulk = page.getByTestId('overlay-resend-all');
    await expect(bulk).toBeVisible({ timeout: 15_000 });
    await bulk.getByRole('button', { name: /まとめて送り直す/ }).click();
    await expect(bulk.getByRole('status')).toContainText('1 件');
    expect((await get('lost.overlay-e2e.test')).status).toBe(200);
  });

  test('adds http routes that use the file service and middleware, keeps the file routes first, and removes them', async ({ page }) => {
    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await expect(section.getByTestId('overlay-none')).toBeVisible();
    // 重ねる分がなければ、ファイルのルートに当たらない名前は default（404）
    expect((await get('overlay.overlay-e2e.test')).status).toBe(404);

    await section.getByTestId('overlay-edit').click();
    const editor = section.getByTestId('overlay-editor');
    await expect(editor.getByTestId('overlay-http-note')).toBeVisible();
    // 「どのルートにも一致しないとき」と HTTP/3 はファイルのもの
    await expect(editor.locator('#http-default-service')).toHaveCount(0);
    await editor.getByRole('button', { name: 'ルートを追加' }).click();
    await editor.locator('#http-route-0-name').fill('overlay-site');
    await editor.locator('#http-route-0-match').fill('Host(`overlay.overlay-e2e.test`)');
    // ファイルのサービス・ミドルウェアは印つきで選べる
    await editor.locator('#http-route-0-target').selectOption('service:file-web');
    await expect(editor.locator('#http-route-0-target')).toContainText('file-web（設定ファイル）');
    await editor.getByLabel('ルート overlay-site にミドルウェアを足す').selectOption('file-headers');
    await expect(editor.getByTestId('file-item-mark')).toHaveText('設定ファイル');

    // ファイルと同じ名前は保存の前に知らせる
    await editor.locator('#http-route-0-name').fill('file-site');
    await editor.getByTestId('overlay-save').click();
    await expect(editor.getByTestId('overlay-problems')).toContainText('file-site');
    await editor.locator('#http-route-0-name').fill('overlay-site');
    await editor.getByTestId('overlay-save').click();

    await expect(section.getByTestId('overlay-state')).toHaveText('効いています');
    await expect(section.getByTestId('overlay-notice')).toBeVisible();
    await expect(page.getByTestId('overlay-badge')).toBeVisible({ timeout: 10_000 });
    // 重ねたルートがファイルのサービスにファイルのミドルウェアを通って届く
    const res = await get('overlay.overlay-e2e.test');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ host: 'overlay.overlay-e2e.test', fromFile: '1' });
    // ファイルのルートはそのまま
    expect((await get('file.overlay-e2e.test')).status).toBe(200);

    // 履歴に残る（固定ルールの履歴は重ねる分だけ）
    const history = page.locator('#section-history').locator('..');
    await expect(history.getByTestId('history-row').first()).toContainText('固定ルールに重ねる分');
    await expect(history.getByTestId('history-overlay-changes').first()).toContainText('overlay-site');

    // 外す
    await section.getByTestId('overlay-remove').click();
    await page.getByRole('button', { name: '外す', exact: true }).click();
    await expect(section.getByTestId('overlay-none')).toBeVisible();
    expect((await get('overlay.overlay-e2e.test')).status).toBe(404);
  });

  test('refuses names of the file (409) and a stale ETag (412), and reloads', async ({ page }) => {
    const put = (data: Record<string, unknown>) => page.request.post('/api/forward/overlay-put', {
      headers: SAME_ORIGIN, data: { protocol: 'tcp', addr: '127.0.0.1', port: HTTP_PORT, ...data },
    });
    const conflict = await put({ overlay: { http: { routes: [{ name: 'file-site', match: 'Host(`x.overlay-e2e.test`)', service: 'file-web' }] } }, etag: null });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).code).toBe('overlay_conflict');

    const route = (name: string) => ({ http: { routes: [{ name, match: `Host(\`${name}.overlay-e2e.test\`)`, service: 'file-web' }] } });
    const created = await put({ overlay: route('one'), etag: null });
    expect(created.status(), await created.text()).toBe(200);
    const etag = (await created.json()).etag as string;

    // 画面で直し始めた後に、ほかの人（rproxy の API）が変える
    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await section.getByTestId('overlay-edit').click();
    const other = await fetch(overlayUrl(HTTP_PORT), { method: 'PUT', headers: { ...apiHeaders, 'If-Match': etag }, body: JSON.stringify(route('two')) });
    expect(other.status, await other.text()).toBe(200);
    await section.getByTestId('overlay-editor').locator('#http-route-0-name').fill('three');
    await section.getByTestId('overlay-save').click();
    await expect(section.getByTestId('overlay-error')).toContainText('ほかの人が');
    await section.getByRole('button', { name: '読み直す' }).click();
    await expect(section.getByTestId('overlay-http-summary')).toContainText('two');

    const stale = await put({ overlay: route('four'), etag });
    expect(stale.status()).toBe(412);
  });

  test('adds server names to an sni rule, but not names the file pattern takes', async ({ page }) => {
    await page.goto(detail(SNI_PORT));
    const section = page.getByTestId('overlay-section');
    await section.getByTestId('overlay-edit').click();
    const editor = section.getByTestId('overlay-tls-editor');
    await editor.getByRole('button', { name: '＋ 転送先を追加' }).click();
    await editor.getByLabel('重ねる転送先 1 のサーバ名').fill('a.files.overlay-e2e.test');
    await editor.getByLabel('重ねる転送先 1 のアドレス').fill('127.0.0.1');
    await editor.getByLabel('重ねる転送先 1 のポート').fill(String(BACKEND));
    await section.getByTestId('overlay-save').click();
    await expect(section.getByTestId('overlay-problems')).toContainText('*.files.overlay-e2e.test');
    await editor.getByLabel('重ねる転送先 1 のサーバ名').fill('git.overlay-e2e.test');
    await section.getByTestId('overlay-save').click();
    await expect(section.getByTestId('overlay-state')).toHaveText('効いています');
    await expect(section.getByTestId('overlay-tls-routes')).toContainText('git.overlay-e2e.test');
  });

  test('users cannot use file services (403) or file items that hold secrets (409 file_in_use)', async ({ page, context }) => {
    await context.clearCookies();
    await context.addCookies(JSON.parse(fs.readFileSync(USER_STATE, 'utf8')).cookies);
    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await section.getByTestId('overlay-edit').click();
    await expect(section.getByTestId('overlay-secret-note')).toContainText('設定ファイルのサービスは管理者だけが');
    await section.getByRole('button', { name: 'サービスを追加' }).click();
    await section.getByRole('button', { name: 'ルートを追加' }).click();
    // 設定ファイルのサービスと、秘密のファイルを持つファイルのミドルウェアは選べない
    await expect(section.locator('#http-route-0-target option', { hasText: 'file-web' })).toBeDisabled();
    await expect(section.locator('#http-route-0-target')).toHaveValue('service:backend');
    // サービスの転送先ごとのミドルウェアの欄もあるので、ルートの欄を名前で選ぶ
    const routeMiddlewares = section.getByLabel('ルート route にミドルウェアを足す');
    const option = routeMiddlewares.locator('option', { hasText: 'file-auth' });
    await expect(option).toBeDisabled();
    await expect(option).toContainText('秘密のファイルあり');
    await expect(routeMiddlewares.locator('option', { hasText: 'file-headers' })).toBeEnabled();

    const put = (http: Record<string, unknown>) => page.request.post('/api/forward/overlay-put', {
      headers: SAME_ORIGIN, data: { protocol: 'tcp', addr: '127.0.0.1', port: HTTP_PORT, etag: null, overlay: { http } },
    });
    const fileService = await put({ routes: [{ name: 'u', match: 'Host(`u.overlay-e2e.test`)', service: 'file-web' }] });
    expect(fileService.status()).toBe(403);
    expect((await fileService.json()).code).toBe('file_service_not_allowed');
    const secret = await put({
      routes: [{ name: 'u', match: 'Host(`u.overlay-e2e.test`)', service: 'mine', middlewares: ['file-auth'] }],
      services: { mine: { servers: [{ url: `http://127.0.0.1:${BACKEND}` }] } },
    });
    expect(secret.status()).toBe(409);
    expect((await secret.json()).code).toBe('file_in_use');
  });

  test('an overlay an administrator created is read-only for users', async ({ page, context }) => {
    const created = await page.request.post('/api/forward/overlay-put', {
      headers: SAME_ORIGIN,
      data: { protocol: 'tcp', addr: '127.0.0.1', port: HTTP_PORT, etag: null, overlay: { http: { routes: [{ name: 'adm', match: 'Host(`adm.overlay-e2e.test`)', service: 'file-web' }] } } },
    });
    expect(created.status(), await created.text()).toBe(200);
    await context.clearCookies();
    await context.addCookies(JSON.parse(fs.readFileSync(USER_STATE, 'utf8')).cookies);
    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await expect(section.getByTestId('overlay-readonly')).toContainText('管理者かほかの利用者が作った');
    await expect(section.getByTestId('overlay-edit')).toHaveCount(0);
    await expect(section.getByTestId('overlay-remove')).toHaveCount(0);
  });

  test('shows the not_applied and shadowed states', async ({ page }) => {
    // rproxy の答えの形（読み直しで設定ファイルが変わったとき）を画面に出せること。答えはブラウザの中で差し替える
    await page.route('**/api/forward/overlay?*', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: {
          ...body,
          etag: '"o-x"',
          overlay: {
            rule: `tcp/127.0.0.1/${HTTP_PORT}`, http: { routes: [{ name: 'gone', match: 'Path(`/`)', service: 'file-web' }] },
            state: 'not_applied', reason: 'invalid', error: 'service file-old is not defined',
            shadowed: [{ kind: 'middleware', name: 'file-headers', reason: 'the settings file defines it' }],
            etag: '"o-x"', created_by: 'ui', created_at: 1790000000, updated_by: 'ui', updated_at: 1790000000, persisted: false,
          },
        },
      });
    });
    await page.goto(detail(HTTP_PORT));
    const section = page.getByTestId('overlay-section');
    await expect(section.getByTestId('overlay-state')).toHaveText('効いていません');
    await expect(section.getByTestId('overlay-not-applied')).toContainText('検証が通りません');
    await expect(section.getByTestId('overlay-not-applied')).toContainText('service file-old is not defined');
    await expect(section.getByTestId('overlay-shadowed')).toContainText('file-headers');
    await expect(section.getByTestId('overlay-not-persisted')).toBeVisible();
  });
});
