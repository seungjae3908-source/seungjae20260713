import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardPartialFillReceiptDigest,
  type PublicForwardPartialFillCaptureIngestResult,
} from './public-forward-partial-fill-calibration-capture-ingest.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  type PublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  publishPublicForwardPartialFillCalibrationDatasetPointer,
  readPublicForwardPartialFillCalibrationDatasetPointer,
  type PublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_VERSION =
  'public-forward-partial-fill-calibration-pointer-recovery-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY = Object.freeze({
  authoritySource: 'FINALIZED_CANONICAL_INGEST_RECEIPT' as const,
  mutableDatasetReadOnly: true,
  ingestReplayAllowed: false,
  observationInsertAllowed: false,
  duplicateCreditAllowed: false,
  sampleCreditDelta: 0,
  directoryScanAllowed: false,
  latestSelectionAllowed: false,
  mtimeSelectionAllowed: false,
  largestNSelectionAllowed: false,
  lexicalSelectionAllowed: false,
  ciArtifactSelectionAllowed: false,
  releaseBindingPublicationPerformed: false,
  runtimeActivationPerformed: false,
  productionPolicyAuthorityConnected: false,
  calibrationSampleSufficient: false,
  partialFillCostPresent: false,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  currentValidatedChampion: 'NONE' as const,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
});

export type PublicForwardPartialFillPointerRecoveryInput = Readonly<{
  stateRoot: string;
  researchRepoRoot: string;
  ingestReceipt: unknown;
}>;

export type PublicForwardPartialFillPointerRecoveryResult = Readonly<{
  recoveryVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_VERSION;
  authoritySource: 'FINALIZED_CANONICAL_INGEST_RECEIPT';
  sourceIngestReceiptDigest: string;
  sourceIngestReceiptRef: string;
  pointerRelativeRef: string;
  pointerIdentity: string;
  pointerDigest: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetBytesDigest: string;
  datasetRelativePath: string;
  collectorCodeSha: string;
  sampleClass: PublicForwardPartialFillCalibrationDataset['sampleClass'];
  storeContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  captureRunId: string;
  captureRunAttempt: string;
  artifactId: string;
  observationCount: number;
  forwardCalibrationSampleCreditCount: number;
  immutableDatasetCreated: boolean;
  pointerCreated: boolean;
  mutableDatasetChanged: false;
  observationInsertCount: 0;
  duplicateCreditCount: 0;
  sampleCreditDelta: 0;
  releaseBindingPublicationPerformed: false;
  runtimeActivationPerformed: false;
  productionPolicyAuthorityConnected: false;
  partialFillCostPresent: false;
  fullCostReady: false;
  evidenceComplete: 0;
  profitabilityProven: false;
  executionAuthority: 'NONE';
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function safeRelativeLocator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || isAbsolute(value) || value.includes('\\')) {
    return false;
  }
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function exactCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function decimalId(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_ID.test(value);
}

function expectedMutableDatasetRelativePath(dataset: PublicForwardPartialFillCalibrationDataset): string {
  return `forward/partial-fill-calibration-v1/${dataset.sampleClass.toLowerCase()}/${dataset.collectorCodeSha}/dataset.json`;
}

function verifyFinalizedIngestReceipt(value: unknown): PublicForwardPartialFillCaptureIngestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('POINTER_RECOVERY_INGEST_RECEIPT_INVALID');
  const receipt = value as Partial<PublicForwardPartialFillCaptureIngestResult>;

  if (receipt.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION) {
    throw new Error('POINTER_RECOVERY_INGEST_RECEIPT_SCHEMA_INVALID');
  }
  if (!exactDigest(receipt.captureReceiptDigest)
    || !exactDigest(receipt.captureArtifactReceiptDigest)
    || !exactCommitSha(receipt.exactMainSha)
    || !REPOSITORY.test(String(receipt.repository ?? ''))
    || !decimalId(receipt.captureRunId)
    || !decimalId(receipt.captureRunAttempt)
    || !decimalId(receipt.artifactId)
    || !exactDigest(receipt.artifactDigest)
    || !exactDigest(receipt.sourceObservationLineageDigest)
    || !exactDigest(receipt.datasetDigest)
    || !exactDigest(receipt.receiptDigest)
    || typeof receipt.datasetIdentity !== 'string'
    || receipt.datasetIdentity.length === 0
    || !safeRelativeLocator(receipt.datasetRelativePath)) {
    throw new Error('POINTER_RECOVERY_INGEST_RECEIPT_IDENTITY_INVALID');
  }

  if (receipt.insertedObservationCount !== 1
    || receipt.duplicateObservationCount !== 0
    || receipt.durableDatasetPersistencePerformed !== true
    || receipt.canonicalDatasetCreditApplied !== true
    || receipt.duplicateCreditEvaluated !== true
    || receipt.calibrationArtifactProduced !== false
    || receipt.partialFillCostPresent !== false
    || receipt.fullCostReady !== false
    || receipt.evidenceCompleteCredit !== 0
    || receipt.naturalEntryCredit !== 0
    || receipt.runtimeCostCredit !== 0
    || receipt.executionAuthority !== 'NONE'
    || receipt.privateApiUsed !== false
    || receipt.liveTrading !== false
    || receipt.orderSubmitted !== false) {
    throw new Error('POINTER_RECOVERY_INGEST_RECEIPT_TRUTH_BOUNDARY_INVALID');
  }

  const typed = receipt as PublicForwardPartialFillCaptureIngestResult;
  const { receiptDigest: _receiptDigest, ...body } = typed;
  if (computePublicForwardPartialFillReceiptDigest(body) !== typed.receiptDigest) {
    throw new Error('POINTER_RECOVERY_INGEST_RECEIPT_DIGEST_MISMATCH');
  }
  return typed;
}

