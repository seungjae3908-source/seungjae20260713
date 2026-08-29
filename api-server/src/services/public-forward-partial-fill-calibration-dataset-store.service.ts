import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
  type PublicForwardPartialFillSampleClass,
} from './public-forward-partial-fill-calibration-collector.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION =
  'public-forward-partial-fill-calibration-dataset-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT =
  'research-production-state-root/forward-partial-fill-calibration-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_SAFETY = Object.freeze({
  existingCanonicalStateRootRequired: true,
  sourceType: 'PUBLIC_FORWARD_SIMULATION' as const,
  actualFillClaimAllowed: false,
  partialFillCostProduced: false,
  calibrationArtifactProduced: false,
  calibrationSampleSufficient: false,
  regimeScopeComplete: false,
  splitAssignmentComplete: false,
  oosValidationComplete: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
  fullCostReady: false,
});

type StoredObservation = Readonly<{
  observationId: string;
  observationDigest: string;
  observation: PublicForwardPartialFillCalibrationObservation;
}>;

export type PublicForwardPartialFillCalibrationDataset = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION;
  storeContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  datasetIdentity: string;
  datasetDigest: string;
  predecessorDatasetDigest: string | null;
  sampleClass: PublicForwardPartialFillSampleClass;
  collectorCodeSha: string;
  createdAtMs: number;
  updatedAtMs: number;
  observationCount: number;
  forwardCalibrationSampleCreditCount: number;
  observations: readonly StoredObservation[];
  durablePersistencePerformed: true;
  calibrationArtifactProduced: false;
  partialFillCostPresent: false;
  calibrationSampleSufficient: false;
  regimeScopeComplete: false;
  splitAssignmentComplete: false;
  oosValidationComplete: false;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  partialFillStatus: 'BLOCKED_DATA';
  fullCostReady: false;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
}>;

export type PublicForwardPartialFillDatasetVerification = Readonly<{
  valid: boolean;
  blockers: readonly string[];
}>;

