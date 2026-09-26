import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_READONLY_E2E !== 'true') {
  throw new Error('PRODUCTION_READONLY_E2E=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-readonly-smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['line'], ['json', { outputFile: 'production-browser-artifacts/playwright-report.json' }]],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'production-desktop-readonly',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'production-mobile-readonly',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
