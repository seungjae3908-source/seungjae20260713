import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_AUTO_LIVE_POLICY_PREPARE !== 'true') {
  throw new Error('PRODUCTION_AUTO_LIVE_POLICY_PREPARE=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-auto-live-policy-prepare\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 2 * 60_000,
  globalTimeout: 4 * 60_000,
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
