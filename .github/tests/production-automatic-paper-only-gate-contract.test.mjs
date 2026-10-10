import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/production-automatic-paper-only-gate.yml', 'utf8');
const spec = readFileSync('stock-analyzer/e2e/production-automatic-paper-activation.spec.ts', 'utf8');

test('owner command activates only isolated Paper after exact release evidence', () => {
  for (const token of [
    '/activate-production-automatic-paper-only ',
    'environment: production',
    'production-automation-research-core-${target}',
    'production-account-readonly-live-${target}',
    'production-live-credential-reuse-${target}',
    'paper-forward-no-deploy-${target}',
    "MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED: 'true'",
    "MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED: 'false'",
    "LIVE_AUTOMATIC_TRADING_ENABLED: 'false'",
    "REAL_ORDER_ENABLED: 'false'",
    "PRIVATE_TRADING_API_ALLOWED: 'false'",
    'Fail closed on activation error',
  ]) assert.ok(workflow.includes(token), `missing ${token}`);
  assert.ok(!workflow.includes("LIVE_TRADING: 'true'"));
  assert.ok(!workflow.includes("AUTO_TRADING: 'true'"));
});

test('Production probe prepares four markets and proves zero financial authority', () => {
  for (const token of [
    '/api/paper-journal/four-market/status',
    '/api/paper-journal/four-market/bootstrap',
    '/api/trade-automation/paper-runtime-readiness',
    "workerMode).toBe('PAPER_ONLY')",
    'telegramRequired: false',
    'orders: 0',
    'cancels: 0',
    'amends: 0',
    'transfers: 0',
    'withdrawals: 0',
    'liveTradingAuthorityGranted: false',
    'autoTradingAuthorityGranted: false',
  ]) assert.ok(spec.includes(token), `missing ${token}`);
});
