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
      schemaVersion: 'production-account-readonly-live-qa-v2',
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
        reconciliation: 'PASS', reconciliationPassed: true,
      })),
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

test('builds ACTIVATION_READY only from exact-SHA zero-authority evidence', () => {
  const evidence = buildProductionPostdeployQaEvidence(fixture());
  assert.equal(evidence.activationReady, true);
  assert.equal(evidence.credentialReuse, '4/4 PASS');
  assert.equal(evidence.activeConflictingTradingGates, 0);
  assert.equal(evidence.realOrderSubmitted, false);
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
  assert.equal(evidence.schemaVersion, 'production-postdeploy-activation-ready-v2');
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
