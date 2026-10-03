// README のスクリーンショットを撮る（npm run screenshots。先に npm run build）。
// 通常の E2E（playwright.config.ts の tests/ui）とは別の設定で、npm test / npm run test:ui では動かない。
// UI は本番ビルドを next start で動かし、画面が呼ぶ /api/forward/* はブラウザの中でサンプルのデータに差し替える
// （MariaDB・rproxy-api・Keycloak は要らない。サインインはテスト用の NEXTAUTH_SECRET で作ったセッションのクッキー）
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SCREENSHOTS_PORT ?? 3197);
export const baseURL = `http://127.0.0.1:${port}`;
export const NEXTAUTH_SECRET = 'screenshots-secret-not-for-production';

function browserEnv(language: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'LC_ALL') env[k] = v;
  return { ...env, LANGUAGE: language };
}

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../../test-results/screenshots',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    deviceScaleFactor: 1,
  },
  // 日本語の画面（README.md）と英語の画面（README.en.md）。日付の入力欄の書式はブラウザのプロセスの LANGUAGE で決まる
  // （LANG / LC_ALL まで変えるとフォントの選び方も変わるので変えない）
  projects: [
    { name: 'ja', use: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', launchOptions: { env: browserEnv('ja') } } },
    { name: 'en', use: { locale: 'en-US', timezoneId: 'UTC', launchOptions: { env: browserEnv('en_US') } } },
  ],
  webServer: {
    command: `npx next start -p ${port} -H 127.0.0.1`,
    cwd: '../..',
    url: `${baseURL}/api/auth/providers`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET,
      KEYCLOAK_CLIENT_ID: 'rproxy-ui',
      KEYCLOAK_CLIENT_SECRET: 'unused',
      KEYCLOAK_ISSUER: 'http://keycloak.invalid/realms/screenshots',
      // 実際の rproxy・DB には届かないようにする（API はすべてブラウザの中で差し替える）
      RPROXY_API_URL: 'http://127.0.0.1:9',
      DB_HOST: '127.0.0.1',
      DB_PORT: '9',
    },
  },
});
