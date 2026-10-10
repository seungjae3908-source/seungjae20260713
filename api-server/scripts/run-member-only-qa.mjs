#!/usr/bin/env node
/**
 * Member-only local Draft QA. No DB or production credentials are used.
 * This is NOT a release, production-auth test, or a substitute for Full CI.
 *
 * From the repository root:
 *   node api-server/scripts/run-member-only-qa.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const forbiddenRequestedModes = [
  'PHASE10_STAGING_E2E',
  'PRODUCTION_MEMBER_READONLY_QA',
];
for (const key of forbiddenRequestedModes) {
  if (process.env[key] === 'true') {
    console.error(`[MEMBER_QA_PRODUCTION_MODE_FORBIDDEN] ${key}`);
    process.exit(2);
  }
}
if (process.argv.length > 2) {
  console.error('Usage: node api-server/scripts/run-member-only-qa.mjs');
  process.exit(2);
}

// Redact provider/database/auth secrets from every child process; they are not
// needed because the member QA runs simulated local API and browser fixtures.
const safeEnv = { ...process.env };
for (const key of Object.keys(safeEnv)) {
  if (/^(?:DATABASE_URL|DB_|PGPASSWORD|PGHOST|PGPORT|PGUSER|PGDATABASE|SUPABASE_|VITE_SUPABASE_|UPBIT_|BITGET_|KIWOOM_|TOSS_|TELEGRAM_|PRODUCTION_QA_|PRODUCTION_BASE_URL|STAGING_BASE_URL|SERVICE_ROLE_|OPENAI_API_KEY)/i.test(key)) delete safeEnv[key];
}
Object.assign(safeEnv, {
  CI: 'true',
  LIVE_TRADING: 'false',
  AUTO_TRADING: 'false',
  REAL_ORDER_ENABLED: 'false',
  PRIVATE_TRADING_API_ALLOWED: 'false',
  PRODUCTION_MEMBER_READONLY_QA: 'false',
  PHASE10_STAGING_E2E: 'false',
});
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(label, command, args, cwd = root) {
  console.log(`[MEMBER_ONLY_QA] ${label}`);
  const result = spawnSync(command, args, {
    cwd, env: safeEnv, stdio: 'inherit', shell: process.platform === 'win32' && command === pnpm,
  });
  if (result.error) {
    console.error(`[MEMBER_ONLY_QA_FAILED] ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[MEMBER_ONLY_QA_FAILED] ${label}: exit ${result.status}`);
    process.exit(result.status || 1);
  }
}

run('Install frozen dependencies', pnpm, ['install', '--frozen-lockfile']);
run('Backend TypeScript validation', pnpm, ['--dir', 'api-server', 'run', 'typecheck']);
run('Frontend TypeScript validation', pnpm, ['--dir', 'stock-analyzer', 'run', 'typecheck']);
run('Membership, approval, RLS gateway mocks, scanner grade API tests', process.execPath, ['./scripts/member-only-api-tests.mjs'], path.join(root, 'api-server'));
run('Member-only browser tests (localhost only)', pnpm, [
  '--dir', 'stock-analyzer', 'exec', 'playwright', 'test',
  'e2e/admin-member-state.spec.ts',
  'e2e/admin-read-timeout-contract.spec.ts',
  'e2e/auth-profile-restored-context-ai-chart.spec.ts',
  'e2e/auth-profile-same-origin-contract.spec.ts',
  'e2e/member-capability-runtime-drift.spec.ts',
  'e2e/member-profile-session-transition.spec.ts',
  'e2e/member-only-runner-contract.spec.ts',
  'e2e/phase8-release-candidate.spec.ts',
  'e2e/scanner-member-access.spec.ts',
  'e2e/ai-chart-external-window-permission.spec.ts',
  '-c', 'playwright.config.ts', '--workers=1',
]);
console.log('[MEMBER_ONLY_QA_SUCCESS] Draft local/member simulation only; no Production QA or activation performed.');
