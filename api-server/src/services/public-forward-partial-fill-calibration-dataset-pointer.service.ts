import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  type PublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_VERSION =
  'public-forward-partial-fill-calibration-dataset-pointer-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY = Object.freeze({
  producerAuthority: 'CANONICAL_INGEST_PRODUCER' as const,
  createOnly: true,
  latestFileSelectionAllowed: false,
  mtimeSelectionAllowed: false,
  largestNSelectionAllowed: false,
  lexicalShaSelectionAllowed: false,
  ciArtifactSelectionAllowed: false,
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

export type PublicForwardPartialFillDatasetPointerPublicationProvenance = Readonly<{
  authority: 'CANONICAL_INGEST_PRODUCER';
  repository: string;
  exactMainSha: string;
  captureRunId: string;
  captureRunAttempt: string;
  artifactId: string;
}>;

export type PublicForwardPartialFillCalibrationDatasetPointer = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_VERSION;
  storeContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  sampleClass: PublicForwardPartialFillCalibrationDataset['sampleClass'];
  collectorCodeSha: string;
  datasetIdentity: string;
  datasetDigest: string;
  datasetBytesDigest: string;
  datasetRelativePath: string;
  sourceIngestReceiptDigest: string;
  sourceIngestReceiptRef: string;
  publicationProvenance: PublicForwardPartialFillDatasetPointerPublicationProvenance;
  pointerIdentity: string;
  pointerRelativePath: string;
  publishedAtMs?: number;
  pointerDigest: string;
}>;

export type PublicForwardPartialFillDatasetPointerVerification = Readonly<{
  valid: boolean;
  blockers: readonly string[];
}>;

export type PublicForwardPartialFillDatasetPointerPublicationResult = Readonly<{
  pointer: PublicForwardPartialFillCalibrationDatasetPointer;
  immutableDatasetCreated: boolean;
  pointerCreated: boolean;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DECIMAL_ID = /^[0-9]+$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PROTECTED_APPLICATION_STORAGE = Object.freeze(['/opt/stock-app-data', '/srv/stock-app', '/var/lib/stock-app']);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function bodyWithoutPointerDigest(
  value: PublicForwardPartialFillCalibrationDatasetPointer,
): Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'pointerDigest'),
  ) as Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'>;
}

export function computePublicForwardPartialFillDatasetPointerDigest(
  value: Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'>
    | PublicForwardPartialFillCalibrationDatasetPointer,
): string {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'pointerDigest'));
  return sha256Canonical(body);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function decimalId(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_ID.test(value);
}

