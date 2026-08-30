import {
  canonicalJson,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from './public-forward-liquidity-capture-ingest.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION =
  'public-forward-liquidity-v3-independent-split-index-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const SPLITS = new Set(['TRAIN', 'VALIDATION', 'OOS']);
const SIDES = new Set(['BUY', 'SELL']);

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}
function text(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}
function digest(value, code) {
  const normalized = text(value, code).replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}
function integer(value, code) {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
}
function exactArray(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}
function lineageKey(sourceIdentity, observationId) {
  return `${text(sourceIdentity, 'V3_SOURCE_IDENTITY_INVALID')}\u0000${text(observationId, 'V3_OBSERVATION_ID_INVALID')}`;
}
function addCount(counts, split, side) {
  counts[split] += 1;
  counts[`${split}_${side}`] += 1;
}

function verifyInventory(inventory) {
  const value = object(inventory, 'V3_INGEST_INVENTORY_REQUIRED');
  if (value.schemaVersion !== 'public-forward-liquidity-authoritative-ingest-inventory-v1'
    || value.kind !== 'PUBLIC_FORWARD_LIQUIDITY_RECEIPT_BOUND_INGEST_EVIDENCE'
    || value.evidenceGeneration !== 'V3_SCHEDULED_CUMULATIVE_REBUILD'
    || value.persistentResearchStateMutation !== false
    || value.productionMutation !== false
    || value.independentSampleCredit !== 0
    || value.fullCostReady !== false
    || value.evidenceComplete !== 0
    || value.executionAuthority !== 'NONE'
    || value.privateApiUsed !== false
    || value.liveTrading !== false
    || value.realOrders !== 0) {
    throw new Error('V3_INGEST_INVENTORY_TRUTH_BOUNDARY_INVALID');
  }
  digest(value.inventoryDigest, 'V3_INGEST_INVENTORY_DIGEST_INVALID');
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inventoryDigest'));
  if (value.inventoryDigest !== sha256(canonicalJson(body))) throw new Error('V3_INGEST_INVENTORY_DIGEST_MISMATCH');
  integer(value.targetSlotIndex, 'V3_TARGET_SLOT_INDEX_INVALID');
  if (!Number.isInteger(value.genuineScheduledSlotN) || value.genuineScheduledSlotN <= 0) {
    throw new Error('V3_GENUINE_SCHEDULED_SLOT_N_INVALID');
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) throw new Error('V3_INGEST_SOURCES_REQUIRED');
  return value;
}

function verifyReceipt(receipt, source, expectedPath, expectedDigest, expectedSlot, expectedSplit) {
  const value = object(receipt, 'V3_INGEST_RECEIPT_REQUIRED');
  if (value.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION
    || value.canonicalDatasetPersistencePerformed !== true
    || value.canonicalDatasetCreditApplied !== false
    || value.independenceEvaluated !== false
    || value.effectiveIndependentCalibrationN !== null
    || value.fullCostReady !== false
    || value.evidenceCompleteCredit !== 0
    || value.executionAuthority !== 'NONE'
    || value.privateApiUsed !== false
    || value.liveTrading !== false
    || value.realOrders !== 0) {
    throw new Error('V3_INGEST_RECEIPT_TRUTH_BOUNDARY_INVALID');
  }
  if (value.collectorCodeSha !== source.collectorCodeSha) throw new Error('V3_RECEIPT_COLLECTOR_MISMATCH');
  const receiptDigest = digest(value.receiptDigest, 'V3_INGEST_RECEIPT_DIGEST_INVALID');
  if (receiptDigest !== expectedDigest
    || receiptDigest !== computePublicForwardLiquidityCaptureIngestReceiptDigest(value)) {
    throw new Error('V3_INGEST_RECEIPT_DIGEST_MISMATCH');
  }
  const lineage = object(value.sourceV3Lineage, 'V3_SOURCE_LINEAGE_REQUIRED');
  if (lineage.slotIndex !== expectedSlot
    || lineage.split !== expectedSplit
    || !SPLITS.has(lineage.split)
    || lineage.prospectiveSlotCredit !== 1
    || lineage.manualCredit !== 0
    || lineage.replayCredit !== 0
    || lineage.backfillCredit !== 0
    || lineage.operatorSelectedCredit !== 0
    || lineage.triggerSource !== 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE') {
    throw new Error('V3_SOURCE_LINEAGE_INVALID');
  }
  if (lineage.policyDigest !== source.v3PolicyDigest || lineage.cohortDigest !== source.v3CohortDigest) {
    throw new Error('V3_SOURCE_POLICY_COHORT_MISMATCH');
  }
  digest(lineage.captureReceiptDigest, 'V3_SOURCE_CAPTURE_RECEIPT_DIGEST_INVALID');
  digest(lineage.artifactReceiptDigest, 'V3_SOURCE_ARTIFACT_RECEIPT_DIGEST_INVALID');
  digest(lineage.canonicalSlotKeyDigest, 'V3_SOURCE_SLOT_KEY_DIGEST_INVALID');
  if (!Array.isArray(value.batchObservationIds) || value.batchObservationIds.length === 0) {
    throw new Error('V3_BATCH_OBSERVATION_IDS_REQUIRED');
  }
  return Object.freeze({ path: expectedPath, receipt: value, lineage });
}

