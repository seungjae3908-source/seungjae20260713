const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildProductionPostdeployQaEvidence,
  verifyPostDeployMainLineage,
  isActiveProductionTradingGateRun,
  revalidateProductionTradingGateConflicts,
  assertAutomaticPositionIsolationReceipt,
  assertAutoLiveSignalReceipt,
} = require('./production-postdeploy-qa-evidence.cjs');

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
test('signal transport receipts reject legacy unbound schema and never accept fabricated producer invocation', () => {
  const receipt = { schemaVersion: 'production-auto-live-signal-source-v2', targetSha: SHA,
    productionDeployRunId: 42, canonicalValidation: true, handoffStatus: 'READY', handoffFresh: true,
    handoffEvaluatedAfterScheduleActivation: true, maximumAgeMinutes: 30, entryCount: 0,
    observedMarkets: [], entryShaMatch: null, entryResearchCodeShas: [], sourceTransportOnly: true,
    producerInvocationVerified: false, scheduleActive: true, scheduleEntryCount: 1,
    disableSentinelPresent: false, publicDataOnly: true, privateRequestCount: 0,
    financialMutationCount: 0, executionAuthority: 'NONE', realOrderSubmitted: false,
    secretValuesRecorded: false, accountValuesRecorded: false, ...ZERO };
  const context = { targetSha: SHA, productionDeployRunId: 42 };
  assert.doesNotThrow(() => assertAutoLiveSignalReceipt(receipt, context));
  assert.throws(() => assertAutoLiveSignalReceipt({ ...receipt,
    schemaVersion: 'production-auto-live-signal-source-v1' }, context), /SIGNAL_INVALID/);
  assert.throws(() => assertAutoLiveSignalReceipt({ ...receipt,
    producerInvocationVerified: true }, context), /SIGNAL_IDENTITY_INVALID/);
  assert.throws(() => assertAutoLiveSignalReceipt({ ...receipt, entryCount: 1, entryShaMatch: true,
    entryResearchCodeShas: ['a'.repeat(40)], observedMarkets: ['KR_STOCK'] }, context), /SIGNAL_IDENTITY_INVALID/);
});
const { REQUIRED_CHECKS, ADDITIONAL_CONTROLS } = require('./automatic-live-preactivation-audit.cjs');
// Synthetic unit evidence only; this fixture must never be emitted as a runtime receipt.
function memberAccountSignalFixture() {
  return {
    schemaVersion: 'automatic-live-preactivation-audit-v1', targetSha: SHA,
    generatedAt: '2026-10-04T00:01:30.000Z', scope: 'MEMBER_ACCOUNT_AND_SIGNAL_READONLY_REHEARSAL',
    ready: true, activationReady: false,
    checks: REQUIRED_CHECKS.map((id) => ({ id, status: 'PASS', codes: [] })),
    additionalRequiredControls: [...ADDITIONAL_CONTROLS], paperOutOfScope: true, telegramOutOfScope: true,
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    liveTradingAuthorityGrantedByAudit: false, autoTradingAuthorityGrantedByAudit: false,
  };
}

test('AUTO isolation proof protects existing manual assets and rejects absent, mixed or mutating evidence', () => {
  const account = fixture().account;
  account.providers.find((row) => row.provider === 'toss').automaticPositionIsolation.manualProtectedPositionCount = 1;
  account.providers.find((row) => row.provider === 'upbit').automaticPositionIsolation.manualProtectedPositionCount = 2;
  assert.doesNotThrow(() => assertAutomaticPositionIsolationReceipt(account));
  for (const [key, invalid] of [ ['ready', false], ['manualEntryBlocked', false], ['canonicalExitOnly', false],
    ['ambiguousPositionCount', 1], ['manualProtectedPositionCount', -1], ['orderRequests', 1],
    ['autoTradingAuthorityGranted', true], ['policyVersion', 'old-unscoped'] ]) {
    const bad = structuredClone(account);
    bad.providers[0].automaticPositionIsolation[key] = invalid;
    assert.throws(() => assertAutomaticPositionIsolationReceipt(bad), /POSITION_ISOLATION/);
  }
  const old = structuredClone(account);
  delete old.providers[0].automaticPositionIsolation;
  assert.throws(() => assertAutomaticPositionIsolationReceipt(old), /POSITION_ISOLATION/);
});

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
        automaticPositionIsolation: { ok: true, provider, policyVersion: 'manual-protected-auto-ledger-v1',
          ready: true, fresh: true, manualEntryBlocked: true, canonicalExitOnly: true,
          manualProtectedPositionCount: 0, automaticOwnedPositionCount: 0, ambiguousPositionCount: 0, ...ZERO },
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
      mainAncestorVerified: true,
      mainAdvancedAfterDeployment: false,
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

