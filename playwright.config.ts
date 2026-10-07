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
    // 画面の言語は日本語（ブラウザの言語から決まる。英語の画面は tests/ui/i18n.spec.ts で切り替えて確かめる）
    locale: 'ja-JP',
    storageState: 'tests/ui/.auth/session.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Playwright は Alpine（musl）向けのブラウザを配らないので、CI（node:24-alpine）では apk の chromium を使う
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
        : {}),
    },
  }],
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
      // 利用量の集計（#101）を早く回す（tests/ui/usage.spec.ts。30 秒が最短）
      RPROXY_UI_USAGE_SECS: process.env.RPROXY_UI_USAGE_SECS ?? '30',
    },
  },
});
