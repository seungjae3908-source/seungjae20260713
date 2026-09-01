import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

import type { PublicForwardPartialFillCalibrationObservation } from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import { publishPublicForwardPartialFillCalibrationDatasetPointer } from './public-forward-partial-fill-calibration-dataset-pointer.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_RECEIPT_VERSION = 'public-forward-partial-fill-capture-receipt-v1' as const;
export const PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_ARTIFACT_RECEIPT_VERSION = 'public-forward-partial-fill-capture-artifact-receipt-v1' as const;
export const PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION = 'public-forward-partial-fill-capture-ingest-receipt-v1' as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const PROTECTED_APPLICATION_STORAGE = Object.freeze(['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app']);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

export function computePublicForwardPartialFillReceiptDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function bodyWithoutDigest(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptDigest'));
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function string(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function decimalId(value: unknown, code: string): string {
  const normalized = string(value, code);
  if (!DECIMAL_ID.test(normalized)) throw new Error(code);
  return normalized;
}

function exactSha(value: unknown, code: string): string {
  const normalized = string(value, code).toLowerCase();
  if (!COMMIT_SHA.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value: unknown, code: string): string {
  const normalized = string(value, code).replace(/^sha256:/u, '').toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function verifyReceiptDigest(receipt: Record<string, unknown>, code: string): string {
  const digest = exactDigest(receipt.receiptDigest, code);
  if (computePublicForwardPartialFillReceiptDigest(bodyWithoutDigest(receipt)) !== digest) throw new Error(code);
  return digest;
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent) + sep;
  const normalizedChild = resolve(child) + sep;
  return normalizedChild.startsWith(normalizedParent);
}

export function assertPublicForwardPartialFillResearchStateRoot(input: Readonly<{
  stateRoot: string;
  researchRepoRoot: string;
}>): string {
  if (!isAbsolute(input.stateRoot)) throw new Error('BLOCKED_STORAGE:STATE_ROOT_MUST_BE_ABSOLUTE');
  if (!isAbsolute(input.researchRepoRoot)) throw new Error('BLOCKED_STORAGE:RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE');
  const stateRoot = resolve(input.stateRoot);
  const researchRepoRoot = resolve(input.researchRepoRoot);
  if (PROTECTED_APPLICATION_STORAGE.some((protectedRoot) => stateRoot === protectedRoot || isInside(protectedRoot, stateRoot))) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_APPLICATION_STORAGE');
  }
  if (isInside(resolve(researchRepoRoot, 'stock-analyzer'), stateRoot)) {
    throw new Error('BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_RESEARCH_CHECKOUT');
  }
  return stateRoot;
}

function assertFalseBoundary(receipt: Record<string, unknown>, prefix: string): void {
  if (receipt.durableDatasetPersistencePerformed !== false
    || receipt.canonicalDatasetCreditApplied !== false
    || receipt.calibrationArtifactProduced !== false
    || receipt.partialFillCostPresent !== false
    || receipt.fullCostReady !== false
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false) throw new Error(`${prefix}_TRUTH_BOUNDARY_INVALID`);
}

export type PublicForwardPartialFillCaptureIngestResult = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION;
  captureReceiptDigest: string;
  captureArtifactReceiptDigest: string;
  exactMainSha: string;
  repository: string;
  captureRunId: string;
  captureRunAttempt: string;
  observationId: string;
  sourceObservationLineageDigest: string;
  artifactId: string;
  artifactDigest: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetRelativePath: string;
  insertedObservationCount: number;
  duplicateObservationCount: number;
  durableDatasetPersistencePerformed: boolean;
  canonicalDatasetCreditApplied: boolean;
  duplicateCreditEvaluated: true;
  calibrationArtifactProduced: false;
  partialFillCostPresent: false;
  fullCostReady: false;
  evidenceCompleteCredit: 0;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
  receiptDigest: string;
}>;

export async function ingestPublicForwardPartialFillCalibrationCapture(input: Readonly<{
  stateRoot: string;
  researchRepoRoot: string;
  expectedMainSha: string;
  expectedRepository: string;
  expectedArtifactId: string;
  expectedArtifactDigest: string;
  captureReceipt: unknown;
  artifactReceipt: unknown;
  nowMs?: number;
}>): Promise<PublicForwardPartialFillCaptureIngestResult> {
  const safeStateRoot = assertPublicForwardPartialFillResearchStateRoot({
    stateRoot: input.stateRoot,
    researchRepoRoot: input.researchRepoRoot,
  });
  const expectedMainSha = exactSha(input.expectedMainSha, 'EXPECTED_MAIN_SHA_INVALID');
  const expectedRepository = string(input.expectedRepository, 'EXPECTED_REPOSITORY_INVALID');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)) throw new Error('EXPECTED_REPOSITORY_INVALID');
  const expectedArtifactId = decimalId(input.expectedArtifactId, 'EXPECTED_ARTIFACT_ID_INVALID');
  const expectedArtifactDigest = exactDigest(input.expectedArtifactDigest, 'EXPECTED_ARTIFACT_DIGEST_INVALID');

  const capture = object(input.captureReceipt, 'CAPTURE_RECEIPT_INVALID');
  if (capture.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_RECEIPT_VERSION) throw new Error('CAPTURE_SCHEMA_INVALID');
  if (capture.evidenceClass !== 'PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_RECEIPT') throw new Error('CAPTURE_EVIDENCE_CLASS_INVALID');
  if (capture.triggerSource !== 'MANUAL_WORKFLOW_DISPATCH') throw new Error('CAPTURE_TRIGGER_INVALID');
  if (capture.repository !== expectedRepository) throw new Error('CAPTURE_REPOSITORY_MISMATCH');
  const captureRunId = decimalId(capture.runId, 'CAPTURE_RUN_ID_INVALID');
  const captureRunAttempt = decimalId(capture.runAttempt, 'CAPTURE_RUN_ATTEMPT_INVALID');
  if (exactSha(capture.exactMainSha, 'CAPTURE_MAIN_SHA_INVALID') !== expectedMainSha) throw new Error('CAPTURE_MAIN_SHA_MISMATCH');
  if (exactSha(capture.collectorCodeSha, 'CAPTURE_COLLECTOR_SHA_INVALID') !== expectedMainSha) throw new Error('CAPTURE_COLLECTOR_SHA_MISMATCH');
  if (capture.captureStatus !== 'PRESENT') throw new Error('CAPTURE_NOT_PRESENT');
  if (!Array.isArray(capture.blockers) || capture.blockers.length !== 0) throw new Error('CAPTURE_BLOCKERS_PRESENT');
  if (capture.market !== 'CRYPTO_FUTURES') throw new Error('CAPTURE_MARKET_INVALID');
  if (capture.duplicateCreditEvaluated !== false || capture.evidenceCompleteCredit !== 0 || capture.realOrders !== 0) throw new Error('CAPTURE_CREDIT_BOUNDARY_INVALID');
  assertFalseBoundary(capture, 'CAPTURE');
  const captureReceiptDigest = verifyReceiptDigest(capture, 'CAPTURE_RECEIPT_DIGEST_INVALID');

  const observationRecord = object(capture.observation, 'CAPTURE_OBSERVATION_MISSING');
  const observation = observationRecord as unknown as PublicForwardPartialFillCalibrationObservation;
  if (observation.sampleClass !== 'FORWARD_NATURAL_SAMPLE') throw new Error('CAPTURE_SAMPLE_CLASS_INVALID');
  if (observation.collectorCodeSha !== expectedMainSha) throw new Error('OBSERVATION_COLLECTOR_SHA_MISMATCH');
  if (observation.symbol !== capture.symbol || observation.side !== capture.side) throw new Error('CAPTURE_SCOPE_MISMATCH');
  if (observation.requestedQuantity !== capture.requestedQuantity
    || observation.quantityNotionalBucketIdentity !== capture.quantityNotionalBucketIdentity) throw new Error('CAPTURE_QUANTITY_SCOPE_MISMATCH');

  const artifact = object(input.artifactReceipt, 'ARTIFACT_RECEIPT_INVALID');
  if (artifact.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_ARTIFACT_RECEIPT_VERSION) throw new Error('ARTIFACT_SCHEMA_INVALID');
  if (exactDigest(artifact.captureReceiptDigest, 'ARTIFACT_CAPTURE_DIGEST_INVALID') !== captureReceiptDigest) throw new Error('ARTIFACT_CAPTURE_DIGEST_MISMATCH');
  if (artifact.captureStatus !== 'PRESENT') throw new Error('ARTIFACT_CAPTURE_STATUS_INVALID');
  if (exactSha(artifact.exactMainSha, 'ARTIFACT_MAIN_SHA_INVALID') !== expectedMainSha) throw new Error('ARTIFACT_MAIN_SHA_MISMATCH');
  if (artifact.observationId !== observation.observationId) throw new Error('ARTIFACT_OBSERVATION_ID_MISMATCH');
  if (artifact.sourceObservationLineageId !== observation.sourceObservationLineageId
    || artifact.sourceObservationLineageDigest !== observation.sourceObservationLineageDigest) throw new Error('ARTIFACT_LINEAGE_MISMATCH');
  const artifactId = decimalId(artifact.artifactId, 'ARTIFACT_ID_INVALID');
  const artifactDigest = exactDigest(artifact.artifactDigest, 'ARTIFACT_DIGEST_INVALID');
  if (artifactId !== expectedArtifactId) throw new Error('ARTIFACT_ID_EXPECTATION_MISMATCH');
  if (artifactDigest !== expectedArtifactDigest) throw new Error('ARTIFACT_DIGEST_EXPECTATION_MISMATCH');
  const artifactName = string(artifact.artifactName, 'ARTIFACT_NAME_INVALID');
  const artifactReference = string(artifact.artifactReference, 'ARTIFACT_REFERENCE_INVALID');
  const expectedArtifactName = `public-forward-partial-fill-capture-${captureRunId}-${captureRunAttempt}`;
  const expectedArtifactReference = `https://github.com/${expectedRepository}/actions/runs/${captureRunId}/artifacts/${artifactId}`;
  if (artifactName !== expectedArtifactName) throw new Error('ARTIFACT_NAME_MISMATCH');
  if (artifactReference !== expectedArtifactReference) throw new Error('ARTIFACT_REFERENCE_MISMATCH');
  assertFalseBoundary(artifact, 'ARTIFACT');
  const captureArtifactReceiptDigest = verifyReceiptDigest(artifact, 'ARTIFACT_RECEIPT_DIGEST_INVALID');

  const persisted = await persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: safeStateRoot,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha: expectedMainSha,
    observations: [observation],
    nowMs: input.nowMs,
  });

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION,
    captureReceiptDigest,
    captureArtifactReceiptDigest,
    exactMainSha: expectedMainSha,
    repository: expectedRepository,
    captureRunId,
    captureRunAttempt,
    observationId: observation.observationId,
    sourceObservationLineageDigest: observation.sourceObservationLineageDigest,
    artifactId,
    artifactDigest,
    datasetIdentity: persisted.dataset.datasetIdentity,
    datasetDigest: persisted.dataset.datasetDigest,
    datasetRelativePath: persisted.datasetRelativePath,
    insertedObservationCount: persisted.insertedObservationCount,
    duplicateObservationCount: persisted.duplicateObservationCount,
    durableDatasetPersistencePerformed: persisted.changed,
    canonicalDatasetCreditApplied: persisted.insertedObservationCount === 1,
    duplicateCreditEvaluated: true as const,
    calibrationArtifactProduced: false as const,
    partialFillCostPresent: false as const,
    fullCostReady: false as const,
    evidenceCompleteCredit: 0 as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
  const result = Object.freeze({ ...body, receiptDigest: computePublicForwardPartialFillReceiptDigest(body) });

  await publishPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot: safeStateRoot,
    researchRepoRoot: input.researchRepoRoot,
    dataset: persisted.dataset,
    mutableDatasetRelativePath: persisted.datasetRelativePath,
    sourceIngestReceiptDigest: result.receiptDigest,
    sourceIngestReceiptRef: `ingest-receipt:sha256:${result.receiptDigest}`,
    publicationProvenance: Object.freeze({
      authority: 'CANONICAL_INGEST_PRODUCER' as const,
      repository: expectedRepository,
      exactMainSha: expectedMainSha,
      captureRunId,
      captureRunAttempt,
      artifactId,
    }),
  });

  return result;
}
