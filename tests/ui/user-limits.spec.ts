// 利用者（admin でない人）のルールの制限（#155）。利用者のセッション（tests/ui/.auth/user.json、CI は RPROXY_UI_USER_ROLE=rproxy-user）で、
// API がファイルのパスと断る転送先を断ること、フォームがファイルの欄を読み取り専用にして登録済みの証明書を出すことを確かめる
import { expect, test } from '@playwright/test';
import { USER_STATE } from './global-setup';

test.describe('rules of users who are not admins (#155)', () => {
  test.use({ storageState: USER_STATE });
  const port = 19495;

  test('the API refuses server files and loopback / metadata destinations, and nothing is created', async ({ page }) => {
    const add = (data: Record<string, unknown>) => page.request.post('/api/forward/add', {
      data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, distAddr: '192.0.2.10', distPort: 9, sourceIp: 'proxy', udpIdleSecs: 30, ...data },
    });
    for (const [data, code] of [
      [{ distAddr: '127.0.0.1', distPort: 3306 }, 'target_not_allowed'],
      [{ distAddr: '169.254.169.254', distPort: 80 }, 'target_not_allowed'],
      [{ distAddr: 'localhost', distPort: 8080 }, 'target_not_allowed'],
      [{ tls: { mode: 'terminate', certificates: [{ cert_file: '/etc/rproxy/tls/dashboard.pem', key_file: '/etc/rproxy/tls/dashboard.key' }] } }, 'file_not_allowed'],
    ] as const) {
      const res = await add(data);
      expect(res.status(), JSON.stringify(data)).toBe(403);
      expect((await res.json()).code).toBe(code);
    }
    expect((await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${port}`)).status()).toBe(404);
  });

  test('the form locks the file fields and tells why', async ({ page }) => {
    await page.goto('/rules/new');
    await expect(page.getByTestId('user-targets-note')).toBeVisible();
    await page.getByRole('tab', { name: 'TLS / DTLS' }).click();
    await page.locator('#rule-tls-mode').selectOption('terminate');
    await expect(page.getByTestId('user-files-note')).toBeVisible();
    await expect(page.getByRole('button', { name: '＋ 証明書を追加' })).toHaveCount(0);
    await page.getByRole('button', { name: '＋ 登録済みの証明書を追加' }).click();
    await expect(page.getByLabel('登録済みの証明書の名前')).toBeVisible();
    await page.getByLabel('転送先へ TLS で再暗号化する').check();
    await expect(page.locator('#rule-upstream-ca')).toHaveAttribute('readonly', '');
  });
});
