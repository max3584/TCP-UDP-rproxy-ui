// #187：L7（http）のルールの tls.upstream（https:// の転送先への検証とクライアント証明書。tls: true なし）。
// rproxy-api は https:// の転送先にこの CA・サーバ名・クライアント証明書を使い、tls.upstream.tls は tls_config で断る。
// 詳細画面に「https:// の転送先への TLS」として出ること、変更の画面でそのまま保存しても消えず（以前は「再暗号化する」のチェックが外れて開き、保存で消えた）
// tls: true を送らないこと、保存の後も転送先へクライアント証明書を出していることを確かめる。openssl がなければ飛ばす
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './global-setup';

const RULE_PORT = 19621;
const BACKEND_PORT = 19622;

async function deleteRule(page: Page): Promise<void> {
  await page.request.post('/api/forward/delete', { headers: SAME_ORIGIN, data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT } });
}

async function storedRule(page: Page): Promise<Record<string, any>> {
  const res = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${RULE_PORT}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

interface Pki { ca: string; site: { cert: string; key: string }; backend: { cert: string; key: string }; client: { cert: string; key: string } }

// 小さな CA と、それが発行したサーバ証明書（rproxy の終端・転送先）とクライアント証明書（openssl がなければ null）。
// rustls は CA の証明書を末端に使えないので、自己署名の 1 枚ではなく CA で発行する
function makePki(dir: string): Pki | null {
  const p = (name: string) => path.join(dir, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  try {
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=e2e upstream CA', '-keyout', p('ca.key'), '-out', p('ca.pem')]);
    const leaf = (name: string, cn: string, ext: string) => {
      fs.writeFileSync(p(`${name}.ext`), ext);
      openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${cn}`,
        '-keyout', p(`${name}.key`), '-out', p(`${name}.csr`)]);
      openssl(['x509', '-req', '-in', p(`${name}.csr`), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial', '-days', '1',
        '-extfile', p(`${name}.ext`), '-out', p(`${name}.pem`)]);
      // rproxy-api v0.4 は誰でも読める鍵を断る
      fs.chmodSync(p(`${name}.key`), 0o600);
      return { cert: p(`${name}.pem`), key: p(`${name}.key`) };
    };
    const server = (dns: string) => `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${dns}\n`;
    return {
      ca: p('ca.pem'),
      site: leaf('site', 'app.test', server('app.test')),
      backend: leaf('backend', 'backend.internal', server('backend.internal')),
      client: leaf('client', 'rproxy-e2e-client', 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n'),
    };
  } catch {
    return null;
  }
}

// rproxy の終端を通して GET し、本文を返す（失敗は ''）
function get(): Promise<string> {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: RULE_PORT, path: '/', servername: 'app.test', headers: { host: 'app.test' }, rejectUnauthorized: false, timeout: 3000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => resolve(`${res.statusCode}:${body}`));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(''));
    req.end();
  });
}

test.describe('TLS to https:// backends of an http rule (#187)', () => {
  let dir = '';
  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rproxy-ui-http-upstream-'));
  });
  test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('tls.upstream without tls: true is shown and survives an edit, and rproxy keeps presenting the client certificate', async ({ page }) => {
    const pki = makePki(dir);
    test.skip(!pki, 'openssl is not available');
    // 転送先は、出されたクライアント証明書の CN を返す（なければ none）
    const backend = https.createServer({
      cert: fs.readFileSync(pki!.backend.cert), key: fs.readFileSync(pki!.backend.key), requestCert: true, rejectUnauthorized: false,
    }, (req, res) => {
      const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
      res.end(`client:${peer?.subject?.CN ?? 'none'}`);
    });
    await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', () => resolve()));
    const upstream = { server_name: 'backend.internal', ca_file: pki!.ca, cert_file: pki!.client.cert, key_file: pki!.client.key };
    await deleteRule(page);
    try {
      const res = await page.request.post('/api/forward/add', {
        headers: SAME_ORIGIN,
        data: {
          protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: RULE_PORT, distAddr: '', distPort: 0,
          tls: { mode: 'terminate', certificates: [{ cert_file: pki!.site.cert, key_file: pki!.site.key }], upstream: upstream },
          http: {
            routes: [{ name: 'app', match: 'PathPrefix(`/`)', service: 'app' }],
            services: { app: { servers: [{ url: `https://127.0.0.1:${BACKEND_PORT}` }] } },
          },
        },
      });
      expect(res.ok(), await res.text()).toBe(true);
      // rproxy は CA と server_name で転送先を確かめ、クライアント証明書を出す
      await expect.poll(get).toBe('200:client:rproxy-e2e-client');

      // 詳細画面：「平文」ではなく https:// の転送先への TLS として出す
      await page.goto(`/rules/tcp/127.0.0.1/${RULE_PORT}`);
      const shown = page.getByTestId('http-upstream');
      await expect(shown).toContainText('https:// の転送先への TLS');
      await expect(shown).toContainText('backend.internal');
      await expect(shown).toContainText(pki!.client.cert);
      await expect(page.getByText('再暗号化しない（転送先へは平文）')).toHaveCount(0);

      // 変更の画面：値が入って開き、「再暗号化する」のチェックはない。そのまま保存しても tls: true を送らず、値が残る
      const sent: unknown[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/forward/modify')) sent.push(r.postDataJSON());
      });
      await page.getByRole('link', { name: '編集' }).click();
      await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
      await expect(page.getByTestId('http-upstream')).toBeVisible();
      await expect(page.getByText('転送先へ TLS で再暗号化する')).toHaveCount(0);
      await expect(page.locator('#rule-upstream-name')).toHaveValue('backend.internal');
      await expect(page.locator('#rule-upstream-ca')).toHaveValue(pki!.ca);
      await expect(page.locator('#rule-upstream-cert')).toHaveValue(pki!.client.cert);
      await expect(page.locator('#rule-upstream-key')).toHaveValue(pki!.client.key);
      await page.getByRole('button', { name: '変更を保存' }).click();
      await expect(page).toHaveURL(new RegExp(`/rules/tcp/127\\.0\\.0\\.1/${RULE_PORT}$`));
      expect(sent).toHaveLength(1);
      expect((sent[0] as { tls: { upstream: Record<string, unknown> } }).tls.upstream).not.toHaveProperty('tls');
      expect((await storedRule(page)).tls.upstream).toEqual(upstream);
      await expect.poll(get).toBe('200:client:rproxy-e2e-client');
    } finally {
      await deleteRule(page);
      backend.close();
    }
  });
});