test('only executing Trading Gate workflows block post-deploy QA; PR checks are not authority', () => {
  assert.equal(isActiveProductionTradingGateRun({event:'pull_request', status:'in_progress'}), false);
  assert.equal(isActiveProductionTradingGateRun({event:'push', status:'queued'}), false);
  assert.equal(isActiveProductionTradingGateRun({event:'issue_comment', status:'waiting'}), true);
  assert.equal(isActiveProductionTradingGateRun({event:'issue_comment', status:'in_progress'}), true);
  assert.equal(isActiveProductionTradingGateRun({event:'workflow_dispatch', status:'queued'}), true);
  assert.equal(isActiveProductionTradingGateRun({event:'workflow_dispatch', status:'in_progress'}), true);
  assert.equal(isActiveProductionTradingGateRun({event:'pull_request', status:'waiting'}), false);
  assert.equal(isActiveProductionTradingGateRun({event:'issue_comment', status:'completed', conclusion:'failure'}), false);
  assert.equal(isActiveProductionTradingGateRun({event:'issue_comment', status:'completed'}), false);
});
test('transient non-command Issue runs are revalidated while a persistent Trading Gate remains blocking', async () => {
  const slept = [];
  const transient = await revalidateProductionTradingGateConflicts(
    [{id: 101, event:'issue_comment', status:'in_progress'}],
    {
      stabilizationMs: 10_000,
      sleep: async (milliseconds) => slept.push(milliseconds),
      loadRun: async () => ({id: 101, event:'issue_comment', status:'completed', conclusion:'skipped'}),
    },
  );
  assert.deepEqual(transient, []);
  assert.deepEqual(slept, [10_000]);

  const persistent = await revalidateProductionTradingGateConflicts(
    [{id: 202, event:'issue_comment', status:'waiting'}],
    {
      sleep: async () => {},
      loadRun: async () => ({id: 202, event:'issue_comment', status:'waiting'}),
    },
  );
  assert.deepEqual(persistent, [{id: 202, event:'issue_comment', status:'waiting'}]);
});
test('Gate revalidation does not sleep or call GitHub when no authority-capable run is active', async () => {
  let called = false;
  const result = await revalidateProductionTradingGateConflicts(
    [{id: 303, event:'pull_request', status:'in_progress'}],
    {
      sleep: async () => { called = true; },
      loadRun: async () => { called = true; },
    },
  );
  assert.deepEqual(result, []);
  assert.equal(called, false);
});
test('postdeploy main movement requires proven fast-forward ancestry, not a forced or diverged SHA', () => {
  const laterSha = 'c'.repeat(40);
  assert.deepEqual(verifyPostDeployMainLineage({ targetSha: SHA, currentMainSha: SHA }), {
    mainSha: SHA, mainAncestorVerified: true, mainAdvancedAfterDeployment: false,
  });
  const valid = {
    status: 'ahead', ahead_by: 1, behind_by: 0,
    base_commit: { sha: SHA }, merge_base_commit: { sha: SHA },
  };
  assert.deepEqual(verifyPostDeployMainLineage({ targetSha: SHA, currentMainSha: laterSha, comparison: valid }), {
    mainSha: laterSha, mainAncestorVerified: true, mainAdvancedAfterDeployment: true,
  });
  for (const comparison of [
    null, { ...valid, status: 'diverged' },
    { ...valid, behind_by: 1 },
    { ...valid, merge_base_commit: { sha: laterSha } },
    { ...valid, base_commit: { sha: laterSha } },
    { ...valid, ahead_by: 0 },
  ]) {
    assert.throws(
      () => verifyPostDeployMainLineage({ targetSha: SHA, currentMainSha: laterSha, comparison }),
      /POSTDEPLOY_CONTEXT_MAIN_NOT_FORWARD_DESCENDANT/,
    );
  }
});

test('forward-only main advancement does not falsify the deployed SHA or bypass context proof', () => {
  const input = fixture();
  const laterSha = 'c'.repeat(40);
  input.context.mainSha = laterSha;
  input.context.mainAncestorVerified = true;
  input.context.mainAdvancedAfterDeployment = true;
  const receipt = buildProductionPostdeployQaEvidence(input);
  assert.equal(receipt.mainSha, laterSha);
  assert.equal(receipt.productionSha, SHA);
  assert.equal(receipt.mainAdvancedAfterDeployment, true);
  input.context.mainAncestorVerified = false;
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /MAIN_LINEAGE_UNVERIFIED/);
  input.context.mainAncestorVerified = true;
  input.context.mainAdvancedAfterDeployment = false;
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /MAIN_LINEAGE_UNVERIFIED/);
  input.context.mainAdvancedAfterDeployment = true;
  input.context.processDeploySha = laterSha;
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /PROCESS_SHA_MISMATCH/);
});
test('builds ACTIVATION_READY only from exact-SHA zero-authority evidence', () => {
  const evidence = buildProductionPostdeployQaEvidence(fixture());
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.credentialReuse, '4/4 PASS');
  assert.equal(evidence.activeConflictingTradingGates, 0);
  assert.equal(evidence.realOrderSubmitted, false);
  assert.equal(evidence.schemaVersion, 'production-postdeploy-activation-ready-v4');
  assert.equal(evidence.bitgetAdministratorLeveragePolicy, '2-7');
  assert.equal(evidence.bitgetMemberLeveragePolicy, '2-3');
  assert.equal(evidence.qaScope, 'full');
  assert.equal(evidence.comprehensiveQa, 'PASS');
  assert.equal(evidence.tradingCoreQa, 'NOT_RUN');
});

