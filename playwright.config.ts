// 画面操作の E2E（tests/ui）。UI は本番ビルドを next start で動かし、DB と rproxy-api は本物を使う（CI の e2e ジョブ）。
// サインインは Keycloak を通さず、テスト用の NEXTAUTH_SECRET で作ったセッションのクッキーを使う（tests/ui/global-setup.ts）。
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.UI_E2E_PORT ?? 3100);
export const baseURL = `http://127.0.0.1:${port}`;
export const NEXTAUTH_SECRET = 'ui-e2e-secret-not-for-production';
// サインインの E2E（tests/ui/csp.spec.ts）が動かす偽の Keycloak（OIDC の discovery と認可のエンドポイントだけ）
export const FAKE_ISSUER_PORT = Number(process.env.UI_E2E_ISSUER_PORT ?? 3198);
export const FAKE_ISSUER = `http://127.0.0.1:${FAKE_ISSUER_PORT}/realms/e2e`;

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
    // keep idle connections for 2 minutes: Node closes them after 5 s by default, and a request sent on a connection
    // the server is closing at that moment fails with "socket hang up" (#143)
    command: `npx next start -p ${port} -H 127.0.0.1 --keepAliveTimeout 120000`,
    url: `${baseURL}/api/auth/providers`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET,
      KEYCLOAK_CLIENT_ID: 'rproxy-ui',
      KEYCLOAK_CLIENT_SECRET: 'unused',
      KEYCLOAK_ISSUER: FAKE_ISSUER,
      // セッションのクッキーは Keycloak を通さずに作るので、ロールを Keycloak に聞き直さない（components/session.ts）
      RPROXY_UI_ROLE_REFRESH_SECS: '0',
      // 利用量の集計（#101）を早く回す（tests/ui/usage.spec.ts。30 秒が最短）
      RPROXY_UI_USAGE_SECS: process.env.RPROXY_UI_USAGE_SECS ?? '30',
    },
  },
});
