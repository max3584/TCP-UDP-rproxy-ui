// フォームで設定できる rproxy の項目（TLS のオプション・basic_auth の realm など・UDP の sni）を画面から作り、
// rproxy-api に反映されて実際に効くことを確かめる
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { expect, test } from '@playwright/test';

const TLS_PORT = 19441;
const AUTH_PORT = 19442;
const ECHO_PORT = 19443;
const HTTP_BACKEND_PORT = 19444;

// 自己署名の証明書（openssl がなければ null）
function selfSigned(dir: string): { cert: string; key: string } | null {
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=app.test', '-addext', 'subjectAltName=DNS:app.test', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    return { cert, key };
  } catch {
    return null;
  }
}

function tlsThrough(port: number, maxVersion: tls.SecureVersion, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'app.test', rejectUnauthorized: false, maxVersion }, () => s.write(msg));
    let data = '';
    s.setTimeout(3000, () => s.destroy(new Error('timeout')));
    s.on('data', (d) => { data += d; s.end(); });
    s.on('end', () => resolve(data));
    s.on('error', reject);
  });
}

function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function deleteRule(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('rproxy settings from the form', () => {
  let dir = '';
  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rproxy-ui-settings-'));
  });
  test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // tls.options（最小バージョン・暗号スイート）。rproxy と同じ規則で先に確かめ、保存すると TLS 1.2 のクライアントを断る
  test('TLS options: minimum version and cipher suites', async ({ page }) => {
    const pki = selfSigned(dir);
    test.skip(!pki, 'openssl is not available');
    const echo = net.createServer((s) => s.on('data', (d) => s.end(`echo:${d}`)));
    await new Promise<void>((r) => echo.listen(ECHO_PORT, '127.0.0.1', () => r()));
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(TLS_PORT));
      await page.locator('#rule-dist-addr').fill('127.0.0.1');
      await page.locator('#rule-dist-port').fill(String(ECHO_PORT));
      await page.getByRole('tab', { name: /TLS/ }).click();
      await page.locator('#rule-tls-mode').selectOption('terminate');
      await page.getByRole('button', { name: '＋ 証明書を追加' }).click();
      await page.locator('#rule-cert-0-cert').fill(pki!.cert);
      await page.locator('#rule-cert-0-key').fill(pki!.key);

      // rproxy の features.tls_options を取得してから出る
      const options = page.getByTestId('tls-options');
      await expect(options).toBeVisible();
      await page.locator('#rule-tls-min-version').selectOption('1.3');
      await options.getByLabel('TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', { exact: true }).check();
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page.getByText('最小バージョンを 1.3 にするときは、TLS 1.3 の暗号スイート')).toBeVisible();
      await expect(page).toHaveURL(/\/rules\/new$/);

      await options.getByLabel('TLS13_AES_128_GCM_SHA256', { exact: true }).check();
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${TLS_PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();
      await expect.poll(() => tlsThrough(TLS_PORT, 'TLSv1.3', 'hi').catch((e) => String(e))).toBe('echo:hi');
      await expect(tlsThrough(TLS_PORT, 'TLSv1.2', 'old')).rejects.toThrow();

      // 編集画面に今の値が出る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: /TLS/ }).click();
      await expect(page.locator('#rule-tls-min-version')).toHaveValue('1.3');
      await expect(page.getByTestId('tls-options').getByLabel('TLS13_AES_128_GCM_SHA256', { exact: true })).toBeChecked();
      await expect(page.getByTestId('tls-options-note')).toHaveCount(0);
      await page.getByRole('button', { name: 'キャンセル' }).click();
      await deleteRule(page);
    } finally {
      echo.close();
    }
  });

  // basic_auth の realm・user_header（と keep_authorization）を専用の欄で設定する
  test('basic_auth: realm and user_header', async ({ page }) => {
    const htpasswd = path.join(dir, 'htpasswd');
    fs.writeFileSync(htpasswd, `alice:{SHA}${createHash('sha1').update('secret').digest('base64')}\n`);
    const backend = http.createServer((req, res) => res.end(`user=${req.headers['x-forwarded-user'] ?? ''} auth=${req.headers.authorization ? 'yes' : 'no'}`));
    await new Promise<void>((r) => backend.listen(HTTP_BACKEND_PORT, '127.0.0.1', () => r()));
    try {
      await page.goto('/rules/new');
      await page.locator('#rule-protocol').selectOption('tcp');
      await page.locator('#rule-src-addr').selectOption('127.0.0.1');
      await page.locator('#rule-src-port').fill(String(AUTH_PORT));
      await page.locator('#rule-l7').check();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await page.getByLabel('サービス backend の転送先 1 の URL').fill(`http://127.0.0.1:${HTTP_BACKEND_PORT}`);
      await page.getByLabel('ミドルウェアを追加', { exact: true }).selectOption('basic_auth');
      await page.locator('#http-mw-0-users_file').fill(htpasswd);
      await page.locator('#http-mw-0-realm').fill('staff');
      await page.locator('#http-mw-0-user_header').fill('X-Forwarded-User');
      await page.locator('#http-mw-0-keep_authorization').check();
      await page.getByLabel(/^ルート .* にミドルウェアを足す$/).selectOption('basic-auth');
      await page.getByRole('button', { name: 'ルールを追加' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${AUTH_PORT}$`));
      await expect(page.getByText('稼働中').first()).toBeVisible();

      await expect.poll(async () => (await get(AUTH_PORT).catch(() => null))?.status).toBe(401);
      expect((await get(AUTH_PORT)).headers['www-authenticate']).toBe('Basic realm="staff"');
      const ok = await get(AUTH_PORT, { authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}` });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe('user=alice auth=yes');

      // 編集画面に今の値が出る
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'L7 (HTTP)' }).click();
      await expect(page.locator('#http-mw-0-realm')).toHaveValue('staff');
      await expect(page.locator('#http-mw-0-keep_authorization')).toBeChecked();
      await page.getByRole('button', { name: 'キャンセル' }).click();
      await deleteRule(page);
    } finally {
      backend.close();
    }
  });

  // UDP の sni は rproxy v0.3.8 から。版を返す rproxy（v0.3.18 以降）なら、版の注意を出さずに選べる
  test('UDP sni is offered without the version note on a current rproxy', async ({ page }) => {
    await page.goto('/rules/new');
    await page.locator('#rule-protocol').selectOption('udp');
    await page.getByRole('tab', { name: /DTLS/ }).click();
    await expect(page.locator('#rule-tls-mode option[value="sni"]')).toHaveCount(1);
    await page.locator('#rule-tls-mode').selectOption('sni');
    await expect(page.getByTestId('udp-sni-notes')).toBeVisible();
    await expect(page.getByTestId('udp-sni-version-note')).toHaveCount(0);
  });
});
