import path from 'node:path';
import { defineConfig } from '@playwright/test';

const stagingMode = process.env.PHASE10_STAGING_E2E === 'true';
const baseURL = stagingMode
  ? process.env.STAGING_BASE_URL
  : 'http://127.0.0.1:4173';
const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? '../staging-artifacts');

if (stagingMode && !baseURL) {
  throw new Error('STAGING_BASE_URL is required for full staging browser verification');
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: stagingMode ? './e2e/support/staging-bootstrap-global-setup.ts' : undefined,
  outputDir: stagingMode ? path.join(artifactDir, 'playwright-test-results') : './test-results',
  timeout: stagingMode ? 120_000 : 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  retries: stagingMode ? 0 : process.env.CI ? 1 : 0,
  reporter: stagingMode ? [
    ['list'],
    ['json', { outputFile: path.join(artifactDir, 'playwright-report.json') }],
    ['html', { outputFolder: path.join(artifactDir, 'playwright-html-report'), open: 'never' }],
  ] : [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    hasTouch: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  webServer: stagingMode ? undefined : {
    command: 'VITE_PHASE4_E2E=true VITE_PHASE5_E2E=true VITE_PHASE6_E2E=true VITE_PHASE7_E2E=true VITE_PHASE8_E2E=true VITE_PHASE9_E2E=true VITE_PHASE11_E2E=true VITE_PHASE12_E2E=true VITE_INFO_TAB_E2E=true pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
