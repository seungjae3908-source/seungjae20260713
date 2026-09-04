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
const SHA40 = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[1-9][0-9]*$/u;
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
function decimalId(value, code) {
  const normalized = text(String(value), code);
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
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

function verifyReceipt(receipt, source, expectedPath, expectedDigest, expectedSlot, expectedSplit, {
  expectedRunId,
  expectedArtifactId,
  expectedArtifactDigest,
} = {}) {
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
  if (!SHA40.test(String(value.exactMainSha ?? '')) || value.exactMainSha !== source.collectorCodeSha) {
    throw new Error('V3_RECEIPT_EXACT_MAIN_SHA_MISMATCH');
  }
  if (value.captureRunAttempt !== '1'
    || decimalId(value.captureRunId, 'V3_CAPTURE_RUN_ID_INVALID') !== expectedRunId) {
    throw new Error('V3_CAPTURE_RUN_IDENTITY_MISMATCH');
  }
  if (decimalId(value.artifactId, 'V3_CAPTURE_ARTIFACT_ID_INVALID') !== expectedArtifactId
    || digest(value.artifactDigest, 'V3_CAPTURE_ARTIFACT_DIGEST_INVALID') !== expectedArtifactDigest) {
    throw new Error('V3_CAPTURE_ARTIFACT_IDENTITY_MISMATCH');
  }
  const receiptDigest = digest(value.receiptDigest, 'V3_INGEST_RECEIPT_DIGEST_INVALID');
  if (receiptDigest !== expectedDigest
    || receiptDigest !== computePublicForwardLiquidityCaptureIngestReceiptDigest(value)) {
    throw new Error('V3_INGEST_RECEIPT_DIGEST_MISMATCH');
  }
  const lineage = object(value.sourceV3Lineage, 'V3_SOURCE_LINEAGE_REQUIRED');
  const legacyLineage = lineage.sourceContractFamily == null
    || lineage.sourceContractFamily === 'CALIBRATION_V3';
  const successorLineage = lineage.sourceContractFamily === 'SUCCESSOR_SCHEDULE_RELIABILITY_V3';
  if ((legacyLineage
      && lineage.triggerSource !== 'GITHUB_ACTIONS_SCHEDULED_CANONICAL_PUBLIC_CAPTURE')
    || (successorLineage
      && (lineage.triggerSource !== 'schedule'
        || lineage.producerWorkflowName !== 'Public Forward Liquidity Successor Scheduled Capture'
        || lineage.producerWorkflowId !== 347888347
        || lineage.scheduleReliabilityContractVersion
          !== 'public-forward-liquidity-successor-schedule-reliability-contract-v3'
        || !SHA256.test(String(lineage.scheduleReliabilityNumericFreezeSha256 ?? ''))
        || !SHA256.test(String(lineage.oosHorizonPolicyDigest ?? ''))
        || !SHA256.test(String(lineage.oosHorizonContractDigest ?? ''))))
    || (!legacyLineage && !successorLineage)) {
    throw new Error('V3_SOURCE_LINEAGE_PRODUCER_INVALID');
  }
  if (lineage.slotIndex !== expectedSlot
    || lineage.split !== expectedSplit
    || !SPLITS.has(lineage.split)
    || lineage.prospectiveSlotCredit !== 1
    || lineage.manualCredit !== 0
    || lineage.replayCredit !== 0
    || lineage.backfillCredit !== 0
    || lineage.operatorSelectedCredit !== 0) {
    throw new Error('V3_SOURCE_LINEAGE_INVALID');
  }
  if (lineage.policyDigest !== source.v3PolicyDigest || lineage.cohortDigest !== source.v3CohortDigest) {
    throw new Error('V3_SOURCE_POLICY_COHORT_MISMATCH');
  }
  digest(lineage.captureReceiptDigest, 'V3_SOURCE_CAPTURE_RECEIPT_DIGEST_INVALID');
  const artifactReceiptDigest = digest(
    lineage.artifactReceiptDigest,
    'V3_SOURCE_ARTIFACT_RECEIPT_DIGEST_INVALID',
  );
  if (artifactReceiptDigest
    !== digest(value.captureArtifactReceiptDigest, 'V3_CAPTURE_ARTIFACT_RECEIPT_DIGEST_INVALID')) {
    throw new Error('V3_CAPTURE_ARTIFACT_RECEIPT_DIGEST_MISMATCH');
  }
  const canonicalSlotKey = object(lineage.canonicalSlotKey, 'V3_SOURCE_SLOT_KEY_REQUIRED');
  if (canonicalSlotKey.slotIndex !== expectedSlot
    || canonicalSlotKey.policyDigest !== lineage.policyDigest
    || canonicalSlotKey.cohortDigest !== lineage.cohortDigest) {
    throw new Error('V3_SOURCE_SLOT_KEY_MISMATCH');
  }
  const derivedSlotKeyDigest = sha256(canonicalJson(canonicalSlotKey));
  if (lineage.canonicalSlotKeyDigest != null
    && digest(lineage.canonicalSlotKeyDigest, 'V3_SOURCE_SLOT_KEY_DIGEST_INVALID')
      !== derivedSlotKeyDigest) {
    throw new Error('V3_SOURCE_SLOT_KEY_DIGEST_MISMATCH');
  }
  if (!Array.isArray(value.batchObservationIds) || value.batchObservationIds.length === 0) {
    throw new Error('V3_BATCH_OBSERVATION_IDS_REQUIRED');
  }
  return Object.freeze({
    path: expectedPath,
    receipt: value,
    lineage,
    canonicalSlotKeyDigest: derivedSlotKeyDigest,
  });
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
  const creditedSlotKeys = new Set();
  const inventorySourceBindings = new Map();

  for (const source of sourceInventory.sources) {
    object(source, 'V3_SOURCE_INVALID');
    const sourceIdentity = text(source.sourceIdentity, 'V3_SOURCE_IDENTITY_INVALID');
    const paths = exactArray(source.ingestReceiptRelativePaths, 'V3_SOURCE_RECEIPT_PATHS_INVALID');
    const digests = exactArray(source.ingestReceiptDigests, 'V3_SOURCE_RECEIPT_DIGESTS_INVALID');
    const slots = exactArray(source.v3SlotIndexes, 'V3_SOURCE_SLOT_INDEXES_INVALID');
    const splits = exactArray(source.v3Splits, 'V3_SOURCE_SPLITS_INVALID');
    const runIds = exactArray(source.captureRunIds, 'V3_SOURCE_RUN_IDS_INVALID');
    const artifactIds = exactArray(source.captureArtifactIds, 'V3_SOURCE_ARTIFACT_IDS_INVALID');
    const artifactDigests = exactArray(source.captureArtifactDigests, 'V3_SOURCE_ARTIFACT_DIGESTS_INVALID');
    if (!paths.length || paths.length !== digests.length || paths.length !== slots.length
      || paths.length !== splits.length || paths.length !== runIds.length
      || paths.length !== artifactIds.length || paths.length !== artifactDigests.length) {
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
      const expectedRunId = decimalId(runIds[index], 'V3_SOURCE_RUN_ID_INVALID');
      const expectedArtifactId = decimalId(artifactIds[index], 'V3_SOURCE_ARTIFACT_ID_INVALID');
      const expectedArtifactDigest = digest(
        artifactDigests[index],
        'V3_SOURCE_ARTIFACT_DIGEST_INVALID',
      );
      const slotCreditKey = `${source.v3PolicyDigest}\u0000${source.v3CohortDigest}\u0000${slotIndex}`;
      if (creditedSlotKeys.has(slotCreditKey)) throw new Error('V3_DUPLICATE_SLOT_CREDIT_FORBIDDEN');
      creditedSlotKeys.add(slotCreditKey);
      const receipt = verifyReceipt(byPath.get(path), source, path, expectedDigest, slotIndex, split, {
        expectedRunId,
        expectedArtifactId,
        expectedArtifactDigest,
      });
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
          canonicalSlotKeyDigest: receipt.canonicalSlotKeyDigest,
          captureReceiptDigest: receipt.lineage.captureReceiptDigest,
          artifactReceiptDigest: receipt.lineage.artifactReceiptDigest,
        }));
      }
    }
    if (predecessor !== source.datasetDigest) throw new Error('V3_SOURCE_FINAL_DATASET_DIGEST_MISMATCH');
    const sourceDatasetDigest = digest(source.datasetDigest, 'V3_SOURCE_DATASET_DIGEST_INVALID');
    const finalReceiptDigest = digest(digests.at(-1), 'V3_SOURCE_FINAL_RECEIPT_DIGEST_INVALID');
    const bindingKey = `${source.collectorCodeSha}\u0000${sourceDatasetDigest}\u0000${finalReceiptDigest}`;
    if (inventorySourceBindings.has(bindingKey)) throw new Error('V3_SOURCE_BINDING_DUPLICATE');
    inventorySourceBindings.set(bindingKey, sourceIdentity);
    sourceFinalDigests.add(sourceDatasetDigest);
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
  const boundToInventorySource = new Map(
    sourceInventory.sources.map((source) => [source.sourceIdentity, source.sourceIdentity]),
  );
  for (const source of exactArray(
    result.splitSource.upstreamSources ?? [],
    'INDEPENDENCE_UPSTREAM_SOURCES_INVALID',
  )) {
    object(source, 'INDEPENDENCE_UPSTREAM_SOURCE_INVALID');
    const boundIdentity = text(source.sourceIdentity, 'INDEPENDENCE_BOUND_SOURCE_IDENTITY_INVALID');
    const bindingKey = `${source.collectorCodeSha}\u0000${digest(
      source.datasetDigest,
      'INDEPENDENCE_SOURCE_DATASET_DIGEST_INVALID',
    )}\u0000${digest(source.receiptDigest, 'INDEPENDENCE_SOURCE_RECEIPT_DIGEST_INVALID')}`;
    const inventoryIdentity = inventorySourceBindings.get(bindingKey);
    if (!inventoryIdentity || boundToInventorySource.has(boundIdentity)) {
      throw new Error('INDEPENDENCE_SOURCE_LINEAGE_BINDING_INVALID');
    }
    boundToInventorySource.set(boundIdentity, inventoryIdentity);
  }

  const counts = {
    TRAIN: 0, TRAIN_BUY: 0, TRAIN_SELL: 0,
    VALIDATION: 0, VALIDATION_BUY: 0, VALIDATION_SELL: 0,
    OOS: 0, OOS_BUY: 0, OOS_SELL: 0,
  };
  const observations = independent.map((item) => {
    const observationId = text(item?.observationId, 'INDEPENDENT_OBSERVATION_ID_INVALID');
    const boundSourceIdentity = text(item?.sourceIdentity, 'INDEPENDENT_SOURCE_IDENTITY_INVALID');
    const sourceIdentity = boundToInventorySource.get(boundSourceIdentity);
    if (!sourceIdentity) throw new Error('INDEPENDENT_SOURCE_LINEAGE_MISSING');
    const sourceObservationId = text(
      item?.sourceObservationId ?? item?.observation?.observationId,
      'INDEPENDENT_SOURCE_OBSERVATION_ID_INVALID',
    );
    if (item?.observation?.observationId != null
      && item.observation.observationId !== sourceObservationId) {
      throw new Error('INDEPENDENT_SOURCE_OBSERVATION_ID_MISMATCH');
    }
    const lineage = lineageByObservation.get(lineageKey(sourceIdentity, sourceObservationId));
    if (!lineage) throw new Error('INDEPENDENT_OBSERVATION_V3_LINEAGE_MISSING');
    const side = text(item?.observation?.aggressiveSide, 'INDEPENDENT_OBSERVATION_SIDE_INVALID');
    if (!SIDES.has(side)) throw new Error('INDEPENDENT_OBSERVATION_SIDE_INVALID');
    addCount(counts, lineage.split, side);
    return Object.freeze({
      observationId,
      sourceObservationId,
      sourceIdentity: boundSourceIdentity,
      ingestSourceIdentity: sourceIdentity,
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
