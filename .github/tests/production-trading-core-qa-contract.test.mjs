import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Trading Core Production QA is isolated from unrelated product QA', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  const config = read('stock-analyzer/playwright.production-trading-core.config.ts');
  const productionDeploy = read('.github/workflows/production-deploy.yml');

  for (const required of [
    '/api/trade-automation/status',
    '/api/trade-automation/policy',
    '/api/trade-automation/plans',
    '/api/user-integrations/execution/sync',
    '/api/paper-journal/unified-ledger',
    '/api/user-integrations/telegram/test',
    "accountMode: 'paper'",
    'TRADING_CORE_QA_CANARY',
    'paperAutomaticTriggered',
    'journalVisible',
    "'READY_FOR_ACTIVATION'",
    "'ACTIVE_VERIFIED'",
    'telegramActivationReady',
    'telegramUserConnectionRequired',
    'telegramPersonalActivationRequired',
    'telegramConnectedBefore',
    'telegramRuntimeReady',
    'telegramTestDelivered',
    'memberAutoPolicyReadiness',
    'preparedMemberAutoPolicy',
    'memberAutoPolicyPrepared',
    'memberAutoResumePrepared',
    "/api/trade-automation/resume",
    "confirmation: 'RESUME_MEMBER_TRADING'",
    'const originalPolicy = structuredClone(statusBefore.body.policy)',
    'Member policy preparation must not grant LIVE AUTO server authority',
    'memberAutoPolicyReady',
    'memberAutoLivePilotReady',
    'memberAutoOriginalPilotStage',
    'memberAutoPolicyBlockers',
    'memberAutoBitgetLeverage',
    'policyRestored',
    'realOrderSubmitted: false',
    'productionReadOnlyAccessToken',
    'Authorization: `Bearer ${token}`',
    'PRODUCTION_TRADING_CORE_AUTH_TOKEN_MISSING',
  ]) assert.ok(spec.includes(required), required);

  for (const forbidden of [
    "accountMode: 'live'",
    '/api/admin/research',
    '/api/research',
    'research-center',
    'youtube',
    'backtester',
    '/api/trade-automation/plans/',
    '/approve',
    '/cancel',
    '/amend',
    '/transfer',
    '/withdraw',
    "pilotStage: policy?.pilotStage === 'validated' ? 'validated' : 'limited-50'",
    "pilotStage: 'validated'",
  ]) assert.equal(spec.includes(forbidden), false, forbidden);

  assert.equal(spec.includes('must change atomically'), false);

  for (const privacy of ["trace: 'off'", "video: 'off'", "screenshot: 'off'"]) {
    assert.ok(config.includes(privacy), privacy);
  }
  assert.ok(config.includes('production-trading-core-qa\\.spec\\.ts'));
  assert.ok(productionDeploy.includes("PRODUCTION_TRADING_CORE_PREPARE_POLICY: 'true'"));
  assert.ok(productionDeploy.includes('Prepare safe member ALL4 policy and run Focused Trading Core Production QA'));
});

test('Trading Core Production QA restores member policy on early failures and independently of notification restore', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.match(spec, /let integrationBefore: ApiResult<any>;\s+try \{\s+if \(prepareMemberAutoPolicy\)/);
  assert.ok(spec.includes('PRODUCTION_TRADING_CORE_PREFLIGHT_RESTORE_FAILED'));
  assert.ok(spec.includes('PRODUCTION_TRADING_CORE_RESTORE_FAILED'));
  const finallyBlock = spec.slice(spec.indexOf('  } finally {'), spec.indexOf('  const statusAfter ='));
  assert.ok(finallyBlock.includes('PREFERENCES_REQUEST_FAILED'));
  assert.ok(finallyBlock.includes('POLICY_REQUEST_FAILED'));
  assert.ok(finallyBlock.indexOf('PREFERENCES_REQUEST_FAILED') < finallyBlock.indexOf('POLICY_REQUEST_FAILED'));
  assert.ok(finallyBlock.includes('if (restoreFailures.length > 0)'));
});
