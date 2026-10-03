// README のスクリーンショット（docs/images/<名前>.<ja|en>.png）を撮る。設定は scripts/screenshots/playwright.config.ts
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import type { Locale } from '@/i18n/core';
import { NEXTAUTH_SECRET, baseURL } from './playwright.config';
import { CAPABILITIES, CONFIG_STATUS, DETAIL_RULE, INTERFACES, historyFor, NOW, RULES } from './sample-data';

const OUT_DIR = path.join(__dirname, '..', '..', 'docs', 'images');
const DESKTOP = { width: 1280, height: 860 };
const PHONE = { width: 375, height: 760 };

async function signIn(context: BrowserContext, lang: string): Promise<void> {
  const token = await encode({
    token: { sub: 'demo-user', name: 'demo', email: 'demo@example.com', roles: ['rproxy-user'] },
    secret: NEXTAUTH_SECRET,
    maxAge: 60 * 60,
  });
  const { hostname } = new URL(baseURL);
  await context.addCookies([
    { name: 'next-auth.session-token', value: token, domain: hostname, path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'rproxy_ui_lang', value: lang, domain: hostname, path: '/', sameSite: 'Lax' },
  ]);
}

// 画面が呼ぶ API（/api/forward/*）をサンプルのデータで返す。サーバには届かない
async function mockApi(context: BrowserContext, lang: Locale): Promise<void> {
  const history = historyFor(lang);
  await context.route('**/api/forward/**', async (route) => {
    const url = new URL(route.request().url());
    const action = url.pathname.replace('/api/forward/', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (action) {
      case 'dashboard':
        return json({ reachable: true, rproxyError: null, rules: RULES });
      case 'list':
        return json(RULES.filter((r) => r.origin === 'dynamic'));
      case 'rule': {
        const q = url.searchParams;
        const rule = RULES.find((r) => r.protocol === q.get('protocol') && r.srcAddr === q.get('addr') && String(r.srcPort) === q.get('port'));
        return rule ? json(rule) : json({ error: 'Not Found', code: 'not_found' }, 404);
      }
      case 'history': {
        const q = url.searchParams;
        const entries = history.filter((e) => (!q.get('protocol') || e.protocol === q.get('protocol'))
          && (!q.get('addr') || e.srcAddr === q.get('addr'))
          && (!q.get('port') || String(e.srcPort) === q.get('port')));
        const perPage = Number(q.get('per_page') ?? 20);
        return json({ entries: entries.slice(0, perPage), total: entries.length, page: 1, perPage: perPage });
      }
      case 'capabilities':
        return json(CAPABILITIES);
      case 'interfaces':
        return json(INTERFACES);
      case 'config':
        return json(CONFIG_STATUS);
      default:
        return json({ error: 'Not available in screenshots', code: 'unsupported' }, 400);
    }
  });
}

// sharp（next が入れる）があれば PNG を 256 色に減らして小さくする。なければそのまま保存する
async function save(buffer: Buffer, name: string): Promise<void> {
  let out = buffer;
  try {
    const mod = 'sharp';
    const sharp = (await import(mod)).default;
    out = await sharp(buffer).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer();
  } catch {
    // sharp がない環境では最適化しない
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), out);
}

async function shoot(page: Page, name: string, lang: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  // フォーカスの枠やカーソルを写さない
  await page.mouse.move(0, 0);
  await save(await page.screenshot({ fullPage: fullPage, animations: 'disabled' }), `${name}.${lang}.png`);
}

// 言語はプロジェクト（playwright.config.ts の ja / en）の名前
test.beforeEach(async ({ context, page }, testInfo) => {
  await signIn(context, testInfo.project.name);
  await mockApi(context, testInfo.project.name as Locale);
  await page.clock.setFixedTime(NOW);
});

test('desktop', async ({ page }, testInfo) => {
  const lang = testInfo.project.name;
  await page.setViewportSize(DESKTOP);

  // ダッシュボードはルールの表まで（ページ全体）
  await page.goto('/');
  await expect(page.locator('table').first()).toBeVisible();
  await shoot(page, 'dashboard', lang, true);

  const d = DETAIL_RULE;
  await page.goto(`/rules/${d.protocol}/${encodeURIComponent(d.srcAddr)}/${d.srcPort}`);
  await expect(page.getByTestId('http-summary')).toBeVisible();
  await shoot(page, 'rule-detail', lang);

  // 新規ルール：プロファイル「HTTPS リバースプロキシ（L7）」を選んで L7 (HTTP) のタブを開く
  await page.goto('/rules/new');
  await expect(page.locator('#rule-protocol')).toBeVisible();
  await page.locator('#rule-profile').selectOption('https-l7');
  await page.locator('#rule-src-addr').selectOption('0.0.0.0');
  await page.getByRole('tab', { name: /L7/ }).click();
  const url = page.getByLabel(/転送先 1 の URL|URL of server 1 /).first();
  await url.fill('http://192.0.2.21:8080');
  await url.blur();
  await shoot(page, 'rule-new', lang);

  await page.goto('/history');
  await expect(page.getByTestId('history-row').first()).toBeVisible();
  await shoot(page, 'history', lang);
});

test('phone', async ({ page }, testInfo) => {
  const lang = testInfo.project.name;
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.locator('table').first()).toBeAttached();
  await shoot(page, 'mobile-dashboard', lang);

  await page.getByRole('button', { name: /メニュー|Menu/ }).click();
  await page.waitForTimeout(300);
  await shoot(page, 'mobile-menu', lang);
});
