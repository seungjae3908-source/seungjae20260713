import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillDatasetPersistResult,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY,
  callPublicForwardPartialFillCalibrationReaderFromProduction,
} from './public-forward-partial-fill-calibration-production-caller.service';

const collectorCodeSha = '17fdbc8c868a21d7386752d136f7c698f0727694';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function observation(): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    observationId: 'partial-fill-observation:test-only-production-caller',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT-PUBLIC-MIN-ORDER-QTY-0.0001-V1',
    collectorCodeSha,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    observedAtMs: 2_500,
    passiveLimitPrice: 100_000,
    requestedQuantity: 0.0001,
    eligiblePublicTouchQuantityUpperBound: 0.00005,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: ['test-only-public-execution'],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: sha256('source'),
    sourceObservationLineageId: 'test-only-source-lineage',
    sourceObservationLineageDigest: sha256('lineage'),
    preEventBookDigest: sha256('pre-book'),
    forwardPublicFillsDigest: sha256('forward-fills'),
    postEventBookDigest: sha256('post-book'),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
    forwardCalibrationSampleCredit: 1,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    calibrationArtifactProduced: false,
    durablePersistencePerformed: false,
    calibrationSampleSufficient: false,
    partialFillStatus: 'BLOCKED_DATA',
    fullCostReady: false,
    privateApiUsed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    orderSubmitted: false,
  };
}

function environment(root: string, persisted: PublicForwardPartialFillDatasetPersistResult) {
  return Object.freeze({
    PARTIAL_FILL_CANONICAL_STATE_ROOT: root,
    PARTIAL_FILL_CANONICAL_STORE_CONTRACT: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    PARTIAL_FILL_CANONICAL_SAMPLE_CLASS: 'FORWARD_NATURAL_SAMPLE',
    PARTIAL_FILL_CANONICAL_COLLECTOR_CODE_SHA: collectorCodeSha,
    PARTIAL_FILL_CANONICAL_DATASET_IDENTITY: persisted.dataset.datasetIdentity,
    PARTIAL_FILL_CANONICAL_DATASET_DIGEST: persisted.dataset.datasetDigest,
  });
}

async function withDataset(
  run: (root: string, persisted: PublicForwardPartialFillDatasetPersistResult, datasetPath: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-production-caller-'));
  try {
    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation()],
      nowMs: 4_000,
    });
    await run(root, persisted, resolve(root, persisted.datasetRelativePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stateRootSnapshot(root: string): Promise<readonly string[]> {
  const rows: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1);
      if (entry.isDirectory()) await walk(path);
      else {
        const metadata = await stat(path);
        rows.push(`${relative}:${metadata.size}:${sha256(await readFile(path, 'utf8'))}`);
      }
    }
  }
  await walk(root);
  return Object.freeze(rows.sort());
}

test('real production caller invokes the canonical N=1 reader and preserves economic truth without mutation', async () => {
  await withDataset(async (root, persisted) => {
    const before = await stateRootSnapshot(root);
    const result = await callPublicForwardPartialFillCalibrationReaderFromProduction(environment(root, persisted));
    const after = await stateRootSnapshot(root);

    assert.equal(result.status, 'READBACK');
    assert.equal(result.productionCallerConnected, true);
    assert.equal(result.productionPolicyAuthorityConnected, false);
    assert.equal(result.calibrationSampleSufficient, false);
    assert.equal(result.calibrationArtifactProduced, false);
    assert.equal(result.partialFillCostPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.evidenceComplete, 0);
    assert.equal(result.profitabilityProven, false);
    assert.equal(result.executionAuthority, 'NONE');
    assert.deepEqual(after, before);

    if (result.status !== 'READBACK') assert.fail('canonical reader did not produce readback');
    assert.equal(result.readback.rawN, 1);
    assert.equal(result.readback.uniqueN, 1);
    assert.equal(result.readback.longN, 1);
    assert.equal(result.readback.shortN, 0);
    assert.equal(result.readback.actualFillObservedN, 0);
    assert.equal(result.readback.queuePositionKnownN, 0);
    assert.equal(result.readback.sufficiencyStatus, 'NOT_EVALUABLE_POLICY_MISSING');
    assert.equal(result.readback.splitAuditExecuted, false);
    assert.equal(result.readback.productionPolicyPresent, false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.readback, 'effectiveIndependentN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.readback, 'buyN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.readback, 'sellN'), false);

    const canonical = persisted.dataset.observations[0].observation;
    assert.equal(canonical.actualFillObserved, false);
    assert.equal(canonical.actualFillFraction, null);
    assert.equal(canonical.queuePositionKnown, false);
    assert.equal(canonical.partialFillCostPercent, null);
  });
});

test('missing runtime bindings block before reader invocation without inventing a root or N=0', async () => {
  const result = await callPublicForwardPartialFillCalibrationReaderFromProduction({});
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.blocker, 'NOT_EVALUABLE_RUNTIME_BINDING_MISSING');
  assert.equal(result.productionCallerConnected, false);
  assert.equal(result.readerError, null);
  assert.equal(result.missingBindings.length, 6);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'rawN'), false);
});

