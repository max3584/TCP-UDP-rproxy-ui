// 利用量の集計（#101）：画面から作ったルールに通信を流すと、UI が rproxy の統計を取って貯め（RPROXY_UI_USAGE_SECS=30）、
// ルールの詳細・利用量の画面・CSV に出ること
import net from 'node:net';
import { expect, test } from '@playwright/test';

const PORT = Number(process.env.UI_E2E_USAGE_PORT ?? 19491);
const BACKEND_PORT = 19492;

function send(msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write(msg));
    c.setTimeout(3000, () => { c.destroy(); resolve(); });
    c.on('data', () => { c.end(); resolve(); });
    c.on('error', reject);
  });
}

test.describe('usage accounting', () => {
  let backend: net.Server;
  test.beforeAll(async () => {
    backend = net.createServer((s) => s.on('data', (d) => s.write(d)));
    await new Promise<void>((r) => backend.listen(BACKEND_PORT, '127.0.0.1', r));
  });
  test.afterAll(() => backend.close());

  test('traffic shows up in the usage after collection', async ({ page }) => {
    test.setTimeout(180_000);
    await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: PORT } });
    const add = await page.request.post('/api/forward/add', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: PORT, distAddr: '127.0.0.1', distPort: BACKEND_PORT } });
    expect(add.ok(), await add.text()).toBe(true);
    try {
      const probe = await page.request.get('/api/forward/usage?range=24h');
      test.skip(!(await probe.json()).available, 'usage tables are not in the DB');
      // 集計の基準ができてからも流し続ける（最初の集計は基準を作るだけのことがある）
      await expect.poll(async () => {
        await send('x'.repeat(4096));
        const res = await page.request.get(`/api/forward/usage?range=24h&protocol=tcp&addr=127.0.0.1&port=${PORT}`);
        const body = await res.json() as { total?: { rx: number } };
        return body.total?.rx ?? 0;
      }, { timeout: 150_000, intervals: [5_000] }).toBeGreaterThan(0);

      await page.goto(`/rules/tcp/127.0.0.1/${PORT}`);
      await expect(page.getByTestId('usage-chart')).toBeVisible();
      await page.goto('/usage');
      await page.getByTestId('usage-group').selectOption('rule');
      await expect(page.getByTestId('usage-report-table')).toContainText(`tcp/127.0.0.1:${PORT}`);
      const month = new Date().toISOString().slice(0, 7);
      const csv = await page.request.get(`/api/forward/usage?report=1&period=${month}&group=rule&format=csv`);
      expect(await csv.text()).toContain(`tcp/127.0.0.1:${PORT}`);
    } finally {
      await page.request.post('/api/forward/delete', { data: { protocol: 'tcp', srcAddr: '127.0.0.1', srcPort: PORT } });
    }
  });
});
