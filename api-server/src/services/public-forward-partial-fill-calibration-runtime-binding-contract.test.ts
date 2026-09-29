import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY,
  assertPublicForwardPartialFillDatasetPointerCompatible,
  computePublicForwardPartialFillDatasetPointerDigest,
  publishPublicForwardPartialFillCalibrationDatasetPointer,
  readPublicForwardPartialFillCalibrationDatasetPointer,
  type PublicForwardPartialFillCalibrationDatasetPointer,
  verifyPublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-dataset-pointer.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY,
  assertPublicForwardPartialFillReleaseBindingCompatible,
  buildPublicForwardPartialFillCalibrationReleaseBinding,
} from './public-forward-partial-fill-calibration-release-binding.service';
import { PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY } from './public-forward-partial-fill-production-policy-manifest.service';

const collectorCodeSha = 'a'.repeat(40);
const repository = 'seungjae3908-source/seungjae20260713';
const hex = (value: string) => value.repeat(64).slice(0, 64);
const researchRepoRoot = resolve(tmpdir(), 'partial-fill-runtime-binding-research-repo');

function observation(
  id: string,
  overrides: Partial<PublicForwardPartialFillCalibrationObservation> = {},
): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
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
    ...overrides,
  };
}

async function withStateRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-runtime-binding-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function persistedDataset(root: string, id = 'obs-1', nowMs = 4_000) {
  return persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    observations: [observation(id)],
    nowMs,
  });
}

function ingestDigest(seed = 'f'): string {
  return hex(seed);
}

function pointerPublicationInput(
  root: string,
  persisted: Awaited<ReturnType<typeof persistedDataset>>,
  receiptDigest = ingestDigest(),
) {
  return {
    stateRoot: root,
    researchRepoRoot,
    dataset: persisted.dataset,
    mutableDatasetRelativePath: persisted.datasetRelativePath,
    sourceIngestReceiptDigest: receiptDigest,
    sourceIngestReceiptRef: `ingest-receipt:sha256:${receiptDigest}`,
    publicationProvenance: {
      authority: 'CANONICAL_INGEST_PRODUCER' as const,
      repository,
      exactMainSha: collectorCodeSha,
      captureRunId: '100',
      captureRunAttempt: '1',
      artifactId: '200',
    },
  };
}

function releaseInput(pointer: PublicForwardPartialFillCalibrationDatasetPointer, identity: string) {
  return {
    pointer,
    releaseBindingIdentity: identity,
    releaseControlReference: `https://github.com/${repository}/issues/23`,
    publicationProvenance: {
      repository,
      exactMainSha: collectorCodeSha,
      issueNumber: 23 as const,
      approvalReference: `approval:${identity}`,
      approvedBy: 'OWNER',
    },
  };
}

function redigestPointer(
  pointer: PublicForwardPartialFillCalibrationDatasetPointer,
  overrides: Record<string, unknown>,
): PublicForwardPartialFillCalibrationDatasetPointer {
  const merged = { ...pointer, ...overrides } as Record<string, unknown>;
  const { pointerDigest: _ignored, ...body } = merged;
  return {
    ...body,
    pointerDigest: computePublicForwardPartialFillDatasetPointerDigest(
      body as Omit<PublicForwardPartialFillCalibrationDatasetPointer, 'pointerDigest'>,
    ),
  } as PublicForwardPartialFillCalibrationDatasetPointer;
}

async function publishFirst(root: string) {
  const persisted = await persistedDataset(root);
  const published = await publishPublicForwardPartialFillCalibrationDatasetPointer(pointerPublicationInput(root, persisted));
  return { persisted, published };
}

async function publishSuccessor(root: string) {
  const first = await publishFirst(root);
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
  const secondPersisted = await persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    observations: [secondObservation],
    nowMs: 8_000,
  });
  const secondPublished = await publishPublicForwardPartialFillCalibrationDatasetPointer(
    pointerPublicationInput(root, secondPersisted, ingestDigest('e')),
  );
  return { ...first, secondPersisted, secondPublished };
}

test('T01 valid finalized canonical dataset publishes an immutable snapshot and pointer', async () => {
  await withStateRoot(async (root) => {
    const { persisted, published } = await publishFirst(root);
    assert.equal(published.immutableDatasetCreated, true);
    assert.equal(published.pointerCreated, true);
    assert.equal(published.pointer.datasetIdentity, persisted.dataset.datasetIdentity);
    assert.equal(published.pointer.datasetDigest, persisted.dataset.datasetDigest);
    assert.match(published.pointer.datasetRelativePath, /immutable-datasets\/[a-f0-9]{64}\/dataset\.json$/u);
  });
});

