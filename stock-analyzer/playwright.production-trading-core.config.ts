import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_TRADING_CORE_QA !== 'true') {
  throw new Error('PRODUCTION_TRADING_CORE_QA=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-trading-core-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 2 * 60_000,
  globalTimeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'production-trading-core-artifacts/playwright-report.json' }],
  ],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'production-trading-core-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
