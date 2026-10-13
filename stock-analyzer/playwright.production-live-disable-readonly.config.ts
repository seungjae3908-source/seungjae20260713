import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_LIVE_DISABLE_READONLY_AUDIT !== 'true') {
  throw new Error('PRODUCTION_LIVE_DISABLE_READONLY_AUDIT=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-live-disable-provider-readonly-audit\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3 * 60_000,
  globalTimeout: 4 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'prod-safe-disable-readonly',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
