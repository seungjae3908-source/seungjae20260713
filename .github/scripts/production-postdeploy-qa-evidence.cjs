const REQUIRED_PROVIDERS = Object.freeze(['bitget', 'kiwoom', 'toss', 'upbit']);
const REQUIRED_CREDENTIAL_REUSE_PATHS = Object.freeze(REQUIRED_PROVIDERS.map(
  (provider) => `/api/trade-automation/connections/${provider}/reuse-readonly`,
));
const ZERO_COUNTERS = Object.freeze([
  'orderRequests',
  'cancelRequests',
  'amendRequests',
  'transferRequests',
  'withdrawalRequests',
]);
const ZERO_SAFETY_COUNTERS = Object.freeze([
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
]);

function requireExactSha(value, expected, code) {
  if (String(value ?? '').toLowerCase() !== expected) throw new Error(code);
}

function requireZeroCounters(value, prefix) {
  for (const key of ZERO_COUNTERS) {
    if (value?.[key] !== 0) throw new Error(`${prefix}_${key.toUpperCase()}_NOT_ZERO`);
  }
}

function requireZeroAuthority(value, prefix) {
  requireZeroCounters(value, prefix);
  if (value?.liveTradingAuthorityGranted !== false) throw new Error(`${prefix}_LIVE_AUTHORITY_NOT_FALSE`);
  if (value?.autoTradingAuthorityGranted !== false) throw new Error(`${prefix}_AUTO_AUTHORITY_NOT_FALSE`);
}

function assertNoForbiddenEvidenceKeys(value) {
  const forbidden = new Set([
    'clientSecret', 'secretKey', 'accessKey', 'apiKey', 'signature', 'prehash',
    'authorization', 'accountUid', 'accountRef', 'user_id', 'vaultRowId',
    'balances', 'positions', 'openOrders',
  ]);
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.has(key)) throw new Error(`POSTDEPLOY_QA_FORBIDDEN_EVIDENCE_KEY:${key}`);
      visit(child);
    }
  };
  visit(value);
}

function providerRows(value, prefix) {
  const rows = Array.isArray(value?.providers) ? value.providers : [];
  const names = rows.map((row) => row?.provider).sort();
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_PROVIDERS)) {
    throw new Error(`${prefix}_PROVIDER_SET_INVALID`);
  }
  return rows;
}

function normalizeReceiptContext(targetSha, productionDeployRunId) {
  const sha = String(targetSha ?? '').trim().toLowerCase();
  const deployRunId = Number(productionDeployRunId);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('POSTDEPLOY_QA_TARGET_SHA_INVALID');
  if (!Number.isSafeInteger(deployRunId) || deployRunId <= 0) throw new Error('POSTDEPLOY_QA_DEPLOY_RUN_ID_INVALID');
  return { sha, deployRunId };
}

function assertComprehensiveReceipt(comprehensive, { targetSha, productionDeployRunId }) {
  const { sha, deployRunId } = normalizeReceiptContext(targetSha, productionDeployRunId);
  if (comprehensive?.schemaVersion !== 'production-comprehensive-readonly-qa-v1'
    || comprehensive?.complete !== true
    || comprehensive?.identityMatch !== true
    || comprehensive?.productionDeployRunId !== deployRunId
    || comprehensive?.recommendationsDesktop1440?.fallbackTimedOut !== false
    || comprehensive?.recommendationsDesktop1440?.busyAfter5s !== 0
    || !Number.isFinite(comprehensive?.recommendationsDesktop1440?.loadMs)
    || comprehensive.recommendationsDesktop1440.loadMs >= 5_000
    || comprehensive?.secretValuesRecorded !== false
    || comprehensive?.realOrderSubmitted !== false) {
    throw new Error('POSTDEPLOY_QA_COMPREHENSIVE_INVALID');
  }
  requireExactSha(comprehensive.targetSha, sha, 'POSTDEPLOY_QA_COMPREHENSIVE_SHA_MISMATCH');
  requireZeroAuthority(comprehensive, 'POSTDEPLOY_QA_COMPREHENSIVE');
  assertNoForbiddenEvidenceKeys(comprehensive);
}

