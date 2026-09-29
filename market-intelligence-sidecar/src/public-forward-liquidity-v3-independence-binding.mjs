import {
  canonicalJson,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from './public-forward-liquidity-capture-ingest.mjs';
import {
  V3_POLICY_BINDING,
  buildV3SlotDescriptor,
} from './public-forward-liquidity-capture-seam-v3.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1,
  verifyPublicForwardLiquidityMultiLanePolicyV1,
} from './public-forward-liquidity-multi-lane-policy-v1.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION =
  'public-forward-liquidity-v3-independent-split-index-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA40 = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[1-9][0-9]*$/u;
const SPLITS = new Set(['TRAIN', 'VALIDATION', 'OOS']);
const SIDES = new Set(['BUY', 'SELL']);
const CALIBRATION_V3 = 'CALIBRATION_V3';
const SUCCESSOR_SCHEDULE_RELIABILITY_V3 = 'SUCCESSOR_SCHEDULE_RELIABILITY_V3';

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

function emptyLaneSplitSideCounts() {
  return Object.fromEntries(PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.laneRegistry.map(
    (lane) => [lane.laneId, {
      TRAIN: { BUY: 0, SELL: 0 },
      VALIDATION: { BUY: 0, SELL: 0 },
      OOS: { BUY: 0, SELL: 0 },
    }],
  ));
}

function immutableSplitRanges(splits) {
  return Object.freeze(Object.fromEntries(
    ['TRAIN', 'VALIDATION', 'OOS'].map((name) => {
      const split = object(splits?.[name], 'SUCCESSOR_V3_NATIVE_SPLIT_CONTRACT_INVALID');
      return [name, Object.freeze({
        startIndexInclusive: integer(
          split.startIndexInclusive,
          'SUCCESSOR_V3_NATIVE_SPLIT_CONTRACT_INVALID',
        ),
        endIndexInclusive: integer(
          split.endIndexInclusive,
          'SUCCESSOR_V3_NATIVE_SPLIT_CONTRACT_INVALID',
        ),
        expectedSlotN: integer(
          split.expectedSlotN,
          'SUCCESSOR_V3_NATIVE_SPLIT_CONTRACT_INVALID',
        ),
      })];
    }),
  ));
}

function verifyCalibrationV3PolicyLineage(lineage, expectedSlot, expectedSplit) {
  const expected = {
    policyArtifactId: V3_POLICY_BINDING.policyArtifactId,
    policyArtifactDigest: V3_POLICY_BINDING.policyArtifactDigest,
    policyInternalArtifactDigest: V3_POLICY_BINDING.policyInternalArtifactDigest,
    policyDigest: V3_POLICY_BINDING.policyDigest,
    cohortId: V3_POLICY_BINDING.cohortId,
    cohortDigest: V3_POLICY_BINDING.cohortDigest,
    captureSelectionPolicyDigest: V3_POLICY_BINDING.captureSelectionPolicyDigest,
    slotIntervalMs: V3_POLICY_BINDING.slotIntervalMs,
  };
  if (Object.entries(expected).some(([key, value]) => lineage[key] !== value)) {
    throw new Error('CALIBRATION_V3_POLICY_LINEAGE_MISMATCH');
  }
  const slot = buildV3SlotDescriptor(expectedSlot);
  if (slot.split !== expectedSplit) throw new Error('CALIBRATION_V3_FROZEN_SPLIT_MISMATCH');
  return slot;
}

