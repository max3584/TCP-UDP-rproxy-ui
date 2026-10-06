// ACME の証明書（rproxy-api v0.3.21）を画面から使う。CI の e2e ジョブは Pebble（ACME の試験用の CA）を同じコンテナで動かし、
// rproxy の設定ファイルの global.acme に resolver を書く（scripts/ci-pebble.sh）。UI_E2E_ACME=1 のときだけ動く。
// - フォームで resolver と名前を選んで保存すると、rproxy が Pebble から証明書を取り（http-01）、詳細画面が「有効」になり、実際にその証明書を返す
// - 名前の検証（ワイルドカードは dns-01 だけ、allowed_names の外）をフォームが保存の前に出す。rproxy の断り（400 invalid）も確かめる
// - 届かない CA の resolver では、仮の証明書（自己署名）と失敗が詳細画面とダッシュボードの要確認に出る
import net from 'node:net';
import tls from 'node:tls';
import { expect, test, type Page } from '@playwright/test';

const ISSUE_PORT = 19441;
const OFFLINE_PORT = 19442;
const BACKEND_PORT = 19451;
const NAME = 'www.acme-e2e.test';
const OFFLINE_NAME = 'offline.acme-e2e.test';

test.skip(!process.env.UI_E2E_ACME, 'needs rproxy with global.acme and Pebble (CI e2e: scripts/ci-pebble.sh)');

// 証明書を発行した CA の名前（TLS で接続して受け取ったサーバ証明書の issuer）
function issuerOf(port: number, servername: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
      const cert = s.getPeerCertificate();
      resolve(`${cert.issuer?.CN ?? ''}`);
      s.end();
    });
    s.setTimeout(3000, () => s.destroy(new Error('timeout')));
    s.on('error', reject);
  });
}

async function deleteRule(page: Page, port: number): Promise<void> {
  await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port } });
}

