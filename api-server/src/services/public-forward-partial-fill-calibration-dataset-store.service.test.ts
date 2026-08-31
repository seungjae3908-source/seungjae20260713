import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
  type PublicForwardPartialFillSampleClass,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_SAFETY,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
  readPublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';

const collectorCodeSha = 'a'.repeat(40);
const hex = (value: string) => value.repeat(64).slice(0, 64);

function observation(
  id: string,
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
  const sampleClass = (overrides.sampleClass ?? 'FORWARD_NATURAL_SAMPLE') as PublicForwardPartialFillSampleClass;
  const forwardCalibrationSampleCredit = sampleClass === 'FORWARD_NATURAL_SAMPLE' ? 1 : 0;
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass,
    observationId: id,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    observedAtMs: 3_000,
    passiveLimitPrice: 100,
    requestedQuantity: 2,
    eligiblePublicTouchQuantityUpperBound: 1,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: [`exec-${id}`],
    actualFillFraction: null,
    actualFillObserved: false,
    queuePositionKnown: false,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1',
    sourceDigest: hex('1'),
    sourceObservationLineageId: `lineage-${id}`,
    sourceObservationLineageDigest: hex('2'),
    preEventBookDigest: hex('3'),
    forwardPublicFillsDigest: hex('4'),
    postEventBookDigest: hex('5'),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'],
    forwardCalibrationSampleCredit,
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
    ...overrides,
  };
}

async function withStateRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-dataset-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('persists one forward observation into an integrity-checked dataset without cost or Entry credit', async () => {
  await withStateRoot(async (root) => {
    const result = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    assert.equal(result.changed, true);
    assert.equal(result.insertedObservationCount, 1);
    assert.equal(result.duplicateObservationCount, 0);
    assert.equal(result.dataset.observationCount, 1);
    assert.equal(result.dataset.forwardCalibrationSampleCreditCount, 1);
    assert.equal(result.dataset.durablePersistencePerformed, true);
    assert.equal(result.dataset.calibrationArtifactProduced, false);
    assert.equal(result.dataset.partialFillCostPresent, false);
    assert.equal(result.dataset.calibrationSampleSufficient, false);
    assert.equal(result.dataset.regimeScopeComplete, false);
    assert.equal(result.dataset.splitAssignmentComplete, false);
    assert.equal(result.dataset.oosValidationComplete, false);
    assert.equal(result.dataset.naturalEntryCredit, 0);
    assert.equal(result.dataset.runtimeCostCredit, 0);
    assert.equal(result.dataset.partialFillStatus, 'BLOCKED_DATA');
    assert.equal(result.dataset.fullCostReady, false);
    assert.equal(verifyPublicForwardPartialFillCalibrationDataset(result.dataset).valid, true);
    assert.match(result.datasetRelativePath, /^forward\/partial-fill-calibration-v1\/forward_natural_sample\/a{40}\/dataset\.json$/u);
  });
});

test('read-only reader binds the canonical path to the expected identity and digest without rewriting it', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    const path = resolve(root, persisted.datasetRelativePath);
    const before = await readFile(path, 'utf8');
    const read = await readPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: persisted.dataset.datasetIdentity,
      expectedDatasetDigest: persisted.dataset.datasetDigest,
    });
    const after = await readFile(path, 'utf8');
    assert.equal(read.readOnly, true);
    assert.equal(read.datasetRelativePath, persisted.datasetRelativePath);
    assert.equal(read.dataset.observationCount, 1);
    assert.equal(read.dataset.partialFillCostPresent, false);
    assert.equal(read.dataset.fullCostReady, false);
    assert.equal(Object.isFrozen(read.dataset), true);
    assert.equal(Object.isFrozen(read.dataset.observations), true);
    assert.equal(after, before);
  });
});

test('read-only reader fails closed on missing data or ingest-receipt identity and digest mismatch', async () => {
  await withStateRoot(async (root) => {
    await assert.rejects(readPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: `partial-fill-forward-dataset:FORWARD_NATURAL_SAMPLE:${collectorCodeSha}`,
      expectedDatasetDigest: hex('f'),
    }), /CANONICAL_PARTIAL_FILL_DATASET_MISSING/u);

    const persisted = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    await assert.rejects(readPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: `${persisted.dataset.datasetIdentity}:wrong`,
      expectedDatasetDigest: persisted.dataset.datasetDigest,
    }), /DATASET_IDENTITY_MISMATCH/u);
    await assert.rejects(readPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      expectedDatasetIdentity: persisted.dataset.datasetIdentity,
      expectedDatasetDigest: hex('f'),
    }), /DATASET_DIGEST_MISMATCH/u);
  });
});

test('identical observation replay is a deterministic duplicate and does not rewrite the dataset', async () => {
  await withStateRoot(async (root) => {
    const first = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    const second = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 5_000,
    });
    assert.equal(second.changed, false);
    assert.equal(second.insertedObservationCount, 0);
    assert.equal(second.duplicateObservationCount, 1);
    assert.equal(second.dataset.datasetDigest, first.dataset.datasetDigest);
    assert.equal(second.dataset.updatedAtMs, first.dataset.updatedAtMs);
  });
});

