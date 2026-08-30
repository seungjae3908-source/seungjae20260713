import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from '../src/public-forward-liquidity-capture-ingest.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
  buildPublicForwardLiquidityV3IndependentSplitIndex,
} from '../src/public-forward-liquidity-v3-independence-binding.mjs';

const POLICY = '1'.repeat(64);
const COHORT = '2'.repeat(64);
const DATASET0 = '3'.repeat(64);
const DATASET1 = '4'.repeat(64);
const AUDIT = '5'.repeat(64);
const SPLIT_SOURCE = '6'.repeat(64);
const PRODUCER = '7'.repeat(40);

function receipt({ predecessorDatasetDigest, datasetDigest, observationIds, slotIndex, split, captureSeed }) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    collectorCodeSha: PRODUCER,
    predecessorDatasetDigest,
    datasetDigest,
    batchObservationIds: observationIds,
    canonicalDatasetPersistencePerformed: true,
    canonicalDatasetCreditApplied: false,
    independenceEvaluated: false,
    effectiveIndependentCalibrationN: null,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
    sourceV3Lineage: {
      triggerSource: 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE',
      prospectiveSlotCredit: 1,
      manualCredit: 0,
      replayCredit: 0,
      backfillCredit: 0,
      operatorSelectedCredit: 0,
      slotIndex,
      split,
      policyDigest: POLICY,
      cohortDigest: COHORT,
      canonicalSlotKeyDigest: String(captureSeed).repeat(64).slice(0, 64),
      captureReceiptDigest: String(Number(captureSeed) + 1).repeat(64).slice(0, 64),
      artifactReceiptDigest: String(Number(captureSeed) + 2).repeat(64).slice(0, 64),
    },
  };
  return { ...body, receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body) };
}

function inventory(source) {
  const body = {
    schemaVersion: 'public-forward-liquidity-authoritative-ingest-inventory-v1',
    kind: 'PUBLIC_FORWARD_LIQUIDITY_RECEIPT_BOUND_INGEST_EVIDENCE',
    evidenceGeneration: 'V3_SCHEDULED_CUMULATIVE_REBUILD',
    persistentResearchStateMutation: false,
    productionMutation: false,
    targetSlotIndex: 24,
    genuineScheduledSlotN: 2,
    independentSampleCredit: 0,
    sources: [source],
    fullCostReady: false,
    evidenceComplete: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
  };
  return { ...body, inventoryDigest: sha256(canonicalJson(body)) };
}

function independence(observationIds = ['obs-a', 'obs-b']) {
  const observations = observationIds.map((observationId, index) => ({
    observationId,
    sourceObservationId: observationId,
    sourceIdentity: `source-${index}`,
    eventIdentity: `event-${index}`,
    sourceFrameIdentity: `frame-${index}`,
    observation: { eventTimestampMs: 1_000 + index, aggressiveSide: index === 0 ? 'BUY' : 'SELL' },
  }));
  return {
    status: 'PRESENT',
    audit: { auditDigest: AUDIT, counts: { INDEPENDENT_N: observations.length } },
    splitSource: {
      splitSourceDigest: SPLIT_SOURCE,
      observations,
      splitAssignmentPerformed: false,
      oosValidationComplete: false,
      calibrationArtifactProduced: false,
      liquidityImpactStatus: 'BLOCKED_DATA',
      fullCostReady: false,
      evidenceCompleteCredit: 0,
      executionAuthority: 'NONE',
    },
  };
}

function fixture() {
  const first = receipt({ predecessorDatasetDigest: null, datasetDigest: DATASET0, observationIds: ['obs-a'], slotIndex: 0, split: 'TRAIN', captureSeed: 8 });
  const second = receipt({ predecessorDatasetDigest: DATASET0, datasetDigest: DATASET1, observationIds: ['obs-b', 'obs-a'], slotIndex: 24, split: 'VALIDATION', captureSeed: 9 });
  const source = {
    sourceIdentity: 'v3-cohort:test', collectorCodeSha: PRODUCER, datasetDigest: DATASET1,
    ingestReceiptRelativePaths: ['receipts/00.json', 'receipts/24.json'],
    ingestReceiptDigests: [first.receiptDigest, second.receiptDigest],
    v3SlotIndexes: [0, 24], v3Splits: ['TRAIN', 'VALIDATION'],
    v3PolicyDigest: POLICY, v3CohortDigest: COHORT,
  };
  return {
    inventory: inventory(source),
    receiptEntries: [
      { relativePath: 'receipts/00.json', receipt: first },
      { relativePath: 'receipts/24.json', receipt: second },
    ],
  };
}

test('propagates first genuine V3 frozen slot lineage to each effective-independent observation', () => {
  const value = fixture();
  const result = buildPublicForwardLiquidityV3IndependentSplitIndex({ ...value, independenceResult: independence(), producerCodeSha: PRODUCER });
  assert.equal(result.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION);
  assert.equal(result.effectiveIndependentN, 2);
  assert.deepEqual(result.counts, {
    TRAIN: 1, TRAIN_BUY: 1, TRAIN_SELL: 0,
    VALIDATION: 1, VALIDATION_BUY: 0, VALIDATION_SELL: 1,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  });
  assert.equal(result.observations.find((item) => item.observationId === 'obs-a').split, 'TRAIN');
  assert.equal(result.observations.find((item) => item.observationId === 'obs-b').split, 'VALIDATION');
  assert.equal(result.duplicateObservationLineageN, 1);
  assert.equal(result.retrospectiveSplitSelection, false);
  assert.equal(result.syntheticSplitAssignment, false);
  assert.equal(result.additionalIndependentSampleCredit, 0);
  assert.equal(result.oosOutcomeCredit, 0);
  assert.equal(result.fullCostReady, false);
});

test('fails closed when effective-independent observation has no genuine V3 lineage', () => {
  const value = fixture();
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
    ...value, independenceResult: independence(['obs-a', 'missing']), producerCodeSha: PRODUCER,
  }), /INDEPENDENT_OBSERVATION_V3_LINEAGE_MISSING/);
});

test('fails closed on tampered ingest receipt digest or split vector', () => {
  const value = fixture();
  value.receiptEntries[0].receipt.receiptDigest = 'f'.repeat(64);
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({ ...value, independenceResult: independence(), producerCodeSha: PRODUCER }), /V3_INGEST_RECEIPT_DIGEST_MISMATCH/);

  const other = fixture();
  other.inventory.sources[0].v3Splits[0] = 'OOS';
  const body = Object.fromEntries(Object.entries(other.inventory).filter(([key]) => key !== 'inventoryDigest'));
  other.inventory.inventoryDigest = sha256(canonicalJson(body));
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({ ...other, independenceResult: independence(), producerCodeSha: PRODUCER }), /V3_SOURCE_LINEAGE_INVALID/);
});
