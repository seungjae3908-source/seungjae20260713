import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export const CRITICAL_BROWSER_SPECS = [
  /full-product-browser-flow\.spec\.ts$/u,
  /app-navigation\.spec\.ts$/u,
  /ai-chart-v2\.spec\.ts$/u,
  /signal-scanner\.spec\.ts$/u,
  /paper-trading-risk-copy-truth\.spec\.ts$/u,
  /paper-action-reentrancy\.spec\.ts$/u,
  /portfolio-professional-ui\.spec\.ts$/u,
  /account-professional-ui\.spec\.ts$/u,
  /phase12-trade-automation\.spec\.ts$/u,
  /research-copilot\.spec\.ts$/u,
];

export default defineConfig(baseConfig, {
  testMatch: CRITICAL_BROWSER_SPECS,
  retries: 0,
  reporter: [['list']],
});
