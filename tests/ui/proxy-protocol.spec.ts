// rproxy-api v0.4.13 の 2 つの項目をフォームから使い、rproxy-api に反映されて効くこと、
// 変更の画面でそのまま保存しても消えないこと（以前は route の source_ip が保存で消えた）を確かめる。
// - ルールの proxy_protocol（#296、features.proxy_protocol_in）：前段の PROXY ヘッダのクライアントで allow_from を判定する
// - tls.routes[].source_ip（#297、features.route_source_ip）：その名前の転送先へだけ PROXY ヘッダを付ける
// rproxy の features が対応していなければ飛ばす
import net from 'node:net';
import tls from 'node:tls';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const PP_PORT = 19561;
const PP_BACKEND = 19562;
const SNI_PORT = 19563;
const SNI_BACKEND = 19564;
const SNI_FALLBACK = 19565;

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

async function deleteRule(page: Page, port: number): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port } });
}

async function storedRule(page: Page, port: number): Promise<Record<string, any>> {
  const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${port}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 送ってから、返ってきたもの（閉じられるか ms まで）を返す
function exchange(port: number, data: string, ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    let got = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(data));
    const done = () => { clearTimeout(t); s.destroy(); resolve(got); };
    const t = setTimeout(done, ms);
    s.on('data', (d) => {
      got += d.toString();
      if (got.includes('hello')) done();
    });
    s.on('close', done);
    s.on('error', done);
  });
}

test.describe('PROXY protocol in and per-route source_ip', () => {
  test('proxy_protocol from the form uses the header client for allow_from and survives an edit', async ({ page }) => {
    const f = await features(page);
    test.skip(f.proxy_protocol_in !== true, 'rproxy-api does not read PROXY headers yet');
    const backend = await listen(net.createServer((s) => s.on('data', (d) => s.write(d))), PP_BACKEND);
    await deleteRule(page, PP_PORT);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(PP_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(PP_BACKEND));
      await page.getByRole('tab', { name: '詳細' }).click();
      // 許可するのはヘッダに書かれたクライアント（文書用のアドレス）だけ。接続元（127.0.0.1）は前段
      await page.locator('#rule-allow-from').fill('192.0.2.10');
      await page.locator('#rule-proxy-protocol').check();
      // /0 は rproxy と同じく断る
      await page.locator('#rule-proxy-protocol-from').fill('0.0.0.0/0');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByTestId('proxy-protocol')).toContainText('だれのヘッダでも');
      await page.locator('#rule-proxy-protocol-from').fill('127.0.0.1');
      await expect(page.locator('#rule-proxy-protocol-required')).toBeChecked();
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PP_PORT}$`));
      await expect(page.getByTestId('proxy-protocol')).toContainText('127.0.0.1/32');
      await expect(page.getByTestId('proxy-protocol')).toContainText('ヘッダが必須');

      // ヘッダのクライアントが allow_from の中なら通り、ヘッダは転送先に届かない
      await expect.poll(() => exchange(PP_PORT, `PROXY TCP4 192.0.2.10 127.0.0.1 40000 ${PP_PORT}\r\nhello`)).toBe('hello');
      // ヘッダのクライアントが allow_from の外なら断る
      expect(await exchange(PP_PORT, `PROXY TCP4 198.51.100.7 127.0.0.1 40000 ${PP_PORT}\r\nhello`)).toBe('');
      // 前段からヘッダなし（required）は断る
      expect(await exchange(PP_PORT, 'hello')).toBe('');

      // 変更の画面で何も変えずに保存しても残る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await expect(page.locator('#rule-proxy-protocol')).toBeChecked();
      await expect(page.locator('#rule-proxy-protocol-from')).toHaveValue('127.0.0.1/32');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PP_PORT}$`));
      expect((await storedRule(page, PP_PORT)).proxyProtocol).toEqual({ from: ['127.0.0.1/32'], required: true });

      // 外すと rproxy からも外れる（ヘッダなしで通る）
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: '詳細' }).click();
      await page.locator('#rule-proxy-protocol').uncheck();
      await page.locator('#rule-allow-from').fill('');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${PP_PORT}$`));
      expect((await storedRule(page, PP_PORT)).proxyProtocol).toBeUndefined();
      await expect.poll(() => exchange(PP_PORT, 'hello')).toBe('hello');
    } finally {
      await deleteRule(page, PP_PORT);
      backend.close();
    }
  });

  test('a route source_ip from the TLS tab reaches its backend and survives an edit', async ({ page }) => {
    const f = await features(page);
    test.skip(f.route_source_ip !== true, 'rproxy-api does not take per-route source_ip yet');
    const received: string[] = [];
    const backend = await listen(net.createServer((s) => {
      s.once('data', (d) => { received.push(d.toString('latin1')); s.destroy(); });
      s.on('error', () => undefined);
    }), SNI_BACKEND);
    const fallback = await listen(net.createServer((s) => s.destroy()), SNI_FALLBACK);
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
      await page.getByLabel('サーバ名 1', { exact: true }).fill('pp.e2e.test');
      await page.getByLabel('転送先アドレス 1', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('転送先ポート 1', { exact: true }).fill(String(SNI_BACKEND));
      await page.getByLabel('転送先 1 の送信元 IP の渡し方', { exact: true }).selectOption('proxy_v1');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${SNI_PORT}$`));
      await expect(page.getByTestId('tls-route-source-ip')).toContainText('proxy_v1');

      // 変更の画面でそのまま保存しても route の source_ip は残る（#297 の前は buildTls が落としていた）
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await expect(page.getByLabel('転送先 1 の送信元 IP の渡し方', { exact: true })).toHaveValue('proxy_v1');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${SNI_PORT}$`));
      expect((await storedRule(page, SNI_PORT)).tls.routes[0].source_ip).toBe('proxy_v1');

      // pp.e2e.test の転送先には、ClientHello の前に PROXY v1 のヘッダ（クライアントは 127.0.0.1）が届く
      await expect.poll(async () => {
        const s = tls.connect({ host: '127.0.0.1', port: SNI_PORT, servername: 'pp.e2e.test', rejectUnauthorized: false });
        s.on('error', () => undefined);
        await new Promise((r) => setTimeout(r, 300));
        s.destroy();
        return received[0] ?? '';
      }).toMatch(new RegExp(`^PROXY TCP4 127\\.0\\.0\\.1 127\\.0\\.0\\.1 \\d+ ${SNI_PORT}\\r\\n`));
    } finally {
      await deleteRule(page, SNI_PORT);
      backend.close();
      fallback.close();
    }
  });
});
