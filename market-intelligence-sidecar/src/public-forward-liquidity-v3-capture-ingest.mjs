import { execFile } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  canonicalJson,
  persistLiquidityCalibrationBatch,
  sha256,
} from './public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  assertPublicForwardLiquidityResearchStateRoot,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
  validatePublicForwardLiquidityObservationIdentity,
} from './public-forward-liquidity-capture-ingest.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  SCHEDULED_TRIGGER_SOURCE,
  V3_POLICY_BINDING,
  buildV3SlotDescriptor,
} from './public-forward-liquidity-capture-seam-v3.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_RECEIPT_VERSION =
  'public-forward-liquidity-capture-receipt-v3';
export const PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_ARTIFACT_RECEIPT_VERSION =
  'public-forward-liquidity-capture-artifact-receipt-v3';
export const PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_EVIDENCE_CLASS =
  'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ATTEMPT_RECEIPT';
export const PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_VERSION =
  'public-forward-liquidity-v3-activation-contract-v1';
export const PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_DIGEST =
  'ea8ee8f151ff58647c1e56cb0ccf7b85f42cb14f118b059eb9a1725c9dc19e60';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const COLLECTOR_IMPLEMENTATION_PATH =
  'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const execFileAsync = promisify(execFile);

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function integer(value, code) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function positiveFinite(value, code) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isFinite(parsed) && parsed > 0)) throw new Error(code);
  return parsed;
}

function decimalId(value, code) {
  const normalized = text(String(value ?? ''), code);
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
}