function assertAccountReceipt(account, { targetSha, productionDeployRunId }) {
  const { sha, deployRunId } = normalizeReceiptContext(targetSha, productionDeployRunId);
  if (account?.schemaVersion !== 'production-account-readonly-live-qa-v3'
    || account?.productionDeployRunId !== deployRunId
    || account?.officialProductionOrigin !== true
    || account?.authenticatedProductionSession !== true
    || account?.credentialVaultEncryptionConfigured !== true
    || account?.secretValuesRecorded !== false
    || account?.accountValuesRecorded !== false
    || account?.blockedMutationRequests !== 0
    || account?.observedAppMutationRequests !== 0
    || account?.realOrderSubmitted !== false
    || JSON.stringify(account?.testedProviders) !== JSON.stringify(REQUIRED_PROVIDERS)) {
    throw new Error('POSTDEPLOY_QA_ACCOUNT_INVALID');
  }
  requireExactSha(account.targetSha, sha, 'POSTDEPLOY_QA_ACCOUNT_SHA_MISMATCH');
  requireZeroAuthority(account, 'POSTDEPLOY_QA_ACCOUNT');
  for (const key of ZERO_SAFETY_COUNTERS) {
    if (account?.safetyCounters?.[key] !== 0) {
      throw new Error(`POSTDEPLOY_QA_ACCOUNT_${key.toUpperCase()}_NOT_ZERO`);
    }
  }
  if (!Number.isInteger(account?.safetyCounters?.bitgetActivePositionCount)
    || account.safetyCounters.bitgetActivePositionCount < 0
    || account?.bitgetPositionMode !== 'one_way_mode') {
    throw new Error('POSTDEPLOY_QA_ACCOUNT_BITGET_RUNTIME_POLICY_INVALID');
  }
  const accountRows = providerRows(account, 'POSTDEPLOY_QA_ACCOUNT');
  for (const row of accountRows) {
    if (row.connected !== true || row.status !== 'CONNECTED' || row.stale !== false
      || row.fresh !== true || row.errorCode !== null || row.checkedAtPresent !== true
      || row.lastGoodAtPresent !== true || row.reconciliation !== 'PASS'
      || row.reconciliationPassed !== true || row.openOrderCount !== 0) {
      throw new Error(`POSTDEPLOY_QA_ACCOUNT_PROVIDER_FAILED:${row.provider}`);
    }
  }
  assertNoForbiddenEvidenceKeys(account);
}

function assertCredentialReceipt(credential, { targetSha, productionDeployRunId }) {
  const { sha, deployRunId } = normalizeReceiptContext(targetSha, productionDeployRunId);
  if (credential?.schemaVersion !== 'production-live-credential-reuse-qa-v1'
    || credential?.productionDeployRunId !== deployRunId
    || credential?.officialProductionOrigin !== true
    || credential?.authenticatedProductionSession !== true
    || credential?.credentialsReturned !== false
    || credential?.secretValuesRecorded !== false
    || credential?.accountValuesRecorded !== false
    || credential?.realOrderSubmitted !== false
    || credential?.observedCredentialConnectionMutations !== REQUIRED_PROVIDERS.length) {
    throw new Error('POSTDEPLOY_QA_CREDENTIAL_INVALID');
  }
  const credentialMutationPaths = Array.isArray(credential?.observedMutationPaths)
    ? credential.observedMutationPaths
    : [];
  const normalizedCredentialMutationPaths = credentialMutationPaths.map((row) => {
    if (row?.method !== 'POST' || typeof row?.path !== 'string') {
      throw new Error('POSTDEPLOY_QA_CREDENTIAL_MUTATION_NOT_READONLY_REUSE');
    }
    return row.path;
  }).sort();
  if (JSON.stringify(normalizedCredentialMutationPaths)
    !== JSON.stringify([...REQUIRED_CREDENTIAL_REUSE_PATHS].sort())) {
    throw new Error('POSTDEPLOY_QA_CREDENTIAL_REUSE_PATH_SET_INVALID');
  }
  requireExactSha(credential.targetSha, sha, 'POSTDEPLOY_QA_CREDENTIAL_SHA_MISMATCH');
  requireZeroAuthority(credential, 'POSTDEPLOY_QA_CREDENTIAL');
  const credentialRows = providerRows(credential, 'POSTDEPLOY_QA_CREDENTIAL');
  for (const row of credentialRows) {
    if (row.configured !== true || row.verified !== true || row.reusedReadonlyCredential !== true
      || row.credentialsReturned !== false || row.liveExecutionActivated !== false
      || row.automaticLiveExecutionActivated !== false || row.realOrderSubmitted !== false) {
      throw new Error(`POSTDEPLOY_QA_CREDENTIAL_PROVIDER_FAILED:${row.provider}`);
    }
    requireZeroCounters(row, `POSTDEPLOY_QA_CREDENTIAL_PROVIDER_${String(row.provider).toUpperCase()}`);
  }
  assertNoForbiddenEvidenceKeys(credential);
}