function safeRelativeLocator(value: unknown): value is string {
  if (!nonEmpty(value) || isAbsolute(value) || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveRelativeInside(root: string, locator: string, code: string): string {
  if (!safeRelativeLocator(locator)) throw new Error(code);
  const resolved = resolve(root, locator);
  if (!pathInside(root, resolved) || resolved === resolve(root)) throw new Error(code);
  return resolved;
}

function assertSafeStateRoot(input: Readonly<{ stateRoot: string; researchRepoRoot: string }>): string {
  if (!isAbsolute(input.stateRoot)) throw new Error('STATE_ROOT_BINDING_MISSING');
  if (!isAbsolute(input.researchRepoRoot)) throw new Error('POINTER_PROVENANCE_INVALID');
  const root = resolve(input.stateRoot);
  if (PROTECTED_APPLICATION_STORAGE.some((protectedRoot) => pathInside(protectedRoot, root))) {
    throw new Error('POINTER_LOCATOR_INVALID');
  }
  if (pathInside(resolve(input.researchRepoRoot, 'stock-analyzer'), root)) {
    throw new Error('POINTER_LOCATOR_INVALID');
  }
  return root;
}

function immutableDatasetRelativePath(datasetDigest: string): string {
  return `forward/partial-fill-calibration-v1/immutable-datasets/${datasetDigest}/dataset.json`;
}

function pointerRelativePath(datasetDigest: string): string {
  return `forward/partial-fill-calibration-v1/dataset-pointers/${datasetDigest}.json`;
}

function expectedMutableDatasetRelativePath(dataset: PublicForwardPartialFillCalibrationDataset): string {
  return `forward/partial-fill-calibration-v1/${dataset.sampleClass.toLowerCase()}/${dataset.collectorCodeSha}/dataset.json`;
}

function expectedPointerIdentity(datasetDigest: string): string {
  return `${PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_VERSION}:${datasetDigest}`;
}

async function atomicCreateOnly(targetPath: string, bytes: Buffer, conflictCode: string): Promise<boolean> {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, bytes, { flag: 'wx' });
  try {
    try {
      await link(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(targetPath);
      if (!existing.equals(bytes)) throw new Error(conflictCode);
      return false;
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function validateProvenance(
  value: PublicForwardPartialFillDatasetPointerPublicationProvenance | undefined,
  expectedCollectorCodeSha: string,
): boolean {
  return Boolean(value)
    && value!.authority === 'CANONICAL_INGEST_PRODUCER'
    && REPOSITORY.test(value!.repository)
    && exactSha(value!.exactMainSha)
    && value!.exactMainSha === expectedCollectorCodeSha
    && decimalId(value!.captureRunId)
    && decimalId(value!.captureRunAttempt)
    && decimalId(value!.artifactId);
}

export function verifyPublicForwardPartialFillCalibrationDatasetPointer(
  pointer: unknown,
  expected: Readonly<{
    datasetIdentity?: string;
    datasetDigest?: string;
    datasetBytesDigest?: string;
    sampleClass?: PublicForwardPartialFillCalibrationDataset['sampleClass'];
    collectorCodeSha?: string;
    storeContract?: string;
    pointerDigest?: string;
  }> = {},
): PublicForwardPartialFillDatasetPointerVerification {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
    return Object.freeze({ valid: false, blockers: Object.freeze(['POINTER_SCHEMA_INVALID']) });
  }
  const candidate = pointer as Partial<PublicForwardPartialFillCalibrationDatasetPointer>;
  if (candidate.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_VERSION) add('POINTER_SCHEMA_INVALID');
  if (candidate.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) add('POINTER_STORE_CONTRACT_MISMATCH');
  if (!['FORWARD_NATURAL_SAMPLE', 'CALIBRATION_RESEARCH_SAMPLE'].includes(String(candidate.sampleClass))) add('POINTER_SAMPLE_CLASS_MISMATCH');
  if (!exactSha(candidate.collectorCodeSha)) add('POINTER_COLLECTOR_SHA_MISMATCH');
  if (!nonEmpty(candidate.datasetIdentity)) add('POINTER_DATASET_IDENTITY_MISMATCH');
  if (!exactDigest(candidate.datasetDigest)) add('POINTER_DATASET_DIGEST_MISMATCH');
  if (!exactDigest(candidate.datasetBytesDigest)) add('POINTER_DATASET_BYTES_DIGEST_MISMATCH');
  if (!safeRelativeLocator(candidate.datasetRelativePath)) add('POINTER_LOCATOR_INVALID');
  if (!exactDigest(candidate.sourceIngestReceiptDigest)) add('POINTER_PROVENANCE_INVALID');
  if (exactDigest(candidate.sourceIngestReceiptDigest)
    && candidate.sourceIngestReceiptRef !== `ingest-receipt:sha256:${candidate.sourceIngestReceiptDigest}`) add('POINTER_PROVENANCE_INVALID');
  if (!validateProvenance(candidate.publicationProvenance, String(candidate.collectorCodeSha ?? ''))) add('POINTER_PROVENANCE_INVALID');
  if (!nonEmpty(candidate.pointerIdentity)) add('POINTER_SCHEMA_INVALID');
  if (!safeRelativeLocator(candidate.pointerRelativePath)) add('POINTER_LOCATOR_INVALID');
  if (candidate.publishedAtMs !== undefined
    && (!Number.isSafeInteger(candidate.publishedAtMs) || candidate.publishedAtMs <= 0)) add('POINTER_PROVENANCE_INVALID');
  if (!exactDigest(candidate.pointerDigest)) add('POINTER_DIGEST_MISMATCH');

  if (exactDigest(candidate.datasetDigest)) {
    if (candidate.datasetRelativePath !== immutableDatasetRelativePath(candidate.datasetDigest)) add('POINTER_LOCATOR_INVALID');
    if (candidate.pointerRelativePath !== pointerRelativePath(candidate.datasetDigest)) add('POINTER_LOCATOR_INVALID');
    if (candidate.pointerIdentity !== expectedPointerIdentity(candidate.datasetDigest)) add('POINTER_SCHEMA_INVALID');
  }

  if (exactDigest(candidate.pointerDigest)) {
    try {
      if (computePublicForwardPartialFillDatasetPointerDigest(
        bodyWithoutPointerDigest(candidate as PublicForwardPartialFillCalibrationDatasetPointer),
      ) !== candidate.pointerDigest) add('POINTER_DIGEST_MISMATCH');
    } catch {
      add('POINTER_DIGEST_MISMATCH');
    }
  }

  if (expected.datasetIdentity !== undefined && candidate.datasetIdentity !== expected.datasetIdentity) add('POINTER_DATASET_IDENTITY_MISMATCH');
  if (expected.datasetDigest !== undefined && candidate.datasetDigest !== expected.datasetDigest) add('POINTER_DATASET_DIGEST_MISMATCH');
  if (expected.datasetBytesDigest !== undefined && candidate.datasetBytesDigest !== expected.datasetBytesDigest) add('POINTER_DATASET_BYTES_DIGEST_MISMATCH');
  if (expected.sampleClass !== undefined && candidate.sampleClass !== expected.sampleClass) add('POINTER_SAMPLE_CLASS_MISMATCH');
  if (expected.collectorCodeSha !== undefined && candidate.collectorCodeSha !== expected.collectorCodeSha) add('POINTER_COLLECTOR_SHA_MISMATCH');
  if (expected.storeContract !== undefined && candidate.storeContract !== expected.storeContract) add('POINTER_STORE_CONTRACT_MISMATCH');
  if (expected.pointerDigest !== undefined && candidate.pointerDigest !== expected.pointerDigest) add('POINTER_DIGEST_MISMATCH');

  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

export function assertPublicForwardPartialFillDatasetPointerCompatible(
  existing: PublicForwardPartialFillCalibrationDatasetPointer,
  candidate: PublicForwardPartialFillCalibrationDatasetPointer,
): void {
  const existingVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(existing);
  const candidateVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(candidate);
  if (!existingVerification.valid || !candidateVerification.valid) throw new Error('POINTER_SCHEMA_INVALID');
  if (existing.pointerIdentity !== candidate.pointerIdentity) return;
  if (existing.pointerDigest !== candidate.pointerDigest
    || existing.datasetDigest !== candidate.datasetDigest
    || existing.datasetBytesDigest !== candidate.datasetBytesDigest
    || JSON.stringify(canonicalize(existing)) !== JSON.stringify(canonicalize(candidate))) {
    throw new Error('POINTER_IDENTITY_CONFLICT');
  }
}

async function readPointerIfPresent(pointerPath: string): Promise<PublicForwardPartialFillCalibrationDatasetPointer | null> {
  try {
    const meta = await lstat(pointerPath);
    if (meta.isSymbolicLink() || !meta.isFile()) throw new Error('POINTER_LOCATOR_INVALID');
    return JSON.parse(await readFile(pointerPath, 'utf8')) as PublicForwardPartialFillCalibrationDatasetPointer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('POINTER_SCHEMA_INVALID');
    throw error;
  }
}

export async function publishPublicForwardPartialFillCalibrationDatasetPointer(input: Readonly<{
  stateRoot: string;
  researchRepoRoot: string;
  dataset: PublicForwardPartialFillCalibrationDataset;
  mutableDatasetRelativePath: string;
  sourceIngestReceiptDigest: string;
  sourceIngestReceiptRef: string;
  publicationProvenance: PublicForwardPartialFillDatasetPointerPublicationProvenance;
  publishedAtMs?: number;
}>): Promise<PublicForwardPartialFillDatasetPointerPublicationResult> {
  const root = assertSafeStateRoot(input);
  const datasetVerification = verifyPublicForwardPartialFillCalibrationDataset(input.dataset);
  if (!datasetVerification.valid) throw new Error(`POINTER_DATASET_INVALID:${datasetVerification.blockers.join(',')}`);
  if (input.dataset.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) throw new Error('POINTER_STORE_CONTRACT_MISMATCH');
  if (input.mutableDatasetRelativePath !== expectedMutableDatasetRelativePath(input.dataset)) throw new Error('POINTER_LOCATOR_INVALID');
  if (!exactDigest(input.sourceIngestReceiptDigest)
    || input.sourceIngestReceiptRef !== `ingest-receipt:sha256:${input.sourceIngestReceiptDigest}`
    || !validateProvenance(input.publicationProvenance, input.dataset.collectorCodeSha)) throw new Error('POINTER_PROVENANCE_INVALID');
  if (input.publishedAtMs !== undefined && (!Number.isSafeInteger(input.publishedAtMs) || input.publishedAtMs <= 0)) {
    throw new Error('POINTER_PROVENANCE_INVALID');
  }

  const mutableDatasetPath = resolveRelativeInside(root, input.mutableDatasetRelativePath, 'POINTER_LOCATOR_INVALID');
  let sourceMeta;
  try {
    sourceMeta = await lstat(mutableDatasetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('DATASET_NOT_FOUND');
    throw error;
  }
  if (sourceMeta.isSymbolicLink() || !sourceMeta.isFile()) throw new Error('POINTER_LOCATOR_INVALID');
  const realSourcePath = await realpath(mutableDatasetPath);
  if (!pathInside(root, realSourcePath)) throw new Error('POINTER_LOCATOR_INVALID');

  const datasetBytes = await readFile(realSourcePath);
  let parsedDataset: PublicForwardPartialFillCalibrationDataset;
  try {
    parsedDataset = JSON.parse(datasetBytes.toString('utf8')) as PublicForwardPartialFillCalibrationDataset;
  } catch {
    throw new Error('POINTER_DATASET_DIGEST_MISMATCH');
  }
  const parsedVerification = verifyPublicForwardPartialFillCalibrationDataset(parsedDataset);
  if (!parsedVerification.valid) throw new Error(`POINTER_DATASET_INVALID:${parsedVerification.blockers.join(',')}`);
  if (parsedDataset.datasetIdentity !== input.dataset.datasetIdentity) throw new Error('POINTER_DATASET_IDENTITY_MISMATCH');
  if (parsedDataset.datasetDigest !== input.dataset.datasetDigest) throw new Error('POINTER_DATASET_DIGEST_MISMATCH');
  if (parsedDataset.collectorCodeSha !== input.dataset.collectorCodeSha) throw new Error('POINTER_COLLECTOR_SHA_MISMATCH');
  if (parsedDataset.sampleClass !== input.dataset.sampleClass) throw new Error('POINTER_SAMPLE_CLASS_MISMATCH');
  if (parsedDataset.storeContract !== input.dataset.storeContract) throw new Error('POINTER_STORE_CONTRACT_MISMATCH');

  const datasetBytesDigest = sha256Bytes(datasetBytes);
  const immutableRelativePath = immutableDatasetRelativePath(input.dataset.datasetDigest);
  const immutablePath = resolveRelativeInside(root, immutableRelativePath, 'POINTER_LOCATOR_INVALID');
  await mkdir(resolve(immutablePath, '..'), { recursive: true });
  const immutableDatasetCreated = await atomicCreateOnly(
    immutablePath,
    datasetBytes,
    'IMMUTABLE_DATASET_SNAPSHOT_CONFLICT',
  );
  const immutableMeta = await lstat(immutablePath);
  if (immutableMeta.isSymbolicLink() || !immutableMeta.isFile()) throw new Error('POINTER_LOCATOR_INVALID');
  if (sha256Bytes(await readFile(immutablePath)) !== datasetBytesDigest) throw new Error('DATASET_BYTES_DIGEST_MISMATCH');

  const pointerPathRelative = pointerRelativePath(input.dataset.datasetDigest);
  const pointerPath = resolveRelativeInside(root, pointerPathRelative, 'POINTER_LOCATOR_INVALID');
  await mkdir(resolve(pointerPath, '..'), { recursive: true });

  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_VERSION,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: input.dataset.sampleClass,
    collectorCodeSha: input.dataset.collectorCodeSha,
    datasetIdentity: input.dataset.datasetIdentity,
    datasetDigest: input.dataset.datasetDigest,
    datasetBytesDigest,
    datasetRelativePath: immutableRelativePath,
    sourceIngestReceiptDigest: input.sourceIngestReceiptDigest,
    sourceIngestReceiptRef: input.sourceIngestReceiptRef,
    publicationProvenance: Object.freeze({ ...input.publicationProvenance }),
    pointerIdentity: expectedPointerIdentity(input.dataset.datasetDigest),
    pointerRelativePath: pointerPathRelative,
    ...(input.publishedAtMs === undefined ? {} : { publishedAtMs: input.publishedAtMs }),
  }) as Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'>;
  const pointer = Object.freeze({
    ...body,
    pointerDigest: computePublicForwardPartialFillDatasetPointerDigest(body),
  });
  const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(pointer, {
    datasetIdentity: input.dataset.datasetIdentity,
    datasetDigest: input.dataset.datasetDigest,
    datasetBytesDigest,
    sampleClass: input.dataset.sampleClass,
    collectorCodeSha: input.dataset.collectorCodeSha,
    storeContract: input.dataset.storeContract,
  });
  if (!verification.valid) throw new Error(`POINTER_SCHEMA_INVALID:${verification.blockers.join(',')}`);

  const existingPointer = await readPointerIfPresent(pointerPath);
  if (existingPointer) {
    const existingVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(existingPointer, {
      datasetIdentity: input.dataset.datasetIdentity,
      datasetDigest: input.dataset.datasetDigest,
      datasetBytesDigest,
      sampleClass: input.dataset.sampleClass,
      collectorCodeSha: input.dataset.collectorCodeSha,
      storeContract: input.dataset.storeContract,
    });
    if (!existingVerification.valid) throw new Error(`POINTER_IDENTITY_CONFLICT:${existingVerification.blockers.join(',')}`);
    try {
      assertPublicForwardPartialFillDatasetPointerCompatible(existingPointer, pointer);
    } catch {
      throw new Error('POINTER_IDENTITY_CONFLICT');
    }
    return Object.freeze({ pointer: existingPointer, immutableDatasetCreated, pointerCreated: false });
  }

  const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  let pointerCreated: boolean;
  try {
    pointerCreated = await atomicCreateOnly(pointerPath, pointerBytes, 'POINTER_IDENTITY_CONFLICT');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('POINTER_IDENTITY_CONFLICT')) throw error;
    const winner = await readPointerIfPresent(pointerPath);
    if (!winner) throw error;
    const winnerVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(winner, {
      datasetIdentity: input.dataset.datasetIdentity,
      datasetDigest: input.dataset.datasetDigest,
      datasetBytesDigest,
      sampleClass: input.dataset.sampleClass,
      collectorCodeSha: input.dataset.collectorCodeSha,
      storeContract: input.dataset.storeContract,
    });
    if (!winnerVerification.valid) throw error;
    try {
      assertPublicForwardPartialFillDatasetPointerCompatible(winner, pointer);
    } catch {
      throw new Error('POINTER_IDENTITY_CONFLICT');
    }
    return Object.freeze({ pointer: winner, immutableDatasetCreated, pointerCreated: false });
  }
  return Object.freeze({ pointer, immutableDatasetCreated, pointerCreated });
}

export async function readPublicForwardPartialFillCalibrationDatasetPointer(input: Readonly<{
  stateRoot: string;
  researchRepoRoot: string;
  pointerRelativePath: string;
  expectedPointerDigest?: string;
}>): Promise<Readonly<{
  pointer: PublicForwardPartialFillCalibrationDatasetPointer;
  dataset: PublicForwardPartialFillCalibrationDataset;
}>> {
  const root = assertSafeStateRoot(input);
  const pointerPath = resolveRelativeInside(root, input.pointerRelativePath, 'POINTER_LOCATOR_INVALID');
  const pointerMeta = await lstat(pointerPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('POINTER_NOT_PUBLISHED');
    throw error;
  });
  if (pointerMeta.isSymbolicLink() || !pointerMeta.isFile()) throw new Error('POINTER_LOCATOR_INVALID');
  let pointer: PublicForwardPartialFillCalibrationDatasetPointer;
  try {
    pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as PublicForwardPartialFillCalibrationDatasetPointer;
  } catch {
    throw new Error('POINTER_SCHEMA_INVALID');
  }
  const pointerVerification = verifyPublicForwardPartialFillCalibrationDatasetPointer(pointer, {
    pointerDigest: input.expectedPointerDigest,
  });
  if (!pointerVerification.valid) throw new Error(`POINTER_INVALID:${pointerVerification.blockers.join(',')}`);
  if (pointer.pointerRelativePath !== input.pointerRelativePath) throw new Error('POINTER_LOCATOR_INVALID');

  const datasetPath = resolveRelativeInside(root, pointer.datasetRelativePath, 'POINTER_LOCATOR_INVALID');
  const datasetMeta = await lstat(datasetPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('DATASET_NOT_FOUND');
    throw error;
  });
  if (datasetMeta.isSymbolicLink() || !datasetMeta.isFile()) throw new Error('POINTER_LOCATOR_INVALID');
  const datasetBytes = await readFile(datasetPath);
  if (sha256Bytes(datasetBytes) !== pointer.datasetBytesDigest) throw new Error('DATASET_BYTES_DIGEST_MISMATCH');

  let dataset: PublicForwardPartialFillCalibrationDataset;
  try {
    dataset = JSON.parse(datasetBytes.toString('utf8')) as PublicForwardPartialFillCalibrationDataset;
  } catch {
    throw new Error('POINTER_DATASET_DIGEST_MISMATCH');
  }
  const datasetVerification = verifyPublicForwardPartialFillCalibrationDataset(dataset);
  if (!datasetVerification.valid) throw new Error(`POINTER_DATASET_INVALID:${datasetVerification.blockers.join(',')}`);
  if (dataset.datasetIdentity !== pointer.datasetIdentity) throw new Error('POINTER_DATASET_IDENTITY_MISMATCH');
  if (dataset.datasetDigest !== pointer.datasetDigest) throw new Error('POINTER_DATASET_DIGEST_MISMATCH');
  if (dataset.collectorCodeSha !== pointer.collectorCodeSha) throw new Error('POINTER_COLLECTOR_SHA_MISMATCH');
  if (dataset.sampleClass !== pointer.sampleClass) throw new Error('POINTER_SAMPLE_CLASS_MISMATCH');
  if (dataset.storeContract !== pointer.storeContract) throw new Error('POINTER_STORE_CONTRACT_MISMATCH');

  return Object.freeze({ pointer, dataset });
}