export function buildPublicForwardLiquidityV3IndependentSplitIndex({
  inventory,
  receiptEntries,
  independenceResult,
  producerCodeSha,
} = {}) {
  const sourceInventory = verifyInventory(inventory);
  const entries = exactArray(receiptEntries, 'V3_RECEIPT_ENTRIES_REQUIRED');
  const byPath = new Map();
  for (const item of entries) {
    const entry = object(item, 'V3_RECEIPT_ENTRY_INVALID');
    const path = text(entry.relativePath, 'V3_RECEIPT_ENTRY_PATH_INVALID');
    if (byPath.has(path)) throw new Error('V3_RECEIPT_ENTRY_PATH_DUPLICATE');
    byPath.set(path, entry.receipt);
  }

  const lineageByObservation = new Map();
  const sourceFinalDigests = new Set();
  let creditedReceiptN = 0;
  let duplicateObservationLineageN = 0;
  const policyDigests = new Set();
  const cohortDigests = new Set();

  for (const source of sourceInventory.sources) {
    object(source, 'V3_SOURCE_INVALID');
    const sourceIdentity = text(source.sourceIdentity, 'V3_SOURCE_IDENTITY_INVALID');
    const paths = exactArray(source.ingestReceiptRelativePaths, 'V3_SOURCE_RECEIPT_PATHS_INVALID');
    const digests = exactArray(source.ingestReceiptDigests, 'V3_SOURCE_RECEIPT_DIGESTS_INVALID');
    const slots = exactArray(source.v3SlotIndexes, 'V3_SOURCE_SLOT_INDEXES_INVALID');
    const splits = exactArray(source.v3Splits, 'V3_SOURCE_SPLITS_INVALID');
    if (!paths.length || paths.length !== digests.length || paths.length !== slots.length || paths.length !== splits.length) {
      throw new Error('V3_SOURCE_RECEIPT_VECTOR_LENGTH_MISMATCH');
    }
    policyDigests.add(digest(source.v3PolicyDigest, 'V3_SOURCE_POLICY_DIGEST_INVALID'));
    cohortDigests.add(digest(source.v3CohortDigest, 'V3_SOURCE_COHORT_DIGEST_INVALID'));
    let predecessor = null;
    for (let index = 0; index < paths.length; index += 1) {
      const path = text(paths[index], 'V3_SOURCE_RECEIPT_PATH_INVALID');
      const expectedDigest = digest(digests[index], 'V3_SOURCE_RECEIPT_DIGEST_INVALID');
      const slotIndex = integer(slots[index], 'V3_SOURCE_SLOT_INDEX_INVALID');
      const split = text(splits[index], 'V3_SOURCE_SPLIT_INVALID');
      if (!SPLITS.has(split)) throw new Error('V3_SOURCE_SPLIT_INVALID');
      const receipt = verifyReceipt(byPath.get(path), source, path, expectedDigest, slotIndex, split);
      if (receipt.receipt.predecessorDatasetDigest !== predecessor) throw new Error('V3_SOURCE_PREDECESSOR_CHAIN_MISMATCH');
      predecessor = receipt.receipt.datasetDigest;
      creditedReceiptN += 1;
      for (const observationId of receipt.receipt.batchObservationIds) {
        const id = text(observationId, 'V3_OBSERVATION_ID_INVALID');
        const key = lineageKey(sourceIdentity, id);
        if (lineageByObservation.has(key)) {
          duplicateObservationLineageN += 1;
          continue;
        }
        lineageByObservation.set(key, Object.freeze({
          sourceIdentity,
          collectorCodeSha: source.collectorCodeSha,
          datasetDigest: source.datasetDigest,
          ingestReceiptRelativePath: receipt.path,
          ingestReceiptDigest: receipt.receipt.receiptDigest,
          slotIndex,
          split,
          policyDigest: receipt.lineage.policyDigest,
          cohortDigest: receipt.lineage.cohortDigest,
          canonicalSlotKeyDigest: receipt.lineage.canonicalSlotKeyDigest,
          captureReceiptDigest: receipt.lineage.captureReceiptDigest,
          artifactReceiptDigest: receipt.lineage.artifactReceiptDigest,
        }));
      }
    }
    if (predecessor !== source.datasetDigest) throw new Error('V3_SOURCE_FINAL_DATASET_DIGEST_MISMATCH');
    sourceFinalDigests.add(digest(source.datasetDigest, 'V3_SOURCE_DATASET_DIGEST_INVALID'));
  }
  if (policyDigests.size !== 1 || cohortDigests.size !== 1) throw new Error('V3_MULTI_POLICY_OR_COHORT_FORBIDDEN');

  const result = object(independenceResult, 'INDEPENDENCE_RESULT_REQUIRED');
  if (result.status !== 'PRESENT' || !result.audit || !result.splitSource
    || result.splitSource.splitAssignmentPerformed !== false
    || result.splitSource.oosValidationComplete !== false
    || result.splitSource.calibrationArtifactProduced !== false
    || result.splitSource.liquidityImpactStatus !== 'BLOCKED_DATA'
    || result.splitSource.fullCostReady !== false
    || result.splitSource.evidenceCompleteCredit !== 0
    || result.splitSource.executionAuthority !== 'NONE') {
    throw new Error('INDEPENDENCE_RESULT_TRUTH_BOUNDARY_INVALID');
  }
  const independent = exactArray(result.splitSource.observations, 'INDEPENDENT_OBSERVATIONS_REQUIRED');
  if (result.audit.counts?.INDEPENDENT_N !== independent.length) throw new Error('INDEPENDENT_N_MISMATCH');

  const counts = {
    TRAIN: 0, TRAIN_BUY: 0, TRAIN_SELL: 0,
    VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  };
  const observations = independent.map((item) => {
    const observationId = text(item?.observationId, 'INDEPENDENT_OBSERVATION_ID_INVALID');
    const sourceIdentity = text(item?.sourceIdentity, 'INDEPENDENT_SOURCE_IDENTITY_INVALID');
    const lineage = lineageByObservation.get(lineageKey(sourceIdentity, observationId));
    if (!lineage) throw new Error('INDEPENDENT_OBSERVATION_V3_LINEAGE_MISSING');
    const side = text(item?.observation?.aggressiveSide, 'INDEPENDENT_OBSERVATION_SIDE_INVALID');
    if (!SIDES.has(side)) throw new Error('INDEPENDENT_OBSERVATION_SIDE_INVALID');
    addCount(counts, lineage.split, side);
    return Object.freeze({
      observationId,
      sourceObservationId: item.sourceObservationId ?? null,
      sourceIdentity,
      eventIdentity: item.eventIdentity,
      sourceFrameIdentity: item.sourceFrameIdentity,
      eventTimestampMs: item.observation?.eventTimestampMs ?? null,
      aggressiveSide: side,
      split: lineage.split,
      slotIndex: lineage.slotIndex,
      canonicalSlotKeyDigest: lineage.canonicalSlotKeyDigest,
      collectorCodeSha: lineage.collectorCodeSha,
      datasetDigest: lineage.datasetDigest,
      ingestReceiptRelativePath: lineage.ingestReceiptRelativePath,
      ingestReceiptDigest: lineage.ingestReceiptDigest,
      captureReceiptDigest: lineage.captureReceiptDigest,
      artifactReceiptDigest: lineage.artifactReceiptDigest,
      policyDigest: lineage.policyDigest,
      cohortDigest: lineage.cohortDigest,
    });
  });

  if (counts.TRAIN + counts.VALIDATION + counts.OOS !== independent.length) throw new Error('V3_SPLIT_COUNT_MISMATCH');
  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    kind: 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION',
    producerCodeSha: text(producerCodeSha, 'PRODUCER_CODE_SHA_REQUIRED'),
    sourceInventoryDigest: sourceInventory.inventoryDigest,
    independenceAuditDigest: digest(result.audit.auditDigest, 'INDEPENDENCE_AUDIT_DIGEST_INVALID'),
    independentSplitSourceDigest: digest(result.splitSource.splitSourceDigest, 'INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID'),
    policyDigest: [...policyDigests][0],
    cohortDigest: [...cohortDigests][0],
    targetSlotIndex: sourceInventory.targetSlotIndex,
    genuineScheduledSlotN: sourceInventory.genuineScheduledSlotN,
    creditedReceiptN,
    sourceDatasetDigests: Object.freeze([...sourceFinalDigests].sort()),
    effectiveIndependentN: independent.length,
    counts: Object.freeze(counts),
    observations: Object.freeze(observations),
    duplicateObservationLineageN,
    frozenSplitSource: 'V3_SCHEDULED_SLOT_RECEIPT_ONLY',
    retrospectiveSplitSelection: false,
    syntheticSplitAssignment: false,
    additionalIndependentSampleCredit: 0,
    oosOutcomeCredit: 0,
    calibrationArtifactProduced: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    realOrders: 0,
  });
  return Object.freeze({ ...body, indexDigest: sha256(canonicalJson(body)) });
}