test('builds ACTIVATION_READY inside the same approved in-progress Production Deploy job', () => {
  const input = fixture();
  Object.assign(input.context, {
    deploymentVerificationMode: 'inline-approved-job',
    productionDeployStatus: 'in_progress',
    productionDeployConclusion: null,
    latestSuccessfulDeploySha: null,
    latestSuccessfulDeployRunId: null,
  });
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.schemaVersion, 'production-postdeploy-activation-ready-v4');
});

test('builds Trading Core ACTIVATION_READY without unrelated Comprehensive receipt', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v4',
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
    memberAutoLivePilotReady: true,
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
  assert.equal(evidence.memberAutoLivePilotReady, true);
  assert.equal(evidence.memberAutoPilotStage, 'validated');
});

test('AUTO-only subset can complete QA without Paper/Telegram but cannot grant overall activation readiness', () => {
  const input = fixture();
  input.qaScope = 'auto_live';
  input.comprehensive = null;
  input.autoLive = {
    schemaVersion: 'production-auto-live-readonly-qa-v3',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    identityMatch: true,
    memberAccountSignalAudit: memberAccountSignalFixture(),
    viewports: ['desktop-1440', 'tablet-1024', 'mobile-390'],
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    markets: {
      domestic_stock: 'PASS', us_stock: 'PASS', crypto_spot: 'PASS', crypto_futures: 'PASS',
    },
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 7,
    memberAutoPilotStage: 'formula-ai-exception',
    memberAutoLivePilotReady: true,
    providerVerificationFresh: true,
    marketReadinessBlockersOnlyExpectedPreactivation: true,
    workerPreactivationSafe: true,
    workerEnabled: false,
    liveBackgroundRequested: false,
    liveEntryArmPresent: false,
    liveEntriesArmed: false,
    pendingOrderCount: 0,
    recoveryRequiredOrderCount: 0,
    statusRequestOrderSubmissionCount: 0,
    paperTrading: 'OUT_OF_SCOPE',
    telegram: 'OUT_OF_SCOPE',
    paperRequests: 0,
    telegramRequests: 0,
    observedMutationRequests: 0,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  input.autoLiveSignal = {
    schemaVersion: 'production-auto-live-signal-source-v2',
    targetSha: SHA,
    productionDeployRunId: 42,
    generatedAt: '2026-10-04T00:02:30.000Z',
    canonicalValidation: true,
    handoffStatus: 'READY',
    handoffFresh: true,
    handoffEvaluatedAfterScheduleActivation: true,
    maximumAgeMinutes: 30,
    entryCount: 0,
    observedMarkets: [],
    entryShaMatch: null, entryResearchCodeShas: [], sourceTransportOnly: true, producerInvocationVerified: false,
    scheduleActive: true,
    scheduleEntryCount: 1,
    disableSentinelPresent: false,
    publicDataOnly: true,
    privateRequestCount: 0,
    financialMutationCount: 0,
    executionAuthority: 'NONE',
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    realOrderSubmitted: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.qaComplete, true);
  assert.equal(evidence.activationReady, false);
  assert.equal(evidence.automaticLiveActivationReady, false);
  assert.deepEqual(evidence.unprovenAutomaticLiveControls, [
    ...input.autoLive.memberAccountSignalAudit.additionalRequiredControls,
    'SCANNER_PRODUCER_CONNECTED', 'AI_PRODUCER_CONNECTED', 'STRATEGY_EXECUTION_LINKAGE']);
  assert.equal(evidence.qaScope, 'auto_live');
  assert.equal(evidence.autoLiveQa, 'PASS');
  assert.equal(evidence.comprehensiveQa, 'NOT_RUN');
  assert.equal(evidence.tradingCoreQa, 'NOT_RUN');
  assert.equal(evidence.memberAutoPolicyReady, true);
  assert.equal(evidence.memberAutoLivePilotReady, true);
  assert.equal(evidence.autoLiveSignalTransport, 'PASS');
  assert.equal(evidence.canonicalAutoLiveSignalSource, 'NOT_PROVEN');
  assert.equal(evidence.telegramActivationState, 'NOT_EVALUATED');
  const missing = structuredClone(input);
  delete missing.autoLive.memberAccountSignalAudit;
  assert.throws(() => buildProductionPostdeployQaEvidence(missing), /MEMBER_SIGNAL_AUDIT_INVALID/);
  const disconnected = structuredClone(input);
  const producer = disconnected.autoLive.memberAccountSignalAudit.checks
    .find((row) => row.id === 'GENUINE_SCANNER_AND_AI_CONNECTION');
  producer.status = 'BLOCKED';
  producer.codes = ['PREACTIVATION_SCANNER_AI_PRODUCER_BINDING_NOT_PROVEN'];
  assert.throws(() => buildProductionPostdeployQaEvidence(disconnected), /MEMBER_SIGNAL_AUDIT_INVALID/);
});

test('rejects Automatic LIVE evidence when the canonical signal schedule is not active', () => {
  const input = fixture();
  input.qaScope = 'auto_live';
  input.comprehensive = null;
  input.autoLive = {
    schemaVersion: 'production-auto-live-readonly-qa-v3', targetSha: SHA,
    productionDeployRunId: 42, generatedAt: '2026-10-04T00:02:00.000Z',
    officialProductionOrigin: true, authenticatedProductionSession: true, identityMatch: true,
    memberAccountSignalAudit: memberAccountSignalFixture(),
    viewports: ['desktop-1440', 'tablet-1024', 'mobile-390'],
    providers: Object.fromEntries(providers.map((provider) => [provider, 'PASS'])),
    markets: { domestic_stock: 'PASS', us_stock: 'PASS', crypto_spot: 'PASS', crypto_futures: 'PASS' },
    memberAutoPolicyReady: true, memberAutoPolicyBlockers: [], memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 7, memberAutoPilotStage: 'formula-ai-exception', memberAutoLivePilotReady: true,
    providerVerificationFresh: true, marketReadinessBlockersOnlyExpectedPreactivation: true,
    workerPreactivationSafe: true, workerEnabled: false, liveBackgroundRequested: false,
    liveEntryArmPresent: false, liveEntriesArmed: false, pendingOrderCount: 0,
    recoveryRequiredOrderCount: 0, statusRequestOrderSubmissionCount: 0,
    paperTrading: 'OUT_OF_SCOPE', telegram: 'OUT_OF_SCOPE', paperRequests: 0, telegramRequests: 0,
    observedMutationRequests: 0, realOrderSubmitted: false, secretValuesRecorded: false,
    accountValuesRecorded: false, ...ZERO,
  };
  input.autoLiveSignal = {
    schemaVersion: 'production-auto-live-signal-source-v2', targetSha: SHA,
    productionDeployRunId: 42, generatedAt: '2026-10-04T00:02:30.000Z',
    canonicalValidation: true, handoffStatus: 'READY', handoffFresh: true,
    handoffEvaluatedAfterScheduleActivation: true,
    maximumAgeMinutes: 30, entryCount: 0, observedMarkets: [], scheduleActive: false,
    entryShaMatch: null, entryResearchCodeShas: [], sourceTransportOnly: true, producerInvocationVerified: false,
    scheduleEntryCount: 0, disableSentinelPresent: false, publicDataOnly: true,
    privateRequestCount: 0, financialMutationCount: 0, executionAuthority: 'NONE',
    secretValuesRecorded: false, accountValuesRecorded: false, realOrderSubmitted: false, ...ZERO,
  };
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /AUTO_LIVE_SIGNAL_INVALID/);
});

test('Trading Core evidence may be core-ready while live pilot remains intentionally unprepared', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v4',
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
    memberAutoPilotStage: 'approval-20',
    memberAutoLivePilotReady: false,
    policyRestored: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  const evidence = buildProductionPostdeployQaEvidence(input);
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.memberAutoPolicyReady, true);
  assert.equal(evidence.memberAutoLivePilotReady, false);
  assert.equal(evidence.memberAutoPilotStage, 'approval-20');
});

test('builds preactivation evidence before Telegram workers are enabled', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v4',
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
    memberAutoLivePilotReady: true,
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

test('rejects Trading Core evidence when the restored member policy is not activation-ready', () => {
  const input = fixture();
  input.qaScope = 'trading_core';
  input.comprehensive = null;
  input.tradingCore = {
    schemaVersion: 'production-trading-core-qa-v4',
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
    memberAutoLivePilotReady: true,
    realOrderSubmitted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    ...ZERO,
  };
  assert.throws(() => buildProductionPostdeployQaEvidence(input), /TRADING_CORE_INVALID/);
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
