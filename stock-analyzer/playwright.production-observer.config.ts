import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_READONLY_E2E !== 'true') {
  throw new Error('PRODUCTION_READONLY_E2E=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-health-observer\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 55_000,
  expect: { timeout: 10_000 },
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
    navigationTimeout: 15_000,
    actionTimeout: 8_000,
  },
  projects: [
    {
      name: 'production-observer-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'production-observer-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
