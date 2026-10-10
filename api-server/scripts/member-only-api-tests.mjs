#!/usr/bin/env node
/**
 * Isolated and non-production member service/HTTP/scanner API tests.
 * Uses the same esbuild + node:test method as the application's test harness
 * without modifying its protected shared test-group registry.
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(apiRoot, '..');
const memberCases = [
  path.join(apiRoot, 'src/services/member-access-phase8.test.ts'),
  path.join(apiRoot, 'src/services/member-administration.service.test.ts'),
  path.join(apiRoot, 'src/routes/member-access-phase8.smoke.test.ts'),
  path.join(apiRoot, 'src/services/scanner-access-control.service.test.ts'),
];
const work = await mkdtemp(path.join(tmpdir(), 'member-only-tests-'));
const outputFiles = [];
try {
  for (const [i, entry] of memberCases.entries()) {
    const dest = path.join(work, `member-only-${i}.test.cjs`);
    await build({
      entryPoints: [entry],
      outfile: dest,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'warning',
      define: { 'import.meta.env': '{}' },
    });
    outputFiles.push(dest);
  }
  const safeEnv = { ...process.env };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:DATABASE_URL|DB_|PGPASSWORD|PGHOST|PGPORT|PGUSER|PGDATABASE|SUPABASE_|VITE_SUPABASE_|UPBIT_|BITGET_|KIWOOM_|TOSS_|TELEGRAM_|PRODUCTION_QA_|PRODUCTION_BASE_URL|STAGING_BASE_URL|SERVICE_ROLE_|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)/i.test(key)) delete safeEnv[key];
  }
  Object.assign(safeEnv, {
    CI: 'true', LIVE_TRADING: 'false', AUTO_TRADING: 'false',
    REAL_ORDER_ENABLED: 'false', PRIVATE_TRADING_API_ALLOWED: 'false',
    PRODUCTION_MEMBER_READONLY_QA: 'false', PHASE10_STAGING_E2E: 'false',
  });
  const result = spawnSync(process.execPath, ['--test', ...outputFiles], {
    cwd: repoRoot,
    env: safeEnv,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
