import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_MEMBER_READONLY_QA !== 'true') {
  throw new Error('PRODUCTION_MEMBER_READONLY_QA=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-member-readonly-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
});
