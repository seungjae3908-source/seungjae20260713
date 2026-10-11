import { defineConfig } from '@playwright/test';
import comprehensive from './playwright.production-comprehensive.config';

if (process.env.PRODUCTION_RESEARCH_ONLY_QA !== 'true') {
  throw new Error('PRODUCTION_RESEARCH_ONLY_QA=true is required');
}
if (process.env.PRODUCTION_BASE_URL !== 'https://lsj119.com') {
  throw new Error('Research QA must use the official Production origin');
}

export default defineConfig({
  ...comprehensive,
  testMatch: /production-research-center-readonly-qa\.spec\.ts/,
  globalTimeout: 15 * 60_000,
  reporter: [['line'], ['json', { outputFile: 'production-research-artifacts/playwright-report.json' }]],
});
