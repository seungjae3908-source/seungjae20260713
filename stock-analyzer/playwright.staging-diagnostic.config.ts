import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  fullyParallel: false,
  workers: 1,
  retries: 0,
});
