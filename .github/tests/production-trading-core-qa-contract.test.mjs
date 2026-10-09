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
    'telegramFillDeliveryConfirmed',
    'filledDeliveryIds',
    "'SENT'",
    'personalWorkerStarted',
    'workerActivationApproved',
    'PRODUCTION_TRADING_CORE_TELEGRAM_WORKER_NOT_READY',
    'memberAutoPolicyReadiness',
    'preparedMemberAutoPolicy',
    'memberAutoPolicyPrepared',
    'memberAutoResumePrepared',
    'PRODUCTION_TRADING_CORE_MEMBER_STOP_ACTIVE',
    'PRODUCTION_TRADING_CORE_CANARY_BUDGET_TOO_LOW',
    'PRODUCTION_TRADING_CORE_RISK_BASELINE_NOT_RESTORABLE',
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
    "/api/trade-automation/resume",
    "confirmation: 'RESUME_MEMBER_TRADING'",
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

test('Canary QA never bypasses member stops or changes irreversible risk guardrails', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  const start = spec.indexOf('    const qaPolicy = {');
  const end = spec.indexOf("    const saved = await appApi<any>(page, '/api/trade-automation/policy', 'PUT', qaPolicy);", start);
  assert.ok(start >= 0 && end > start, 'QA policy setup must be present');
  const policy = spec.slice(start, end);
  assert.ok(policy.includes('...originalPolicy'), 'Original risk ceilings/floors must be preserved');
  for (const irreversible of [
    'riskPerTradePercent:', 'totalDailyLossLimitPercent:', 'minProfitFactor:',
    'minExpectedValueR:', 'maxInstrumentKrw:', 'maxOrderKrw:',
    'maxStrategyDrawdownPercent:', 'maxAverageSpreadPercent:',
  ]) {
    assert.equal(policy.includes(irreversible), false, irreversible);
  }
  assert.ok(spec.includes('qaCapitalKrw: number = originalPolicy.totalCapitalKrw'));
  assert.ok(spec.includes('availableBalance: qaCapitalKrw'));
  assert.ok(spec.includes('POLICY_RESTORE_STATE_MISMATCH'));
  assert.ok(spec.includes('POLICY_STATE_MISMATCH'));
  assert.ok(spec.includes('isDeepStrictEqual(statusAfter.body?.policy, originalPolicy)'));
});

test('Trading Core ACTIVE_VERIFIED requires same-fill SENT receipt and started Telegram worker', () => {
  const bridge = read('api-server/src/features/user-broker-telegram/trade-execution-event-bridge.service.ts');
  const route = read('api-server/src/routes/user-broker-telegram.ts');
  const workflow = read('.github/workflows/production-trading-core-qa.yml');
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.ok(bridge.includes("event.type === 'ORDER_FILLED'"));
  assert.ok(bridge.includes('filledDeliveryIds.push(queuedId)'));
  assert.ok(bridge.includes('scopedToOrder: true as const, filledDeliveryIds'));
  assert.ok(route.includes('const personalWorkerHealth = readUserTelegramDeliveryWorkerHealth()'));
  assert.ok(route.includes('personalWorkerHealth.enabled === true'));
  assert.ok(route.includes("Date.parse(personalWorkerHealth.lastTickAt ?? '')"));
  assert.ok(route.includes('Date.now() - personalTickAt <= 360_000'));
  assert.ok(route.includes("workerActivationApproved: process.env.LIVE_TELEGRAM_ACTIVATION_APPROVED === 'true'"));
  assert.ok(spec.includes('delivery?.id === id'));
  assert.ok(spec.includes("delivery?.state === 'SENT'"));
  assert.ok(spec.includes('telegramFillDeliveryConfirmed = true'));
  assert.ok(workflow.includes("value?.telegramFillDeliveryConfirmed === true"));
  assert.ok(workflow.includes("value?.telegramFillDeliveryConfirmed === false"));
});

test('Trading Core Telegram receipt polling spans at least two default worker ticks', () => {
  const spec = read('stock-analyzer/e2e/production-trading-core-qa.spec.ts');
  assert.ok(spec.includes('test.setTimeout(4 * 60_000)'));
  assert.ok(spec.includes('timeout: 90_000'));
  assert.ok(spec.includes('telegramFillDeliveryConfirmed = true'));
});
