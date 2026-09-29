import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: [/research-video-intelligence\.spec\.ts/, /research-workspace-v2\.spec\.ts/],
  outputDir:'test-results/research-workspace',
  reporter:[['list'],['json',{outputFile:'test-results/research-workspace-result.json'}]],
  workers:1,
  retries:0,
  webServer:{
    command:'node ./e2e/support/start-vite-e2e-server.mjs vite.research-workspace.config.ts',
    url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:120000,
  },
});
