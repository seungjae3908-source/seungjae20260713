import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_TELEGRAM_DELIVERY_DIAGNOSTIC !== 'true') {
  throw new Error('PRODUCTION_TELEGRAM_DELIVERY_DIAGNOSTIC=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-telegram-delivery-readonly-diagnostic\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  globalTimeout: 3 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'production-telegram-delivery-diagnostic-artifacts/playwright-report.json' }],
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
      name: 'production-telegram-delivery-readonly',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
