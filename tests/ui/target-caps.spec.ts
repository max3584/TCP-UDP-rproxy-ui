// 宛先ごとの上限（rproxy-api #341 の targets[].max_connections、features.target_max_connections。UI #171）を
// フォームで付け、rproxy-api で効くこと（いっぱいの宛先を飛ばし、すべていっぱいなら断る）、詳細画面の「接続数 / 上限」と
// 上限の印、ダッシュボードの要確認、変更の画面でそのまま保存しても消えないことを確かめる。
// rproxy の features が対応していなければ飛ばす
import net from 'node:net';
import tls from 'node:tls';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const PORT = 19591;
const BACKENDS = [19592, 19593];
const SNI_PORT = 19594;
const SNI_BACKENDS = [19595, 19596];
const SNI_FALLBACK = 19597;

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

async function deleteRule(page: Page, port = PORT): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port } });
}

// 受けたデータに名前を付けて返し、接続は開いたままにする転送先
function holdServer(port: number, name: string): Promise<net.Server> {
  const server = net.createServer((s) => {
    s.on('data', (d) => s.write(`${name}:${d}`));
    s.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 1 回送って返事（なければ 'closed'）と、開いたままの接続を返す
function open(msg: string): Promise<{ reply: string; socket: net.Socket }> {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1', () => socket.write(msg));
    const t = setTimeout(() => resolve({ reply: 'timeout', socket }), 3000);
    socket.once('data', (d) => { clearTimeout(t); resolve({ reply: d.toString(), socket }); });
    socket.on('close', () => { clearTimeout(t); resolve({ reply: 'closed', socket }); });
    socket.on('error', () => undefined);
  });
}

test.describe('per-target max_connections', () => {
  test('caps from the form fill targets in order, show on the detail page and survive an edit', async ({ page }) => {
    const f = await features(page);
    test.skip(f.target_max_connections !== true, 'rproxy-api does not have per-target caps yet');
    const servers = await Promise.all(BACKENDS.map((p, i) => holdServer(p, i === 0 ? 'A' : 'B')));
    const sockets: net.Socket[] = [];
    await deleteRule(page);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(BACKENDS[0]));
      await page.getByRole('button', { name: '宛先を追加' }).click();
      await page.locator('#rule-target-addr-1').fill('127.0.0.1');
      await page.locator('#rule-target-port-1').fill(String(BACKENDS[1]));
      await page.locator('#rule-balance').selectOption('failover');
      // 欄は rproxy の features を取得してから出る
      await page.locator('#rule-target-max-0').fill('1');
      await page.locator('#rule-target-max-1').fill('1');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();

      // 1 本目は上の宛先、2 本目はいっぱいの上を飛ばして次へ、3 本目はすべていっぱいなので断る
      const first = await open('one');
      sockets.push(first.socket);
      expect(first.reply).toBe('A:one');
      const second = await open('two');
      sockets.push(second.socket);
      expect(second.reply).toBe('B:two');
      const third = await open('three');
      sockets.push(third.socket);
      expect(third.reply).toBe('closed');

      const cells = page.getByTestId('targets-table').getByTestId('target-connections');
      await expect(async () => {
        await page.reload();
        await expect(cells.nth(0)).toContainText('1 / 1', { timeout: 1000 });
      }).toPass({ timeout: 15000 });
      await expect(cells.nth(1)).toContainText('1 / 1');
      await expect(page.getByTestId('targets-table').getByTestId('target-full')).toHaveCount(2);

      // すべていっぱいのルールはダッシュボードの要確認に出る
      await page.goto('/');
      const attention = page.locator('section[aria-labelledby="card-attention"]');
      await expect(attention.getByText('すべての宛先が同時接続の上限に達していて、新しい接続を断っています。')).toBeVisible({ timeout: 15000 });

      // 変更の画面でそのまま保存しても上限は残る
      await page.goto(`/rules/tcp/127.0.0.1/${PORT}/edit`);
      await expect(page.locator('#rule-target-max-0')).toHaveValue('1');
      await page.locator('#rule-target-max-1').fill('2');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PORT}$`));
      const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${PORT}`);
      const rule = await res.json() as { targets: { max_connections?: number }[] };
      expect(rule.targets.map((t) => t.max_connections)).toEqual([1, 2]);
      // 開いている接続の数は引き継ぐので、空いた 1 本だけ 2 番目へ入る
      const fourth = await open('four');
      sockets.push(fourth.socket);
      expect(fourth.reply).toBe('B:four');
    } finally {
      sockets.forEach((s) => s.destroy());
      await deleteRule(page);
      servers.forEach((s) => s.close());
    }
  });

  test('caps on the targets of a server name show their connections and full state on the detail page', async ({ page }) => {
    const f = await features(page);
    test.skip(f.target_max_connections !== true || f.tls_route_targets !== true, 'rproxy-api does not have per-target caps yet');
    // ClientHello を受けても何も返さず、接続を開いたままにする転送先（受けた数を数える）
    const got = [0, 0];
    const servers = await Promise.all(SNI_BACKENDS.map((p, i) => new Promise<net.Server>((resolve) => {
      const server = net.createServer((s) => { got[i] += 1; s.on('error', () => undefined); });
      server.listen(p, '127.0.0.1', () => resolve(server));
    })));
    const fallback = await new Promise<net.Server>((resolve) => {
      const server = net.createServer((s) => s.destroy());
      server.listen(SNI_FALLBACK, '127.0.0.1', () => resolve(server));
    });
    const sockets: tls.TLSSocket[] = [];
    await deleteRule(page, SNI_PORT);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(SNI_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(SNI_FALLBACK));
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('sni');
      await page.getByRole('button', { name: '＋ 転送先を追加' }).click();
      await page.getByLabel('サーバ名 1', { exact: true }).fill('cap.e2e.test');
      await page.getByLabel('転送先アドレス 1', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('転送先ポート 1', { exact: true }).fill(String(SNI_BACKENDS[0]));
      await page.getByRole('button', { name: '転送先 1 を複数の宛先にする' }).click();
      await page.getByLabel('転送先 1 の宛先 2 のアドレス', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('転送先 1 の宛先 2 のポート', { exact: true }).fill(String(SNI_BACKENDS[1]));
      await page.getByLabel('転送先 1 の宛先 1 の同時接続の上限', { exact: true }).fill('1');
      await page.getByLabel('転送先 1 の宛先 2 の同時接続の上限', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${SNI_PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();

      // 2 本で両方の宛先がいっぱいになる
      for (let n = 0; n < 2; n += 1) {
        const s = tls.connect({ host: '127.0.0.1', port: SNI_PORT, servername: 'cap.e2e.test', rejectUnauthorized: false });
        s.on('error', () => undefined);
        sockets.push(s);
        await expect.poll(() => got[0] + got[1]).toBe(n + 1);
      }
      expect(got).toEqual([1, 1]);

      const route = page.getByTestId('tls-route-targets');
      await expect(async () => {
        await page.reload();
        await expect(route.getByTestId('tls-route-target-connections').nth(0)).toContainText('1 / 1', { timeout: 1000 });
      }).toPass({ timeout: 15000 });
      await expect(route.getByTestId('tls-route-target-connections').nth(1)).toContainText('1 / 1');
      await expect(route.getByTestId('target-full')).toHaveCount(2);
    } finally {
      sockets.forEach((s) => s.destroy());
      await deleteRule(page, SNI_PORT);
      servers.forEach((s) => s.close());
      fallback.close();
    }
  });
});