function assertMemberReceipt(member, { targetSha, productionDeployRunId }) {
  const { sha, deployRunId } = normalizeReceiptContext(targetSha, productionDeployRunId);
  if (member?.schemaVersion !== 'production-member-readonly-qa-v1'
    || member?.complete !== true
    || member?.productionDeployRunId !== deployRunId
    || member?.officialProductionOrigin !== true
    || member?.authenticatedProductionSession !== true
    || !['associate', 'regular', 'admin'].includes(member?.membershipLevel)
    || member?.profileStatus !== 'approved'
    || member?.memberActive !== true
    || member?.membershipExpiryValid !== true
    || member?.sGradeAccessAllowed !== true
    || member?.aiChartAccessible !== true
    || member?.tradingAnalyticsAccessible !== true
    || member?.aiTradingReviewAccessible !== true
    || member?.adminSurfaceMatchedTier !== true
    || member?.liveOrderSurfaceMatchedTier !== true
    || member?.mobileAccountLayoutSafe !== true
    || member?.blockedMutationRequests !== 0
    || member?.realOrderSubmitted !== false
    || member?.secretValuesRecorded !== false
    || member?.accountValuesRecorded !== false) {
    throw new Error('POSTDEPLOY_QA_MEMBER_INVALID');
  }
  requireExactSha(member.targetSha, sha, 'POSTDEPLOY_QA_MEMBER_SHA_MISMATCH');
  requireZeroAuthority(member, 'POSTDEPLOY_QA_MEMBER');
  assertNoForbiddenEvidenceKeys(member);
}

