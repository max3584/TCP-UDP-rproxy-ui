import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 本番で勧める設定（利用者のロールを決める。#155 から、空なら admin でない人は使えない）。既定の動きの試験は roleConfig に env を渡す
    env: { RPROXY_UI_USER_ROLE: 'rproxy-user' },
  },
});
