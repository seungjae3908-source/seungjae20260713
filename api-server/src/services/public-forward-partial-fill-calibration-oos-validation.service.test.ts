import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicForwardPartialFillSplitAuditManifest } from './public-forward-partial-fill-calibration-split-audit.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_SAFETY,
  type PublicForwardPartialFillOosOutcome,
  validatePublicForwardPartialFillOosOutcomes,
} from './public-forward-partial-fill-calibration-oos-validation.service';

const hex = (value: string) => value.repeat(64).slice(0, 64);
const producerSha = 'a'.repeat(40);
const methodology = Object.freeze({
  methodologyIdentity: 'partial-fill-held-out-public-forward-outcome-v1',
  methodologyDigest: hex('9'),
  methodologyFrozenAtMs: 900,
});

function audit(overrides: Record<string, unknown> = {}): PublicForwardPartialFillSplitAuditManifest {
  return {
    schemaVersion: 'public-forward-partial-fill-calibration-split-audit-v1',
    datasetSchemaVersion: 'public-forward-partial-fill-calibration-dataset-v1',
    datasetStoreContract: 'research-production-state-root/forward-partial-fill-calibration-v1',
    datasetIdentity: 'dataset-forward-1',
    datasetDigest: hex('1'),
    collectorCodeSha: 'b'.repeat(40),
    splitPolicyIdentity: 'frozen-partial-fill-split-policy-v1',
    splitPolicyVersion: 'v1',
    splitPolicyDigest: hex('2'),
    splitPolicyFrozenAtMs: 800,
    regimeOwnerIdentity: 'canonical-regime-owner',
    regimePolicyIdentity: 'canonical-regime-policy-v1',
    regimePolicyDigest: hex('3'),
    assignmentDigest: hex('4'),
    auditDigest: hex('5'),
    totalObservationCount: 3,
    counts: { train: 1, validation: 1, oos: 1 },
    assignments: [
      {
        observationId: 'obs-train',
        sourceObservationLineageDigest: hex('6'),
        split: 'TRAIN',
        eventStartMs: 1_000,
        observedAtMs: 1_100,
        scopeKey: 'CRYPTO_FUTURES|BTCUSDT|LONG|bucket-1|VOL_NORMAL|LIQ_NORMAL',
        regimeEvidenceIdentity: 'regime-train',
        regimeEvidenceDigest: hex('a'),
      },
      {
        observationId: 'obs-validation',
        sourceObservationLineageDigest: hex('7'),
        split: 'VALIDATION',
        eventStartMs: 2_000,
        observedAtMs: 2_100,
        scopeKey: 'CRYPTO_FUTURES|BTCUSDT|LONG|bucket-1|VOL_NORMAL|LIQ_NORMAL',
        regimeEvidenceIdentity: 'regime-validation',
        regimeEvidenceDigest: hex('b'),
      },
      {
        observationId: 'obs-oos',
        sourceObservationLineageDigest: hex('8'),
        split: 'OOS',
        eventStartMs: 3_000,
        observedAtMs: 3_100,
        scopeKey: 'CRYPTO_FUTURES|BTCUSDT|LONG|bucket-1|VOL_NORMAL|LIQ_NORMAL',
        regimeEvidenceIdentity: 'regime-oos',
        regimeEvidenceDigest: hex('c'),
      },
    ],
    scopeCounts: [],
    sampleDeficits: [],
    regimeScopeComplete: true,
    splitAssignmentComplete: true,
    calibrationSampleSufficient: true,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    partialFillCostPresent: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    partialFillStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  } as unknown as PublicForwardPartialFillSplitAuditManifest;
}

function outcome(overrides: Record<string, unknown> = {}): PublicForwardPartialFillOosOutcome {
  return {
    outcomeId: 'oos-outcome-1',
    observationId: 'obs-oos',
    sourceObservationLineageDigest: hex('8'),
    splitAuditDigest: hex('5'),
    datasetDigest: hex('1'),
    splitPolicyDigest: hex('2'),
    scopeKey: 'CRYPTO_FUTURES|BTCUSDT|LONG|bucket-1|VOL_NORMAL|LIQ_NORMAL',
    eventStartMs: 3_000,
    scoredAtMs: 3_200,
    hypotheticalOrderIdentity: 'passive-order-fixed-before-obs-oos',
    hypotheticalOrderFrozenAtMs: 2_900,
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    outcomeSourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_OPPORTUNITY_OUTCOME_V1',
    outcomeSourceDigest: hex('d'),
    outcomeProducerCodeSha: producerSha,
    methodologyIdentity: methodology.methodologyIdentity,
    methodologyDigest: methodology.methodologyDigest,
    methodologyFrozenAtMs: methodology.methodologyFrozenAtMs,
    heldOut: true,
    contaminationFree: true,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    ...overrides,
  } as unknown as PublicForwardPartialFillOosOutcome;
}