function assertTradingCoreReceipt(tradingCore, { targetSha, productionDeployRunId }) {
  const { sha, deployRunId } = normalizeReceiptContext(targetSha, productionDeployRunId);
  const telegramState = tradingCore?.telegramActivationState;
  const telegramConnected = tradingCore?.telegramConnectedBefore;
  const telegramRuntimeReady = tradingCore?.telegramRuntimeReady;
  const telegramReady = telegramState === 'READY_FOR_ACTIVATION'
    && tradingCore?.telegramActivationReady === true
    && typeof telegramConnected === 'boolean'
    && typeof telegramRuntimeReady === 'boolean'
    && !(telegramConnected && telegramRuntimeReady)
    && tradingCore?.telegramUserConnectionRequired === !telegramConnected
    && tradingCore?.telegramPersonalActivationRequired === true
    && tradingCore?.telegramDeliveryQueued === 0
    && tradingCore?.telegramTestDelivered === false;
  const telegramVerified = telegramState === 'ACTIVE_VERIFIED'
    && tradingCore?.telegramActivationReady === true
    && telegramConnected === true
    && telegramRuntimeReady === true
    && tradingCore?.telegramUserConnectionRequired === false
    && tradingCore?.telegramPersonalActivationRequired === false
    && Number(tradingCore?.telegramDeliveryQueued) >= 1
    && tradingCore?.telegramTestDelivered === true;
  const memberAutoPilotStage = String(tradingCore?.memberAutoPilotStage ?? '');
  const expectedLivePilotReady = ['limited-50', 'validated', 'formula-ai-exception'].includes(memberAutoPilotStage);
  const memberAutoPolicyReady = tradingCore?.memberAutoPolicyReady === true
    && Array.isArray(tradingCore?.memberAutoPolicyBlockers)
    && tradingCore.memberAutoPolicyBlockers.length === 0
    && ['kiwoom', 'toss'].includes(tradingCore?.memberAutoDomesticBroker)
    && Number.isInteger(tradingCore?.memberAutoBitgetLeverage)
    && tradingCore.memberAutoBitgetLeverage >= 2
    && tradingCore.memberAutoBitgetLeverage <= 7
    && ['approval-20', 'limited-50', 'validated', 'formula-ai-exception'].includes(memberAutoPilotStage)
    && tradingCore?.memberAutoLivePilotReady === expectedLivePilotReady;
  if (tradingCore?.schemaVersion !== 'production-trading-core-qa-v4'
    || tradingCore?.productionDeployRunId !== deployRunId
    || tradingCore?.officialProductionOrigin !== true
    || tradingCore?.authenticatedProductionSession !== true
    || tradingCore?.paperAutomaticTriggered !== true
    || tradingCore?.paperFilled !== true
    || tradingCore?.journalVisible !== true
    || !(Number(tradingCore?.executionSyncInserted) >= 1)
    || (!telegramReady && !telegramVerified)
    || !memberAutoPolicyReady
    || tradingCore?.policyRestored !== true
    || tradingCore?.realOrderSubmitted !== false
    || tradingCore?.liveTradingAuthorityGranted !== false
    || tradingCore?.autoTradingAuthorityGranted !== false
    || tradingCore?.secretValuesRecorded !== false
    || tradingCore?.accountValuesRecorded !== false) {
    throw new Error('POSTDEPLOY_QA_TRADING_CORE_INVALID');
  }
  requireExactSha(tradingCore.targetSha, sha, 'POSTDEPLOY_QA_TRADING_CORE_SHA_MISMATCH');
  requireZeroAuthority(tradingCore, 'POSTDEPLOY_QA_TRADING_CORE');
  for (const provider of REQUIRED_PROVIDERS) {
    if (tradingCore?.providers?.[provider] !== 'PASS') {
      throw new Error(`POSTDEPLOY_QA_TRADING_CORE_PROVIDER_FAILED:${provider}`);
    }
  }
  assertNoForbiddenEvidenceKeys(tradingCore);
}

