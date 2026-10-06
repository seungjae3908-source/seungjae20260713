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
    'Member policy preparation must not grant LIVE AUTO server authority',
    "pilotStage: policy?.pilotStage === 'validated' ? 'validated' : 'limited-50'",
    'memberAutoPolicyReady',
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
  ]) assert.equal(spec.includes(forbidden), false, forbidden);

  assert.equal(spec.includes('must change atomically'), false);

  for (const privacy of ["trace: 'off'", "video: 'off'", "screenshot: 'off'"]) {
    assert.ok(config.includes(privacy), privacy);
  }
  assert.ok(config.includes('production-trading-core-qa\\.spec\\.ts'));
  assert.ok(productionDeploy.includes("PRODUCTION_TRADING_CORE_PREPARE_POLICY: 'true'"));
  assert.ok(productionDeploy.includes('Prepare safe member ALL4 policy and run Focused Trading Core Production QA'));
});
