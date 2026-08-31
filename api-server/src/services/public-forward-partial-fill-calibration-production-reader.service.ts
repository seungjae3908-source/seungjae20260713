import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { PublicForwardPartialFillSampleClass } from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  type PublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  auditPublicForwardPartialFillCalibrationSplits,
  type PublicForwardPartialFillRegimeBinding,
  type PublicForwardPartialFillSplitAuditResult,
  type PublicForwardPartialFillSplitPolicy,
} from './public-forward-partial-fill-calibration-split-audit.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_VERSION =
  'public-forward-partial-fill-calibration-production-reader-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_SAFETY = Object.freeze({
  readOnly: true,
  existingCanonicalStateRootRequired: true,
  expectedDatasetIdentityRequired: true,
  expectedDatasetDigestRequired: true,
  protectedApplicationStorageAllowed: false,
  symlinkDatasetAllowed: false,
  missingDatasetBecomesEmpty: false,
  malformedDatasetBecomesEmpty: false,
  duplicateTruthMaskingAllowed: false,
  effectiveIndependentNProduced: false,
  buySellSemanticRemapAllowed: false,
  productionPolicyRequiredForSufficiency: true,
  productionPolicyAuthorityConnected: false,
  defaultSampleThresholdAllowed: false,
  calibrationArtifactProduced: false,
  partialFillCostProduced: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  fullCostReady: false,
  evidenceComplete: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

export type PublicForwardPartialFillProductionReaderInput = Readonly<{
  stateRoot: string;
  storeContract: string;
  sampleClass: PublicForwardPartialFillSampleClass;
  collectorCodeSha: string;
  expectedDatasetIdentity: string;
  expectedDatasetDigest: string;
}>;

export type PublicForwardPartialFillProductionDatasetRead = Readonly<{
  readerVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_VERSION;
  dataset: PublicForwardPartialFillCalibrationDataset;
  stateRoot: string;
  datasetRelativePath: string;
  readOnly: true;
}>;

export type PublicForwardPartialFillProductionSufficiencyStatus =
  | 'NOT_EVALUABLE_POLICY_MISSING'
  | 'NOT_EVALUABLE_POLICY_AUTHORITY_NOT_CONNECTED';

export type PublicForwardPartialFillProductionSplitAuditReadback = Readonly<{
  readerVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_VERSION;
  datasetReadback: 'PASS';
  splitAuditConnected: true;
  splitAuditExecuted: boolean;
  productionCallerConnected: false;
  productionPolicyPresent: boolean;
  productionPolicyAuthorityConnected: false;
  sufficiencyStatus: PublicForwardPartialFillProductionSufficiencyStatus;
  calibrationSampleSufficient: false;
  splitAuditResult: PublicForwardPartialFillSplitAuditResult | null;
  datasetIdentity: string;
  datasetDigest: string;
  rawN: number;
  uniqueN: number;
  longN: number;
  shortN: number;
  actualFillObservedN: number;
  queuePositionKnownN: number;
  calibrationArtifactProduced: false;
  partialFillCostPresent: false;
  fullCostReady: false;
  evidenceComplete: 0;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
}>;

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROTECTED_EXACT_OR_PREFIX_ROOTS = Object.freeze([
  '/app',
  '/workspace',
  '/workspaces',
  '/home/runner/work',
  '/opt/investment-research/current',
  '/opt/investment-research/releases',
]);
const PROTECTED_PATH_SEGMENTS = new Set(['checkout', 'checkouts']);

function exactCommitSha(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return COMMIT_SHA.test(normalized) ? normalized : null;
}

function exactSha256(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function normalizedPortablePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
}

function assertStateRootNotProtected(stateRoot: string): void {
  const normalized = normalizedPortablePath(stateRoot);
  if (PROTECTED_EXACT_OR_PREFIX_ROOTS.some((protectedRoot) => (
    normalized === protectedRoot || normalized.startsWith(`${protectedRoot}/`)
  ))) {
    throw new Error('BLOCKED_READER:PROTECTED_APPLICATION_STORAGE');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => PROTECTED_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error('BLOCKED_READER:PROTECTED_CHECKOUT_STORAGE');
  }
}

function canonicalDatasetIdentity(sampleClass: PublicForwardPartialFillSampleClass, collectorCodeSha: string): string {
  return `partial-fill-forward-dataset:${sampleClass}:${collectorCodeSha}`;
}

function canonicalDatasetRelativePath(
  sampleClass: PublicForwardPartialFillSampleClass,
  collectorCodeSha: string,
): string {
  return [
    'forward',
    'partial-fill-calibration-v1',
    sampleClass.toLowerCase(),
    collectorCodeSha,
    'dataset.json',
  ].join('/');
}