test('same observation identity with changed content fails closed', async () => {
  await withStateRoot(async (root) => {
    await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    await assert.rejects(
      persistPublicForwardPartialFillCalibrationDataset({
        stateRoot: root,
        storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
        sampleClass: 'FORWARD_NATURAL_SAMPLE',
        collectorCodeSha,
        observations: [observation('obs-1', {
          eligiblePublicTouchQuantityUpperBound: 0.5,
          opportunityFillRatioUpperBound: 0.25,
        })],
        nowMs: 5_000,
      }),
      /OBSERVATION_ID_CONTENT_CONFLICT/u,
    );
  });
});

test('new observations extend the immutable predecessor digest chain', async () => {
  await withStateRoot(async (root) => {
    const first = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    const secondObservation = observation('obs-2', {
      windowStartMs: 5_000,
      windowEndMs: 6_000,
      observedAtMs: 7_000,
      sourceDigest: hex('6'),
      sourceObservationLineageDigest: hex('7'),
      preEventBookDigest: hex('8'),
      forwardPublicFillsDigest: hex('9'),
      postEventBookDigest: hex('b'),
    });
    const second = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [secondObservation],
      nowMs: 8_000,
    });
    assert.equal(second.dataset.predecessorDatasetDigest, first.dataset.datasetDigest);
    assert.equal(second.dataset.observationCount, 2);
    assert.equal(second.dataset.forwardCalibrationSampleCreditCount, 2);
    assert.equal(second.insertedObservationCount, 1);
    assert.equal(verifyPublicForwardPartialFillCalibrationDataset(second.dataset).valid, true);
  });
});

test('research samples are isolated and receive zero forward calibration credit', async () => {
  await withStateRoot(async (root) => {
    const result = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'CALIBRATION_RESEARCH_SAMPLE',
      collectorCodeSha,
      observations: [observation('research-1', {
        sampleClass: 'CALIBRATION_RESEARCH_SAMPLE',
        forwardCalibrationSampleCredit: 0,
      })],
      nowMs: 4_000,
    });
    assert.equal(result.dataset.forwardCalibrationSampleCreditCount, 0);
    assert.match(result.datasetRelativePath, /calibration_research_sample/u);
    assert.equal(result.dataset.calibrationArtifactProduced, false);
  });
});

test('missing or non-absolute canonical state root fails closed without creating storage', async () => {
  await assert.rejects(
    persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: 'relative-state-root',
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    }),
    /STATE_ROOT_MUST_BE_ABSOLUTE/u,
  );
  await assert.rejects(
    persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: join(tmpdir(), `missing-partial-fill-root-${process.pid}`),
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    }),
    /STATE_ROOT_MISSING/u,
  );
});

test('corrupted on-disk dataset is rejected instead of silently repaired or overwritten', async () => {
  await withStateRoot(async (root) => {
    const first = await persistPublicForwardPartialFillCalibrationDataset({
      stateRoot: root,
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      collectorCodeSha,
      observations: [observation('obs-1')],
      nowMs: 4_000,
    });
    const path = resolve(root, first.datasetRelativePath);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.observationCount = 99;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    await assert.rejects(
      persistPublicForwardPartialFillCalibrationDataset({
        stateRoot: root,
        storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
        sampleClass: 'FORWARD_NATURAL_SAMPLE',
        collectorCodeSha,
        observations: [observation('obs-2', { windowStartMs: 5_000, windowEndMs: 6_000, observedAtMs: 7_000 })],
        nowMs: 8_000,
      }),
      /DATASET_CORRUPT/u,
    );
  });
});

test('actual-fill or partial-fill-cost claims are rejected at the persistence boundary', async () => {
  await withStateRoot(async (root) => {
    const unsafe = {
      ...observation('unsafe'),
      actualFillFraction: 0.5,
      actualFillObserved: true,
      partialFillCostPercent: 0.1,
    } as unknown as PublicForwardPartialFillCalibrationObservation;
    await assert.rejects(
      persistPublicForwardPartialFillCalibrationDataset({
        stateRoot: root,
        storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
        sampleClass: 'FORWARD_NATURAL_SAMPLE',
        collectorCodeSha,
        observations: [unsafe],
        nowMs: 4_000,
      }),
      /OBSERVATION_ACTUAL_FILL_CLAIM_FORBIDDEN|OBSERVATION_PARTIAL_FILL_COST_FORBIDDEN/u,
    );
  });
});

test('dataset safety contract keeps calibration, cost, Entry and execution authority disabled', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_SAFETY, {
    existingCanonicalStateRootRequired: true,
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    actualFillClaimAllowed: false,
    partialFillCostProduced: false,
    calibrationArtifactProduced: false,
    calibrationSampleSufficient: false,
    regimeScopeComplete: false,
    splitAssignmentComplete: false,
    oosValidationComplete: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    orderSubmissionAllowed: false,
    financialMutationAllowed: false,
    fullCostReady: false,
  });
});
