import path from 'node:path';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.STAGING_BASE_URL?.trim();
if (!baseURL) {
  throw new Error('STAGING_BASE_URL is required for strict staging user-integrations verification');
}

const artifactDir = path.resolve(
  process.env.STAGING_STRICT_ARTIFACT_DIR ?? '../staging-user-integrations-artifacts',
);

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(artifactDir, 'playwright-test-results'),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    hasTouch: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    ignoreHTTPSErrors: false,
  },
});