test('missing dataset and malformed JSON remain explicit canonical reader blockers', async () => {
  await withDataset(async (root, persisted, datasetPath) => {
    await rm(datasetPath);
    const missing = await callPublicForwardPartialFillCalibrationReaderFromProduction(environment(root, persisted));
    assert.equal(missing.status, 'BLOCKED');
    assert.equal(missing.blocker, 'CANONICAL_READER_BLOCKED');
    assert.equal(missing.productionCallerConnected, true);
    assert.match(missing.readerError ?? '', /DATASET_MISSING/u);
    assert.equal(Object.prototype.hasOwnProperty.call(missing, 'rawN'), false);

    await mkdir(dirname(datasetPath), { recursive: true });
    await writeFile(datasetPath, '{', 'utf8');
    const malformed = await callPublicForwardPartialFillCalibrationReaderFromProduction(environment(root, persisted));
    assert.equal(malformed.status, 'BLOCKED');
    assert.match(malformed.readerError ?? '', /INVALID_JSON/u);
    assert.equal(malformed.calibrationSampleSufficient, false);
  });
});

test('reader contract, sample class, SHA, identity and digest failures are not washed into READY', async () => {
  await withDataset(async (root, persisted) => {
    const base = environment(root, persisted);
    const cases = [
      [{ ...base, PARTIAL_FILL_CANONICAL_STORE_CONTRACT: 'wrong' }, /STORE_CONTRACT_MISMATCH/u],
      [{ ...base, PARTIAL_FILL_CANONICAL_SAMPLE_CLASS: 'BUY' }, /SAMPLE_CLASS_INVALID/u],
      [{ ...base, PARTIAL_FILL_CANONICAL_COLLECTOR_CODE_SHA: 'wrong' }, /COLLECTOR_CODE_SHA_INVALID/u],
      [{ ...base, PARTIAL_FILL_CANONICAL_DATASET_IDENTITY: 'wrong' }, /EXPECTED_DATASET_IDENTITY_INVALID/u],
      [{ ...base, PARTIAL_FILL_CANONICAL_DATASET_DIGEST: 'wrong' }, /EXPECTED_DATASET_DIGEST_INVALID/u],
    ] as const;
    for (const [current, expected] of cases) {
      const result = await callPublicForwardPartialFillCalibrationReaderFromProduction(current);
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.blocker, 'CANONICAL_READER_BLOCKED');
      assert.equal(result.productionCallerConnected, true);
      assert.match(result.readerError ?? '', expected);
    }
  });
});

test('TEST_ONLY-looking environment values cannot promote policy or regime authority', async () => {
  await withDataset(async (root, persisted) => {
    const result = await callPublicForwardPartialFillCalibrationReaderFromProduction({
      ...environment(root, persisted),
      PARTIAL_FILL_PRODUCTION_POLICY: 'TEST_ONLY_POLICY',
      PARTIAL_FILL_REGIME_BINDINGS: 'TEST_ONLY_REGIME',
    });
    assert.equal(result.status, 'READBACK');
    assert.equal(result.productionPolicyAuthorityConnected, false);
    assert.equal(result.calibrationSampleSufficient, false);
    if (result.status !== 'READBACK') assert.fail('canonical reader did not produce readback');
    assert.equal(result.readback.productionPolicyPresent, false);
    assert.equal(result.readback.splitAuditExecuted, false);
    assert.equal(result.readback.sufficiencyStatus, 'NOT_EVALUABLE_POLICY_MISSING');
  });
});

test('api-server startup is the non-test production consumer of the caller', async () => {
  const startupPath = process.cwd().endsWith('api-server')
    ? resolve(process.cwd(), 'src/index.ts')
    : resolve(process.cwd(), 'api-server/src/index.ts');
  const source = await readFile(startupPath, 'utf8');
  assert.match(source, /import \{ runPublicForwardPartialFillCalibrationProductionReadback \}/u);
  assert.match(source, /void runPublicForwardPartialFillCalibrationProductionReadback\(\)\.then/u);
});

test('caller safety contract forbids policy invention, economic credit, mutation, network and trading authority', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_CALLER_SAFETY, {
    readOnly: true,
    runtimeBindingsRequired: true,
    defaultStateRootAllowed: false,
    productionCallerConnectedByStaticImportOnly: false,
    productionPolicyAuthorityConnected: false,
    testOnlyPolicyPromotionAllowed: false,
    regimeBindingInventionAllowed: false,
    datasetMutationAllowed: false,
    captureAllowed: false,
    replayAllowed: false,
    backfillAllowed: false,
    effectiveIndependentNProduced: false,
    buySellSemanticRemapAllowed: false,
    calibrationArtifactProduced: false,
    partialFillCostProduced: false,
    fullCostReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
  });
});
