// セキュリティレビュー（UI v0.4.0）の画面と API の確認。利用者（rproxy-user）のセッションで動く
import { expect, test } from '@playwright/test';

test.describe('security review fixes', () => {
  test('a POST from another site is refused (CSRF, 403 csrf) before anything changes', async ({ page }) => {
    const port = 19491;
    const res = await page.request.post('/api/forward/add', {
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: port, distAddr: '127.0.0.1', distPort: 9 },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('csrf');
    const rule = await page.request.get(`/api/forward/rule?protocol=tcp&addr=127.0.0.1&port=${port}`);
    expect(rule.status()).toBe(404);
  });

  test('users do not get rproxy config paths, errors or build hashes', async ({ page }) => {
    const system = await page.request.get('/api/forward/system');
    expect(system.status()).toBe(200);
    const body = await system.json() as { admin?: boolean; nodes: { build: { sha256?: string } | null; config: { path: string | null } }[] };
    expect(body.admin).toBeUndefined();
    for (const n of body.nodes) {
      expect(n.config.path).toBeNull();
      expect(n.build?.sha256).toBeUndefined();
    }
    const config = await page.request.get('/api/forward/config');
    expect((await config.json()).path).toBeNull();

    // 画面も開ける
    await page.goto('/system');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