test('T02 exact dataset version and exact pointer payload re-publication is idempotent', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const first = await publishPublicForwardPartialFillCalibrationDatasetPointer(pointerPublicationInput(root, persisted));
    const second = await publishPublicForwardPartialFillCalibrationDatasetPointer(pointerPublicationInput(root, persisted));
    assert.equal(first.pointer.pointerDigest, second.pointer.pointerDigest);
    assert.equal(second.immutableDatasetCreated, false);
    assert.equal(second.pointerCreated, false);
  });
});

test('T03 same immutable snapshot locator with different bytes is a hard conflict', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const immutablePath = resolve(
      root,
      `forward/partial-fill-calibration-v1/immutable-datasets/${persisted.dataset.datasetDigest}/dataset.json`,
    );
    await mkdir(dirname(immutablePath), { recursive: true });
    await writeFile(immutablePath, 'conflicting-bytes', 'utf8');
    await assert.rejects(
      publishPublicForwardPartialFillCalibrationDatasetPointer(pointerPublicationInput(root, persisted)),
      /IMMUTABLE_DATASET_SNAPSHOT_CONFLICT/u,
    );
  });
});

test('T04 dataset bytes digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { datasetBytesDigest: hex('0') });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      datasetBytesDigest: published.pointer.datasetBytesDigest,
    });
    assert.equal(verification.valid, false);
    assert.ok(verification.blockers.includes('POINTER_DATASET_BYTES_DIGEST_MISMATCH'));
  });
});

test('T05 semantic dataset digest mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { datasetDigest: hex('0') });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      datasetDigest: published.pointer.datasetDigest,
    });
    assert.ok(verification.blockers.includes('POINTER_DATASET_DIGEST_MISMATCH'));
  });
});

test('T06 dataset identity mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { datasetIdentity: 'OTHER_DATASET' });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      datasetIdentity: published.pointer.datasetIdentity,
    });
    assert.ok(verification.blockers.includes('POINTER_DATASET_IDENTITY_MISMATCH'));
  });
});

test('T07 collector code SHA mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { collectorCodeSha: 'b'.repeat(40) });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      collectorCodeSha,
    });
    assert.ok(verification.blockers.includes('POINTER_COLLECTOR_SHA_MISMATCH'));
  });
});

test('T08 sample class mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { sampleClass: 'CALIBRATION_RESEARCH_SAMPLE' });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
    });
    assert.ok(verification.blockers.includes('POINTER_SAMPLE_CLASS_MISMATCH'));
  });
});

test('T09 store contract mismatch fails closed', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { storeContract: 'WRONG_STORE' });
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered, {
      storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    });
    assert.ok(verification.blockers.includes('POINTER_STORE_CONTRACT_MISMATCH'));
  });
});

test('T10 traversal locator is rejected', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { datasetRelativePath: '../dataset.json' });
    assert.ok(verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered).blockers.includes('POINTER_LOCATOR_INVALID'));
  });
});

test('T11 absolute locator is rejected', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = redigestPointer(published.pointer, { datasetRelativePath: '/tmp/dataset.json' });
    assert.ok(verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered).blockers.includes('POINTER_LOCATOR_INVALID'));
  });
});

test('T12 symlinked canonical dataset source is rejected', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const mutablePath = resolve(root, persisted.datasetRelativePath);
    const realPath = `${mutablePath}.real`;
    await rename(mutablePath, realPath);
    await symlink(realPath, mutablePath);
    await assert.rejects(
      publishPublicForwardPartialFillCalibrationDatasetPointer(pointerPublicationInput(root, persisted)),
      /POINTER_LOCATOR_INVALID/u,
    );
  });
});

test('T13 missing ingest receipt provenance blocks pointer publication', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    await assert.rejects(
      publishPublicForwardPartialFillCalibrationDatasetPointer({
        ...pointerPublicationInput(root, persisted),
        sourceIngestReceiptDigest: '',
        sourceIngestReceiptRef: '',
      }),
      /POINTER_PROVENANCE_INVALID/u,
    );
  });
});

test('T14 pointer payload tampering is detected by canonical pointer digest', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const tampered = { ...published.pointer, datasetIdentity: 'TAMPERED' };
    const verification = verifyPublicForwardPartialFillCalibrationDatasetPointer(tampered);
    assert.ok(verification.blockers.includes('POINTER_DIGEST_MISMATCH'));
  });
});

test('T15 release binding explicitly selects a pointer and never uses filesystem mtime', async () => {
  await withStateRoot(async (root) => {
    const { published, secondPublished } = await publishSuccessor(root);
    await utimes(resolve(root, published.pointer.pointerRelativePath), new Date(10_000), new Date(10_000));
    await utimes(resolve(root, secondPublished.pointer.pointerRelativePath), new Date(20_000), new Date(20_000));
    const binding = buildPublicForwardPartialFillCalibrationReleaseBinding(releaseInput(published.pointer, 'release-mtime-test'));
    assert.equal(binding.datasetPointerDigest, published.pointer.pointerDigest);
    assert.notEqual(binding.datasetPointerDigest, secondPublished.pointer.pointerDigest);
  });
});

