import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export const CRITICAL_BROWSER_SPECS = [
  /full-product-browser-flow\.spec\.ts$/u,
  /app-navigation\.spec\.ts$/u,
  /ai-chart-v2\.spec\.ts$/u,
  /ai-chart-stream-consumer-fail-closed\.spec\.ts$/u,
  /ai-chart-stream-timer-scheduler-fail-closed\.spec\.ts$/u,
  /ai-chart-stream-binary-type-fail-closed\.spec\.ts$/u,
  /signal-scanner\.spec\.ts$/u,
  /paper-trading-risk-copy-truth\.spec\.ts$/u,
  /paper-action-reentrancy\.spec\.ts$/u,
  /portfolio-professional-ui\.spec\.ts$/u,
  /account-professional-ui\.spec\.ts$/u,
  /phase12-trade-automation\.spec\.ts$/u,
  /research-copilot\.spec\.ts$/u,
  /research-center-professional-hierarchy\.spec\.ts$/u,
  /research-video-intelligence\.spec\.ts$/u,
];

export default defineConfig(baseConfig, {
  testMatch: CRITICAL_BROWSER_SPECS,
  retries: 0,
  reporter: [['list']],
});
