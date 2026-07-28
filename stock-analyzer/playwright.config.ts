import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui-audit',
  timeout: 600_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'ui-audit-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.UI_TEST_BASE_URL || 'https://lsj119.duckdns.org',
    headless: true,
    launchOptions: {
      args: ['--disable-dev-shm-usage', '--disable-gpu'],
    },
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  outputDir: 'ui-audit-results',
});
