import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeManualPaperCanonicalRuntimeReadiness,
} from './manual-paper-canonical-runtime-readiness.service';

const SHA = 'a'.repeat(40);
const ACCOUNT_DIGEST = 'b'.repeat(64);
const STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const SNAPSHOT_PATH = `${STATE_ROOT}/publisher/paper-state-v2.json`;
const ARTIFACT_ROOT = '/opt/stock-app-data/forward-observer-v1';
const RECEIPT_ROOT = '/opt/stock-app-data/manual-paper-validation-receipts-v1';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOY_SHA: SHA,
    PAPER_CANONICAL_OWNER_BRIDGE_ENABLED: 'false',
    PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT: ARTIFACT_ROOT,
    PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT: RECEIPT_ROOT,
    PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS: '3600000',
    LIVE_TRADING: 'false',
    AUTO_TRADING: 'false',
    REAL_ORDER_ENABLED: 'false',
    PRIVATE_TRADING_API_ALLOWED: 'false',
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function binding(sourceSha = SHA) {
  return {
    schemaVersion: 'paper-state-publisher-runtime-binding-v1',
    paperRuntimeSourceSha: sourceSha,
    snapshotPath: SNAPSHOT_PATH,
    publisherAccountIdSha256: ACCOUNT_DIGEST,
    immutable: true,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

function dependencies(input: {
  bindingSha?: string;
  recurringSha?: string;
  snapshotSha?: string;
  missingArtifact?: boolean;
  receiptAccessFails?: boolean;
} = {}) {
  const bindingSha = input.bindingSha ?? SHA;
  const recurringSha = input.recurringSha ?? SHA;
  const snapshotSha = input.snapshotSha ?? SHA;
  return {
    async readText(path: string) {
      if (path.endsWith('/publisher-binding.json')) return JSON.stringify(binding(bindingSha));
      if (path.endsWith('/publisher/paper-state-v2.json')) return JSON.stringify({ schemaVersion: 'fixture' });
      if (path.endsWith('/state/recurring-paper-loop.json')) {
        return JSON.stringify({ identity: { researchCodeSha: recurringSha } });
      }
      if (path.startsWith(ARTIFACT_ROOT)) {
        if (input.missingArtifact && path.endsWith('/manifest.json')) throw new Error('missing');
        return JSON.stringify({ schemaVersion: 'fixture' });
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async accessPath(path: string) {
      assert.equal(path, RECEIPT_ROOT);
      if (input.receiptAccessFails) throw new Error('denied');
    },
    validateSnapshot() {
      return {
        sourceSha: snapshotSha,
        publisherAccountIdSha256: ACCOUNT_DIGEST,
        executionAuthority: 'NONE',
        privateApiAllowed: false,
        liveTrading: false,
        financialMutationAllowed: false,
      } as any;
    },
    validateRecurringState(raw: unknown) {
      return raw;
    },
  };
}

test('complete read-only evidence is ready for activation review without enabling anything', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    nowMs: Date.parse('2026-09-24T08:00:00.000Z'),
    dependencies: dependencies(),
  });

  assert.equal(result.status, 'READY_FOR_ACTIVATION_REVIEW');
  assert.equal(result.readyForActivationReview, true);
  assert.equal(result.activationApplied, false);
  assert.equal(result.bridgeEnabled, false);
  assert.equal(result.deployShaBound, true);
  assert.equal(result.paperStateBindingReady, true);
  assert.equal(result.paperStateSnapshotReady, true);
  assert.equal(result.naturalPaperStateReady, true);
  assert.equal(result.forwardObserverArtifactsReady, true);
  assert.equal(result.validationReceiptPathReady, true);
  assert.equal(result.safetyBoundaryReady, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.safety, {
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
    financialMutationPerformed: false,
    environmentMutationPerformed: false,
  });
});

test('bridge already enabled or dangerous trading flags fail closed', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env({
      PAPER_CANONICAL_OWNER_BRIDGE_ENABLED: 'true',
      LIVE_TRADING: 'true',
      AUTO_TRADING: 'true',
      REAL_ORDER_ENABLED: 'true',
      PRIVATE_TRADING_API_ALLOWED: 'true',
      executionAuthority: 'LIVE',
    }),
    dependencies: dependencies(),
  });

  assert.equal(result.readyForActivationReview, false);
  assert.equal(result.activationApplied, false);
  assert.equal(result.bridgeEnabled, true);
  assert.equal(result.safetyBoundaryReady, false);
  assert.ok(result.blockers.includes('PAPER_CANONICAL_BRIDGE_ALREADY_ENABLED'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_LIVE_TRADING_MUST_REMAIN_OFF'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_AUTO_TRADING_MUST_REMAIN_OFF'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_REAL_ORDER_MUST_REMAIN_OFF'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_PRIVATE_API_MUST_REMAIN_OFF'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_EXECUTION_AUTHORITY_MUST_BE_NONE'));
});

test('exact-main mismatches in binding snapshot or Natural state are explicit blockers', async () => {
  const other = 'c'.repeat(40);
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    dependencies: dependencies({
      bindingSha: other,
      snapshotSha: other,
      recurringSha: other,
    }),
  });

  assert.equal(result.readyForActivationReview, false);
  assert.equal(result.paperStateBindingReady, false);
  assert.equal(result.paperStateSnapshotReady, false);
  assert.equal(result.naturalPaperStateReady, false);
  assert.ok(result.blockers.includes('PAPER_CANONICAL_PAPER_STATE_BINDING_NOT_READY'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_PAPER_STATE_SNAPSHOT_NOT_READY'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_NATURAL_STATE_NOT_READY'));
});

test('missing observer artifact, receipt access, or freshness policy never becomes ready', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env({ PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_MS: undefined }),
    dependencies: dependencies({
      missingArtifact: true,
      receiptAccessFails: true,
    }),
  });

  assert.equal(result.readyForActivationReview, false);
  assert.equal(result.forwardObserverArtifactsReady, false);
  assert.equal(result.validationReceiptPathReady, false);
  assert.ok(result.blockers.includes('PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_UNREADABLE'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACTS_NOT_READY'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT_NOT_ACCESSIBLE'));
  assert.ok(result.blockers.includes('PAPER_CANONICAL_VALIDATION_RECEIPT_MAXIMUM_AGE_UNCONFIGURED'));
});

test('DEPLOY_SHA must equal the explicitly supplied current main', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env({ DEPLOY_SHA: 'd'.repeat(40) }),
    dependencies: dependencies(),
  });

  assert.equal(result.readyForActivationReview, false);
  assert.equal(result.deployShaBound, false);
  assert.ok(result.blockers.includes('PAPER_CANONICAL_DEPLOY_SHA_MISMATCH'));
});
