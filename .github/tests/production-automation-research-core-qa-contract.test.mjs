import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const deploy = read('.github/workflows/production-deploy.yml');
const command = read('.github/workflows/production-postdeploy-qa.yml');
const spec = read('stock-analyzer/e2e/production-automation-research-core-qa.spec.ts');
const config = read('stock-analyzer/playwright.production-automation-research-core.config.ts');
const verifier = '.github/scripts/verify-production-automation-research-core-receipt.mjs';
const sha = 'a'.repeat(40);
const runId = 12345;

test('dedicated release command selects scoped Staging and only the four requested Production features', () => {
  for (const marker of [
    '/run-production-automation-research-backtester-release ',
    "? 'staging-trading-core-only.yml'",
    "? 'automation_research'",
    "qa_scope: qaScope",
    'delegated_by_run_id: String(context.runId)',
  ]) assert.ok(command.includes(marker), marker);
  for (const marker of [
    '- automation_research',
    "inputs.qa_scope == 'automation_research'",
    'playwright.production-automation-research-core.config.ts',
    'verify-production-automation-research-core-receipt.mjs',
    'Four-provider Account / Credential Reuse / Trading Core safety: `PASS`',
    'Unrelated comprehensive UI QA: `NOT_RUN`',
    'evidence_scope=trading_core',
    'production-postdeploy-activation-ready-',
  ]) assert.ok(deploy.includes(marker), marker);
  assert.ok(deploy.includes("inputs.qa_scope == 'full' || inputs.qa_scope == 'trading_core' || inputs.qa_scope == 'automation_research'"));
});

test('browser contract covers Auto, Paper, Research and Backtester without financial authority', () => {
  for (const marker of [
    "'/api/trade-automation/status'",
    "'/api/trade-automation/paper-runtime-readiness'",
    "'/api/paper-journal/snapshot'",
    "'/api/admin/research/overview'",
    "'/api/backtests/run'",
    "page.goto('/auto-trading'",
    "getByTestId('trading-mode-paper')",
    "getByTestId('trading-workspace-journal')",
    "page.goto('/research-center'",
    "page.goto('/backtests'",
    "url.pathname === '/api/backtests/run'",
    "backtest.body?.mode).toBe('backtest-only')",
    'policyMutationPerformed: false',
    'journalReadbackReady: true',
    "phase: 'PREACTIVATION'",
    'paperRuntimeContractVerified: true',
    'telegramExcludedFromScope: true',
    'liveTradingAuthorityGranted: false',
    'autoTradingAuthorityGranted: false',
    'orders: 0', 'cancels: 0', 'amends: 0', 'transfers: 0', 'withdrawals: 0',
  ]) assert.ok(spec.includes(marker), marker);
  for (const forbidden of [
    '/recommendations', '/ai-chart',
    '/api/trade-automation/policy', '/api/trade-automation/plans',
    '/api/user-integrations/telegram/test',
    "'/api/user-integrations'",
    "getByTestId('user-broker-telegram-panel')",
  ]) assert.ok(!spec.includes(forbidden), forbidden);
  for (const marker of ["trace: 'off'", "video: 'off'", "screenshot: 'off'", 'workers: 1', 'retries: 0']) {
    assert.ok(config.includes(marker), marker);
  }
});

test('Production scoped receipt is exact-SHA, exact-run and fail closed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'automation-research-prod-'));
  const file = path.join(dir, 'receipt.json');
  const base = {
    schemaVersion: 'production-automation-paper-research-backtester-core-qa-v2',
    targetSha: sha,
    productionDeployRunId: runId,
    generatedAt: '2026-10-10T00:00:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    features: {
      automaticTrading: 'PASS', automaticPaperTrading: 'PASS',
      researchCenter: 'PASS', backtester: 'PASS',
    },
    backtestMode: 'backtest-only',
    phase: 'PREACTIVATION',
    paperRuntimeContractVerified: true, paperRuntimeReadyAtDeploy: false,
    paperRuntimeBlockers: ['BACKGROUND_WORKER_TICK_NOT_HEALTHY'],
    journalReadbackReady: true,
    telegramExcludedFromScope: true,
    policyMutationPerformed: false,
    liveTradingAuthorityGranted: false, autoTradingAuthorityGranted: false,
    orders: 0, cancels: 0, amends: 0, transfers: 0, withdrawals: 0,
    providerPrivateRequests: 0, secretsRecorded: false,
  };
  const run = (value) => {
    writeFileSync(file, JSON.stringify(value));
    return spawnSync(process.execPath, [verifier, file, sha, String(runId)], { encoding: 'utf8' });
  };
  try {
    assert.equal(run(base).status, 0);
    assert.notEqual(run({ ...base, targetSha: 'b'.repeat(40) }).status, 0);
    assert.notEqual(run({ ...base, orders: 1 }).status, 0);
    assert.notEqual(run({ ...base, features: { ...base.features, backtester: 'FAIL' } }).status, 0);
    assert.notEqual(run({ ...base, autoTradingAuthorityGranted: true }).status, 0);
    assert.notEqual(run({ ...base, telegramExcludedFromScope: false }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
