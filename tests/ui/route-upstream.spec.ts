// rproxy-api v0.4.7 の tls.routes[].upstream（名前ごとの転送先への TLS、features.tls_route_upstream。rproxy-gateway が BackendTLSPolicy から作る）を
// TLS タブから使い、rproxy-api に反映されてその名前だけ転送先へ TLS でつなぐこと、変更の画面でそのまま保存しても消えないこと
// （以前は normalizeTls が知らない項目として断った）、平文に切り替えると {} になることを確かめる。
// rproxy の features が対応していないか、openssl がなければ飛ばす
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const RULE_PORT = 19571;
const TLS_BACKEND = 19572;
const PLAIN_BACKEND = 19573;
const NAME = 'up.e2e.test';

async function features(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/forward/capabilities');
  if (!res.ok()) return {};
  const caps = await res.json() as { features?: Record<string, unknown> };
  return caps.features ?? {};
}

async function deleteRule(page: Page): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT } });
}

async function storedRule(page: Page): Promise<Record<string, any>> {
  const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${RULE_PORT}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

// 自己署名の証明書（openssl がなければ null）
function selfSigned(dir: string): { cert: string; key: string } | null {
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=app.test', '-addext', 'subjectAltName=DNS:app.test', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    // rproxy-api v0.4 は誰でも読める鍵を断る
    fs.chmodSync(key, 0o600);
    return { cert, key };
  } catch {
    return null;
  }
}

function listen<T extends net.Server>(server: T, port: number): Promise<T> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// rproxy の終端を通して送り、返ってきたものを返す
function through(msg: string): Promise<string> {
  return new Promise((resolve) => {
    let got = '';
    const s = tls.connect({ host: '127.0.0.1', port: RULE_PORT, servername: NAME, rejectUnauthorized: false }, () => s.write(msg));
    const done = () => { clearTimeout(t); s.destroy(); resolve(got); };
    const t = setTimeout(done, 3000);
    s.on('data', (d) => { got += d.toString(); if (got.includes(msg)) done(); });
    s.on('close', done);
    s.on('error', done);
  });
}

test.describe('per-route TLS to the backend', () => {
  let dir = '';
  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rproxy-ui-route-upstream-'));
  });
  test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a route upstream from the TLS tab re-encrypts that name and survives an edit', async ({ page }) => {
    const f = await features(page);
    test.skip(f.tls_route_upstream !== true, 'rproxy-api does not take tls.routes[].upstream yet');
    const pki = selfSigned(dir);
    test.skip(!pki, 'openssl is not available');
    // TLS の転送先は、受け取ったサーバ名（rproxy が送る server_name）を付けて返す。平文の転送先はそのまま返す
    const tlsBackend = await listen(tls.createServer({ cert: fs.readFileSync(pki!.cert), key: fs.readFileSync(pki!.key) }, (s) => {
      s.on('data', (d) => s.write(`tls:${(s as tls.TLSSocket).servername || ''}:${d}`));
      s.on('error', () => undefined);
    }), TLS_BACKEND);
    const plainBackend = await listen(net.createServer((s) => {
      s.on('data', (d) => s.write(`plain:${d}`));
      s.on('error', () => undefined);
    }), PLAIN_BACKEND);
    await deleteRule(page);
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(RULE_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(PLAIN_BACKEND));
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.locator('#rule-tls-mode').selectOption('terminate');
      await page.getByRole('button', { name: '＋ 証明書を追加' }).click();
      await page.locator('#rule-cert-0-cert').fill(pki!.cert);
      await page.locator('#rule-cert-0-key').fill(pki!.key);
      await page.getByRole('button', { name: '＋ 転送先を追加' }).click();
      await page.getByLabel('サーバ名 1', { exact: true }).fill(NAME);
      await page.getByLabel('転送先アドレス 1', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('転送先ポート 1', { exact: true }).fill(String(TLS_BACKEND));
      // rproxy の features.tls_route_upstream を取得してから出る
      await page.getByLabel('転送先 1 への TLS', { exact: true }).selectOption('tls');
      await page.locator('#rule-route-1-upstream-name').fill('backend.internal');
      // クライアント証明書だけで秘密鍵がなければ、rproxy と同じ規則で先に断る
      await page.locator('#rule-route-1-upstream-cert').fill(pki!.cert);
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByText('転送先へのクライアント証明書と秘密鍵は両方とも指定してください')).toBeVisible();
      await expect(page).toHaveURL(/\/rules\/new$/);
      await page.locator('#rule-route-1-upstream-cert').fill('');
      // 自己署名なので検証しない（テスト用）
      await page.locator('#rule-route-1-upstream-insecure').check();
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      await expect(page.getByTestId('tls-route-upstream')).toContainText('再暗号化する');
      await expect(page.getByTestId('tls-route-upstream')).toContainText('backend.internal');

      // その名前だけ、ルールの upstream（平文）の代わりに TLS で、指定したサーバ名でつなぐ
      await expect.poll(() => through('hello')).toBe('tls:backend.internal:hello');

      // 変更の画面でそのまま保存しても残る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await expect(page.getByLabel('転送先 1 への TLS', { exact: true })).toHaveValue('tls');
      await expect(page.locator('#rule-route-1-upstream-name')).toHaveValue('backend.internal');
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      expect((await storedRule(page)).tls.routes[0].upstream).toEqual({ tls: true, server_name: 'backend.internal', insecure_skip_verify: true });

      // この名前を平文にすると、残った値は注記で出て、消すと {}。rproxy は平文で TLS の転送先につなぐので、返事は来ない
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await page.getByLabel('転送先 1 への TLS', { exact: true }).selectOption('plain');
      await expect(page.locator('#rule-route-1-upstream-name')).toHaveCount(0);
      await expect(page.getByTestId('route-upstream-unused')).toContainText('backend.internal');
      await page.getByLabel('転送先 1 への TLS の使わない値を消す', { exact: true }).click();
      await expect(page.getByTestId('route-upstream-unused')).toHaveCount(0);
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      await expect(page.getByTestId('tls-route-upstream')).toContainText('平文');
      expect((await storedRule(page)).tls.routes[0].upstream).toEqual({});
      expect(await through('again')).not.toContain('tls:');
    } finally {
      await deleteRule(page);
      tlsBackend.close();
      plainBackend.close();
    }
  });
});
