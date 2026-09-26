import { execFile } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  canonicalJson,
  persistLiquidityCalibrationBatch,
  sha256,
} from './public-forward-liquidity-calibration.mjs';

export const PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION =
  'public-forward-liquidity-capture-receipt-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION =
  'public-forward-liquidity-capture-artifact-receipt-v1';
export const PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION =
  'public-forward-liquidity-capture-ingest-receipt-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const COLLECTOR_IMPLEMENTATION_PATH = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const execFileAsync = promisify(execFile);
const PROTECTED_APPLICATION_STORAGE = Object.freeze([
  '/opt/stock-app-data',
  '/srv/stock-app',
  '/var/lib/stock-app',
]);

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
  const normalized = text(value, code);
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

function withoutReceiptDigest(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptDigest'));
}

export function computePublicForwardLiquidityCaptureIngestReceiptDigest(value) {
  return sha256(canonicalJson(withoutReceiptDigest(object(value, 'RECEIPT_INVALID'))));
}

function verifyReceiptDigest(receipt, code) {
  const expected = exactDigest(receipt.receiptDigest, code);
  const actual = computePublicForwardLiquidityCaptureIngestReceiptDigest(receipt);
  if (actual !== expected) throw new Error(code);
  return expected;
}

function isInside(parent, child) {
  const normalizedParent = `${resolve(parent)}${sep}`;
  const normalizedChild = `${resolve(child)}${sep}`;
  return normalizedChild.startsWith(normalizedParent);
}

export function assertPublicForwardLiquidityResearchStateRoot({ stateRoot, researchRepoRoot }) {
  if (!isAbsolute(stateRoot)) throw new Error('BLOCKED_STORAGE:STATE_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(researchRepoRoot)) throw new Error('BLOCKED_STORAGE:RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE');
  const normalizedStateRoot = resolve(stateRoot);
  const normalizedResearchRoot = resolve(researchRepoRoot);
  if (PROTECTED_APPLICATION_STORAGE.some(
    (protectedRoot) => normalizedStateRoot === protectedRoot || isInside(protectedRoot, normalizedStateRoot),
  )) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_APPLICATION_STORAGE');
  }
  if (isInside(normalizedResearchRoot, normalizedStateRoot)
    || isInside(normalizedStateRoot, normalizedResearchRoot)) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT');
  }
  return normalizedStateRoot;
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
    const line = treeEntry.stdout.trim();
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    if (!match || match[2] !== COLLECTOR_IMPLEMENTATION_PATH) {
      throw new Error('COLLECTOR_IMPLEMENTATION_BLOB_UNPROVEN');
    }
    return exactSha(match[1], 'COLLECTOR_IMPLEMENTATION_BLOB_INVALID');
  } catch (error) {
    if (String(error?.message ?? '').startsWith('COLLECTOR_IMPLEMENTATION_')) throw error;
    throw new Error('COLLECTOR_IMPLEMENTATION_BLOB_UNPROVEN');
  }
}

export function validatePublicForwardLiquidityObservationIdentity(observation) {
  const rawSourceProvenance = object(
    observation?.rawSourceProvenance,
    'OBSERVATION_RAW_SOURCE_PROVENANCE_INVALID',
  );
  const publicTrade = object(
    rawSourceProvenance.publicTrade,
    'OBSERVATION_PUBLIC_TRADE_PROVENANCE_INVALID',
  );
  const aggressiveSide = text(observation.aggressiveSide, 'OBSERVATION_AGGRESSIVE_SIDE_INVALID');
  if (!['BUY', 'SELL'].includes(aggressiveSide)) throw new Error('OBSERVATION_AGGRESSIVE_SIDE_INVALID');
  const identityInput = {
    contract: PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT,
    publicDataSource: text(observation.publicDataSource, 'OBSERVATION_PUBLIC_SOURCE_INVALID'),
    market: text(observation.market, 'OBSERVATION_MARKET_INVALID'),
    symbol: text(observation.symbol, 'OBSERVATION_SYMBOL_INVALID'),
    publicExecutionId: text(publicTrade.publicExecutionId, 'OBSERVATION_PUBLIC_EXECUTION_ID_INVALID'),
    eventTimestampMs: positiveFinite(observation.eventTimestampMs, 'OBSERVATION_EVENT_TIMESTAMP_INVALID'),
    preEventBookDigest: exactDigest(observation.preEventBookDigest, 'OBSERVATION_PRE_EVENT_BOOK_DIGEST_INVALID'),
  };
  const expectedObservationId = `liquidity-observation:${sha256(canonicalJson(identityInput))}`;
  if (observation.observationId !== expectedObservationId) throw new Error('OBSERVATION_ID_MISMATCH');

  const expectedSourceDigest = sha256(canonicalJson({
    identityInput,
    aggressiveSide,
    price: positiveFinite(observation.publicExecutionPrice, 'OBSERVATION_EXECUTION_PRICE_INVALID'),
    quantity: positiveFinite(observation.tradeFlowQuantity, 'OBSERVATION_TRADE_FLOW_QUANTITY_INVALID'),
    rawSourceProvenance,
  }));
  if (exactDigest(observation.sourceDigest, 'OBSERVATION_SOURCE_DIGEST_INVALID') !== expectedSourceDigest) {
    throw new Error('OBSERVATION_SOURCE_DIGEST_MISMATCH');
  }
  return Object.freeze({ observationId: expectedObservationId, sourceDigest: expectedSourceDigest });
}