function validateReaderInput(input: PublicForwardPartialFillProductionReaderInput): Readonly<{
  lexicalStateRoot: string;
  collectorCodeSha: string;
  expectedDatasetIdentity: string;
  expectedDatasetDigest: string;
  datasetRelativePath: string;
}> {
  if (input.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    throw new Error('BLOCKED_READER:STORE_CONTRACT_MISMATCH');
  }
  if (!['FORWARD_NATURAL_SAMPLE', 'CALIBRATION_RESEARCH_SAMPLE'].includes(input.sampleClass)) {
    throw new Error('BLOCKED_READER:SAMPLE_CLASS_INVALID');
  }
  const collectorCodeSha = exactCommitSha(input.collectorCodeSha);
  if (!collectorCodeSha) throw new Error('BLOCKED_READER:COLLECTOR_CODE_SHA_INVALID');
  const expectedDatasetIdentity = String(input.expectedDatasetIdentity ?? '').trim();
  const canonicalIdentity = canonicalDatasetIdentity(input.sampleClass, collectorCodeSha);
  if (expectedDatasetIdentity !== canonicalIdentity) {
    throw new Error('BLOCKED_READER:EXPECTED_DATASET_IDENTITY_INVALID');
  }
  const expectedDatasetDigest = exactSha256(input.expectedDatasetDigest);
  if (!expectedDatasetDigest) throw new Error('BLOCKED_READER:EXPECTED_DATASET_DIGEST_INVALID');
  if (!isAbsolute(input.stateRoot)) throw new Error('BLOCKED_READER:STATE_ROOT_MUST_BE_ABSOLUTE');

  const lexicalStateRoot = resolve(input.stateRoot);
  assertStateRootNotProtected(lexicalStateRoot);
  const datasetRelativePath = canonicalDatasetRelativePath(input.sampleClass, collectorCodeSha);
  const datasetPath = resolve(lexicalStateRoot, datasetRelativePath);
  const lexicalRelative = relative(lexicalStateRoot, datasetPath);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new Error('BLOCKED_READER:DATASET_PATH_OUTSIDE_STATE_ROOT');
  }
  if (normalizedPortablePath(lexicalRelative) !== datasetRelativePath) {
    throw new Error('BLOCKED_READER:UNEXPECTED_DATASET_PATH');
  }

  return Object.freeze({
    lexicalStateRoot,
    collectorCodeSha,
    expectedDatasetIdentity,
    expectedDatasetDigest,
    datasetRelativePath,
  });
}