async function canonicalStateRoot(stateRoot: string): Promise<string> {
  if (!isAbsolute(stateRoot)) throw new Error('POINTER_RECOVERY_STATE_ROOT_AUTHORITY_MISSING');
  const lexical = resolve(stateRoot);
  let meta;
  try {
    meta = await lstat(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('POINTER_RECOVERY_STATE_ROOT_NOT_AVAILABLE');
    throw error;
  }
  if (meta.isSymbolicLink() || !meta.isDirectory()) throw new Error('POINTER_RECOVERY_STATE_ROOT_NOT_AVAILABLE');
  const canonical = await realpath(lexical);
  const canonicalMeta = await stat(canonical);
  if (!canonicalMeta.isDirectory()) throw new Error('POINTER_RECOVERY_STATE_ROOT_NOT_AVAILABLE');
  return canonical;
}

async function readExactMutableDataset(
  stateRoot: string,
  receipt: PublicForwardPartialFillCaptureIngestResult,
): Promise<Readonly<{ dataset: PublicForwardPartialFillCalibrationDataset; bytes: Buffer }>> {
  const datasetPath = resolve(stateRoot, receipt.datasetRelativePath);
  if (!pathInside(stateRoot, datasetPath) || datasetPath === stateRoot) throw new Error('POINTER_RECOVERY_DATASET_LOCATOR_INVALID');

  let meta;
  try {
    meta = await lstat(datasetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('POINTER_RECOVERY_DATASET_NOT_FOUND');
    throw error;
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new Error('POINTER_RECOVERY_DATASET_LOCATOR_INVALID');
  const canonicalPath = await realpath(datasetPath);
  if (!pathInside(stateRoot, canonicalPath) || canonicalPath !== datasetPath) {
    throw new Error('POINTER_RECOVERY_DATASET_LOCATOR_INVALID');
  }

  const bytes = await readFile(canonicalPath);
  let dataset: PublicForwardPartialFillCalibrationDataset;
  try {
    dataset = JSON.parse(bytes.toString('utf8')) as PublicForwardPartialFillCalibrationDataset;
  } catch {
    throw new Error('POINTER_RECOVERY_DATASET_SCHEMA_INVALID');
  }
  const verification = verifyPublicForwardPartialFillCalibrationDataset(dataset);
  if (!verification.valid) throw new Error(`POINTER_RECOVERY_DATASET_INVALID:${verification.blockers.join(',')}`);

  if (dataset.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    throw new Error('POINTER_RECOVERY_STORE_CONTRACT_MISMATCH');
  }
  if (dataset.datasetIdentity !== receipt.datasetIdentity) throw new Error('POINTER_RECOVERY_DATASET_IDENTITY_MISMATCH');
  if (dataset.datasetDigest !== receipt.datasetDigest) throw new Error('POINTER_RECOVERY_DATASET_DIGEST_MISMATCH');
  if (dataset.collectorCodeSha !== receipt.exactMainSha) throw new Error('POINTER_RECOVERY_COLLECTOR_SHA_MISMATCH');
  if (receipt.datasetRelativePath !== expectedMutableDatasetRelativePath(dataset)) {
    throw new Error('POINTER_RECOVERY_DATASET_LOCATOR_INVALID');
  }

  return Object.freeze({ dataset, bytes });
}

function assertRecoveredPointer(
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
  receipt: PublicForwardPartialFillCaptureIngestResult,
  dataset: PublicForwardPartialFillCalibrationDataset,
): void {
  if (pointer.sourceIngestReceiptDigest !== receipt.receiptDigest
    || pointer.sourceIngestReceiptRef !== `ingest-receipt:sha256:${receipt.receiptDigest}`
    || pointer.datasetIdentity !== dataset.datasetIdentity
    || pointer.datasetDigest !== dataset.datasetDigest
    || pointer.collectorCodeSha !== dataset.collectorCodeSha
    || pointer.sampleClass !== dataset.sampleClass
    || pointer.storeContract !== dataset.storeContract
    || pointer.publicationProvenance.authority !== 'CANONICAL_INGEST_PRODUCER'
    || pointer.publicationProvenance.repository !== receipt.repository
    || pointer.publicationProvenance.exactMainSha !== receipt.exactMainSha
    || pointer.publicationProvenance.captureRunId !== receipt.captureRunId
    || pointer.publicationProvenance.captureRunAttempt !== receipt.captureRunAttempt
    || pointer.publicationProvenance.artifactId !== receipt.artifactId) {
    throw new Error('POINTER_RECOVERY_READBACK_MISMATCH');
  }
}

export async function recoverPublicForwardPartialFillCalibrationDatasetPointer(
  input: PublicForwardPartialFillPointerRecoveryInput,
): Promise<PublicForwardPartialFillPointerRecoveryResult> {
  if (!isAbsolute(input.researchRepoRoot)) throw new Error('POINTER_RECOVERY_RESEARCH_REPO_ROOT_INVALID');
  const receipt = verifyFinalizedIngestReceipt(input.ingestReceipt);
  const stateRoot = await canonicalStateRoot(input.stateRoot);
  const before = await readExactMutableDataset(stateRoot, receipt);

  const publication = await publishPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot,
    researchRepoRoot: input.researchRepoRoot,
    dataset: before.dataset,
    mutableDatasetRelativePath: receipt.datasetRelativePath,
    sourceIngestReceiptDigest: receipt.receiptDigest,
    sourceIngestReceiptRef: `ingest-receipt:sha256:${receipt.receiptDigest}`,
    publicationProvenance: Object.freeze({
      authority: 'CANONICAL_INGEST_PRODUCER' as const,
      repository: receipt.repository,
      exactMainSha: receipt.exactMainSha,
      captureRunId: receipt.captureRunId,
      captureRunAttempt: receipt.captureRunAttempt,
      artifactId: receipt.artifactId,
    }),
  });

  const afterBytes = await readFile(resolve(stateRoot, receipt.datasetRelativePath));
  if (!before.bytes.equals(afterBytes)) throw new Error('POINTER_RECOVERY_MUTABLE_DATASET_CHANGED');

  const readback = await readPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot,
    researchRepoRoot: input.researchRepoRoot,
    pointerRelativePath: publication.pointer.pointerRelativePath,
    expectedPointerDigest: publication.pointer.pointerDigest,
  });
  assertRecoveredPointer(readback.pointer, receipt, before.dataset);

  return Object.freeze({
    recoveryVersion: PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_VERSION,
    authoritySource: 'FINALIZED_CANONICAL_INGEST_RECEIPT' as const,
    sourceIngestReceiptDigest: receipt.receiptDigest,
    sourceIngestReceiptRef: `ingest-receipt:sha256:${receipt.receiptDigest}`,
    pointerRelativeRef: readback.pointer.pointerRelativePath,
    pointerIdentity: readback.pointer.pointerIdentity,
    pointerDigest: readback.pointer.pointerDigest,
    datasetIdentity: readback.pointer.datasetIdentity,
    datasetDigest: readback.pointer.datasetDigest,
    datasetBytesDigest: readback.pointer.datasetBytesDigest,
    datasetRelativePath: readback.pointer.datasetRelativePath,
    collectorCodeSha: readback.pointer.collectorCodeSha,
    sampleClass: readback.pointer.sampleClass,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    captureRunId: receipt.captureRunId,
    captureRunAttempt: receipt.captureRunAttempt,
    artifactId: receipt.artifactId,
    observationCount: readback.dataset.observationCount,
    forwardCalibrationSampleCreditCount: readback.dataset.forwardCalibrationSampleCreditCount,
    immutableDatasetCreated: publication.immutableDatasetCreated,
    pointerCreated: publication.pointerCreated,
    mutableDatasetChanged: false as const,
    observationInsertCount: 0 as const,
    duplicateCreditCount: 0 as const,
    sampleCreditDelta: 0 as const,
    releaseBindingPublicationPerformed: false as const,
    runtimeActivationPerformed: false as const,
    productionPolicyAuthorityConnected: false as const,
    partialFillCostPresent: false as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    profitabilityProven: false as const,
    executionAuthority: 'NONE' as const,
  });
}