test('validates exact held-out OOS coverage without producing partial-fill cost or runtime credit', () => {
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [outcome()],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'PRESENT');
  assert.deepEqual(result.blockers, []);
  assert.ok(result.validation);
  assert.equal(result.validation.oosAssignmentCount, 1);
  assert.equal(result.validation.scoredOutcomeCount, 1);
  assert.equal(result.validation.exactOosCoverage, true);
  assert.equal(result.validation.heldOut, true);
  assert.equal(result.validation.contaminationFree, true);
  assert.equal(result.validation.actualFillObserved, false);
  assert.equal(result.validation.queuePositionKnown, false);
  assert.equal(result.validation.oosValidationComplete, true);
  assert.equal(result.validation.calibrationArtifactProduced, false);
  assert.equal(result.validation.partialFillCostPresent, false);
  assert.equal(result.validation.naturalEntryCredit, 0);
  assert.equal(result.validation.runtimeCostCredit, 0);
  assert.equal(result.validation.partialFillStatus, 'BLOCKED_DATA');
  assert.equal(result.validation.fullCostReady, false);
});

test('fails closed when upstream frozen split audit is not sample-sufficient', () => {
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit({ calibrationSampleSufficient: false, sampleDeficits: ['OOS:1'] }),
    outcomes: [outcome()],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('CALIBRATION_SAMPLE_INSUFFICIENT'));
  assert.equal(result.validation, null);
});

test('does not mark OOS complete when a held-out scored outcome is missing', () => {
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_SCORED_OUTCOMES_MISSING'));
  assert.equal(result.validation, null);
});

test('rejects actual-fill, known-queue and partial-fill-cost claims from public-forward simulation', () => {
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [outcome({ actualFillObserved: true, queuePositionKnown: true, partialFillCostPercent: 0.1 })],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_ACTUAL_FILL_CLAIM_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_QUEUE_POSITION_CLAIM_FORBIDDEN'));
  assert.ok(result.blockers.includes('OOS_PARTIAL_FILL_COST_FORBIDDEN'));
});

test('rejects contamination or non-held-out outcomes instead of granting OOS credit', () => {
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [outcome({ heldOut: false, contaminationFree: false })],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_OUTCOME_NOT_HELD_OUT'));
  assert.ok(result.blockers.includes('OOS_OUTCOME_CONTAMINATED'));
});

test('rejects an order or methodology frozen after the OOS event started', () => {
  const lateMethodology = { ...methodology, methodologyFrozenAtMs: 3_001 };
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [outcome({ hypotheticalOrderFrozenAtMs: 3_001, methodologyFrozenAtMs: 3_001 })],
    methodology: lateMethodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_HYPOTHETICAL_ORDER_NOT_FROZEN_BEFORE_EVENT'));
  assert.ok(result.blockers.includes('OOS_METHODOLOGY_NOT_FROZEN_BEFORE_EVENT'));
});

test('rejects orphan or duplicated OOS outcomes and exact-identity mismatches', () => {
  const duplicate = outcome({ outcomeId: 'oos-outcome-2', outcomeSourceDigest: hex('e') });
  const orphan = outcome({
    outcomeId: 'orphan-outcome',
    observationId: 'obs-not-in-oos',
    outcomeSourceDigest: hex('f'),
  });
  const result = validatePublicForwardPartialFillOosOutcomes({
    audit: audit(),
    outcomes: [outcome(), duplicate, orphan],
    methodology,
    expectedOutcomeProducerCodeSha: producerSha,
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('OOS_OUTCOME_DUPLICATE_OBSERVATION'));
  assert.ok(result.blockers.includes('OOS_OUTCOME_ORPHAN'));
  assert.ok(result.blockers.includes('OOS_EXACT_COVERAGE_MISMATCH'));
});

test('safety contract keeps execution, cost, calibration artifact and Natural credit disabled', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_SAFETY, {
    heldOutScoredOutcomeRequired: true,
    contaminationFreeRequired: true,
    publicForwardSimulationRequired: true,
    hypotheticalOrderFrozenBeforeEventRequired: true,
    actualFillClaimAllowed: false,
    queuePositionClaimAllowed: false,
    publicL2AloneMayProducePartialFillCost: false,
    historicalBackfillCreditAllowed: false,
    testFixtureRuntimeCreditAllowed: false,
    partialFillCostProduced: false,
    calibrationArtifactProduced: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
    fullCostReady: false,
  });
});