function verifySuccessorNativePolicyLineage(lineage, expectedSlot, expectedSplit) {
  const contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT;
  const contractVerdict = verifySuccessorScheduleReliabilityV3Contract(contract);
  const oosVerdict = verifySuccessorOosOutcomeHorizonContract();
  if (!contractVerdict.valid || contract.activationBound !== true || !oosVerdict.valid) {
    throw new Error('SUCCESSOR_V3_NATIVE_POLICY_CONTRACT_INVALID');
  }
  const expected = {
    scheduleReliabilityContractVersion: contract.contractVersion,
    scheduleReliabilityNumericFreezeSha256: contract.numericFreezeSha256,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
  };
  if (Object.entries(expected).some(([key, value]) => lineage[key] !== value)) {
    throw new Error('SUCCESSOR_V3_NATIVE_POLICY_LINEAGE_MISMATCH');
  }
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(expectedSlot, contract);
  if (slot.split !== expectedSplit) throw new Error('SUCCESSOR_V3_NATIVE_SPLIT_MISMATCH');
  const oosPolicy = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  return Object.freeze({
    sourceContractFamily: SUCCESSOR_SCHEDULE_RELIABILITY_V3,
    scheduleReliabilityContractVersion: contract.contractVersion,
    scheduleReliabilityNumericFreezeSha256: contract.numericFreezeSha256,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    splitMode: contract.policyCore.splits.mode,
    splits: immutableSplitRanges(contract.policyCore.splits),
    oosHorizonContractVersion: SUCCESSOR_OOS_HORIZON_CONTRACT.contractVersion,
    oosHorizonPolicyDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest,
    oosHorizonContractDigest: SUCCESSOR_OOS_HORIZON_CONTRACT.contractDigest,
    oosOutcomeHorizonMs: oosPolicy.outcomeHorizonMs,
    oosOutcomeSelectionPolicy: oosPolicy.outcomeSelectionPolicy,
  });
}

