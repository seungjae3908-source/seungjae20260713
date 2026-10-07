const assert = require('node:assert/strict');
const test = require('node:test');
const { buildProductionPostdeployQaEvidence } = require('./production-postdeploy-qa-evidence.cjs');

const SHA = 'b'.repeat(40);
const ZERO = {
  orderRequests: 0,
  cancelRequests: 0,
  amendRequests: 0,
  transferRequests: 0,
  withdrawalRequests: 0,
  liveTradingAuthorityGranted: false,
  autoTradingAuthorityGranted: false,
};
const providers = ['bitget', 'kiwoom', 'toss', 'upbit'];

function fixture() {
  return {
    targetSha: SHA,
    productionDeployRunId: 42,
    qaScope: 'full',
    comprehensive: {
      schemaVersion: 'production-comprehensive-readonly-qa-v1',
      targetSha: SHA,
      productionDeployRunId: 42,
      generatedAt: '2026-10-04T00:02:00.000Z',
      complete: true,
      identityMatch: true,
      secretValuesRecorded: false,
      realOrderSubmitted: false,
      recommendationsDesktop1440: { loadMs: 250, fallbackTimedOut: false, busyAfter5s: 0 },
      ...ZERO,
    },
    account: {
      schemaVersion: 'production-account-readonly-live-qa-v3',
      targetSha: SHA,
      productionDeployRunId: 42,
      generatedAt: '2026-10-04T00:03:00.000Z',
      officialProductionOrigin: true,
      authenticatedProductionSession: true,
      credentialVaultEncryptionConfigured: true,
      secretValuesRecorded: false,
      accountValuesRecorded: false,
      blockedMutationRequests: 0,
      observedAppMutationRequests: 0,
      realOrderSubmitted: false,
      testedProviders: providers,
      providers: providers.map((provider) => ({
        provider, connected: true, status: 'CONNECTED', stale: false, fresh: true,
        errorCode: null, checkedAtPresent: true, lastGoodAtPresent: true,
        reconciliation: 'PASS', reconciliationPassed: true, openOrderCount: 0,
      })),
      safetyCounters: {
        openOrderCount: 0,
        orphanOrderCount: 0,
        activeLocalOrderCount: 0,
        staleLocalOrderCount: 0,
        duplicateClientOrderIdCount: 0,
        stalePlanCount: 0,
        bitgetActivePositionCount: 0,
        oppositePositionDuplicateCount: 0,
        nonIsolatedPositionCount: 0,
        outOfPolicyLeveragePositionCount: 0,
        liquidationRiskPositionCount: 0,
      },
      bitgetPositionMode: 'one_way_mode',
      ...ZERO,
    },
    credential: {
      schemaVersion: 'production-live-credential-reuse-qa-v1',
      targetSha: SHA,
      productionDeployRunId: 42,
      generatedAt: '2026-10-04T00:04:00.000Z',
      officialProductionOrigin: true,
      authenticatedProductionSession: true,
      credentialsReturned: false,
      secretValuesRecorded: false,
      accountValuesRecorded: false,
      realOrderSubmitted: false,
      observedCredentialConnectionMutations: providers.length,
      observedMutationPaths: providers.map((provider) => ({
        method: 'POST',
        path: `/api/trade-automation/connections/${provider}/reuse-readonly`,
      })),
      providers: providers.map((provider) => ({
        provider, configured: true, verified: true, reusedReadonlyCredential: true,
        credentialsReturned: false, liveExecutionActivated: false,
        automaticLiveExecutionActivated: false, realOrderSubmitted: false,
        ...ZERO,
      })),
      ...ZERO,
    },
    context: {
      schemaVersion: 'production-postdeploy-context-v2',
      deploymentVerificationMode: 'completed-successful-run',
      mainSha: SHA,
      productionDeploySha: SHA,
      processDeploySha: SHA,
      deployMarkerSha: SHA,
      latestSuccessfulDeploySha: SHA,
      latestSuccessfulDeployRunId: 42,
      productionDeployRunId: 42,
      productionDeployHeadSha: SHA,
      productionDeployStatus: 'completed',
      productionDeployConclusion: 'success',
      deploymentStepSucceeded: true,
      deploymentSafetyVerified: true,
      identityMatch: true,
      productionDeployCompletedAt: '2026-10-04T00:00:00.000Z',
      orchestratorStartedAt: '2026-10-04T00:01:00.000Z',
      activeConflictingTradingGates: [],
    },
  };
}

