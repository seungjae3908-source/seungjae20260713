import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.STAGING_BASE_URL?.trim();
if (!baseURL) throw new Error('STAGING_BASE_URL is required');
if (process.env.STAGING_AUTO_LIVE_ONLY_QA !== 'true') {
  throw new Error('STAGING_AUTO_LIVE_ONLY_QA=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /staging-auto-live-only\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 2 * 60_000,
  globalTimeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
});
