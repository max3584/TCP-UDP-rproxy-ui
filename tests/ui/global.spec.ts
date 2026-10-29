// global の設定の画面（/global。rproxy-api v0.4.19 の GET / PATCH /config/global、UI #169）。
// CI の rproxy-api は同じ名前のブランチか既定のブランチからビルドし、TCP（127.0.0.1:8080）で聞き、DB（schema.sql の rproxy_global）に保存する。
// global の設定の API のない rproxy-api（features.global_api がない）なら、画面がそう言うことだけを確かめる
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SAME_ORIGIN, USER_STATE } from './global-setup';

interface NodeView {
  node: string;
  supported: boolean;
  transport: string;
  settings: { storage: string; items: Record<string, { source: string; apply: string; settable: boolean; unix_only: boolean }> } | null;
}

async function firstNode(page: Page): Promise<NodeView> {
  const res = await page.request.get('/api/forward/global');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { nodes: NodeView[] }).nodes[0];
}

// API の値を消して既定に戻す（失敗しても次の試験に残さない）
async function clear(page: Page, item: string) {
  await page.request.post('/api/forward/global', { headers: SAME_ORIGIN, data: { values: { [item]: null } } });
}

test.describe('global settings', () => {
  test.afterEach(async ({ page }) => {
    const n = await firstNode(page);
    if (n.supported && n.settings?.items.udp_max_sessions?.source === 'api') await clear(page, 'udp_max_sessions');
  });

  test('shows each item with its source and how it changes; changes a live item after a dry run', async ({ page }) => {
    const n = await firstNode(page);
    await page.goto('/global');
    await expect(page.getByRole('heading', { name: 'global の設定', level: 1 })).toBeVisible();
    if (!n.supported) {
      await expect(page.getByTestId('global-unsupported')).toBeVisible();
      return;
    }
    const card = page.getByTestId('global-node').first();
    // migration 013 の rproxy_global に保存する
    await expect(card.getByTestId('global-storage')).toContainText('データベース（rproxy_global）');
    // 起動のときに保存した値を読めている（読めなければ警告を出して適用できない）
    await expect(card.getByTestId('global-not-loaded')).toHaveCount(0);
    // 起動のときだけの項目は表示だけ
    await expect(card.getByTestId('global-item-performance')).toContainText('再起動が要る');
    // Unix ソケットだけの項目は TCP では変えられない（UI は rproxy の unix_only に従う）
    for (const [name, item] of Object.entries(n.settings!.items)) {
      if (item.unix_only && n.transport === 'tcp' && item.apply === 'live' && item.source !== 'file' && item.source !== 'env') {
        await expect(card.getByTestId(`global-item-${name}`).getByTestId('global-block')).toHaveText('Unix ソケットからだけ変えられます');
        await expect(page.getByTestId(`global-edit-${name}`)).toHaveCount(0);
      }
    }
    const row = card.getByTestId('global-item-udp_max_sessions');
    await expect(row.getByTestId('global-source')).toHaveText('既定');

    const edit = page.getByTestId('global-edit-udp_max_sessions');
    await edit.getByLabel('値を入れる').check();
    await edit.getByRole('textbox').fill('4321');
    await expect(page.getByTestId('global-apply')).toBeDisabled();
    await page.getByTestId('global-dry-run').click();
    const plan = page.getByTestId('global-plan');
    await expect(plan.getByTestId('global-change-udp_max_sessions')).toContainText('4321');
    // dry run では何も変わらない
    expect((await firstNode(page)).settings!.items.udp_max_sessions.source).toBe('default');

    await page.getByTestId('global-apply').click();
    await expect(page.getByTestId('global-result')).toContainText('適用しました');
    await expect(row.getByTestId('global-source')).toHaveText('API');
    await expect(row.getByTestId('global-value')).toHaveText('4321');

    // API の値を消すと既定に戻る
    await edit.getByLabel('API の値を消す（既定に戻す）').check();
    await page.getByTestId('global-dry-run').click();
    await expect(page.getByTestId('global-plan')).toBeVisible();
    await page.getByTestId('global-apply').click();
    await expect(row.getByTestId('global-source')).toHaveText('既定');
  });

  test('a form error and a refusal by rproxy are shown', async ({ page }) => {
    const n = await firstNode(page);
    test.skip(!n.supported, 'rproxy-api without the global settings API');
    await page.goto('/global');
    const edit = page.getByTestId('global-edit-udp_max_sessions');
    await edit.getByLabel('値を入れる').check();
    await edit.getByRole('textbox').fill('-5');
    await expect(page.getByTestId('global-edit').getByRole('alert')).toContainText('0 以上の整数');
    await expect(page.getByTestId('global-dry-run')).toBeDisabled();

    // 秘密に関わる項目（unix_only）を TCP から送ると rproxy が断り、UI は直し方を出す
    const secret = Object.entries(n.settings!.items).find(([, i]) => i.unix_only && i.apply === 'live' && i.source !== 'file' && i.source !== 'env');
    if (secret && n.transport === 'tcp') {
      const res = await page.request.post('/api/forward/global', { headers: SAME_ORIGIN, data: { values: { [secret[0]]: null }, dryRun: true } });
      expect(res.status()).toBe(200);
      const body = await res.json() as { nodes: { ok: boolean; code?: string }[] };
      expect(body.nodes[0]).toMatchObject({ ok: false, code: 'global_unix_only' });
    }
  });

});

// 利用者のセッション（上の afterEach は管理者の API を使うので別の describe にする）
test.describe('global settings as a user', () => {
  test.use({ storageState: USER_STATE });
  test('is for administrators only', async ({ page }) => {
    const res = await page.request.get('/api/forward/global');
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('forbidden_admin');
    const post = await page.request.post('/api/forward/global', { headers: SAME_ORIGIN, data: { values: { udp_max_sessions: 1 } } });
    expect(post.status()).toBe(403);
  });
});
