import { defineConfig } from '@playwright/test';

const stagingMode = process.env.PHASE10_STAGING_E2E === 'true';
const baseURL = stagingMode
  ? process.env.STAGING_BASE_URL
  : 'http://127.0.0.1:4173';

if (stagingMode && !baseURL) {
  throw new Error('STAGING_BASE_URL is required for Phase 10 staging browser verification');
}

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: stagingMode ? 90_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    hasTouch: true,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  webServer: stagingMode ? undefined : {
    command: 'VITE_PHASE4_E2E=true VITE_PHASE5_E2E=true VITE_PHASE6_E2E=true VITE_PHASE7_E2E=true VITE_PHASE8_E2E=true VITE_PHASE9_E2E=true VITE_PHASE11_E2E=true pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