// 白地に白文字のような読めない文字がないこと（tests/ui/contrast.spec.ts と同じ確かめ方）
async function unreadableText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bgOf = (el: Element | null): string => {
      for (let e = el; e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return [...document.querySelectorAll('body *')]
      .filter((e) => {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const hasText = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        return hasText && s.color === bgOf(e);
      })
      .map((e) => `${e.tagName.toLowerCase()}: ${e.textContent?.trim().slice(0, 40)}`);
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `document is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
}

test.describe('ACME certificates', () => {
  let backend: net.Server;
  test.beforeAll(async () => {
    backend = net.createServer((s) => s.on('data', (d) => s.end(`B:${d}`)));
    await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', () => resolve()));
  });
  test.afterAll(() => backend.close());

  test('issues a certificate from Pebble for a rule made in the form', async ({ page }) => {
    test.setTimeout(180_000);
    await deleteRule(page, ISSUE_PORT);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(ISSUE_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKEND_PORT));
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('terminate');
      await page.getByRole('button', { name: '＋ ACME の証明書を追加' }).click();

      // resolver は rproxy の GET /acme の名前（challenge つき）。秘密やアカウントの作成の欄はない
      const resolver = page.locator('#rule-cert-0-acme');
      await expect(resolver.locator('option')).toHaveText(['（選んでください）', /^offline（http-01/, /^pebble-dns（dns-01/, /^pebble-http（http-01/]);
      await resolver.selectOption('pebble-http');
      await expect(page.getByTestId('acme-resolver-help')).toContainText('**.acme-e2e.test');

      // ワイルドカードは dns-01 だけ、allowed_names の外の名前は保存の前に断る
      const domains = page.locator('#rule-cert-0-domains');
      await domains.fill('*.acme-e2e.test');
      await expect(page.getByTestId('acme-domains-error')).toContainText('dns-01 の resolver でだけ取れます');
      await domains.fill('www.evil.example');
      await expect(page.getByTestId('acme-domains-error')).toContainText('アカウント pebble で取ってよい名前');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByText(/証明書 1（ACME）: www\.evil\.example は ACME のアカウント pebble/)).toBeVisible();
      await expect(page).toHaveURL(/\/rules\/new$/);
      await resolver.selectOption('pebble-dns');
      await domains.fill('*.acme-e2e.test');
      await expect(page.getByTestId('acme-domains-error')).toHaveCount(0);

      await resolver.selectOption('pebble-http');
      await domains.fill(NAME);
      await expect(page.getByTestId('acme-domains-error')).toHaveCount(0);
      expect(await unreadableText(page)).toEqual([]);
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${ISSUE_PORT}$`));

      // 取れるまでは仮の証明書、取れたら「有効」になり、Pebble の証明書を返す
      const cert = page.getByTestId('acme-certificate');
      await expect(cert).toContainText(`ACME（resolver: pebble-http）: ${NAME}`);
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('acme-state')).toHaveText('有効', { timeout: 1000 });
      }).toPass({ timeout: 120_000, intervals: [2000] });
      await expect(page.getByTestId('acme-stand-in')).toHaveCount(0);
      await expect(cert).toContainText('期限');
      await expect(cert).toContainText('更新の予定');
      await expect.poll(() => issuerOf(ISSUE_PORT, NAME).catch((e) => String(e)), { timeout: 30_000 }).toMatch(/pebble/i);
      expect(await unreadableText(page)).toEqual([]);

      // 編集画面では resolver と名前がそのまま入っている
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await expect(page.locator('#rule-cert-0-acme')).toHaveValue('pebble-http');
      await expect(page.locator('#rule-cert-0-domains')).toHaveValue(NAME);
    } finally {
      await deleteRule(page, ISSUE_PORT);
    }
  });

  test("rproxy's allowlist refusals come back as 400 invalid", async ({ page }) => {
    const res = await page.request.post('/api/forward/add', {
      data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: OFFLINE_PORT, distAddr: '127.0.0.1', distPort: BACKEND_PORT,
        tls: { mode: 'terminate', certificates: [{ acme: 'pebble-http', domains: ['www.evil.example'] }] } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid');
    expect(body.error).toContain('allowed_names');
  });

  for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 375, height: 812 }]) {
    test(`shows the stand-in and the failure for a CA that cannot be reached (${vp.name})`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await deleteRule(page, OFFLINE_PORT);
      const res = await page.request.post('/api/forward/add', {
        data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: OFFLINE_PORT, distAddr: '127.0.0.1', distPort: BACKEND_PORT,
          tls: { mode: 'terminate', certificates: [{ acme: 'offline', domains: [OFFLINE_NAME] }] } },
      });
      expect(res.ok(), await res.text()).toBe(true);
      try {
        await page.goto(`/rules/tcp/127.0.0.1/${OFFLINE_PORT}`);
        await expect(async () => {
          await page.reload();
          await expect(page.getByTestId('acme-state')).toHaveText('失敗', { timeout: 1000 });
        }).toPass({ timeout: 60_000, intervals: [1000] });
        await expect(page.getByTestId('acme-stand-in')).toBeVisible();
        await expect(page.getByText('rproxy ACME placeholder')).toBeVisible();
        await expect(page.getByTestId('acme-error')).not.toBeEmpty();
        // rproxy は仮の証明書を返している
        expect(await issuerOf(OFFLINE_PORT, OFFLINE_NAME)).toMatch(/placeholder/i);
        await expectNoPageOverflow(page);
        expect(await unreadableText(page)).toEqual([]);
        await page.emulateMedia({ colorScheme: 'dark' });
        expect(await unreadableText(page)).toEqual([]);
        await page.emulateMedia({ colorScheme: 'light' });

        // ダッシュボードの要確認に、ACME の失敗として出る
        await page.goto('/');
        const attention = page.locator('section[aria-labelledby="card-attention"]');
        const item = attention.locator('li', { has: page.locator(`a[href="/rules/tcp/127.0.0.1/${OFFLINE_PORT}"]`) });
        await expect(item).toContainText('ACME 失敗');
        await expect(item).toContainText(`ACME の証明書（${OFFLINE_NAME}）`);
        await expect(item).toContainText('自己署名の仮の証明書を返しています');
        await page.waitForLoadState('networkidle');
        await expectNoPageOverflow(page);
        expect(await unreadableText(page)).toEqual([]);
      } finally {
        await deleteRule(page, OFFLINE_PORT);
      }
    });
  }
});