function assertPersistedStructure(value: unknown): asserts value is PublicForwardPartialFillCalibrationDataset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DATASET_CORRUPT:INVALID_PERSISTED_STRUCTURE');
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.observations)) {
    throw new Error('DATASET_CORRUPT:INVALID_PERSISTED_STRUCTURE');
  }
  for (const stored of candidate.observations) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new Error('DATASET_CORRUPT:INVALID_PERSISTED_STRUCTURE');
    }
    const observation = (stored as Record<string, unknown>).observation;
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new Error('DATASET_CORRUPT:INVALID_PERSISTED_STRUCTURE');
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function readPublicForwardPartialFillCalibrationDatasetReadOnly(
  input: PublicForwardPartialFillProductionReaderInput,
): Promise<PublicForwardPartialFillProductionDatasetRead> {
  const validated = validateReaderInput(input);
  let rootStat;
  try {
    rootStat = await stat(validated.lexicalStateRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('BLOCKED_READER:STATE_ROOT_MISSING');
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error('BLOCKED_READER:STATE_ROOT_NOT_DIRECTORY');

  const canonicalStateRoot = await realpath(validated.lexicalStateRoot);
  assertStateRootNotProtected(canonicalStateRoot);
  const lexicalDatasetPath = resolve(validated.lexicalStateRoot, validated.datasetRelativePath);
  let datasetLstat;
  try {
    datasetLstat = await lstat(lexicalDatasetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('BLOCKED_READER:DATASET_MISSING');
    throw error;
  }
  if (datasetLstat.isSymbolicLink()) throw new Error('BLOCKED_READER:DATASET_SYMLINK_FORBIDDEN');
  if (!datasetLstat.isFile()) throw new Error('BLOCKED_READER:DATASET_NOT_REGULAR_FILE');

  const canonicalDatasetPath = await realpath(lexicalDatasetPath);
  const canonicalRelative = relative(canonicalStateRoot, canonicalDatasetPath);
  if (!canonicalRelative || canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
    throw new Error('BLOCKED_READER:DATASET_PATH_OUTSIDE_STATE_ROOT');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonicalDatasetPath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('DATASET_CORRUPT:INVALID_JSON');
    throw error;
  }
  assertPersistedStructure(parsed);
  const dataset = parsed;

  if (dataset.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION) {
    throw new Error('DATASET_CORRUPT:DATASET_SCHEMA_INVALID');
  }
  if (dataset.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    throw new Error('DATASET_CORRUPT:DATASET_STORE_CONTRACT_INVALID');
  }
  if (dataset.sampleClass !== input.sampleClass) throw new Error('DATASET_CORRUPT:DATASET_SAMPLE_CLASS_MISMATCH');
  if (dataset.collectorCodeSha !== validated.collectorCodeSha) {
    throw new Error('DATASET_CORRUPT:DATASET_COLLECTOR_SHA_MISMATCH');
  }
  if (dataset.datasetIdentity !== validated.expectedDatasetIdentity) {
    throw new Error('DATASET_CORRUPT:DATASET_IDENTITY_MISMATCH');
  }
  if (dataset.datasetDigest !== validated.expectedDatasetDigest) {
    throw new Error('DATASET_CORRUPT:DATASET_DIGEST_MISMATCH');
  }

  const verification = verifyPublicForwardPartialFillCalibrationDataset(dataset);
  if (!verification.valid) throw new Error(`DATASET_CORRUPT:${verification.blockers.join(',')}`);
  if (dataset.observationCount <= 0) throw new Error('DATASET_CORRUPT:DATASET_EMPTY');

  return Object.freeze({
    readerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_VERSION,
    dataset: deepFreeze(dataset),
    stateRoot: canonicalStateRoot,
    datasetRelativePath: validated.datasetRelativePath,
    readOnly: true as const,
  });
}

function summarizeDataset(dataset: PublicForwardPartialFillCalibrationDataset) {
  const observationIds = new Set<string>();
  let longN = 0;
  let shortN = 0;
  let actualFillObservedN = 0;
  let queuePositionKnownN = 0;
  for (const stored of dataset.observations) {
    observationIds.add(stored.observationId);
    if (stored.observation.side === 'LONG') longN += 1;
    if (stored.observation.side === 'SHORT') shortN += 1;
    actualFillObservedN += Number(stored.observation.actualFillObserved);
    queuePositionKnownN += Number(stored.observation.queuePositionKnown);
  }
  return Object.freeze({
    rawN: dataset.observationCount,
    uniqueN: observationIds.size,
    longN,
    shortN,
    actualFillObservedN,
    queuePositionKnownN,
  });
}

export async function readAndConnectPublicForwardPartialFillCalibrationSplitAudit(input: Readonly<{
  reader: PublicForwardPartialFillProductionReaderInput;
  productionPolicy?: PublicForwardPartialFillSplitPolicy | null;
  regimeBindings?: readonly PublicForwardPartialFillRegimeBinding[] | null;
}>): Promise<PublicForwardPartialFillProductionSplitAuditReadback> {
  const readback = await readPublicForwardPartialFillCalibrationDatasetReadOnly(input.reader);
  const summary = summarizeDataset(readback.dataset);
  const productionPolicyPresent = input.productionPolicy != null;
  let splitAuditResult: PublicForwardPartialFillSplitAuditResult | null = null;
  let splitAuditExecuted = false;

  if (productionPolicyPresent && input.regimeBindings != null) {
    splitAuditResult = auditPublicForwardPartialFillCalibrationSplits({
      dataset: readback.dataset,
      regimeBindings: input.regimeBindings,
      policy: input.productionPolicy as PublicForwardPartialFillSplitPolicy,
    });
    splitAuditExecuted = true;
  }

  return Object.freeze({
    readerVersion: PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_READER_VERSION,
    datasetReadback: 'PASS' as const,
    splitAuditConnected: true as const,
    splitAuditExecuted,
    productionCallerConnected: false as const,
    productionPolicyPresent,
    productionPolicyAuthorityConnected: false as const,
    sufficiencyStatus: productionPolicyPresent
      ? 'NOT_EVALUABLE_POLICY_AUTHORITY_NOT_CONNECTED' as const
      : 'NOT_EVALUABLE_POLICY_MISSING' as const,
    calibrationSampleSufficient: false as const,
    splitAuditResult,
    datasetIdentity: readback.dataset.datasetIdentity,
    datasetDigest: readback.dataset.datasetDigest,
    ...summary,
    calibrationArtifactProduced: false as const,
    partialFillCostPresent: false as const,
    fullCostReady: false as const,
    evidenceComplete: 0 as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
}
