// rproxy-api v0.4.20 の tcp のルールの idle_timeout・half_close_timeout（#353、features.tcp_idle_timeout、UI #181）をフォームから使い、
// rproxy-api に反映されて効くこと（何も運ばない接続を閉じる・0s で閉じない）、変更の画面でそのまま保存しても消えないこと、
// 空にすると既定に戻ることを確かめる。rproxy の features が対応していなければ飛ばす
import net from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const RULE_PORT = 19601;
const BACKEND = 19602;

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

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// つないで 1 回やり取りし、黙ったまま rproxy が閉じるまでの時間（ms）を返す。limit ms まで閉じなければ null
function idleClose(limit: number): Promise<number | null> {
  return new Promise((resolve) => {
    let start = 0;
    const s = net.connect(RULE_PORT, '127.0.0.1', () => s.write('ping'));
    const finish = (v: number | null) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => finish(null), limit);
    s.once('data', () => { start = Date.now(); });
    s.on('close', () => finish(start === 0 ? -1 : Date.now() - start));
    s.on('error', () => undefined);
  });
}

test.describe('TCP relay timeouts', () => {
  test('idle_timeout from the form closes a silent connection, 0s keeps it, and an edit keeps the value', async ({ page }) => {
    const f = await features(page);
    test.skip(f.tcp_idle_timeout !== true, 'rproxy-api does not take idle_timeout yet');
    const backend = await listen(net.createServer((s) => {
      s.on('data', (d) => s.write(d));
      s.on('error', () => undefined);
    }), BACKEND);
    await deleteRule(page);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(RULE_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKEND));
      await page.getByRole('tab', { name: '詳細' }).click();
      // 1s 未満は rproxy と同じく断る
      await page.locator('#rule-idle-timeout').fill('500ms');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByTestId('relay-timeouts')).toContainText('1s 以上');
      await page.locator('#rule-idle-timeout').fill('2s');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      await expect(page.getByTestId('idle-timeout')).toHaveText('2s');
      await expect(page.getByTestId('half-close-timeout')).toHaveText('既定（1m）');

      // 黙った接続を 2 秒ほどで閉じる（判定は 1/8 ごとなので少し遅れる）
      const closed = await idleClose(10_000);
      expect(closed).not.toBeNull();
      expect(closed!).toBeGreaterThanOrEqual(1500);

      // 変更の画面で何も変えずに保存しても残る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await expect(page.locator('#rule-idle-timeout')).toHaveValue('2s');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      expect((await storedRule(page)).idleTimeout).toBe('2s');

      // 0s（上限なし）にすると閉じない。DB にも 0s で残る（rproxy が UI の DB から戻すときも上限なし）
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await page.locator('#rule-idle-timeout').fill('0s');
      await page.locator('#rule-half-close-timeout').fill('0s');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      await expect(page.getByTestId('idle-timeout')).toHaveText('上限なし（0s）');
      expect(await storedRule(page)).toMatchObject({ idleTimeout: '0s', halfCloseTimeout: '0s' });
      expect(await idleClose(4_000)).toBeNull();

      // 空にすると既定に戻る（rproxy へは 1h・1m を送る）
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await page.locator('#rule-idle-timeout').fill('');
      await page.locator('#rule-half-close-timeout').fill('');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      await expect(page.getByTestId('idle-timeout')).toHaveText('既定（1h）');
      const back = await storedRule(page);
      expect(back.idleTimeout).toBeUndefined();
      expect(back.halfCloseTimeout).toBeUndefined();
    } finally {
      await deleteRule(page);
      backend.close();
    }
  });
});