test('T16 release binding never chooses lexicographically latest pointer filename', async () => {
  await withStateRoot(async (root) => {
    const { published, secondPublished } = await publishSuccessor(root);
    const ordered = [published.pointer, secondPublished.pointer]
      .sort((left, right) => left.pointerRelativePath.localeCompare(right.pointerRelativePath));
    const binding = buildPublicForwardPartialFillCalibrationReleaseBinding(releaseInput(ordered[0], 'release-lexical-test'));
    assert.equal(binding.datasetPointerRef, ordered[0].pointerRelativePath);
    assert.notEqual(binding.datasetPointerRef, ordered[1].pointerRelativePath);
  });
});

test('T17 same immutable pointer identity with different payload is a hard conflict', async () => {
  await withStateRoot(async (root) => {
    const { published } = await publishFirst(root);
    const conflicting = redigestPointer(published.pointer, {
      publicationProvenance: {
        ...published.pointer.publicationProvenance,
        artifactId: '201',
      },
    });
    assert.equal(conflicting.pointerIdentity, published.pointer.pointerIdentity);
    assert.throws(
      () => assertPublicForwardPartialFillDatasetPointerCompatible(published.pointer, conflicting),
      /POINTER_IDENTITY_CONFLICT/u,
    );
  });
});

test('T18 same logical dataset identity may advance only through predecessor lineage and a new pointer identity', async () => {
  await withStateRoot(async (root) => {
    const { persisted, published, secondPersisted, secondPublished } = await publishSuccessor(root);
    assert.equal(secondPersisted.dataset.datasetIdentity, persisted.dataset.datasetIdentity);
    assert.equal(secondPersisted.dataset.predecessorDatasetDigest, persisted.dataset.datasetDigest);
    assert.notEqual(secondPersisted.dataset.datasetDigest, persisted.dataset.datasetDigest);
    assert.notEqual(secondPublished.pointer.pointerIdentity, published.pointer.pointerIdentity);
  });
});

test('T19 rollback creates a new release binding that references the old immutable pointer without rewriting it', async () => {
  await withStateRoot(async (root) => {
    const { published, secondPublished } = await publishSuccessor(root);
    const current = buildPublicForwardPartialFillCalibrationReleaseBinding(releaseInput(secondPublished.pointer, 'release-r2'));
    const rollback = buildPublicForwardPartialFillCalibrationReleaseBinding(releaseInput(published.pointer, 'release-r3-rollback'));
    assert.equal(current.datasetPointerDigest, secondPublished.pointer.pointerDigest);
    assert.equal(rollback.datasetPointerDigest, published.pointer.pointerDigest);
    assert.notEqual(current.releaseBindingIdentity, rollback.releaseBindingIdentity);
    assert.doesNotThrow(() => assertPublicForwardPartialFillReleaseBindingCompatible(current, rollback));
  });
});

test('T20 #855 production policy manifest remains candidate-only with zero production authority', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.candidateOnly, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.productionAuthorityConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.policyArtifactProduced, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_PRODUCTION_POLICY_MANIFEST_SAFETY.evidenceComplete, 0);
});

test('T21 pointer and release-binding existence never promotes economic evidence', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.calibrationSampleSufficient, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.partialFillCostPresent, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.profitabilityProven, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.fullCostReady, false);
});

test('T22 pointer readback is read-only and does not mutate the canonical mutable dataset', async () => {
  await withStateRoot(async (root) => {
    const { persisted, published } = await publishFirst(root);
    const mutablePath = resolve(root, persisted.datasetRelativePath);
    const before = await readFile(mutablePath);
    const readback = await readPublicForwardPartialFillCalibrationDatasetPointer({
      stateRoot: root,
      researchRepoRoot,
      pointerRelativePath: published.pointer.pointerRelativePath,
      expectedPointerDigest: published.pointer.pointerDigest,
    });
    const after = await readFile(mutablePath);
    assert.ok(before.equals(after));
    assert.equal(readback.dataset.datasetDigest, persisted.dataset.datasetDigest);
  });
});

test('T23 Phase B contract leaves runtime resolver, API startup binding, and release-control publication disconnected', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.runtimeResolverConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.apiStartupBindingConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.releaseControlPublicationConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.productionPolicyAuthorityConnected, false);
});

test('T24 all Phase B contracts preserve zero execution authority and no live/private/order capability', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.autoTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_POINTER_SAFETY.realOrderEnabled, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.autoTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_RELEASE_BINDING_SAFETY.realOrderEnabled, false);
});
