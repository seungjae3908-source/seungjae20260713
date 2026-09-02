import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  type PublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  type PublicForwardPartialFillCalibrationDatasetPointer,
  verifyPublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';
import {
  publicForwardPartialFillReleaseBindingRelativePath,
  type PublicForwardPartialFillCalibrationReleaseBinding,
  verifyPublicForwardPartialFillCalibrationReleaseBinding,
} from './public-forward-partial-fill-calibration-release-binding.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_VERSION =
  'public-forward-partial-fill-calibration-runtime-binding-resolver-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_SAFETY = Object.freeze({
  readOnly: true,
  directoryScanAllowed: false,
  latestSelectionAllowed: false,
  mtimeSelectionAllowed: false,
  largestNSelectionAllowed: false,
  lexicalSelectionAllowed: false,
  ciArtifactSelectionAllowed: false,
  runtimeActivationPerformed: false,
  productionPolicyAuthorityConnected: false,
  calibrationSampleSufficient: false,
  partialFillCostPresent: false,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
});

export type PublicForwardPartialFillRuntimeBindingResolverInput = Readonly<{
  stateRoot: string;
  releaseBindingRef: string;
  releaseBindingDigest: string;
  runtimeReleaseSha: string;
}>;

export type PublicForwardPartialFillResolvedRuntimeDatasetBinding = Readonly<{
  resolverVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_VERSION;
  runtimeBindingSource: 'IMMUTABLE_RELEASE_BINDING';
  stateRoot: string;
  releaseBindingRef: string;
  releaseBindingDigest: string;
  approvedMainSha: string;
  datasetPointerIdentity: string;
  datasetPointerRef: string;
  datasetPointerDigest: string;
  datasetRelativePath: string;
  storeContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  sampleClass: PublicForwardPartialFillCalibrationDataset['sampleClass'];
  collectorCodeSha: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetBytesDigest: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactDigest(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function exactCommitSha(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return COMMIT_SHA.test(normalized) ? normalized : null;
}

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

function resolveRelativeInside(root: string, locator: string, errorCode: string): string {
  if (!safeRelativeLocator(locator)) throw new Error(errorCode);
  const resolved = resolve(root, locator);
  if (!pathInside(root, resolved) || resolved === resolve(root)) throw new Error(errorCode);
  return resolved;
}

async function canonicalStateRoot(stateRoot: string): Promise<string> {
  if (!isAbsolute(stateRoot)) throw new Error('STATE_ROOT_AUTHORITY_MISSING');
  const lexical = resolve(stateRoot);
  let meta;
  try {
    meta = await lstat(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('STATE_ROOT_NOT_AVAILABLE');
    throw error;
  }
  if (meta.isSymbolicLink() || !meta.isDirectory()) throw new Error('STATE_ROOT_NOT_AVAILABLE');
  const canonical = await realpath(lexical);
  const canonicalMeta = await stat(canonical);
  if (!canonicalMeta.isDirectory()) throw new Error('STATE_ROOT_NOT_AVAILABLE');
  return canonical;
}

async function readRegularFileInside(
  root: string,
  locator: string,
  missingCode: string,
  locatorCode: string,
): Promise<Readonly<{ path: string; bytes: Buffer }>> {
  const lexicalPath = resolveRelativeInside(root, locator, locatorCode);
  let meta;
  try {
    meta = await lstat(lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missingCode);
    throw error;
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new Error(locatorCode);
  const canonicalPath = await realpath(lexicalPath);
  if (!pathInside(root, canonicalPath)) throw new Error(locatorCode);
  return Object.freeze({ path: canonicalPath, bytes: await readFile(canonicalPath) });
}

function parseJson<T>(bytes: Buffer, errorCode: string): T {
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new Error(errorCode);
  }
}

function throwReleaseBindingVerification(blockers: readonly string[]): never {
  if (blockers.includes('RELEASE_BINDING_SCHEMA_INVALID')) throw new Error('RELEASE_BINDING_SCHEMA_INVALID');
  if (blockers.includes('RELEASE_BINDING_DIGEST_MISMATCH')) throw new Error('RELEASE_BINDING_DIGEST_MISMATCH');
  if (blockers.includes('RELEASE_BINDING_AUTHORITY_INVALID')) throw new Error('RELEASE_BINDING_AUTHORITY_INVALID');
  if (blockers.includes('RELEASE_BINDING_POINTER_MISMATCH')) throw new Error('RELEASE_BINDING_POINTER_MISMATCH');
  throw new Error('RUNTIME_BINDING_NOT_EVALUABLE');
}

function throwPointerVerification(blockers: readonly string[]): never {
  if (blockers.includes('POINTER_SCHEMA_INVALID')) throw new Error('POINTER_SCHEMA_INVALID');
  if (blockers.includes('POINTER_DIGEST_MISMATCH')) throw new Error('POINTER_DIGEST_MISMATCH');
  if (blockers.includes('POINTER_LOCATOR_INVALID')) throw new Error('POINTER_LOCATOR_INVALID');
  if (blockers.includes('POINTER_STORE_CONTRACT_MISMATCH')) throw new Error('DATASET_STORE_CONTRACT_MISMATCH');
  if (blockers.includes('POINTER_SAMPLE_CLASS_MISMATCH')) throw new Error('DATASET_SAMPLE_CLASS_MISMATCH');
  if (blockers.includes('POINTER_COLLECTOR_SHA_MISMATCH')) throw new Error('DATASET_COLLECTOR_SHA_MISMATCH');
  if (blockers.includes('POINTER_DATASET_IDENTITY_MISMATCH')) throw new Error('DATASET_IDENTITY_MISMATCH');
  if (blockers.includes('POINTER_DATASET_DIGEST_MISMATCH')) throw new Error('DATASET_SEMANTIC_DIGEST_MISMATCH');
  if (blockers.includes('POINTER_DATASET_BYTES_DIGEST_MISMATCH')) throw new Error('DATASET_BYTES_DIGEST_MISMATCH');
  throw new Error('RUNTIME_BINDING_NOT_EVALUABLE');
}

function verifyDatasetAgainstPointer(
  dataset: PublicForwardPartialFillCalibrationDataset,
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
): void {
  if (dataset.datasetIdentity !== pointer.datasetIdentity) throw new Error('DATASET_IDENTITY_MISMATCH');
  if (dataset.datasetDigest !== pointer.datasetDigest) throw new Error('DATASET_SEMANTIC_DIGEST_MISMATCH');
  if (dataset.sampleClass !== pointer.sampleClass) throw new Error('DATASET_SAMPLE_CLASS_MISMATCH');
  if (dataset.collectorCodeSha !== pointer.collectorCodeSha) throw new Error('DATASET_COLLECTOR_SHA_MISMATCH');
  if (dataset.storeContract !== pointer.storeContract) throw new Error('DATASET_STORE_CONTRACT_MISMATCH');
  const verification = verifyPublicForwardPartialFillCalibrationDataset(dataset);
  if (!verification.valid) throw new Error('DATASET_SEMANTIC_DIGEST_MISMATCH');
}

export async function resolvePublicForwardPartialFillCalibrationRuntimeBinding(
  input: PublicForwardPartialFillRuntimeBindingResolverInput,
): Promise<PublicForwardPartialFillResolvedRuntimeDatasetBinding> {
  const releaseBindingRef = String(input.releaseBindingRef ?? '').trim();
  if (!releaseBindingRef) throw new Error('RELEASE_BINDING_REF_MISSING');
  const releaseBindingDigest = exactDigest(input.releaseBindingDigest);
  if (!releaseBindingDigest) throw new Error('RELEASE_BINDING_DIGEST_MISMATCH');
  const runtimeReleaseSha = exactCommitSha(input.runtimeReleaseSha);
  if (!runtimeReleaseSha) throw new Error('RELEASE_BINDING_MAIN_SHA_MISMATCH');

  const stateRoot = await canonicalStateRoot(input.stateRoot);
  if (!safeRelativeLocator(releaseBindingRef)) throw new Error('RELEASE_BINDING_REF_MISSING');

  const bindingFile = await readRegularFileInside(
    stateRoot,
    releaseBindingRef,
    'RELEASE_BINDING_NOT_FOUND',
    'RELEASE_BINDING_REF_MISSING',
  );
  const binding = parseJson<PublicForwardPartialFillCalibrationReleaseBinding>(
    bindingFile.bytes,
    'RELEASE_BINDING_SCHEMA_INVALID',
  );
  const bindingVerification = verifyPublicForwardPartialFillCalibrationReleaseBinding(
    binding,
    undefined,
    { requirePublicationRecord: true },
  );
  if (!bindingVerification.valid) throwReleaseBindingVerification(bindingVerification.blockers);
  if (binding.releaseBindingDigest !== releaseBindingDigest) throw new Error('RELEASE_BINDING_DIGEST_MISMATCH');
  if (releaseBindingRef !== publicForwardPartialFillReleaseBindingRelativePath(binding.releaseBindingDigest)) {
    throw new Error('RELEASE_BINDING_REF_MISSING');
  }
  if (binding.approvedMainSha !== runtimeReleaseSha
    || binding.publicationProvenance.exactMainSha !== runtimeReleaseSha) {
    throw new Error('RELEASE_BINDING_MAIN_SHA_MISMATCH');
  }
  if (binding.datasetPointerRef.length === 0) throw new Error('RELEASE_BINDING_POINTER_MISSING');

  const pointerFile = await readRegularFileInside(
    stateRoot,
    binding.datasetPointerRef,
    'POINTER_NOT_FOUND',
    'POINTER_LOCATOR_INVALID',
  );
  const pointer = parseJson<PublicForwardPartialFillCalibrationDatasetPointer>(
    pointerFile.bytes,
    'POINTER_SCHEMA_INVALID',
  );
  const pointerVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(pointer, {
    pointerDigest: binding.datasetPointerDigest,
    storeContract: binding.expectedStoreContract,
  });
  if (!pointerVerification.valid) throwPointerVerification(pointerVerification.blockers);
  if (pointer.pointerIdentity !== binding.datasetPointerIdentity
    || pointer.pointerRelativePath !== binding.datasetPointerRef
    || pointer.pointerDigest !== binding.datasetPointerDigest) {
    throw new Error('RELEASE_BINDING_POINTER_MISMATCH');
  }

  const datasetFile = await readRegularFileInside(
    stateRoot,
    pointer.datasetRelativePath,
    'DATASET_NOT_FOUND',
    'POINTER_LOCATOR_INVALID',
  );
  if (sha256Bytes(datasetFile.bytes) !== pointer.datasetBytesDigest) {
    throw new Error('DATASET_BYTES_DIGEST_MISMATCH');
  }
  const dataset = parseJson<PublicForwardPartialFillCalibrationDataset>(
    datasetFile.bytes,
    'DATASET_SEMANTIC_DIGEST_MISMATCH',
  );
  verifyDatasetAgainstPointer(dataset, pointer);

  return Object.freeze({
    resolverVersion: PUBLIC_FORWARD_PARTIAL_FILL_RUNTIME_BINDING_RESOLVER_VERSION,
    runtimeBindingSource: 'IMMUTABLE_RELEASE_BINDING' as const,
    stateRoot,
    releaseBindingRef,
    releaseBindingDigest,
    approvedMainSha: runtimeReleaseSha,
    datasetPointerIdentity: pointer.pointerIdentity,
    datasetPointerRef: pointer.pointerRelativePath,
    datasetPointerDigest: pointer.pointerDigest,
    datasetRelativePath: pointer.datasetRelativePath,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: pointer.sampleClass,
    collectorCodeSha: pointer.collectorCodeSha,
    datasetIdentity: pointer.datasetIdentity,
    datasetDigest: pointer.datasetDigest,
    datasetBytesDigest: pointer.datasetBytesDigest,
  });
}
