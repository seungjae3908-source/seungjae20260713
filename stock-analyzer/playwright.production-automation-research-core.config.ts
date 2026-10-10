import { defineConfig, devices } from '@playwright/test';

const enabled = process.env.PRODUCTION_AUTOMATION_RESEARCH_QA === 'true';
const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (enabled && (!baseURL || new URL(baseURL).origin !== 'https://lsj119.com')) {
  throw new Error('PRODUCTION_AUTOMATION_RESEARCH_OFFICIAL_ORIGIN_REQUIRED');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-automation-research-core-qa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  globalTimeout: 4 * 60_000,
  reporter: [['list']],
  use: {
    baseURL: baseURL || 'https://production-qa-disabled.invalid',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    ignoreHTTPSErrors: false,
  },
});
