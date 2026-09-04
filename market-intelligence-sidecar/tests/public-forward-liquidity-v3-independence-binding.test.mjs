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
const SOURCE = 'v3-cohort:test';

function receipt({ predecessorDatasetDigest, datasetDigest, observationIds, slotIndex, split, captureSeed,
  successor = false }) {
  const captureRunId = String(33809694015 + slotIndex);
  const artifactId = String(9914306478 + slotIndex);
  const artifactDigest = String(Number(captureSeed) + 3).repeat(64).slice(0, 64);
  const artifactReceiptDigest = String(Number(captureSeed) + 2).repeat(64).slice(0, 64);
  const canonicalSlotKey = { policyDigest: POLICY, cohortDigest: COHORT, slotIndex };
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    exactMainSha: PRODUCER,
    collectorCodeSha: PRODUCER,
    captureRunId,
    captureRunAttempt: '1',
    artifactId,
    artifactDigest,
    captureArtifactReceiptDigest: artifactReceiptDigest,
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
      ...(successor ? {
        sourceContractFamily: 'SUCCESSOR_SCHEDULE_RELIABILITY_V3',
        producerWorkflowName: 'Public Forward Liquidity Successor Scheduled Capture',
        producerWorkflowId: 347888347,
        triggerSource: 'schedule',
        scheduleReliabilityContractVersion:
          'public-forward-liquidity-successor-schedule-reliability-contract-v3',
        scheduleReliabilityNumericFreezeSha256: 'a'.repeat(64),
        oosHorizonPolicyDigest: 'b'.repeat(64),
        oosHorizonContractDigest: 'c'.repeat(64),
      } : { triggerSource: 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE' }),
      prospectiveSlotCredit: 1,
      manualCredit: 0,
      replayCredit: 0,
      backfillCredit: 0,
      operatorSelectedCredit: 0,
      slotIndex,
      split,
      policyDigest: POLICY,
      cohortDigest: COHORT,
      canonicalSlotKey,
      canonicalSlotKeyDigest: sha256(canonicalJson(canonicalSlotKey)),
      captureReceiptDigest: String(Number(captureSeed) + 1).repeat(64).slice(0, 64),
      artifactReceiptDigest,
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
    sourceIdentity: SOURCE,
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
    sourceIdentity: SOURCE, collectorCodeSha: PRODUCER, datasetDigest: DATASET1,
    ingestReceiptRelativePaths: ['receipts/00.json', 'receipts/24.json'],
    ingestReceiptDigests: [first.receiptDigest, second.receiptDigest],
    captureRunIds: [first.captureRunId, second.captureRunId],
    captureArtifactIds: [first.artifactId, second.artifactId],
    captureArtifactDigests: [first.artifactDigest, second.artifactDigest],
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

function successorFixture() {
  const first = receipt({ predecessorDatasetDigest: null, datasetDigest: DATASET0,
    observationIds: ['obs-a', 'obs-b'], slotIndex: 20, split: 'TRAIN', captureSeed: 8,
    successor: true });
  // The genuine #36 #811 receipt carries canonicalSlotKey but omits the redundant digest.
  delete first.sourceV3Lineage.canonicalSlotKeyDigest;
  const firstBody = { ...first };
  delete firstBody.receiptDigest;
  first.receiptDigest = computePublicForwardLiquidityCaptureIngestReceiptDigest(firstBody);
  const source = {
    sourceIdentity: SOURCE, collectorCodeSha: PRODUCER, datasetDigest: DATASET0,
    ingestReceiptRelativePaths: ['receipts/20.json'],
    ingestReceiptDigests: [first.receiptDigest],
    captureRunIds: [first.captureRunId],
    captureArtifactIds: [first.artifactId],
    captureArtifactDigests: [first.artifactDigest],
    v3SlotIndexes: [20], v3Splits: ['TRAIN'],
    v3PolicyDigest: POLICY, v3CohortDigest: COHORT,
  };
  const sourceInventory = inventory(source);
  const inventoryBody = { ...sourceInventory, targetSlotIndex: 20, genuineScheduledSlotN: 1 };
  delete inventoryBody.inventoryDigest;
  return {
    inventory: { ...inventoryBody, inventoryDigest: sha256(canonicalJson(inventoryBody)) },
    receiptEntries: [{ relativePath: 'receipts/20.json', receipt: first }],
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

test('fails closed when source identity differs even if observation id matches', () => {
  const value = fixture();
  const result = independence();
  result.splitSource.observations[0].sourceIdentity = 'different-source';
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
    ...value, independenceResult: result, producerCodeSha: PRODUCER,
  }), /INDEPENDENT_SOURCE_LINEAGE_MISSING/);
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

test('admits #36-shaped native Successor lineage without creating additional credit', () => {
  const result = buildPublicForwardLiquidityV3IndependentSplitIndex({
    ...successorFixture(), independenceResult: independence(), producerCodeSha: PRODUCER,
  });
  assert.equal(result.genuineScheduledSlotN, 1);
  assert.equal(result.creditedReceiptN, 1);
  assert.equal(result.effectiveIndependentN, 2);
  assert.equal(result.counts.TRAIN, 2);
  assert.equal(result.counts.OOS, 0);
  assert.equal(result.additionalIndependentSampleCredit, 0);
  assert.equal(result.oosOutcomeCredit, 0);
  assert.equal(result.calibrationArtifactProduced, false);
  assert.equal(result.fullCostReady, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('fails closed on forged Successor producer identity or generic schedule lineage', () => {
  for (const mutate of [
    (lineage) => { lineage.producerWorkflowName = 'Public Forward Liquidity Calibration Scheduled V3'; },
    (lineage) => { lineage.producerWorkflowId = 1; },
    (lineage) => { lineage.triggerSource = 'workflow_dispatch'; },
    (lineage) => { lineage.sourceContractFamily = 'UNKNOWN'; },
  ]) {
    const value = successorFixture();
    mutate(value.receiptEntries[0].receipt.sourceV3Lineage);
    const receiptBody = { ...value.receiptEntries[0].receipt };
    delete receiptBody.receiptDigest;
    value.receiptEntries[0].receipt.receiptDigest =
      computePublicForwardLiquidityCaptureIngestReceiptDigest(receiptBody);
    value.inventory.sources[0].ingestReceiptDigests[0] = value.receiptEntries[0].receipt.receiptDigest;
    const inventoryBody = { ...value.inventory };
    delete inventoryBody.inventoryDigest;
    value.inventory.inventoryDigest = sha256(canonicalJson(inventoryBody));
    assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
      ...value, independenceResult: independence(), producerCodeSha: PRODUCER,
    }), /V3_SOURCE_LINEAGE_PRODUCER_INVALID/);
  }
});

test('fails closed on wrong exact-main, rerun, raw artifact identity, or incomplete vectors', () => {
  for (const [mutate, expected] of [
    [
      (value) => { value.receiptEntries[0].receipt.exactMainSha = 'e'.repeat(40); },
      /V3_RECEIPT_EXACT_MAIN_SHA_MISMATCH/,
    ],
    [
      (value) => { value.receiptEntries[0].receipt.captureRunAttempt = '2'; },
      /V3_CAPTURE_RUN_IDENTITY_MISMATCH/,
    ],
    [
      (value) => { value.receiptEntries[0].receipt.artifactDigest = 'e'.repeat(64); },
      /V3_CAPTURE_ARTIFACT_IDENTITY_MISMATCH/,
    ],
    [
      (value) => { value.inventory.sources[0].captureArtifactIds = []; },
      /V3_SOURCE_RECEIPT_VECTOR_LENGTH_MISMATCH/,
    ],
  ]) {
    const value = successorFixture();
    mutate(value);
    const receiptBody = { ...value.receiptEntries[0].receipt };
    delete receiptBody.receiptDigest;
    value.receiptEntries[0].receipt.receiptDigest =
      computePublicForwardLiquidityCaptureIngestReceiptDigest(receiptBody);
    value.inventory.sources[0].ingestReceiptDigests[0] = value.receiptEntries[0].receipt.receiptDigest;
    const inventoryBody = { ...value.inventory };
    delete inventoryBody.inventoryDigest;
    value.inventory.inventoryDigest = sha256(canonicalJson(inventoryBody));
    assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
      ...value, independenceResult: independence(), producerCodeSha: PRODUCER,
    }), expected);
  }
});

test('fails closed on an incomplete receipt chain or duplicate credited V3 slot', () => {
  const missing = successorFixture();
  missing.receiptEntries = [];
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
    ...missing, independenceResult: independence(), producerCodeSha: PRODUCER,
  }), /V3_INGEST_RECEIPT_REQUIRED/);

  const duplicate = fixture();
  duplicate.inventory.sources[0].v3SlotIndexes[1] = 0;
  const duplicateInventoryBody = { ...duplicate.inventory };
  delete duplicateInventoryBody.inventoryDigest;
  duplicate.inventory.inventoryDigest = sha256(canonicalJson(duplicateInventoryBody));
  assert.throws(() => buildPublicForwardLiquidityV3IndependentSplitIndex({
    ...duplicate, independenceResult: independence(), producerCodeSha: PRODUCER,
  }), /V3_DUPLICATE_SLOT_CREDIT_FORBIDDEN/);
});