function exactSha(value, code) {
  const normalized = text(value, code).toLowerCase();
  if (!GIT_OBJECT_SHA.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = text(value, code).replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function exactStringArray(value, expected, code) {
  if (!Array.isArray(value) || canonicalJson(value) !== canonicalJson(expected)) throw new Error(code);
}

function withoutKey(value, key) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function verifyCanonicalDigest(value, digestKey, code) {
  const digest = exactDigest(value[digestKey], code);
  if (digest !== sha256(canonicalJson(withoutKey(value, digestKey)))) throw new Error(code);
  return digest;
}

function assertCommonNoAuthorityBoundary(value, { duplicateCreditEvaluated }) {
  if (value.canonicalDatasetPersistencePerformed !== false
    || value.canonicalDatasetCreditApplied !== false
    || value.duplicateCreditEvaluated !== duplicateCreditEvaluated
    || value.splitAssignmentPerformed !== false
    || value.oosValidationComplete !== false
    || value.calibrationArtifactProduced !== false
    || value.liquidityImpactPresent !== false
    || value.fullCostReady !== false
    || value.evidenceCompleteCredit !== 0
    || value.naturalEntryCredit !== 0
    || value.runtimeCostCredit !== 0
    || value.executionAuthority !== 'NONE'
    || value.privateApiUsed !== false
    || value.liveTrading !== false
    || value.orderSubmitted !== false
    || value.realOrders !== 0) {
    throw new Error('V3_CAPTURE_TRUTH_BOUNDARY_INVALID');
  }
}

async function proveCollectorImplementationBlobSha({ researchRepoRoot, exactMainSha }) {
  const repoRoot = resolve(researchRepoRoot);
  try {
    const commitType = await execFileAsync(
      'git',
      ['-C', repoRoot, 'cat-file', '-t', `${exactMainSha}^{commit}`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    if (commitType.stdout.trim() !== 'commit') throw new Error('COLLECTOR_IMPLEMENTATION_COMMIT_UNPROVEN');
    const treeEntry = await execFileAsync(
      'git',
      ['-C', repoRoot, 'ls-tree', exactMainSha, '--', COLLECTOR_IMPLEMENTATION_PATH],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(treeEntry.stdout.trim());
    if (!match || match[2] !== COLLECTOR_IMPLEMENTATION_PATH) {
      throw new Error('COLLECTOR_IMPLEMENTATION_BLOB_UNPROVEN');
    }
    return exactSha(match[1], 'COLLECTOR_IMPLEMENTATION_BLOB_INVALID');
  } catch (error) {
    if (String(error?.message ?? '').startsWith('COLLECTOR_IMPLEMENTATION_')) throw error;
    throw new Error('COLLECTOR_IMPLEMENTATION_BLOB_UNPROVEN');
  }
}

function verifyScheduledIdentity(capture) {
  if (capture.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_RECEIPT_VERSION
    || capture.evidenceClass !== PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_EVIDENCE_CLASS
    || capture.triggerSource !== SCHEDULED_TRIGGER_SOURCE) {
    throw new Error('V3_CAPTURE_RECEIPT_CONTRACT_INVALID');
  }
  if (capture.ATTEMPTED !== true || capture.collectorInvoked !== true
    || capture.captureStatus !== 'PRESENT'
    || !Array.isArray(capture.blockers) || capture.blockers.length !== 0
    || capture.prospectiveSlotCredit !== 1
    || capture.manualCredit !== 0
    || capture.replayCredit !== 0
    || capture.backfillCredit !== 0
    || capture.operatorSelectedCredit !== 0) {
    throw new Error('V3_CAPTURE_CREDIT_BOUNDARY_INVALID');
  }
  if (capture.activationContractVersion !== PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_VERSION
    || exactDigest(capture.activationContractDigest, 'V3_ACTIVATION_DIGEST_INVALID')
      !== PUBLIC_FORWARD_LIQUIDITY_V3_ACTIVATION_CONTRACT_DIGEST) {
    throw new Error('V3_ACTIVATION_CONTRACT_MISMATCH');
  }

  const expectedPairs = [
    ['policyVersion', V3_POLICY_BINDING.policyVersion],
    ['policyDigest', V3_POLICY_BINDING.policyDigest],
    ['policyArtifactId', V3_POLICY_BINDING.policyArtifactId],
    ['policyArtifactDigest', V3_POLICY_BINDING.policyArtifactDigest],
    ['policyInternalArtifactDigest', V3_POLICY_BINDING.policyInternalArtifactDigest],
    ['cohortId', V3_POLICY_BINDING.cohortId],
    ['cohortDigest', V3_POLICY_BINDING.cohortDigest],
    ['cohortEligibleAfterMs', V3_POLICY_BINDING.cohortEligibleAfterMs],
    ['captureSelectionPolicyDigest', V3_POLICY_BINDING.captureSelectionPolicyDigest],
    ['slotIntervalMs', V3_POLICY_BINDING.slotIntervalMs],
    ['market', V3_POLICY_BINDING.market],
    ['symbol', V3_POLICY_BINDING.symbol],
  ];
  for (const [key, expected] of expectedPairs) {
    if (capture[key] !== expected) throw new Error(`V3_${String(key).toUpperCase()}_MISMATCH`);
  }
  if (capture.captureParameterPolicyDigest !== CAPTURE_PARAMETER_POLICY_DIGEST
    || capture.eventObservationDelayMs !== CAPTURE_PARAMETER_POLICY.eventObservationDelayMs
    || canonicalJson(capture.postObservationDelaysMs) !== canonicalJson(CAPTURE_PARAMETER_POLICY.postObservationDelaysMs)
    || capture.maxPreEventBookAgeMs !== CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs) {
    throw new Error('V3_CAPTURE_PARAMETER_POLICY_MISMATCH');
  }
  if (exactSha(capture.collectorImplementationBlobSha, 'V3_COLLECTOR_IMPLEMENTATION_BLOB_INVALID')
    !== CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha) {
    throw new Error('V3_COLLECTOR_IMPLEMENTATION_BLOB_MISMATCH');
  }

  const slotIndex = integer(capture.slotIndex, 'V3_SLOT_INDEX_INVALID');
  const slot = buildV3SlotDescriptor(slotIndex);
  for (const key of [
    'split', 'slotStartMs', 'slotEndMs', 'nominalScheduledAtMs', 'cronUtc', 'canonicalSlotKeyDigest',
  ]) {
    if (capture[key] !== slot[key]) throw new Error(`V3_SLOT_${key.toUpperCase()}_MISMATCH`);
  }
  if (canonicalJson(capture.canonicalSlotKey) !== canonicalJson(slot.canonicalSlotKey)) {
    throw new Error('V3_CANONICAL_SLOT_KEY_MISMATCH');
  }
  const startedAtMs = integer(capture.actualRunStartedAtMs, 'V3_ACTUAL_RUN_STARTED_AT_INVALID');
  const completedAtMs = integer(capture.actualRunCompletedAtMs, 'V3_ACTUAL_RUN_COMPLETED_AT_INVALID');
  if (startedAtMs < slot.nominalScheduledAtMs || startedAtMs >= slot.slotEndMs
    || completedAtMs < startedAtMs || completedAtMs >= slot.slotEndMs) {
    throw new Error('V3_SLOT_CHRONOLOGY_INVALID');
  }
  if (capture.runAttempt !== '1') throw new Error('V3_RERUN_CREDIT_FORBIDDEN');
  if (capture.sampleClass !== FORWARD_NATURAL_SAMPLE) throw new Error('V3_SAMPLE_CLASS_INVALID');
  assertCommonNoAuthorityBoundary(capture, { duplicateCreditEvaluated: true });
  verifyCanonicalDigest(capture, 'captureReceiptDigest', 'V3_CAPTURE_RECEIPT_DIGEST_INVALID');
  return slot;
}

function validateRawBatch(rawBatch, expectedMainSha, capture) {
  const batch = object(rawBatch, 'RAW_BATCH_INVALID');
  if (batch.schemaVersion !== 1
    || batch.kind !== 'public-forward-liquidity-calibration-batch'
    || batch.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || batch.sampleClass !== FORWARD_NATURAL_SAMPLE) {
    throw new Error('RAW_BATCH_CONTRACT_INVALID');
  }
  if (batch.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true
    || !Array.isArray(batch.observations)
    || !Array.isArray(batch.droppedEvents)
    || batch.observations.length === 0) {
    throw new Error('RAW_BATCH_SHAPE_INVALID');
  }
  if (batch.datasetProvenance?.collectorCodeSha !== expectedMainSha
    || batch.datasetProvenance?.eventCount !== batch.observations.length
    || batch.datasetProvenance?.droppedCount !== batch.droppedEvents.length
    || batch.datasetProvenance?.rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || batch.datasetProvenance?.rawSource?.privateApiUsed !== false) {
    throw new Error('RAW_BATCH_PROVENANCE_INVALID');
  }
  if (batch.readiness?.LIQUIDITY_IMPACT_PRESENT !== false
    || batch.readiness?.CALIBRATION_SAMPLE_SUFFICIENT !== false
    || batch.readiness?.LIQUIDITY_IMPACT_STATUS !== 'BLOCKED_DATA'
    || batch.readiness?.FULL_COST_READY !== false) {
    throw new Error('RAW_BATCH_READINESS_ESCALATION');
  }
  if (batch.safety?.publicDataOnly !== true
    || batch.safety?.executionAuthority !== 'NONE'
    || batch.safety?.privateTradingApiAllowed !== false
    || batch.safety?.liveTradingAllowed !== false
    || batch.safety?.realOrderAllowed !== false
    || batch.safety?.financialMutationAllowed !== false) {
    throw new Error('RAW_BATCH_SAFETY_INVALID');
  }

  const ids = new Set();
  for (const observation of batch.observations) {
    const observationId = text(observation?.observationId, 'OBSERVATION_ID_INVALID');
    if (ids.has(observationId)) throw new Error('RAW_BATCH_DUPLICATE_OBSERVATION_ID');
    ids.add(observationId);
    if (observation.sampleClass !== FORWARD_NATURAL_SAMPLE
      || observation.forwardCalibrationSampleCredit !== 1
      || observation.historicalBackfillForwardCredit !== 0
      || observation.collectorCodeSha !== expectedMainSha
      || observation.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
      || observation.calibrationSourceOnly !== true
      || observation.executionCostEligible !== false
      || observation.liquidityImpactCoefficient !== null
      || observation.causalMarketImpactClaim !== false
      || observation.paperOrderSourceAllowed !== false) {
      throw new Error('OBSERVATION_AUTHORITY_INVALID');
    }
    validatePublicForwardLiquidityObservationIdentity(observation);
  }

  const rawBatchDigest = sha256(canonicalJson(batch));
  if (exactDigest(capture.rawBatchDigest, 'CAPTURE_RAW_BATCH_DIGEST_INVALID') !== rawBatchDigest) {
    throw new Error('CAPTURE_RAW_BATCH_DIGEST_MISMATCH');
  }
  if (integer(capture.prospectiveObservationCount, 'CAPTURE_OBSERVATION_COUNT_INVALID') !== batch.observations.length
    || integer(capture.droppedObservationCount, 'CAPTURE_DROPPED_COUNT_INVALID') !== batch.droppedEvents.length) {
    throw new Error('CAPTURE_RAW_BATCH_COUNT_MISMATCH');
  }
  return { batch, rawBatchDigest };
}

function validateArtifactReceipt(artifactReceipt, capture, slot, {
  expectedArtifactId,
  expectedArtifactDigest,
  expectedRepository,
}) {
  const artifact = object(artifactReceipt, 'V3_ARTIFACT_RECEIPT_INVALID');
  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_ARTIFACT_RECEIPT_VERSION) {
    throw new Error('V3_ARTIFACT_RECEIPT_VERSION_INVALID');
  }
  const {
    schemaVersion: _artifactSchema,
    artifactId,
    artifactName,
    artifactDigest,
    artifactReference,
    receiptDigest,
    ...artifactCaptureFields
  } = artifact;
  const { schemaVersion: _captureSchema, ...captureFields } = capture;
  if (canonicalJson(artifactCaptureFields) !== canonicalJson(captureFields)) {
    throw new Error('V3_ARTIFACT_CAPTURE_BINDING_MISMATCH');
  }
  const id = decimalId(artifactId, 'V3_ARTIFACT_ID_INVALID');
  const digest = exactDigest(artifactDigest, 'V3_ARTIFACT_DIGEST_INVALID');
  if (id !== decimalId(expectedArtifactId, 'EXPECTED_ARTIFACT_ID_INVALID')) {
    throw new Error('ARTIFACT_ID_EXPECTATION_MISMATCH');
  }
  if (digest !== exactDigest(expectedArtifactDigest, 'EXPECTED_ARTIFACT_DIGEST_INVALID')) {
    throw new Error('ARTIFACT_DIGEST_EXPECTATION_MISMATCH');
  }
  const expectedName = `public-forward-liquidity-v3-slot-${slot.slotIndex}-${slot.canonicalSlotKeyDigest}`;
  const expectedReference = `https://github.com/${expectedRepository}/actions/runs/${capture.runId}/artifacts/${id}`;
  if (artifactName !== expectedName) throw new Error('V3_ARTIFACT_NAME_MISMATCH');
  if (artifactReference !== expectedReference) throw new Error('V3_ARTIFACT_REFERENCE_MISMATCH');
  const actualReceiptDigest = exactDigest(receiptDigest, 'V3_ARTIFACT_RECEIPT_DIGEST_INVALID');
  if (actualReceiptDigest !== sha256(canonicalJson(withoutKey(artifact, 'receiptDigest')))) {
    throw new Error('V3_ARTIFACT_RECEIPT_DIGEST_MISMATCH');
  }
  return { artifactId: id, artifactDigest: digest, artifactReceiptDigest: actualReceiptDigest };
}

export async function ingestPublicForwardLiquidityV3Capture({
  stateRoot,
  researchRepoRoot,
  expectedMainSha,
  expectedRepository,
  expectedArtifactId,
  expectedArtifactDigest,
  rawBatch,
  captureReceipt,
  artifactReceipt,
}) {
  const safeStateRoot = assertPublicForwardLiquidityResearchStateRoot({ stateRoot, researchRepoRoot });
  const mainSha = exactSha(expectedMainSha, 'EXPECTED_MAIN_SHA_INVALID');
  const repository = text(expectedRepository, 'EXPECTED_REPOSITORY_INVALID');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('EXPECTED_REPOSITORY_INVALID');

  const capture = object(captureReceipt, 'V3_CAPTURE_RECEIPT_INVALID');
  const slot = verifyScheduledIdentity(capture);
  if (capture.repository !== repository) throw new Error('CAPTURE_REPOSITORY_MISMATCH');
  const captureRunId = decimalId(capture.runId, 'CAPTURE_RUN_ID_INVALID');
  const captureRunAttempt = decimalId(capture.runAttempt, 'CAPTURE_RUN_ATTEMPT_INVALID');
  if (exactSha(capture.exactMainSha, 'CAPTURE_MAIN_SHA_INVALID') !== mainSha
    || exactSha(capture.collectorCodeSha, 'CAPTURE_COLLECTOR_SHA_INVALID') !== mainSha) {
    throw new Error('CAPTURE_SHA_MISMATCH');
  }

  const collectorImplementationBlobSha = await proveCollectorImplementationBlobSha({
    researchRepoRoot,
    exactMainSha: mainSha,
  });
  if (collectorImplementationBlobSha !== CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha) {
    throw new Error('COLLECTOR_IMPLEMENTATION_FROZEN_BLOB_MISMATCH');
  }
  const { batch, rawBatchDigest } = validateRawBatch(rawBatch, mainSha, capture);
  const artifact = validateArtifactReceipt(artifactReceipt, capture, slot, {
    expectedArtifactId,
    expectedArtifactDigest,
    expectedRepository: repository,
  });

  const persisted = await persistLiquidityCalibrationBatch({
    stateRoot: safeStateRoot,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    batch,
  });
  const datasetRelativePath = relative(safeStateRoot, persisted.datasetPath);
  if (!datasetRelativePath || datasetRelativePath === '..' || datasetRelativePath.startsWith(`..${sep}`)) {
    throw new Error('DATASET_PATH_ESCAPED_STATE_ROOT');
  }
  const batchObservationIds = Object.freeze(batch.observations.map((observation) => observation.observationId).sort());
  const batchObservationsForDigest = [...batch.observations].sort(
    (left, right) => left.observationId.localeCompare(right.observationId),
  );
  const sourceV3Lineage = Object.freeze({
    captureReceiptVersion: capture.schemaVersion,
    captureReceiptDigest: capture.captureReceiptDigest,
    artifactReceiptVersion: PUBLIC_FORWARD_LIQUIDITY_V3_CAPTURE_ARTIFACT_RECEIPT_VERSION,
    artifactReceiptDigest: artifact.artifactReceiptDigest,
    triggerSource: capture.triggerSource,
    policyVersion: capture.policyVersion,
    policyDigest: capture.policyDigest,
    policyArtifactId: capture.policyArtifactId,
    policyArtifactDigest: capture.policyArtifactDigest,
    policyInternalArtifactDigest: capture.policyInternalArtifactDigest,
    cohortId: capture.cohortId,
    cohortDigest: capture.cohortDigest,
    captureSelectionPolicyDigest: capture.captureSelectionPolicyDigest,
    slotIntervalMs: capture.slotIntervalMs,
    slotIndex: slot.slotIndex,
    split: slot.split,
    slotStartMs: slot.slotStartMs,
    slotEndMs: slot.slotEndMs,
    nominalScheduledAtMs: slot.nominalScheduledAtMs,
    actualRunStartedAtMs: capture.actualRunStartedAtMs,
    actualRunCompletedAtMs: capture.actualRunCompletedAtMs,
    cronUtc: slot.cronUtc,
    canonicalSlotKey: slot.canonicalSlotKey,
    canonicalSlotKeyDigest: slot.canonicalSlotKeyDigest,
    prospectiveSlotCredit: 1,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    operatorSelectedCredit: 0,
  });

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    exactMainSha: mainSha,
    collectorCodeSha: persisted.dataset.collectorCodeSha,
    collectorImplementationPath: COLLECTOR_IMPLEMENTATION_PATH,
    collectorImplementationBlobSha,
    repository,
    sampleClass: batch.sampleClass,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    captureRunId,
    captureRunAttempt,
    rawBatchDigest,
    batchObservationIds,
    batchObservationCount: batch.observations.length,
    batchObservationDigest: sha256(canonicalJson(batchObservationsForDigest)),
    batchDatasetProvenanceDigest: sha256(canonicalJson(batch.datasetProvenance)),
    batchProvenanceIndex: persisted.dataset.batchProvenance.length - 1,
    captureArtifactReceiptDigest: artifact.artifactReceiptDigest,
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    predecessorDatasetDigest: persisted.dataset.predecessorDigest ?? null,
    datasetDigest: persisted.dataset.datasetDigest,
    datasetRelativePath,
    datasetObservationCount: persisted.dataset.observations.length,
    datasetBatchProvenanceCount: persisted.dataset.batchProvenance.length,
    datasetDuplicateAttemptCount: persisted.dataset.duplicateAttempts.length,
    insertedObservationCount: persisted.insertedObservationCount,
    duplicateObservationCount: persisted.duplicateObservationCount,
    rawIngestObservationDelta: persisted.insertedObservationCount,
    forwardCalibrationSampleCreditDelta: 0,
    independenceEvaluated: false,
    effectiveIndependentCalibrationN: null,
    calibrationSampleSufficient: false,
    independentSampleCreditAuthority: 'NONE_UNTIL_CANONICAL_INDEPENDENCE_TRANSFORM',
    canonicalDatasetPersistencePerformed: true,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: true,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    realOrders: 0,
    sourceV3Lineage,
  });
  return Object.freeze({
    ...body,
    receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body),
  });
}
