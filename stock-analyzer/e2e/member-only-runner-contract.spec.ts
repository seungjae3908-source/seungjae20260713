import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const root = path.resolve(process.cwd(), '..');
const runner = fs.readFileSync(path.join(root, 'api-server/scripts/run-member-only-qa.mjs'), 'utf8');
const apiTests = fs.readFileSync(path.join(root, 'api-server/scripts/member-only-api-tests.mjs'), 'utf8');

test('member-only runner removes production credentials, disables real orders, and uses local browser mocks', () => {
  expect(runner).toContain("LIVE_TRADING: 'false'");
  expect(runner).toContain("AUTO_TRADING: 'false'");
  expect(runner).toContain("REAL_ORDER_ENABLED: 'false'");
  expect(runner).toContain("PRIVATE_TRADING_API_ALLOWED: 'false'");
  expect(runner).toContain("PRODUCTION_MEMBER_READONLY_QA: 'false'");
  expect(runner).toContain("PHASE10_STAGING_E2E: 'false'");
  expect(runner).toContain("delete safeEnv[key]");
  expect(runner).toContain("['./scripts/member-only-api-tests.mjs']");
  expect(runner).toContain("shell: process.platform === 'win32' && command === pnpm");
  expect(runner).toContain("'-c', 'playwright.config.ts', '--workers=1'");
  expect(runner).not.toContain('gh pr merge');
  expect(runner).not.toContain('vercel deploy');
});

test('member-only API runner selects approval, auth and scanner tests without trade execution', () => {
  expect(apiTests).toContain('const memberCases = [');
  expect(apiTests).toContain('member-access-phase8.test.ts');
  expect(apiTests).toContain('member-administration.service.test.ts');
  expect(apiTests).toContain('member-access-phase8.smoke.test.ts');
  expect(apiTests).toContain('scanner-access-control.service.test.ts');
  expect(apiTests).toContain("format: 'cjs'");
  expect(apiTests).toContain("'--test', ...outputFiles");
  expect(apiTests).not.toContain('trade-automation.service.test');
  expect(apiTests).not.toContain('real-order');
  expect(apiTests).not.toContain('network-smoke');
});

test('member-only API runner actually passes in isolated local mock mode', () => {
  const safeEnv = { ...process.env, CI: 'true', LIVE_TRADING: 'false', AUTO_TRADING: 'false', PRODUCTION_MEMBER_READONLY_QA: 'false' };
  const result = spawnSync(process.execPath, ['./scripts/member-only-api-tests.mjs'], {
    cwd: path.join(root, 'api-server'),
    env: safeEnv,
    encoding: 'utf8',
    timeout: 50_000,
  });
  expect(result.status, (result.stderr ?? '').slice(-1200)).toBe(0);
});