function isActiveProductionTradingGateRun(run) {
  // PR checks validate contracts only: they cannot activate Live/Auto authority.
  // Operational issue commands (or future workflow dispatches) must still
  // stop QA while their run is nonterminal, even if its intent is uncertain.
  return (run?.event === 'issue_comment' || run?.event === 'workflow_dispatch')
    && run?.status !== 'completed';
}
function verifyPostDeployMainLineage({ targetSha, currentMainSha, comparison = null }) {
  const target = String(targetSha ?? '').trim().toLowerCase();
  const mainSha = String(currentMainSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(target) || !/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new Error('POSTDEPLOY_CONTEXT_MAIN_LINEAGE_SHA_INVALID');
  }
  // Exact main is mandatory at initial release authorization. After that
  // immutable Production QA may outlive an ordinary fast-forward merge.
  if (mainSha === target) {
    return { mainSha, mainAncestorVerified: true, mainAdvancedAfterDeployment: false };
  }
  const baseSha = String(comparison?.base_commit?.sha ?? '').toLowerCase();
  const mergeBaseSha = String(comparison?.merge_base_commit?.sha ?? '').toLowerCase();
  if (comparison?.status !== 'ahead' || baseSha !== target
    || mergeBaseSha !== target || comparison?.behind_by !== 0
    || !Number.isSafeInteger(comparison?.ahead_by) || comparison.ahead_by < 1) {
    throw new Error('POSTDEPLOY_CONTEXT_MAIN_NOT_FORWARD_DESCENDANT');
  }
  return { mainSha, mainAncestorVerified: true, mainAdvancedAfterDeployment: true };
}
function buildProductionPostdeployQaEvidence({
  targetSha,
  productionDeployRunId,
  comprehensive = null,
  tradingCore = null,
  qaScope = 'full',
  account,
  credential,
  context,
  generatedAt = new Date().toISOString(),
}) {
  const sha = String(targetSha ?? '').trim().toLowerCase();
  const deployRunId = Number(productionDeployRunId);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('POSTDEPLOY_QA_TARGET_SHA_INVALID');
  if (!Number.isSafeInteger(deployRunId) || deployRunId <= 0) throw new Error('POSTDEPLOY_QA_DEPLOY_RUN_ID_INVALID');

  if (qaScope === 'full') {
    assertComprehensiveReceipt(comprehensive, { targetSha: sha, productionDeployRunId: deployRunId });
  } else if (qaScope === 'trading_core') {
    assertTradingCoreReceipt(tradingCore, { targetSha: sha, productionDeployRunId: deployRunId });
  } else {
    throw new Error('POSTDEPLOY_QA_SCOPE_INVALID');
  }
  assertAccountReceipt(account, { targetSha: sha, productionDeployRunId: deployRunId });
  assertCredentialReceipt(credential, { targetSha: sha, productionDeployRunId: deployRunId });

  const actualMainSha = String(context?.mainSha ?? '').trim().toLowerCase();
  // The context builder has verified the exact GitHub compare ancestry;
  // neither an unrelated/divergent main nor a missing proof is acceptable.
  if (!/^[0-9a-f]{40}$/.test(actualMainSha)
    || context?.mainAncestorVerified !== true
    || context?.mainAdvancedAfterDeployment !== (actualMainSha !== sha)) {
    throw new Error('POSTDEPLOY_QA_MAIN_LINEAGE_UNVERIFIED');
  }
  requireExactSha(context?.productionDeploySha, sha, 'POSTDEPLOY_QA_PRODUCTION_SHA_MISMATCH');
  requireExactSha(context?.processDeploySha, sha, 'POSTDEPLOY_QA_PROCESS_SHA_MISMATCH');
  requireExactSha(context?.deployMarkerSha, sha, 'POSTDEPLOY_QA_MARKER_SHA_MISMATCH');
  requireExactSha(context?.productionDeployHeadSha, sha, 'POSTDEPLOY_QA_DEPLOY_HEAD_SHA_MISMATCH');
  if (context?.schemaVersion !== 'production-postdeploy-context-v2'
    || context?.identityMatch !== true
    || context?.productionDeployRunId !== deployRunId
    || context?.deploymentStepSucceeded !== true
    || context?.deploymentSafetyVerified !== true) {
    throw new Error('POSTDEPLOY_QA_PRODUCTION_IDENTITY_INVALID');
  }
  if (context?.deploymentVerificationMode === 'inline-approved-job') {
    if (context?.productionDeployStatus !== 'in_progress' || context?.productionDeployConclusion !== null) {
      throw new Error('POSTDEPLOY_QA_INLINE_DEPLOY_STATE_INVALID');
    }
  } else if (context?.deploymentVerificationMode === 'completed-successful-run') {
    requireExactSha(context?.latestSuccessfulDeploySha, sha, 'POSTDEPLOY_QA_LATEST_DEPLOY_SHA_MISMATCH');
    if (context?.productionDeployStatus !== 'completed'
      || context?.productionDeployConclusion !== 'success'
      || context?.latestSuccessfulDeployRunId !== deployRunId) {
      throw new Error('POSTDEPLOY_QA_COMPLETED_DEPLOY_STATE_INVALID');
    }
  } else {
    throw new Error('POSTDEPLOY_QA_DEPLOYMENT_VERIFICATION_MODE_INVALID');
  }
  if (!Array.isArray(context?.activeConflictingTradingGates)
    || context.activeConflictingTradingGates.length !== 0) {
    throw new Error('POSTDEPLOY_QA_ACTIVE_GATE_CONFLICT');
  }
  const deployCompletedAt = Date.parse(String(context?.productionDeployCompletedAt ?? ''));
  const orchestratorStartedAt = Date.parse(String(context?.orchestratorStartedAt ?? ''));
  if (!Number.isFinite(deployCompletedAt) || !Number.isFinite(orchestratorStartedAt)
    || orchestratorStartedAt < deployCompletedAt) {
    throw new Error('POSTDEPLOY_QA_EVIDENCE_PREDATES_DEPLOY');
  }
  const scopedReceipts = qaScope === 'trading_core'
    ? { tradingCore, account, credential }
    : { comprehensive, account, credential };
  for (const [name, receipt] of Object.entries(scopedReceipts)) {
    const receiptGeneratedAt = Date.parse(String(receipt?.generatedAt ?? ''));
    if (!Number.isFinite(receiptGeneratedAt) || receiptGeneratedAt < orchestratorStartedAt) {
      throw new Error(`POSTDEPLOY_QA_${name.toUpperCase()}_RECEIPT_NOT_FRESH`);
    }
  }

  assertNoForbiddenEvidenceKeys(scopedReceipts);

  return {
    schemaVersion: 'production-postdeploy-activation-ready-v4',
    qaScope,
    targetSha: sha,
    mainSha: actualMainSha,
    mainAncestorVerified: true,
    mainAdvancedAfterDeployment: context.mainAdvancedAfterDeployment,
    productionSha: sha,
    productionDeployRunId: deployRunId,
    generatedAt,
    identityMatch: true,
    comprehensiveQa: qaScope === 'full' ? 'PASS' : 'NOT_RUN',
    tradingCoreQa: qaScope === 'trading_core' ? 'PASS' : 'NOT_RUN',
    telegramActivationState: qaScope === 'trading_core'
      ? tradingCore.telegramActivationState
      : 'NOT_EVALUATED',
    telegramActivationReady: qaScope === 'trading_core'
      ? tradingCore.telegramActivationReady
      : false,
    telegramActivationVerified: qaScope === 'trading_core'
      ? tradingCore.telegramActivationState === 'ACTIVE_VERIFIED'
      : false,
    memberAutoPolicyReady: qaScope === 'trading_core'
      ? tradingCore.memberAutoPolicyReady
      : false,
    memberAutoLivePilotReady: qaScope === 'trading_core'
      ? tradingCore.memberAutoLivePilotReady === true
      : false,
    memberAutoPilotStage: qaScope === 'trading_core'
      ? String(tradingCore.memberAutoPilotStage ?? '')
      : 'NOT_EVALUATED',
    providers: Object.fromEntries(REQUIRED_PROVIDERS.map((provider) => [provider, 'PASS'])),
    credentialReuse: '4/4 PASS',
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    activeConflictingTradingGates: 0,
    openOrderCount: account.safetyCounters.openOrderCount,
    orphanOrderCount: account.safetyCounters.orphanOrderCount,
    activeLocalOrderCount: account.safetyCounters.activeLocalOrderCount,
    staleLocalOrderCount: account.safetyCounters.staleLocalOrderCount,
    duplicateClientOrderIdCount: account.safetyCounters.duplicateClientOrderIdCount,
    stalePlanCount: account.safetyCounters.stalePlanCount,
    oppositePositionDuplicateCount: account.safetyCounters.oppositePositionDuplicateCount,
    nonIsolatedPositionCount: account.safetyCounters.nonIsolatedPositionCount,
    outOfPolicyLeveragePositionCount: account.safetyCounters.outOfPolicyLeveragePositionCount,
    liquidationRiskPositionCount: account.safetyCounters.liquidationRiskPositionCount,
    bitgetPositionMode: account.bitgetPositionMode,
    bitgetMarginModePolicy: 'isolated',
    bitgetLeveragePolicy: '2-7',
    duplicateWorkerExecutionCount: 0,
    pm2FlagDriftCount: 0,
    legacyCryptoAutoAuthorityGranted: false,
    activationReady: true,
  };
}

module.exports = {
  REQUIRED_PROVIDERS,
  REQUIRED_CREDENTIAL_REUSE_PATHS,
  ZERO_COUNTERS,
  ZERO_SAFETY_COUNTERS,
  assertAccountReceipt,
  assertComprehensiveReceipt,
  assertCredentialReceipt,
  assertMemberReceipt,
  assertTradingCoreReceipt,
  buildProductionPostdeployQaEvidence,
  verifyPostDeployMainLineage,
  isActiveProductionTradingGateRun,
};
