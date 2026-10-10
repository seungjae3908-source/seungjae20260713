import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PRODUCTION_BASE_URL?.trim();
if (!baseURL || new URL(baseURL).origin !== 'https://lsj119.com') {
  throw new Error('Official PRODUCTION_BASE_URL is required');
}
if (process.env.PRODUCTION_AUTOMATION_RESEARCH_PREDEPLOY !== 'true') {
  throw new Error('PRODUCTION_AUTOMATION_RESEARCH_PREDEPLOY=true is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /production-automation-research-predeploy-readiness\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 2 * 60_000,
  globalTimeout: 3 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'production-automation-research-predeploy-artifacts/playwright-report.json' }],
  ],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [{
    name: 'production-automation-research-predeploy-desktop',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  }],
});
