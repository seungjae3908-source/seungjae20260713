import { defineConfig, devices } from '@playwright/test';

const enabled = process.env.STAGING_TRADING_CORE_ONLY_QA === 'true';
const baseURL = process.env.STAGING_BASE_URL?.trim();
if (enabled) {
  if (!baseURL) throw new Error('SCOPED_STAGING_BASE_URL_REQUIRED');
  const origin = new URL(baseURL);
  if (origin.protocol !== 'https:' || origin.hostname === 'lsj119.com'
    || origin.hostname.endsWith('.supabase.co')) {
    throw new Error('SCOPED_STAGING_ISOLATED_HTTPS_ORIGIN_REQUIRED');
  }
}
export default defineConfig({
  testDir: './e2e',
  testMatch: /staging-trading-core-only\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  globalTimeout: 12 * 60_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'staging-trading-core-artifacts/playwright-report.json' }],
  ],
  use: {
    baseURL: baseURL || 'http://127.0.0.1:4173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'trading-core-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'trading-core-mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
