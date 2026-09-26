// 画面操作の E2E（tests/ui）。UI は本番ビルドを next start で動かし、DB と rproxy-api は本物を使う（CI の e2e ジョブ）。
// サインインは Keycloak を通さず、テスト用の NEXTAUTH_SECRET で作ったセッションのクッキーを使う（tests/ui/global-setup.ts）。
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.UI_E2E_PORT ?? 3100);
export const baseURL = `http://127.0.0.1:${port}`;
export const NEXTAUTH_SECRET = 'ui-e2e-secret-not-for-production';

export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/ui/global-setup.ts',
  use: {
    baseURL,
    storageState: 'tests/ui/.auth/session.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next start -p ${port} -H 127.0.0.1`,
    url: `${baseURL}/api/auth/providers`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET,
      KEYCLOAK_CLIENT_ID: 'rproxy-ui',
      KEYCLOAK_CLIENT_SECRET: 'unused',
      KEYCLOAK_ISSUER: 'http://keycloak.invalid/realms/e2e',
    },
  },
});
