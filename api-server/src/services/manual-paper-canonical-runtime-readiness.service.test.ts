import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeManualPaperCanonicalRuntimeReadiness,
} from './manual-paper-canonical-runtime-readiness.service';
import { manualPaperEvidenceSha256 } from './manual-paper-canonical-contract.service';

const SHA = 'a'.repeat(40);
const ACCOUNT_DIGEST = 'b'.repeat(64);
const STATE_ROOT = '/opt/stock-app-data/paper-forward-v1';
const SNAPSHOT_PATH = `${STATE_ROOT}/publisher/paper-state-v2.json`;
const ARTIFACT_ROOT = '/opt/stock-app-data/forward-observer-v1';
const RECEIPT_ROOT = '/opt/stock-app-data/manual-paper-validation-receipts-v1';
const DEFAULT_ARTIFACT_ROOT = `${STATE_ROOT}/forward-observer`;
const DEFAULT_RECEIPT_ROOT = `${STATE_ROOT}/validation-receipts`;
const RECEIPT_PARENT = '/opt/stock-app-data';
const NOW = Date.parse('2026-09-24T08:00:00.000Z');
const CANDIDATE_ID = `paper-candidate-v1:${'c'.repeat(64)}`;
const BINDING_DIGEST = '3'.repeat(64);
const EXIT_TRIGGER_ID = '1'.repeat(64);
const EXIT_EXECUTION_ID = '2'.repeat(64);

function durableComponent(name: string) {
  return {
    valuePercent: name === 'tax' ? 0 : 0.01,
    source: `public:${name}`,
    quality: name === 'tax' ? 'NOT_APPLICABLE' : 'OBSERVED',
    observedAtMs: NOW - 1_000,
  };
}

function durablePosition(researchSha = SHA, missingComponent?: string) {
  const components: Record<string, any> = {
    commission: durableComponent('commission'),
    tax: durableComponent('tax'),
    spread: durableComponent('spread'),
    slippage: durableComponent('slippage'),
    funding: durableComponent('funding'),
    latency: durableComponent('latency'),
    liquidityImpact: durableComponent('liquidityImpact'),
    partialFillImpact: durableComponent('partialFillImpact'),
  };
  if (missingComponent) delete components[missingComponent];
  const trigger = {
    exitTriggerId: EXIT_TRIGGER_ID,
    triggeredAtMs: NOW,
    positionId: 'natural-position-1',
    paperSampleId: 'paper-sample-1',
  };
  return {
    positionId: 'natural-position-1',
    paperSampleId: 'paper-sample-1',
    candidateId: CANDIDATE_ID,
    researchCodeSha: researchSha,
    costPolicyVersion: 'cost-v1',
    entryTimestampMs: NOW,
    entryCandidate: {
      candidateId: CANDIDATE_ID,
      execution: { dataEvidence: { maxAgeMs: 60_000 } },
    },
    entryCostProvenance: {
      policyId: 'cost-v1',
      providerProvenance: 'bitget-public-owner',
      components,
    },
    lifecycle: { pendingExit: trigger },
  };
}

function packetPayload(packet: Record<string, any>) {
  return {
    schemaVersion: packet.schemaVersion,
    positionId: packet.positionId,
    paperSampleId: packet.paperSampleId,
    candidateId: packet.candidateId,
    researchCodeSha: packet.researchCodeSha,
    exitTriggerId: packet.exitTriggerId,
    exitExecutionId: packet.exitExecutionId,
    evaluatedAtMs: packet.evaluatedAtMs,
    bindingEvidenceDigest: packet.bindingEvidenceDigest,
    position: packet.position,
    sourceObservation: packet.sourceObservation,
    authoritativeEvidence: packet.authoritativeEvidence,
    trigger: packet.trigger,
  };
}