test('full QA remains deployment-safe but is not sufficient for automatic activation', () => {
  const evidence = buildProductionPostdeployQaEvidence(fixture());
  assert.equal(evidence.activationReady, false);
  assert.equal(evidence.credentialReuse, '4/4 PASS');
  assert.equal(evidence.activeConflictingTradingGates, 0);
  assert.equal(evidence.realOrderSubmitted, false);
  assert.equal(evidence.schemaVersion, 'production-postdeploy-activation-ready-v4');
  assert.equal(evidence.qaScope, 'full');
  assert.equal(evidence.comprehensiveQa, 'PASS');
  assert.equal(evidence.tradingCoreQa, 'NOT_RUN');
});

test('inline full QA remains non-activating even inside the approved Production Deploy job', () => {
  const input = fixture();
  Object.assign(input.context, {
    deploymentVerificationMode: 'inline-approved-job',
    productionDeployStatus: 'in_progress',
    productionDeployConclusion: null,
    latestSuccessfulDeploySha: null,
    latestSuccessfulDeployRunId: null,
  });
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, false);
  assert.equal(evidence.schemaVersion, 'production-postdeploy-activation-ready-v4');
});

test('builds Trading Core ACTIVATION_READY without unrelated Comprehensive receipt', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v5',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    paperAutomaticTriggered: true,
    paperFilled: true,
    journalVisible: true,
    executionSyncInserted: 1,
    telegramActivationState: 'ACTIVE_VERIFIED',
    telegramActivationReady: true,
    telegramUserConnectionRequired: false,
    telegramPersonalActivationRequired: false,
    telegramConnectedBefore: true,
    telegramRuntimeReady: true,
    telegramDeliveryQueued: 1,
    telegramTestDelivered: true,
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 7,
    memberAutoPilotStage: 'validated',
    backgroundWorkerSourceReady: true,
    backgroundWorkerReadinessBlockers: [],
    backgroundHandoffState: 'READY',
    backgroundEligibleMembers: 1,
    backgroundPaperAccountsReady: 1,
    memberAutoStrategyAllowlistReady: true,
    policyRestored: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.qaScope, 'trading_core');
  assert.equal(evidence.tradingCoreQa, 'PASS');
  assert.equal(evidence.comprehensiveQa, 'NOT_RUN');
  assert.equal(evidence.telegramActivationState, 'ACTIVE_VERIFIED');
  assert.equal(evidence.telegramActivationVerified, true);
  assert.equal(evidence.memberAutoPolicyReady, true);
});

test('builds preactivation evidence before Telegram workers are enabled', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v5',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    paperAutomaticTriggered: true,
    paperFilled: true,
    journalVisible: true,
    executionSyncInserted: 1,
    telegramActivationState: 'READY_FOR_ACTIVATION',
    telegramActivationReady: true,
    telegramUserConnectionRequired: true,
    telegramPersonalActivationRequired: true,
    telegramConnectedBefore: false,
    telegramRuntimeReady: false,
    telegramDeliveryQueued: 0,
    telegramTestDelivered: false,
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: 'toss',
    memberAutoBitgetLeverage: 2,
    memberAutoPilotStage: 'limited-50',
    backgroundWorkerSourceReady: true,
    backgroundWorkerReadinessBlockers: [],
    backgroundHandoffState: 'READY',
    backgroundEligibleMembers: 1,
    backgroundPaperAccountsReady: 1,
    memberAutoStrategyAllowlistReady: true,
    policyRestored: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.telegramActivationState, 'READY_FOR_ACTIVATION');
  assert.equal(evidence.telegramActivationReady, true);
  assert.equal(evidence.telegramActivationVerified, false);

  input.tradingCore.telegramRuntimeReady = true;
  assert.equal(buildProductionPostdeployQaEvidence(input).activationReady, true);

  input.tradingCore.telegramRuntimeReady = false;
  input.tradingCore.telegramConnectedBefore = true;
  input.tradingCore.telegramUserConnectionRequired = false;
  assert.equal(buildProductionPostdeployQaEvidence(input).activationReady, true);

  input.tradingCore.telegramRuntimeReady = true;
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /TRADING_CORE_INVALID/);
});

