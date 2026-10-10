import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const workflow = read('.github/workflows/production-deploy.yml');
const predeploy = read('stock-analyzer/e2e/production-automation-research-predeploy-readiness.spec.ts');
const config = read('stock-analyzer/playwright.production-automation-research-predeploy.config.ts');
const focused = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');

test('Automation/Paper/Research/Backtester readiness runs before every Production mutation boundary', () => {
  const install = workflow.indexOf('Install exact-SHA QA dependencies before Production mutation');
  const preflight = workflow.indexOf('Pre-deploy readiness — Auto, Paper, Research, Backtester and zero authority');
  const ssh = workflow.indexOf('- name: Configure SSH');
  const database = workflow.indexOf('Require canonical Production trade schema and journal privileges before application mutation');
  const deploy = workflow.indexOf('- name: Deploy exact approved revision');
  assert.ok(install > 0 && preflight > install, 'exact QA harness must install before external preflight');
  assert.ok(ssh > preflight, 'SSH authority must not exist before external preflight passes');
  assert.ok(database > ssh && deploy > database, 'database/deploy boundaries must remain after the preflight');
  assert.ok(workflow.includes("if: ${{ inputs.qa_scope == 'automation_research' }}"));
  assert.ok(workflow.includes('production-automation-research-predeploy-${{ env.TARGET_SHA }}'));
  assert.equal(workflow.match(/Install exact-SHA QA dependencies/g)?.length, 1);
  assert.equal(workflow.match(/pnpm\/action-setup@v4/g)?.length, 1);
});

test('predeploy browser audit is authenticated, sanitized, read-only and excludes Telegram', () => {
  for (const marker of [
    "appGet<any>(page, '/api/health')",
    "appGet<any>(page, '/api/trade-automation/status')",
    "appGet<any>(page, '/api/trade-automation/paper-runtime-readiness')",
    'PRODUCTION_RUNTIME_IDENTITY_DRIFT',
    "schemaVersion: 'production-automation-paper-research-backtester-predeploy-readiness-v2'",
    'telegramExcludedFromScope: true',
    'PRODUCTION_PREDEPLOY_READINESS_BLOCKED',
    'sshConfigured: false',
    'databaseMutations: 0',
    'deploymentExecuted: false',
    'policyMutations: 0',
    'telegramMessagesSent: 0',
    'orders: 0',
    'cancels: 0',
    'amends: 0',
    'transfers: 0',
    'withdrawals: 0',
    'secretValuesRecorded: false',
    'accountValuesRecorded: false',
  ]) assert.ok(predeploy.includes(marker), marker);
  for (const forbidden of [
    "appGet<any>(page, '/api/user-integrations')",
    'TELEGRAM_DESTINATION_FORBIDDEN_RECONNECT_REQUIRED',
    'TELEGRAM_CONNECTION_REQUIRED',
  ]) assert.equal(predeploy.includes(forbidden), false, forbidden);
  for (const forbidden of [
    'page.request.post(', 'page.request.put(', 'page.request.patch(', 'page.request.delete(',
    '/telegram/test', '/trade-automation/policy', '/trade-automation/plans', 'sendMessage',
  ]) assert.equal(predeploy.includes(forbidden), false, forbidden);
  for (const marker of ["trace: 'off'", "video: 'off'", "screenshot: 'off'", 'workers: 1', 'retries: 0']) {
    assert.ok(config.includes(marker), marker);
  }
});

test('focused Trading Core preserves temporary member policy rollback', () => {
  const policyWrite = focused.indexOf('preparedMemberAutoPolicy(statusBefore.body.policy)');
  assert.ok(policyWrite > 0);
  assert.ok(focused.includes('if (memberAutoPolicyPrepared)'));
  assert.equal(focused.includes('if (prepareMemberAutoPolicy) {\n      try {\n        const restored'), false);
});
