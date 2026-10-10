import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (process.env.PRODUCTION_AUTOMATIC_PAPER_ACTIVATION !== 'true') {
  throw new Error('PRODUCTION_AUTOMATIC_PAPER_ACTIVATION=true is required');
}
if (!baseURL || new URL(baseURL).origin !== 'https://lsj119.com') {
  throw new Error('OFFICIAL_PRODUCTION_ORIGIN_REQUIRED');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-automatic-paper-activation\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 6 * 60_000,
  globalTimeout: 8 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [{
    name: 'production-automatic-paper-only',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  }],
});
