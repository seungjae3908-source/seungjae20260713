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
    command:'VITE_SUPABASE_URL=http://127.0.0.1:4173/__e2e-supabase VITE_SUPABASE_ANON_KEY=e2e-public-anon-key VITE_PHASE4_E2E=true VITE_PHASE5_E2E=true VITE_PHASE6_E2E=true VITE_PHASE7_E2E=true VITE_PHASE8_E2E=true VITE_PHASE9_E2E=true VITE_PHASE11_E2E=true VITE_PHASE12_E2E=true pnpm exec vite --config vite.research-workspace.config.ts --host 127.0.0.1 --port 4173',
    url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:120000,
  },
});