function assertCaptureTruthBoundary(receipt) {
  if (
    receipt.canonicalDatasetPersistencePerformed !== false
    || receipt.canonicalDatasetCreditApplied !== false
    || receipt.duplicateCreditEvaluated !== false
    || receipt.splitAssignmentPerformed !== false
    || receipt.oosValidationComplete !== false
    || receipt.calibrationArtifactProduced !== false
    || receipt.liquidityImpactPresent !== false
    || receipt.fullCostReady !== false
    || receipt.evidenceCompleteCredit !== 0
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false
    || receipt.realOrders !== 0
  ) throw new Error('CAPTURE_TRUTH_BOUNDARY_INVALID');
}

function assertArtifactTruthBoundary(receipt) {
  if (
    receipt.canonicalDatasetPersistencePerformed !== false
    || receipt.canonicalDatasetCreditApplied !== false
    || receipt.splitAssignmentPerformed !== false
    || receipt.oosValidationComplete !== false
    || receipt.calibrationArtifactProduced !== false
    || receipt.liquidityImpactPresent !== false
    || receipt.fullCostReady !== false
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false
  ) throw new Error('ARTIFACT_TRUTH_BOUNDARY_INVALID');
}

function validateRawBatch(rawBatch, expectedMainSha, capture) {
  const batch = object(rawBatch, 'RAW_BATCH_INVALID');
  if (batch.schemaVersion !== 1
    || batch.kind !== 'public-forward-liquidity-calibration-batch'
    || batch.contract !== PUBLIC_LIQUIDITY_CALIBRATION_CONTRACT
    || batch.sampleClass !== FORWARD_NATURAL_SAMPLE) {
    throw new Error('RAW_BATCH_CONTRACT_INVALID');
  }
  if (batch.capability?.PUBLIC_CALIBRATION_DATA_CAPABLE !== true) throw new Error('RAW_BATCH_CAPABILITY_INVALID');
  if (!Array.isArray(batch.observations) || !Array.isArray(batch.droppedEvents)) throw new Error('RAW_BATCH_SHAPE_INVALID');
  if (batch.observations.length === 0) throw new Error('RAW_BATCH_OBSERVATIONS_EMPTY');
  if (batch.datasetProvenance?.collectorCodeSha !== expectedMainSha) throw new Error('RAW_BATCH_COLLECTOR_SHA_MISMATCH');
  if (batch.datasetProvenance?.eventCount !== batch.observations.length
    || batch.datasetProvenance?.droppedCount !== batch.droppedEvents.length) {
    throw new Error('RAW_BATCH_COUNT_MISMATCH');
  }
  if (batch.datasetProvenance?.rawSource?.provider !== 'BITGET_PUBLIC_UTA_V3'
    || batch.datasetProvenance?.rawSource?.privateApiUsed !== false) {
    throw new Error('RAW_BATCH_PUBLIC_PROVENANCE_INVALID');
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
  if (canonicalJson(capture.datasetProvenance) !== canonicalJson(batch.datasetProvenance)) {
    throw new Error('CAPTURE_DATASET_PROVENANCE_MISMATCH');
  }
  return { batch, rawBatchDigest };
}

export async function ingestPublicForwardLiquidityCapture({
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
  const artifactIdExpected = decimalId(expectedArtifactId, 'EXPECTED_ARTIFACT_ID_INVALID');
  const artifactDigestExpected = exactDigest(expectedArtifactDigest, 'EXPECTED_ARTIFACT_DIGEST_INVALID');

  const capture = object(captureReceipt, 'CAPTURE_RECEIPT_INVALID');
  if (capture.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION
    || capture.evidenceClass !== 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT'
    || capture.triggerSource !== 'MANUAL_WORKFLOW_DISPATCH') {
    throw new Error('CAPTURE_RECEIPT_CONTRACT_INVALID');
  }
  if (capture.captureStatus !== 'PRESENT' || !Array.isArray(capture.blockers) || capture.blockers.length !== 0) {
    throw new Error('CAPTURE_NOT_PRESENT');
  }
  if (capture.repository !== repository) throw new Error('CAPTURE_REPOSITORY_MISMATCH');
  const captureRunId = decimalId(capture.runId, 'CAPTURE_RUN_ID_INVALID');
  const captureRunAttempt = decimalId(capture.runAttempt, 'CAPTURE_RUN_ATTEMPT_INVALID');
  if (exactSha(capture.exactMainSha, 'CAPTURE_MAIN_SHA_INVALID') !== mainSha
    || exactSha(capture.collectorCodeSha, 'CAPTURE_COLLECTOR_SHA_INVALID') !== mainSha) {
    throw new Error('CAPTURE_SHA_MISMATCH');
  }
  if (capture.sampleClass !== FORWARD_NATURAL_SAMPLE) throw new Error('CAPTURE_SAMPLE_CLASS_INVALID');
  assertCaptureTruthBoundary(capture);

  const collectorImplementationBlobSha = await proveCollectorImplementationBlobSha({
    researchRepoRoot,
    exactMainSha: mainSha,
  });
  const { batch, rawBatchDigest } = validateRawBatch(rawBatch, mainSha, capture);

  const artifact = object(artifactReceipt, 'ARTIFACT_RECEIPT_INVALID');
  if (artifact.schemaVersion !== PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION) {
    throw new Error('ARTIFACT_RECEIPT_CONTRACT_INVALID');
  }
  if (exactSha(artifact.exactMainSha, 'ARTIFACT_MAIN_SHA_INVALID') !== mainSha
    || exactSha(artifact.collectorCodeSha, 'ARTIFACT_COLLECTOR_SHA_INVALID') !== mainSha) {
    throw new Error('ARTIFACT_SHA_MISMATCH');
  }
  if (artifact.captureStatus !== 'PRESENT') throw new Error('ARTIFACT_CAPTURE_NOT_PRESENT');
  if (exactDigest(artifact.rawBatchDigest, 'ARTIFACT_RAW_BATCH_DIGEST_INVALID') !== rawBatchDigest) {
    throw new Error('ARTIFACT_RAW_BATCH_DIGEST_MISMATCH');
  }
  if (integer(artifact.prospectiveObservationCount, 'ARTIFACT_OBSERVATION_COUNT_INVALID') !== batch.observations.length) {
    throw new Error('ARTIFACT_OBSERVATION_COUNT_MISMATCH');
  }
  const artifactId = decimalId(artifact.artifactId, 'ARTIFACT_ID_INVALID');
  const artifactDigest = exactDigest(artifact.artifactDigest, 'ARTIFACT_DIGEST_INVALID');
  if (artifactId !== artifactIdExpected) throw new Error('ARTIFACT_ID_EXPECTATION_MISMATCH');
  if (artifactDigest !== artifactDigestExpected) throw new Error('ARTIFACT_DIGEST_EXPECTATION_MISMATCH');
  const expectedArtifactName = `public-forward-liquidity-capture-${captureRunId}-${captureRunAttempt}`;
  const expectedArtifactReference = `https://github.com/${repository}/actions/runs/${captureRunId}/artifacts/${artifactId}`;
  if (artifact.artifactName !== expectedArtifactName) throw new Error('ARTIFACT_NAME_MISMATCH');
  if (artifact.artifactReference !== expectedArtifactReference) throw new Error('ARTIFACT_REFERENCE_MISMATCH');
  assertArtifactTruthBoundary(artifact);
  const captureArtifactReceiptDigest = verifyReceiptDigest(artifact, 'ARTIFACT_RECEIPT_DIGEST_INVALID');

  const persisted = await persistLiquidityCalibrationBatch({
    stateRoot: safeStateRoot,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    batch,
  });
  const datasetRelativePath = relative(safeStateRoot, persisted.datasetPath);
  if (!datasetRelativePath || isAbsolute(datasetRelativePath) || datasetRelativePath.startsWith(`..${sep}`) || datasetRelativePath === '..') {
    throw new Error('DATASET_PATH_ESCAPED_STATE_ROOT');
  }
  const batchObservationIds = Object.freeze(batch.observations.map((observation) => observation.observationId).sort());
  const batchObservationsForDigest = [...batch.observations]
    .sort((left, right) => left.observationId.localeCompare(right.observationId));

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
    captureArtifactReceiptDigest,
    artifactId,
    artifactDigest,
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
  });
  return Object.freeze({
    ...body,
    receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body),
  });
}
