import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync('.github/workflows/production-telegram-delivery-readonly-diagnostic.yml', 'utf8');
const spec = fs.readFileSync('stock-analyzer/e2e/production-telegram-delivery-readonly-diagnostic.spec.ts', 'utf8');
const config = fs.readFileSync('stock-analyzer/playwright.production-telegram-delivery-diagnostic.config.ts', 'utf8');

test('diagnostic is exact-run, authenticated, sanitized and read-only', () => {
  for (const marker of [
    '/run-production-telegram-delivery-diagnostic ',
    'environment: production',
    'FAILED_PRODUCTION_RUN_ID',
    'DIAGNOSTIC_WINDOW_START',
    'DIAGNOSTIC_WINDOW_END',
    'PRODUCTION_QA_LOGIN',
    'PRODUCTION_QA_PASSWORD',
    'getWorkflowRun',
    'listJobsForWorkflowRun',
    '1T · Prepare safe member ALL4 policy and run Focused Trading Core Production QA',
    'value.readOnly!==true',
    'value.telegramMessagesSent!==0',
    'financialMutations',
  ]) assert.ok(workflow.includes(marker), marker);
  for (const marker of [
    "appGet<any>(page, '/api/user-integrations')",
    "page.request.get(route",
    'productionReadOnlyAccessToken',
    'WORKER_QUEUE_STARVATION_OR_NOT_TICKING',
    'DELIVERY_RECOVERED_AFTER_QA_DEADLINE',
    'lastErrorCode: safeCode(item.lastErrorCode)',
    'secretValuesRecorded: false',
    'accountValuesRecorded: false',
    'telegramMessagesSent: 0',
    'orders: 0',
    'cancels: 0',
    'amends: 0',
    'transfers: 0',
    'withdrawals: 0',
  ]) assert.ok(spec.includes(marker), marker);
  for (const forbidden of [
    "page.request.post(",
    "page.request.put(",
    "page.request.patch(",
    "page.request.delete(",
    '/telegram/test',
    '/trade-automation/plans',
    'sendMessage',
  ]) assert.equal(spec.includes(forbidden), false, forbidden);
});

test('browser diagnostic does not retain screenshots, video, traces or raw delivery ids', () => {
  for (const marker of ["trace: 'off'", "video: 'off'", "screenshot: 'off'", 'workers: 1', 'retries: 0']) {
    assert.ok(config.includes(marker), marker);
  }
  assert.ok(spec.includes("createHash('sha256')"));
  assert.ok(spec.includes(".slice(0, 16)"));
  assert.equal(spec.includes('id: item.id'), false);
});