function durableSettlement(position: any) {
  const trigger = position.lifecycle.pendingExit;
  const packet: Record<string, any> = {
    schemaVersion: 'canonical-natural-settlement-owner-evidence-v1',
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    candidateId: position.candidateId,
    researchCodeSha: position.researchCodeSha,
    exitTriggerId: EXIT_TRIGGER_ID,
    exitExecutionId: EXIT_EXECUTION_ID,
    evaluatedAtMs: NOW,
    bindingEvidenceDigest: BINDING_DIGEST,
    position,
    sourceObservation: { observationId: 'natural-exit-observation', maxAgeMs: 60_000 },
    authoritativeEvidence: { schemaVersion: 'authoritative-natural-paper-trigger-settlement-evidence-v1' },
    trigger,
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    naturalSampleCredit: 0,
    executionAuthority: 'NONE',
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  packet.evidenceDigest = manualPaperEvidenceSha256(packetPayload(packet));
  const settlementIdentity = {
    candidateId: position.candidateId,
    entryId: position.paperSampleId,
    positionId: position.positionId,
    exitTriggerId: EXIT_TRIGGER_ID,
    exitExecutionId: EXIT_EXECUTION_ID,
  };
  const settlementId = manualPaperEvidenceSha256(settlementIdentity);
  return {
    settlementId,
    settlementIdentity,
    paperSampleId: position.paperSampleId,
    entryId: position.paperSampleId,
    positionId: position.positionId,
    candidateId: position.candidateId,
    researchCodeSha: position.researchCodeSha,
    exitTriggerId: EXIT_TRIGGER_ID,
    exitExecutionId: EXIT_EXECUTION_ID,
    canonicalOwnerEvidence: packet,
    canonicalOwnerEvidenceBindingDigest: manualPaperEvidenceSha256({
      settlementId,
      ownerEvidenceDigest: packet.evidenceDigest,
      exitTriggerId: EXIT_TRIGGER_ID,
      exitExecutionId: EXIT_EXECUTION_ID,
    }),
  };
}

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
  bindingMissing?: boolean;
  fallbackSnapshotPath?: string;
  missingArtifact?: boolean;
  receiptAccessFails?: boolean;
  receiptRootMissing?: boolean;
  missingCostComponent?: string;
  missingSettlement?: boolean;
  rebindFails?: boolean;
} = {}) {
  const bindingSha = input.bindingSha ?? SHA;
  const recurringSha = input.recurringSha ?? SHA;
  const snapshotSha = input.snapshotSha ?? SHA;
  return {
    async readText(path: string) {
      if (path.endsWith('/publisher-binding.json')) {
        if (input.bindingMissing) {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(binding(bindingSha));
      }
      if (path.endsWith('/publisher/paper-state-v2.json')) return JSON.stringify({ schemaVersion: 'fixture' });
      if (input.fallbackSnapshotPath && path === input.fallbackSnapshotPath) {
        return JSON.stringify({ schemaVersion: 'fixture' });
      }
      if (path.endsWith('/state/recurring-paper-loop.json')) {
        const position = durablePosition(recurringSha, input.missingCostComponent);
        return JSON.stringify({
          identity: { researchCodeSha: recurringSha },
          positions: [position],
          settlements: input.missingSettlement ? [] : [durableSettlement(position)],
        });
      }
      if ([ARTIFACT_ROOT, DEFAULT_ARTIFACT_ROOT].some((root) => path.startsWith(root))) {
        if (input.missingArtifact && path.endsWith('/manifest.json')) throw new Error('missing');
        return JSON.stringify({ schemaVersion: 'fixture' });
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async accessPath(path: string) {
      assert.ok([
        RECEIPT_ROOT,
        RECEIPT_PARENT,
        DEFAULT_RECEIPT_ROOT,
        STATE_ROOT,
      ].includes(path));
      if (input.receiptAccessFails) throw new Error('denied');
      if (input.receiptRootMissing && path === DEFAULT_RECEIPT_ROOT) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
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
    rebindSettlementEvidence(inputValue: any) {
      if (input.rebindFails) return { status: 'BLOCKED', fullCostReady: false };
      return {
        status: 'PRESENT',
        fullCostReady: true,
        evidenceDigest: BINDING_DIGEST,
        exitTriggerId: EXIT_TRIGGER_ID,
        exitExecutionId: EXIT_EXECUTION_ID,
        observation: inputValue?.observation,
      };
    },
  };
}

test('complete read-only evidence is ready for activation review without enabling anything', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    nowMs: NOW,
    dependencies: dependencies(),
  });

  assert.equal(result.status, 'READY_FOR_ACTIVATION_REVIEW');
  assert.equal(result.readyForActivationReview, true);
  assert.equal(result.activationApplied, false);
  assert.equal(result.bridgeEnabled, false);
  assert.equal(result.deployShaBound, true);
  assert.equal(result.paperStateBindingReady, true);
  assert.equal(result.paperStateConfigurationMode, 'RUNTIME_BINDING');
  assert.equal(result.paperStateSnapshotReady, true);
  assert.equal(result.naturalPaperStateReady, true);
  assert.equal(result.fullCostComponentsReady, true);
  assert.equal(result.settlementDurablePacketReady, true);
  assert.equal(result.closePositionCanonicalRebindReady, true);
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

test('canonical owner paths default under the Paper state root without weakening evidence gates', async () => {
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env({
      PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT: undefined,
      PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT: undefined,
    }),
    nowMs: NOW,
    dependencies: dependencies({ receiptRootMissing: true }),
  });

  assert.equal(result.forwardObserverArtifactsReady, true);
  assert.equal(result.validationReceiptPathReady, true);
  assert.ok(!result.blockers.includes('PAPER_CANONICAL_FORWARD_OBSERVER_ARTIFACT_ROOT_UNCONFIGURED'));
  assert.ok(!result.blockers.includes('PAPER_CANONICAL_VALIDATION_RECEIPT_ROOT_UNCONFIGURED'));
  assert.equal(result.readyForActivationReview, true);
});

test('supported env fallback is accepted only when runtime binding file is absent', async () => {
  const fallbackPath = '/opt/stock-app-data/fallback/paper-state.json';
  const result = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env({
      PAPER_FORWARD_PAPER_STATE_SNAPSHOT_PATH: fallbackPath,
      PAPER_FORWARD_PAPER_STATE_PUBLISHER_ACCOUNT_ID_SHA256: ACCOUNT_DIGEST,
    }),
    dependencies: dependencies({
      bindingMissing: true,
      fallbackSnapshotPath: fallbackPath,
    }),
  });

  assert.equal(result.readyForActivationReview, true);
  assert.equal(result.paperStateBindingReady, true);
  assert.equal(result.paperStateConfigurationMode, 'ENV_FALLBACK');
  assert.equal(result.paperStateSnapshotReady, true);
  assert.equal(result.activationApplied, false);
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


test('missing Full Cost, settlement packet, or canonical rebind stays fail-closed', async () => {
  const noCost = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    dependencies: dependencies({ missingCostComponent: 'partialFillImpact' }),
  });
  assert.equal(noCost.fullCostComponentsReady, false);
  assert.ok(noCost.blockers.includes('PAPER_CANONICAL_FULL_COST_EIGHT_COMPONENTS_NOT_READY'));

  const noSettlement = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    dependencies: dependencies({ missingSettlement: true }),
  });
  assert.equal(noSettlement.settlementDurablePacketReady, false);
  assert.equal(noSettlement.closePositionCanonicalRebindReady, false);
  assert.ok(noSettlement.blockers.includes('PAPER_CANONICAL_SETTLEMENT_DURABLE_PACKET_NOT_READY'));
  assert.ok(noSettlement.blockers.includes('PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY'));

  const failedRebind = await probeManualPaperCanonicalRuntimeReadiness({
    expectedMainSha: SHA,
    env: env(),
    dependencies: dependencies({ rebindFails: true }),
  });
  assert.equal(failedRebind.settlementDurablePacketReady, true);
  assert.equal(failedRebind.closePositionCanonicalRebindReady, false);
  assert.ok(failedRebind.blockers.includes('PAPER_CANONICAL_CLOSE_POSITION_REBIND_NOT_READY'));
});
