import { defineConfig, devices } from '@playwright/test';

const baseURL = String(process.env.STAGING_BASE_URL ?? '').trim();
if (process.env.STAGING_TRADING_CORE_QA !== 'true') throw new Error('STAGING_TRADING_CORE_QA_REQUIRED');
let origin: URL;
try { origin = new URL(baseURL); } catch { throw new Error('STAGING_CORE_ORIGIN_INVALID'); }
if (origin.protocol !== 'https:' || origin.username || origin.password
  || origin.pathname !== '/' || origin.search || origin.hash
  || ['lsj119.com', 'www.lsj119.com', 'lsj119.duckdns.org'].includes(origin.hostname)) {
  throw new Error('STAGING_CORE_PRODUCTION_ORIGIN_FORBIDDEN');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /staging-trading-core-readonly\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 150_000,
  globalTimeout: 7 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['line']],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 25_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'staging-core-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'staging-core-mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
