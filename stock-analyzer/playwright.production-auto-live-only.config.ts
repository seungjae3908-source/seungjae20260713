import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_AUTO_LIVE_ONLY_QA !== 'true') {
  throw new Error('PRODUCTION_AUTO_LIVE_ONLY_QA=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-auto-live-only-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3 * 60_000,
  globalTimeout: 6 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'production-auto-live-artifacts/playwright-report.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
});