test('accepts safe Trading Core QA but keeps activation blocked when restored member policy is not ready', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v5',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    paperAutomaticTriggered: true,
    paperFilled: true,
    journalVisible: true,
    executionSyncInserted: 1,
    telegramActivationState: 'READY_FOR_ACTIVATION',
    telegramActivationReady: true,
    telegramUserConnectionRequired: true,
    telegramPersonalActivationRequired: true,
    telegramConnectedBefore: false,
    telegramRuntimeReady: false,
    telegramDeliveryQueued: 0,
    telegramTestDelivered: false,
    policyRestored: true,
    memberAutoPolicyReady: false,
    memberAutoPolicyBlockers: ['MEMBER_AUTOMATIC_DISABLED'],
    memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 2,
    memberAutoPilotStage: 'validated',
    backgroundWorkerSourceReady: true,
    backgroundWorkerReadinessBlockers: [],
    backgroundHandoffState: 'READY',
    backgroundEligibleMembers: 1,
    backgroundPaperAccountsReady: 1,
    memberAutoStrategyAllowlistReady: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, false);
  assert.equal(evidence.memberAutoPolicyReady, false);
});

test('keeps activation blocked when no explicit strategy allowlist exists', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v5',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    paperAutomaticTriggered: true,
    paperFilled: true,
    journalVisible: true,
    executionSyncInserted: 1,
    telegramActivationState: 'READY_FOR_ACTIVATION',
    telegramActivationReady: true,
    telegramUserConnectionRequired: true,
    telegramPersonalActivationRequired: true,
    telegramConnectedBefore: false,
    telegramRuntimeReady: false,
    telegramDeliveryQueued: 0,
    telegramTestDelivered: false,
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 2,
    memberAutoPilotStage: 'limited-50',
    backgroundWorkerSourceReady: true,
    backgroundWorkerReadinessBlockers: [],
    backgroundHandoffState: 'READY',
    backgroundEligibleMembers: 1,
    backgroundPaperAccountsReady: 1,
    memberAutoStrategyAllowlistReady: false,
    policyRestored: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, false);
  assert.equal(evidence.memberAutoStrategyAllowlistReady, false);
});

test('rejects any nonzero financial mutation counter', () => {
  const input = fixture();
  input.account.orderRequests = 1;
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /ORDERREQUESTS_NOT_ZERO/);
});

test('rejects active trading gate conflicts', () => {
  const input = fixture();
  input.context.activeConflictingTradingGates = [{ name: 'Production Live Trading Gate', id: 7 }];
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /ACTIVE_GATE_CONFLICT/);
});

test('rejects unsafe open, orphan, stale, duplicate, margin, leverage, or liquidation state', () => {
  for (const key of [
    'openOrderCount',
    'orphanOrderCount',
    'activeLocalOrderCount',
    'staleLocalOrderCount',
    'duplicateClientOrderIdCount',
    'stalePlanCount',
    'oppositePositionDuplicateCount',
    'nonIsolatedPositionCount',
    'outOfPolicyLeveragePositionCount',
    'liquidationRiskPositionCount',
  ]) {
    const input = fixture();
    input.account.safetyCounters[key] = 1;
    assert.throws(() => buildProductionPostdeployQaEvidence(input), /NOT_ZERO/);
  }
});

test('rejects Bitget hedge mode even when all counters are zero', () => {
  const input = fixture();
  input.account.bitgetPositionMode = 'hedge_mode';
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /BITGET_RUNTIME_POLICY_INVALID/);
});

test('rejects a receipt created before the current post-deploy orchestrator', () => {
  const input = fixture();
  input.credential.generatedAt = '2026-10-03T23:59:59.000Z';
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /CREDENTIAL_RECEIPT_NOT_FRESH/);
});

test('rejects credential reuse evidence containing any unexpected mutation route', () => {
  const input = fixture();
  input.credential.observedMutationPaths[0].path = '/api/trade-automation/orders';
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /CREDENTIAL_REUSE_PATH_SET_INVALID/);
});
