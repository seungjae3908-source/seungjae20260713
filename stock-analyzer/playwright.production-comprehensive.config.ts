import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_READONLY_E2E !== 'true') {
  throw new Error('PRODUCTION_READONLY_E2E=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-(?:comprehensive|mobile-scroll|critical-http)-readonly-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  globalTimeout: 72 * 60_000,
  expect: { timeout: 12_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'production-comprehensive-artifacts/playwright-report.json' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'prod-desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'prod-desktop-1024', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } } },
    { name: 'prod-mobile-320', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 740 } } },
    { name: 'prod-mobile-360', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 800 } } },
    { name: 'prod-mobile-390', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'prod-mobile-412', use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } } },
    { name: 'prod-mobile-430', use: { ...devices['Pixel 7'], viewport: { width: 430, height: 932 } } },
  ],
});