function verifySuccessorMultiLaneLineage(lineage, expectedSlot) {
  const markerFields = [
    'multiLanePolicyVersion', 'multiLanePolicyDigest', 'laneId',
    'laneCreditKey', 'laneCreditKeyDigest', 'globalSlotKey', 'globalSlotKeyDigest',
    'activationBoundaryMs', 'activationSlotIndex', 'activationBoundaryDigest',
    'activationPostMergeRequiredCiRunId', 'activationPostMergeRequiredCiHeadSha',
    'activationCurrentMainBinding',
  ];
  const marked = markerFields.filter((key) => lineage[key] != null);
  if (marked.length === 0) return null;
  if (marked.length !== markerFields.length) throw new Error('PHASE2_SOURCE_LINEAGE_PARTIAL');
  const policy = PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1;
  const verdict = verifyPublicForwardLiquidityMultiLanePolicyV1(policy);
  const lane = policy.laneRegistry.find((item) => item.laneId === lineage.laneId);
  if (!verdict.valid || !lane
    || lineage.multiLanePolicyVersion !== policy.policyVersion
    || lineage.multiLanePolicyDigest !== policy.policyDigest
    || lineage.laneRegistryDigest !== policy.laneRegistryDigest
    || lineage.dependencyPolicyDigest !== policy.dependencyPolicyDigest
    || lineage.balancingPolicyDigest !== policy.balancingPolicyDigest
    || lineage.approvedCheckpointDigest !== policy.approvedCheckpointDigest
    || lineage.approvedCheckpointArtifactId
      !== policy.config.approvedCheckpoint.authoritativeIndexArtifactId
    || lineage.approvedCheckpointArtifactDigest
      !== policy.config.approvedCheckpoint.authoritativeIndexArtifactDigest
    || lineage.scheduleIdentity !== lane.scheduleIdentity
    || lineage.slotIndex !== expectedSlot
    || lineage.maxCreditPerLanePerSlot !== 1
    || lineage.maxTotalCreditPerSlot !== 2
    || lineage.maxCreditPerDependencyComponent !== 1
    || lineage.retroactiveMultiLaneCreditAllowed !== false) {
    throw new Error('PHASE2_SOURCE_LINEAGE_POLICY_INVALID');
  }
  const expectedLaneKey = {
    policyDigest: policy.policyDigest,
    cohortDigest: lineage.cohortDigest,
    slotIndex: expectedSlot,
    laneId: lane.laneId,
    market: lane.market,
    provider: lane.provider,
    symbol: lane.symbol,
    timeframe: lane.timeframe,
  };
  const expectedGlobalKey = {
    policyDigest: policy.policyDigest,
    cohortDigest: lineage.cohortDigest,
    slotIndex: expectedSlot,
  };
  if (canonicalJson(lineage.laneCreditKey) !== canonicalJson(expectedLaneKey)
    || digest(lineage.laneCreditKeyDigest, 'PHASE2_LANE_CREDIT_KEY_DIGEST_INVALID')
      !== sha256(canonicalJson(expectedLaneKey))
    || canonicalJson(lineage.globalSlotKey) !== canonicalJson(expectedGlobalKey)
    || digest(lineage.globalSlotKeyDigest, 'PHASE2_GLOBAL_SLOT_KEY_DIGEST_INVALID')
      !== sha256(canonicalJson(expectedGlobalKey))
    || !Number.isInteger(lineage.activationBoundaryMs)
    || lineage.activationBoundaryMs < 0
    || !Number.isInteger(lineage.activationSlotIndex)
    || lineage.activationSlotIndex < 0
    || expectedSlot < lineage.activationSlotIndex
    || digest(lineage.activationBoundaryDigest, 'PHASE2_ACTIVATION_BOUNDARY_DIGEST_INVALID').length !== 64) {
    throw new Error('PHASE2_SOURCE_LINEAGE_CREDIT_KEY_INVALID');
  }
  const currentMainBinding = object(
    lineage.activationCurrentMainBinding,
    'PHASE2_CURRENT_MAIN_BINDING_REQUIRED',
  );
  const currentMainBindingBody = Object.fromEntries(
    Object.entries(currentMainBinding).filter(([key]) => key !== 'currentMainBindingDigest'),
  );
  const activationCiHeadSha = text(
    lineage.activationPostMergeRequiredCiHeadSha,
    'PHASE2_ACTIVATION_CI_HEAD_SHA_INVALID',
  ).toLowerCase();
  const currentMainSha = text(
    currentMainBinding.currentMainSha,
    'PHASE2_CURRENT_MAIN_SHA_INVALID',
  ).toLowerCase();
  if (!SHA40.test(activationCiHeadSha) || !SHA40.test(currentMainSha)
    || !Number.isInteger(lineage.activationPostMergeRequiredCiRunId)
    || lineage.activationPostMergeRequiredCiRunId <= 0
    || currentMainBinding.schemaVersion
      !== 'public-forward-liquidity-multi-lane-current-main-binding-v1'
    || currentMainBinding.policyDigest !== policy.policyDigest
    || currentMainBinding.activationBoundaryDigest !== lineage.activationBoundaryDigest
    || currentMainBinding.activationCiHeadSha !== activationCiHeadSha
    || currentMainBinding.mergeBaseSha !== activationCiHeadSha
    || (currentMainSha === activationCiHeadSha
      && (currentMainBinding.compareStatus !== 'identical'
        || currentMainBinding.relationship !== 'EXACT_ACTIVATION_CI_HEAD'))
    || (currentMainSha !== activationCiHeadSha
      && (currentMainBinding.compareStatus !== 'ahead'
        || currentMainBinding.relationship !== 'DESCENDANT_OF_ACTIVATION_CI_HEAD'))
    || digest(
      currentMainBinding.currentMainBindingDigest,
      'PHASE2_CURRENT_MAIN_BINDING_DIGEST_INVALID',
    ) !== sha256(canonicalJson(currentMainBindingBody))) {
    throw new Error('PHASE2_CURRENT_MAIN_BINDING_INVALID');
  }
  return Object.freeze({
    laneId: lane.laneId,
    scheduleIdentity: lane.scheduleIdentity,
    multiLanePolicyDigest: policy.policyDigest,
    laneCreditKeyDigest: lineage.laneCreditKeyDigest,
    globalSlotKeyDigest: lineage.globalSlotKeyDigest,
    activationBoundaryMs: lineage.activationBoundaryMs,
    activationSlotIndex: lineage.activationSlotIndex,
    activationBoundaryDigest: lineage.activationBoundaryDigest,
    activationPostMergeRequiredCiRunId: lineage.activationPostMergeRequiredCiRunId,
    activationPostMergeRequiredCiHeadSha: activationCiHeadSha,
    currentMainSha,
    currentMainBindingDigest: currentMainBinding.currentMainBindingDigest,
  });
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
  if (value.genuineScheduledLaneReceiptN != null
    && (!Number.isInteger(value.genuineScheduledLaneReceiptN)
      || value.genuineScheduledLaneReceiptN < value.genuineScheduledSlotN)) {
    throw new Error('PHASE2_GENUINE_LANE_RECEIPT_N_INVALID');
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
    || lineage.sourceContractFamily === CALIBRATION_V3;
  const successorLineage = lineage.sourceContractFamily === SUCCESSOR_SCHEDULE_RELIABILITY_V3;
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
  const successorNativePolicy = successorLineage
    ? verifySuccessorNativePolicyLineage(lineage, expectedSlot, expectedSplit)
    : null;
  const multiLane = successorLineage
    ? verifySuccessorMultiLaneLineage(lineage, expectedSlot)
    : null;
  const calibrationSlot = legacyLineage
    ? verifyCalibrationV3PolicyLineage(lineage, expectedSlot, expectedSplit)
    : null;
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
  if (multiLane && multiLane.currentMainSha !== value.exactMainSha) {
    throw new Error('PHASE2_CURRENT_MAIN_RECEIPT_SHA_MISMATCH');
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
  if (successorLineage) {
    const nativeSlot = buildSuccessorScheduleReliabilityV3SlotDescriptor(
      expectedSlot,
      SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
    );
    if (canonicalJson(canonicalSlotKey) !== canonicalJson(nativeSlot.canonicalSlotKey)) {
      throw new Error('SUCCESSOR_V3_NATIVE_SLOT_KEY_MISMATCH');
    }
  } else if (canonicalJson(canonicalSlotKey) !== canonicalJson(calibrationSlot.canonicalSlotKey)) {
    throw new Error('CALIBRATION_V3_FROZEN_SLOT_KEY_MISMATCH');
  }
  if (!Array.isArray(value.batchObservationIds) || value.batchObservationIds.length === 0) {
    throw new Error('V3_BATCH_OBSERVATION_IDS_REQUIRED');
  }
  return Object.freeze({
    path: expectedPath,
    receipt: value,
    lineage,
    sourceContractFamily: successorLineage
      ? SUCCESSOR_SCHEDULE_RELIABILITY_V3
      : CALIBRATION_V3,
    successorNativePolicy,
    multiLane,
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
  const sourceContractFamilies = new Set();
  const successorNativePolicies = new Map();
  const creditedSlotKeys = new Set();
  const phase2SlotModes = new Map();
  const phase2CandidateCountsBySlot = new Map();
  const phase2ActivationBoundaries = new Map();
  const inventorySourceBindings = new Map();

  for (const source of sourceInventory.sources) {
    object(source, 'V3_SOURCE_INVALID');
    const sourceIdentity = text(source.sourceIdentity, 'V3_SOURCE_IDENTITY_INVALID');
    const paths = exactArray(source.ingestReceiptRelativePaths, 'V3_SOURCE_RECEIPT_PATHS_INVALID');
    const digests = exactArray(source.ingestReceiptDigests, 'V3_SOURCE_RECEIPT_DIGESTS_INVALID');
    const slots = exactArray(source.v3SlotIndexes, 'V3_SOURCE_SLOT_INDEXES_INVALID');
    const splits = exactArray(source.v3Splits, 'V3_SOURCE_SPLITS_INVALID');
    const lanes = source.v3LaneIds == null
      ? paths.map(() => null)
      : exactArray(source.v3LaneIds, 'PHASE2_SOURCE_LANE_IDS_INVALID');
    const creditPolicyDigests = source.v3CreditPolicyDigests == null
      ? paths.map(() => source.v3PolicyDigest)
      : exactArray(source.v3CreditPolicyDigests, 'PHASE2_SOURCE_CREDIT_POLICY_DIGESTS_INVALID');
    const laneCreditKeyDigests = source.v3LaneCreditKeyDigests == null
      ? paths.map(() => null)
      : exactArray(source.v3LaneCreditKeyDigests, 'PHASE2_SOURCE_LANE_KEY_DIGESTS_INVALID');
    const runIds = exactArray(source.captureRunIds, 'V3_SOURCE_RUN_IDS_INVALID');
    const artifactIds = exactArray(source.captureArtifactIds, 'V3_SOURCE_ARTIFACT_IDS_INVALID');
    const artifactDigests = exactArray(source.captureArtifactDigests, 'V3_SOURCE_ARTIFACT_DIGESTS_INVALID');
    if (!paths.length || paths.length !== digests.length || paths.length !== slots.length
      || paths.length !== splits.length || paths.length !== runIds.length
      || paths.length !== artifactIds.length || paths.length !== artifactDigests.length
      || paths.length !== lanes.length || paths.length !== creditPolicyDigests.length
      || paths.length !== laneCreditKeyDigests.length) {
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
      const vectorLaneId = lanes[index] == null
        ? null
        : text(lanes[index], 'PHASE2_SOURCE_LANE_ID_INVALID');
      const vectorCreditPolicyDigest = digest(
        creditPolicyDigests[index],
        'PHASE2_SOURCE_CREDIT_POLICY_DIGEST_INVALID',
      );
      const preliminarySlotCreditKey = vectorLaneId === null
        ? `${source.v3PolicyDigest}\u0000${source.v3CohortDigest}\u0000${slotIndex}`
        : `${vectorCreditPolicyDigest}\u0000${source.v3CohortDigest}\u0000${slotIndex}\u0000${vectorLaneId}`;
      if (creditedSlotKeys.has(preliminarySlotCreditKey)) {
        throw new Error('V3_DUPLICATE_SLOT_CREDIT_FORBIDDEN');
      }
      creditedSlotKeys.add(preliminarySlotCreditKey);
      const receipt = verifyReceipt(byPath.get(path), source, path, expectedDigest, slotIndex, split, {
        expectedRunId,
        expectedArtifactId,
        expectedArtifactDigest,
      });
      const laneId = receipt.multiLane?.laneId ?? null;
      if (lanes[index] !== laneId) throw new Error('PHASE2_SOURCE_LANE_VECTOR_MISMATCH');
      const creditPolicyDigest = receipt.multiLane?.multiLanePolicyDigest ?? source.v3PolicyDigest;
      if (creditPolicyDigests[index] !== creditPolicyDigest) {
        throw new Error('PHASE2_SOURCE_CREDIT_POLICY_VECTOR_MISMATCH');
      }
      const expectedLaneKeyDigest = receipt.multiLane?.laneCreditKeyDigest ?? null;
      if (laneCreditKeyDigests[index] !== expectedLaneKeyDigest) {
        throw new Error('PHASE2_SOURCE_LANE_KEY_VECTOR_MISMATCH');
      }
      const slotMode = laneId === null ? 'LEGACY_SINGLE_LANE' : 'PHASE2_MULTI_LANE';
      const priorMode = phase2SlotModes.get(slotIndex);
      if (priorMode && priorMode !== slotMode) throw new Error('PHASE2_MIXED_SLOT_POLICY_FORBIDDEN');
      phase2SlotModes.set(slotIndex, slotMode);
      const slotCreditKey = laneId === null
        ? `${source.v3PolicyDigest}\u0000${source.v3CohortDigest}\u0000${slotIndex}`
        : `${creditPolicyDigest}\u0000${source.v3CohortDigest}\u0000${slotIndex}\u0000${laneId}`;
      if (slotCreditKey !== preliminarySlotCreditKey) {
        throw new Error('PHASE2_SOURCE_CREDIT_KEY_VECTOR_MISMATCH');
      }
      const nextSlotCandidateN = (phase2CandidateCountsBySlot.get(slotIndex) ?? 0) + 1;
      if (nextSlotCandidateN > (laneId === null ? 1 : 2)) {
        throw new Error('PHASE2_GLOBAL_SLOT_CREDIT_CANDIDATE_CAP_EXCEEDED');
      }
      phase2CandidateCountsBySlot.set(slotIndex, nextSlotCandidateN);
      if (receipt.multiLane) {
        const activationKey = `${receipt.multiLane.activationBoundaryMs}\u0000${receipt.multiLane.activationBoundaryDigest}`;
        phase2ActivationBoundaries.set(activationKey, receipt.multiLane);
      }
      sourceContractFamilies.add(receipt.sourceContractFamily);
      if (receipt.successorNativePolicy) {
        successorNativePolicies.set(
          canonicalJson(receipt.successorNativePolicy),
          receipt.successorNativePolicy,
        );
      }
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
          multiLanePolicyDigest: receipt.multiLane?.multiLanePolicyDigest ?? null,
          laneId,
          scheduleIdentity: receipt.multiLane?.scheduleIdentity ?? null,
          laneCreditKeyDigest: receipt.multiLane?.laneCreditKeyDigest ?? null,
          globalSlotKeyDigest: receipt.multiLane?.globalSlotKeyDigest ?? null,
          activationBoundaryMs: receipt.multiLane?.activationBoundaryMs ?? null,
          activationSlotIndex: receipt.multiLane?.activationSlotIndex ?? null,
          activationBoundaryDigest: receipt.multiLane?.activationBoundaryDigest ?? null,
          activationPostMergeRequiredCiRunId:
            receipt.multiLane?.activationPostMergeRequiredCiRunId ?? null,
          activationPostMergeRequiredCiHeadSha:
            receipt.multiLane?.activationPostMergeRequiredCiHeadSha ?? null,
          currentMainBindingDigest: receipt.multiLane?.currentMainBindingDigest ?? null,
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
  if (sourceInventory.genuineScheduledLaneReceiptN != null
    && sourceInventory.genuineScheduledLaneReceiptN !== creditedReceiptN) {
    throw new Error('PHASE2_GENUINE_LANE_RECEIPT_N_MISMATCH');
  }
  if (sourceContractFamilies.size !== 1) throw new Error('V3_MIXED_SOURCE_CONTRACT_FAMILY_FORBIDDEN');
  const sourceContractFamily = [...sourceContractFamilies][0];
  if ((sourceContractFamily === SUCCESSOR_SCHEDULE_RELIABILITY_V3
      && successorNativePolicies.size !== 1)
    || (sourceContractFamily === CALIBRATION_V3 && successorNativePolicies.size !== 0)) {
    throw new Error('V3_SOURCE_POLICY_FAMILY_BINDING_INVALID');
  }

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
  const laneSplitSideCounts = emptyLaneSplitSideCounts();
  const componentCredits = new Set();
  const creditCandidates = independent.map((item) => {
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
    if ((item.laneId ?? null) !== lineage.laneId) {
      throw new Error('PHASE2_INDEPENDENCE_LANE_LINEAGE_MISMATCH');
    }
    const dependencyComponentId = item?.dependencyComponentId == null && lineage.laneId === null
      ? `legacy-dependency-component:${observationId}`
      : text(item?.dependencyComponentId, 'INDEPENDENT_DEPENDENCY_COMPONENT_ID_INVALID');
    if (componentCredits.has(dependencyComponentId)) {
      throw new Error('PHASE2_DEPENDENCY_COMPONENT_MULTI_CREDIT_FORBIDDEN');
    }
    componentCredits.add(dependencyComponentId);
    return Object.freeze({
      observationId,
      sourceObservationId,
      sourceIdentity: boundSourceIdentity,
      ingestSourceIdentity: sourceIdentity,
      eventIdentity: item.eventIdentity,
      sourceFrameIdentity: item.sourceFrameIdentity,
      dependencyComponentId,
      eventTimestampMs: integer(
        item.observation?.eventTimestampMs,
        'INDEPENDENT_OBSERVATION_TIMESTAMP_INVALID',
      ),
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
      multiLanePolicyDigest: lineage.multiLanePolicyDigest,
      laneId: lineage.laneId,
      scheduleIdentity: lineage.scheduleIdentity,
      laneCreditKeyDigest: lineage.laneCreditKeyDigest,
      globalSlotKeyDigest: lineage.globalSlotKeyDigest,
      activationPostMergeRequiredCiRunId: lineage.activationPostMergeRequiredCiRunId,
      activationPostMergeRequiredCiHeadSha: lineage.activationPostMergeRequiredCiHeadSha,
      activationSlotIndex: lineage.activationSlotIndex,
      currentMainBindingDigest: lineage.currentMainBindingDigest,
      scopeCell: lineage.laneId === null ? null : Object.freeze({
        policyDigest: lineage.multiLanePolicyDigest,
        cohortDigest: lineage.cohortDigest,
        split: lineage.split,
        laneId: lineage.laneId,
        market: item.observation?.market,
        provider: item.observation?.publicDataSource,
        symbol: item.observation?.symbol,
        side,
      }),
    });
  });

  if (phase2ActivationBoundaries.size > 1) {
    throw new Error('PHASE2_MULTIPLE_ACTIVATION_BOUNDARIES_FORBIDDEN');
  }
  const phase2Activation = phase2ActivationBoundaries.size === 1
    ? [...phase2ActivationBoundaries.values()][0]
    : null;
  if (phase2Activation) {
    for (const observation of creditCandidates) {
      if (observation.laneId === null && observation.slotIndex >= phase2Activation.activationSlotIndex) {
        throw new Error('PHASE2_POST_BOUNDARY_LEGACY_CREDIT_FORBIDDEN');
      }
      if (observation.laneId !== null
        && (observation.slotIndex < phase2Activation.activationSlotIndex
          || observation.eventTimestampMs < phase2Activation.activationBoundaryMs)) {
        throw new Error('PHASE2_RETROACTIVE_LANE_CREDIT_FORBIDDEN');
      }
    }
  }
  const laneSlotCredits = new Set();
  const totalCreditsBySlot = new Map();
  const capRejections = [];
  const observations = [...creditCandidates]
    .sort((left, right) => left.eventTimestampMs - right.eventTimestampMs
      || String(left.laneId ?? '').localeCompare(String(right.laneId ?? ''))
      || left.sourceIdentity.localeCompare(right.sourceIdentity)
      || left.observationId.localeCompare(right.observationId))
    .filter((observation) => {
      if (observation.laneId === null) return true;
      const laneSlotKey = `${observation.multiLanePolicyDigest}\u0000${observation.cohortDigest}\u0000${observation.slotIndex}\u0000${observation.laneId}`;
      const globalSlotKey = `${observation.multiLanePolicyDigest}\u0000${observation.cohortDigest}\u0000${observation.slotIndex}`;
      let reason = null;
      if (laneSlotCredits.has(laneSlotKey)) reason = 'PHASE2_LANE_SLOT_CREDIT_CAP_REACHED';
      else if ((totalCreditsBySlot.get(globalSlotKey) ?? 0) >= 2) {
        reason = 'PHASE2_GLOBAL_SLOT_CREDIT_CAP_REACHED';
      }
      if (reason !== null) {
        capRejections.push(Object.freeze({
          observationId: observation.observationId,
          dependencyComponentId: observation.dependencyComponentId,
          laneId: observation.laneId,
          slotIndex: observation.slotIndex,
          eventTimestampMs: observation.eventTimestampMs,
          reason,
          effectiveIndependentCredit: 0,
        }));
        return false;
      }
      laneSlotCredits.add(laneSlotKey);
      totalCreditsBySlot.set(globalSlotKey, (totalCreditsBySlot.get(globalSlotKey) ?? 0) + 1);
      return true;
    });
  for (const observation of observations) {
    addCount(counts, observation.split, observation.aggressiveSide);
    if (observation.laneId !== null) {
      laneSplitSideCounts[observation.laneId][observation.split][observation.aggressiveSide] += 1;
    }
  }
  const preCutoverObservations = phase2Activation
    ? observations.filter((observation) => observation.slotIndex < phase2Activation.activationSlotIndex)
    : [];
  const preCutoverCounts = { TRAIN: 0, VALIDATION: 0, OOS: 0, BUY: 0, SELL: 0 };
  for (const observation of preCutoverObservations) {
    preCutoverCounts[observation.split] += 1;
    preCutoverCounts[observation.aggressiveSide] += 1;
  }
  const preCutoverIndexFreezeBody = phase2Activation
    ? Object.freeze({
        activationBoundaryMs: phase2Activation.activationBoundaryMs,
        activationBoundaryDigest: phase2Activation.activationBoundaryDigest,
        approvedCheckpointDigest: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.approvedCheckpointDigest,
        effectiveIndependentN: preCutoverObservations.length,
        counts: Object.freeze(preCutoverCounts),
        observationIdentityDigest: sha256(canonicalJson(preCutoverObservations.map((observation) => ({
          observationId: observation.observationId,
          eventTimestampMs: observation.eventTimestampMs,
          split: observation.split,
          aggressiveSide: observation.aggressiveSide,
          policyDigest: observation.policyDigest,
          cohortDigest: observation.cohortDigest,
        })))),
        retroactiveMultiLaneCreditAllowed: false,
      })
    : null;
  const preCutoverIndexFreeze = preCutoverIndexFreezeBody
    ? Object.freeze({
        ...preCutoverIndexFreezeBody,
        preCutoverIndexDigest: sha256(canonicalJson(preCutoverIndexFreezeBody)),
      })
    : null;

  if (counts.TRAIN + counts.VALIDATION + counts.OOS !== observations.length) throw new Error('V3_SPLIT_COUNT_MISMATCH');
  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V3_INDEPENDENT_SPLIT_INDEX_VERSION,
    kind: 'PUBLIC_FORWARD_LIQUIDITY_V3_FROZEN_SPLIT_PROPAGATION',
    producerCodeSha: text(producerCodeSha, 'PRODUCER_CODE_SHA_REQUIRED'),
    sourceInventoryDigest: sourceInventory.inventoryDigest,
    sourceContractFamily,
    successorNativePolicy: sourceContractFamily === SUCCESSOR_SCHEDULE_RELIABILITY_V3
      ? [...successorNativePolicies.values()][0]
      : null,
    independenceAuditDigest: digest(result.audit.auditDigest, 'INDEPENDENCE_AUDIT_DIGEST_INVALID'),
    independentSplitSourceDigest: digest(result.splitSource.splitSourceDigest, 'INDEPENDENT_SPLIT_SOURCE_DIGEST_INVALID'),
    policyDigest: [...policyDigests][0],
    cohortDigest: [...cohortDigests][0],
    targetSlotIndex: sourceInventory.targetSlotIndex,
    genuineScheduledSlotN: sourceInventory.genuineScheduledSlotN,
    genuineScheduledLaneReceiptN:
      sourceInventory.genuineScheduledLaneReceiptN ?? creditedReceiptN,
    creditedReceiptN,
    sourceDatasetDigests: Object.freeze([...sourceFinalDigests].sort()),
    preCapIndependentN: creditCandidates.length,
    effectiveIndependentN: observations.length,
    counts: Object.freeze(counts),
    observations: Object.freeze(observations),
    capRejections: Object.freeze(capRejections),
    laneSlotCapRejectedN: capRejections
      .filter((value) => value.reason === 'PHASE2_LANE_SLOT_CREDIT_CAP_REACHED').length,
    globalSlotCapRejectedN: capRejections
      .filter((value) => value.reason === 'PHASE2_GLOBAL_SLOT_CREDIT_CAP_REACHED').length,
    multiLanePolicyVersion: phase2Activation
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyVersion
      : null,
    multiLanePolicyDigest: phase2Activation
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest
      : null,
    laneRegistryDigest: phase2Activation
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.laneRegistryDigest
      : null,
    dependencyPolicyDigest: phase2Activation
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.dependencyPolicyDigest
      : null,
    balancingPolicyDigest: phase2Activation
      ? PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.balancingPolicyDigest
      : null,
    approvedCheckpointDigest: PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.approvedCheckpointDigest,
    approvedCheckpointArtifactId:
      PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.config.approvedCheckpoint.authoritativeIndexArtifactId,
    approvedCheckpointArtifactDigest:
      PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.config.approvedCheckpoint.authoritativeIndexArtifactDigest,
    preCutoverIndexFreeze,
    laneSplitSideCounts: Object.freeze(laneSplitSideCounts),
    scopeCells: Object.freeze(observations.filter((value) => value.scopeCell !== null)
      .map((value) => Object.freeze({
        ...value.scopeCell,
        scopeCellDigest: sha256(canonicalJson(value.scopeCell)),
      }))),
    maxCreditPerLanePerSlot: 1,
    maxTotalCreditPerSlot: 2,
    maxCreditPerDependencyComponent: 1,
    utc27AdditionalIndependentCredit: 0,
    retroactiveMultiLaneCreditAllowed: false,
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