export type PublicForwardPartialFillDatasetPersistResult = Readonly<{
  dataset: PublicForwardPartialFillCalibrationDataset;
  datasetRelativePath: string;
  insertedObservationCount: number;
  duplicateObservationCount: number;
  changed: boolean;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

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

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function exactSha(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return COMMIT_SHA.test(normalized) ? normalized : null;
}

function exactDigest(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function nonEmpty(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function observationDigest(observation: PublicForwardPartialFillCalibrationObservation): string {
  return sha256(observation);
}

function validateObservation(
  observation: PublicForwardPartialFillCalibrationObservation,
  expected: Readonly<{
    sampleClass: PublicForwardPartialFillSampleClass;
    collectorCodeSha: string;
  }>,
): string[] {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (observation.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION) add('OBSERVATION_SCHEMA_MISMATCH');
  if (observation.evidenceClass !== 'PUBLIC_FORWARD_SIMULATION_OBSERVATION') add('OBSERVATION_EVIDENCE_CLASS_INVALID');
  if (observation.sourceType !== 'PUBLIC_FORWARD_SIMULATION') add('OBSERVATION_SOURCE_TYPE_INVALID');
  if (observation.sampleClass !== expected.sampleClass) add('OBSERVATION_SAMPLE_CLASS_MISMATCH');
  if (exactSha(observation.collectorCodeSha) !== expected.collectorCodeSha) add('OBSERVATION_COLLECTOR_SHA_MISMATCH');
  if (!nonEmpty(observation.observationId)) add('OBSERVATION_ID_INVALID');
  if (observation.market !== 'CRYPTO_FUTURES') add('OBSERVATION_MARKET_INVALID');
  if (!nonEmpty(observation.symbol)) add('OBSERVATION_SYMBOL_INVALID');
  if (!['LONG', 'SHORT'].includes(observation.side)) add('OBSERVATION_SIDE_INVALID');
  if (!nonEmpty(observation.quantityNotionalBucketIdentity)) add('OBSERVATION_BUCKET_INVALID');
  if (!(finitePositive(observation.windowStartMs)
    && finitePositive(observation.windowEndMs)
    && finitePositive(observation.observedAtMs)
    && observation.windowStartMs < observation.windowEndMs
    && observation.windowEndMs <= observation.observedAtMs)) add('OBSERVATION_TIME_ORDER_INVALID');
  if (!(finitePositive(observation.passiveLimitPrice) && finitePositive(observation.requestedQuantity))) add('OBSERVATION_ORDER_SHAPE_INVALID');
  if (!(typeof observation.eligiblePublicTouchQuantityUpperBound === 'number'
    && Number.isFinite(observation.eligiblePublicTouchQuantityUpperBound)
    && observation.eligiblePublicTouchQuantityUpperBound >= 0)) add('OBSERVATION_TOUCH_QUANTITY_INVALID');
  if (!(typeof observation.opportunityFillRatioUpperBound === 'number'
    && Number.isFinite(observation.opportunityFillRatioUpperBound)
    && observation.opportunityFillRatioUpperBound >= 0
    && observation.opportunityFillRatioUpperBound <= 1)) add('OBSERVATION_FILL_RATIO_BOUND_INVALID');
  if (observation.actualFillFraction !== null || observation.actualFillObserved !== false || observation.queuePositionKnown !== false) {
    add('OBSERVATION_ACTUAL_FILL_CLAIM_FORBIDDEN');
  }
  if (observation.partialFillCostPercent !== null) add('OBSERVATION_PARTIAL_FILL_COST_FORBIDDEN');
  if (observation.sourceIdentity !== 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1') add('OBSERVATION_SOURCE_IDENTITY_INVALID');
  for (const [name, value] of [
    ['SOURCE', observation.sourceDigest],
    ['LINEAGE', observation.sourceObservationLineageDigest],
    ['PRE_BOOK', observation.preEventBookDigest],
    ['FORWARD_FILLS', observation.forwardPublicFillsDigest],
    ['POST_BOOK', observation.postEventBookDigest],
  ] as const) {
    if (!exactDigest(value)) add(`OBSERVATION_${name}_DIGEST_INVALID`);
  }
  if (!nonEmpty(observation.sourceObservationLineageId)) add('OBSERVATION_LINEAGE_ID_INVALID');
  if (!Array.isArray(observation.endpoints)
    || observation.endpoints.length !== 2
    || observation.endpoints[0] !== '/api/v3/market/orderbook'
    || observation.endpoints[1] !== '/api/v3/market/fills') add('OBSERVATION_ENDPOINT_CONTRACT_INVALID');
  const expectedForwardCredit = expected.sampleClass === 'FORWARD_NATURAL_SAMPLE' ? 1 : 0;
  if (observation.forwardCalibrationSampleCredit !== expectedForwardCredit) add('OBSERVATION_FORWARD_SAMPLE_CREDIT_INVALID');
  if (observation.historicalBackfillCredit !== 0 || observation.testFixtureCredit !== 0) add('OBSERVATION_NON_FORWARD_CREDIT_INVALID');
  if (observation.naturalEntryCredit !== 0 || observation.runtimeCostCredit !== 0) add('OBSERVATION_RUNTIME_CREDIT_FORBIDDEN');
  if (observation.calibrationArtifactProduced !== false
    || observation.durablePersistencePerformed !== false
    || observation.calibrationSampleSufficient !== false
    || observation.partialFillStatus !== 'BLOCKED_DATA'
    || observation.fullCostReady !== false) add('OBSERVATION_TRUTH_BOUNDARY_INVALID');
  if (observation.privateApiUsed !== false
    || observation.executionAuthority !== 'NONE'
    || observation.liveTrading !== false
    || observation.orderSubmitted !== false) add('OBSERVATION_EXECUTION_SAFETY_INVALID');

  return blockers;
}

export function computePublicForwardPartialFillDatasetDigest(
  dataset: Omit<PublicForwardPartialFillCalibrationDataset, 'datasetDigest'> | PublicForwardPartialFillCalibrationDataset,
): string {
  const payload = Object.fromEntries(
    Object.entries(dataset as Record<string, unknown>).filter(([key]) => key !== 'datasetDigest'),
  );
  return sha256(payload);
}

export function verifyPublicForwardPartialFillCalibrationDataset(
  dataset: PublicForwardPartialFillCalibrationDataset,
): PublicForwardPartialFillDatasetVerification {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (dataset.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION) add('DATASET_SCHEMA_INVALID');
  if (dataset.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) add('DATASET_STORE_CONTRACT_INVALID');
  const collectorCodeSha = exactSha(dataset.collectorCodeSha);
  if (!collectorCodeSha) add('DATASET_COLLECTOR_SHA_INVALID');
  if (!['FORWARD_NATURAL_SAMPLE', 'CALIBRATION_RESEARCH_SAMPLE'].includes(dataset.sampleClass)) add('DATASET_SAMPLE_CLASS_INVALID');
  if (!nonEmpty(dataset.datasetIdentity)) add('DATASET_IDENTITY_INVALID');
  if (!exactDigest(dataset.datasetDigest)) add('DATASET_DIGEST_INVALID');
  try {
    if (dataset.datasetDigest !== computePublicForwardPartialFillDatasetDigest(dataset)) add('DATASET_DIGEST_MISMATCH');
  } catch {
    add('DATASET_DIGEST_UNVERIFIABLE');
  }
  if (dataset.predecessorDatasetDigest !== null && !exactDigest(dataset.predecessorDatasetDigest)) add('DATASET_PREDECESSOR_DIGEST_INVALID');
  if (!(finitePositive(dataset.createdAtMs) && finitePositive(dataset.updatedAtMs) && dataset.createdAtMs <= dataset.updatedAtMs)) add('DATASET_TIME_INVALID');
  if (!nonNegativeInteger(dataset.observationCount) || dataset.observationCount !== dataset.observations.length) add('DATASET_OBSERVATION_COUNT_INVALID');
  if (!nonNegativeInteger(dataset.forwardCalibrationSampleCreditCount)) add('DATASET_FORWARD_CREDIT_COUNT_INVALID');

  const ids = new Set<string>();
  let forwardCredit = 0;
  let previous: StoredObservation | null = null;
  if (collectorCodeSha) {
    for (const stored of dataset.observations) {
      if (ids.has(stored.observationId)) add('DATASET_DUPLICATE_OBSERVATION_ID');
      ids.add(stored.observationId);
      if (stored.observationId !== stored.observation.observationId) add('DATASET_OBSERVATION_ID_MISMATCH');
      if (stored.observationDigest !== observationDigest(stored.observation)) add('DATASET_OBSERVATION_DIGEST_MISMATCH');
      validateObservation(stored.observation, { sampleClass: dataset.sampleClass, collectorCodeSha }).forEach(add);
      forwardCredit += stored.observation.forwardCalibrationSampleCredit;
      if (previous) {
        const ordered = previous.observation.observedAtMs < stored.observation.observedAtMs
          || (previous.observation.observedAtMs === stored.observation.observedAtMs
            && previous.observationId.localeCompare(stored.observationId) <= 0);
        if (!ordered) add('DATASET_OBSERVATION_ORDER_INVALID');
      }
      previous = stored;
    }
  }
  if (dataset.forwardCalibrationSampleCreditCount !== forwardCredit) add('DATASET_FORWARD_CREDIT_COUNT_MISMATCH');
  if (dataset.durablePersistencePerformed !== true
    || dataset.calibrationArtifactProduced !== false
    || dataset.partialFillCostPresent !== false
    || dataset.calibrationSampleSufficient !== false
    || dataset.regimeScopeComplete !== false
    || dataset.splitAssignmentComplete !== false
    || dataset.oosValidationComplete !== false
    || dataset.naturalEntryCredit !== 0
    || dataset.runtimeCostCredit !== 0
    || dataset.partialFillStatus !== 'BLOCKED_DATA'
    || dataset.fullCostReady !== false) add('DATASET_TRUTH_BOUNDARY_INVALID');
  if (dataset.executionAuthority !== 'NONE'
    || dataset.privateApiUsed !== false
    || dataset.liveTrading !== false
    || dataset.orderSubmitted !== false) add('DATASET_EXECUTION_SAFETY_INVALID');

  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function buildDataset(input: Readonly<{
  existing: PublicForwardPartialFillCalibrationDataset | null;
  sampleClass: PublicForwardPartialFillSampleClass;
  collectorCodeSha: string;
  observations: readonly PublicForwardPartialFillCalibrationObservation[];
  nowMs: number;
}>): Readonly<{
  dataset: PublicForwardPartialFillCalibrationDataset;
  insertedObservationCount: number;
  duplicateObservationCount: number;
  changed: boolean;
}> {
  const current = input.existing;
  if (current) {
    const verification = verifyPublicForwardPartialFillCalibrationDataset(current);
    if (!verification.valid) throw new Error(`DATASET_CORRUPT:${verification.blockers.join(',')}`);
    if (current.sampleClass !== input.sampleClass) throw new Error('DATASET_SAMPLE_CLASS_MISMATCH');
    if (current.collectorCodeSha !== input.collectorCodeSha) throw new Error('DATASET_COLLECTOR_SHA_MISMATCH');
  }

  const byId = new Map<string, StoredObservation>();
  for (const stored of current?.observations ?? []) byId.set(stored.observationId, stored);
  let insertedObservationCount = 0;
  let duplicateObservationCount = 0;
  for (const observation of input.observations) {
    const blockers = validateObservation(observation, {
      sampleClass: input.sampleClass,
      collectorCodeSha: input.collectorCodeSha,
    });
    if (blockers.length > 0) throw new Error(`OBSERVATION_INVALID:${blockers.join(',')}`);
    const stored = Object.freeze({
      observationId: observation.observationId,
      observationDigest: observationDigest(observation),
      observation,
    });
    const prior = byId.get(stored.observationId);
    if (prior) {
      if (prior.observationDigest !== stored.observationDigest) throw new Error('OBSERVATION_ID_CONTENT_CONFLICT');
      duplicateObservationCount += 1;
      continue;
    }
    byId.set(stored.observationId, stored);
    insertedObservationCount += 1;
  }

  if (current && insertedObservationCount === 0) {
    return Object.freeze({ dataset: current, insertedObservationCount, duplicateObservationCount, changed: false });
  }
  if (!current && byId.size === 0) throw new Error('DATASET_OBSERVATION_REQUIRED');

  const observations = [...byId.values()].sort((left, right) => (
    left.observation.observedAtMs - right.observation.observedAtMs
    || left.observationId.localeCompare(right.observationId)
  ));
  const datasetIdentity = `partial-fill-forward-dataset:${input.sampleClass}:${input.collectorCodeSha}`;
  const base = {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    datasetIdentity,
    predecessorDatasetDigest: current?.datasetDigest ?? null,
    sampleClass: input.sampleClass,
    collectorCodeSha: input.collectorCodeSha,
    createdAtMs: current?.createdAtMs ?? input.nowMs,
    updatedAtMs: input.nowMs,
    observationCount: observations.length,
    forwardCalibrationSampleCreditCount: observations.reduce(
      (sum, stored) => sum + stored.observation.forwardCalibrationSampleCredit,
      0,
    ),
    observations: Object.freeze(observations),
    durablePersistencePerformed: true as const,
    calibrationArtifactProduced: false as const,
    partialFillCostPresent: false as const,
    calibrationSampleSufficient: false as const,
    regimeScopeComplete: false as const,
    splitAssignmentComplete: false as const,
    oosValidationComplete: false as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    partialFillStatus: 'BLOCKED_DATA' as const,
    fullCostReady: false as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  };
  const dataset = Object.freeze({
    ...base,
    datasetDigest: computePublicForwardPartialFillDatasetDigest(base as Omit<PublicForwardPartialFillCalibrationDataset, 'datasetDigest'>),
  });
  const verification = verifyPublicForwardPartialFillCalibrationDataset(dataset);
  if (!verification.valid) throw new Error(`DATASET_BUILD_INVALID:${verification.blockers.join(',')}`);
  return Object.freeze({ dataset, insertedObservationCount, duplicateObservationCount, changed: true });
}

function safeDatasetLocation(stateRoot: string, sampleClass: PublicForwardPartialFillSampleClass, collectorCodeSha: string) {
  if (!isAbsolute(stateRoot)) throw new Error('BLOCKED_STORAGE:STATE_ROOT_MUST_BE_ABSOLUTE');
  const root = resolve(stateRoot);
  const datasetDirectory = resolve(
    root,
    'forward',
    'partial-fill-calibration-v1',
    sampleClass.toLowerCase(),
    collectorCodeSha,
  );
  const rel = relative(root, datasetDirectory);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('BLOCKED_STORAGE:DATASET_PATH_OUTSIDE_STATE_ROOT');
  return {
    root,
    datasetDirectory,
    datasetPath: resolve(datasetDirectory, 'dataset.json'),
    lockPath: resolve(datasetDirectory, '.dataset.lock'),
    relativePath: `${rel.replaceAll('\\', '/')}/dataset.json`,
  };
}

async function readExisting(path: string): Promise<PublicForwardPartialFillCalibrationDataset | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PublicForwardPartialFillCalibrationDataset;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('DATASET_CORRUPT:INVALID_JSON');
    throw error;
  }
}

export async function persistPublicForwardPartialFillCalibrationDataset(input: Readonly<{
  stateRoot: string;
  storeContract: string;
  sampleClass: PublicForwardPartialFillSampleClass;
  collectorCodeSha: string;
  observations: readonly PublicForwardPartialFillCalibrationObservation[];
  nowMs?: number;
}>): Promise<PublicForwardPartialFillDatasetPersistResult> {
  if (input.storeContract !== PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT) {
    throw new Error('BLOCKED_STORAGE:STORE_CONTRACT_MISMATCH');
  }
  if (!['FORWARD_NATURAL_SAMPLE', 'CALIBRATION_RESEARCH_SAMPLE'].includes(input.sampleClass)) {
    throw new Error('BLOCKED_STORAGE:SAMPLE_CLASS_INVALID');
  }
  const collectorCodeSha = exactSha(input.collectorCodeSha);
  if (!collectorCodeSha) throw new Error('BLOCKED_STORAGE:COLLECTOR_CODE_SHA_INVALID');
  const nowMs = Math.trunc(Number(input.nowMs ?? Date.now()));
  if (!(nowMs > 0)) throw new Error('BLOCKED_STORAGE:NOW_INVALID');

  const location = safeDatasetLocation(input.stateRoot, input.sampleClass, collectorCodeSha);
  let rootStat;
  try {
    rootStat = await stat(location.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('BLOCKED_STORAGE:STATE_ROOT_MISSING');
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error('BLOCKED_STORAGE:STATE_ROOT_NOT_DIRECTORY');

  await mkdir(location.datasetDirectory, { recursive: true });
  let lock: Awaited<ReturnType<typeof open>> | null = null;
  try {
    try {
      lock = await open(location.lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('BLOCKED_STORAGE:DATASET_LOCK_BUSY');
      throw error;
    }
    const existing = await readExisting(location.datasetPath);
    const built = buildDataset({
      existing,
      sampleClass: input.sampleClass,
      collectorCodeSha,
      observations: input.observations,
      nowMs,
    });
    if (built.changed) {
      const temporaryPath = `${location.datasetPath}.tmp-${process.pid}-${nowMs}`;
      await writeFile(temporaryPath, `${JSON.stringify(built.dataset, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, location.datasetPath);
    }
    return Object.freeze({
      dataset: built.dataset,
      datasetRelativePath: location.relativePath,
      insertedObservationCount: built.insertedObservationCount,
      duplicateObservationCount: built.duplicateObservationCount,
      changed: built.changed,
    });
  } finally {
    await lock?.close().catch(() => undefined);
    await rm(location.lockPath, { force: true }).catch(() => undefined);
  }
}
