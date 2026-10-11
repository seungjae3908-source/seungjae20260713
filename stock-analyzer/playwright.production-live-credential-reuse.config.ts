import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL) throw new Error('PRODUCTION_BASE_URL is required');
if (process.env.PRODUCTION_LIVE_CREDENTIAL_REUSE_QA !== 'true') {
  throw new Error('PRODUCTION_LIVE_CREDENTIAL_REUSE_QA=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-live-credential-reuse-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 4 * 60_000,
  globalTimeout: 8 * 60_000,
  expect: { timeout: 15000 },
  reporter: [['line']],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [{
    name: 'prod-live-credential-reuse-desktop',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  }],
});
