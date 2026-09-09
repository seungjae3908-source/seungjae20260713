import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
  type PublicForwardPartialFillCalibrationObservation,
} from './public-forward-partial-fill-calibration-collector.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardPartialFillReceiptDigest,
  type PublicForwardPartialFillCaptureIngestResult,
} from './public-forward-partial-fill-calibration-capture-ingest.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  persistPublicForwardPartialFillCalibrationDataset,
  type PublicForwardPartialFillDatasetPersistResult,
} from './public-forward-partial-fill-calibration-dataset-store.service';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY,
  recoverPublicForwardPartialFillCalibrationDatasetPointer,
} from './public-forward-partial-fill-calibration-pointer-recovery.service';

const collectorCodeSha = 'a'.repeat(40);
const repository = 'seungjae3908-source/seungjae20260713';
const researchRepoRoot = resolve(tmpdir(), 'partial-fill-pointer-recovery-research');
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

function observation(id = 'obs-1'): PublicForwardPartialFillCalibrationObservation {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION',
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    observationId: id,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantityNotionalBucketIdentity: 'BTCUSDT-PUBLIC-MIN-ORDER-QTY-0.0001-V1',
    collectorCodeSha,
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    observedAtMs: 3_000,
    passiveLimitPrice: 100,
    requestedQuantity: 0.0001,
    eligiblePublicTouchQuantityUpperBound: 0,
    opportunityFillRatioUpperBound: 0,
    eligiblePublicExecutionIds: [],
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
  };
}

async function withStateRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'partial-fill-pointer-recovery-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function persistedDataset(root: string): Promise<PublicForwardPartialFillDatasetPersistResult> {
  return persistPublicForwardPartialFillCalibrationDataset({
    stateRoot: root,
    storeContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    collectorCodeSha,
    observations: [observation()],
    nowMs: 4_000,
  });
}

function finalizedReceipt(persisted: PublicForwardPartialFillDatasetPersistResult): PublicForwardPartialFillCaptureIngestResult {
  const body = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_INGEST_RECEIPT_VERSION,
    captureReceiptDigest: hex('6'),
    captureArtifactReceiptDigest: hex('7'),
    exactMainSha: collectorCodeSha,
    repository,
    captureRunId: '33356043075',
    captureRunAttempt: '1',
    observationId: observation().observationId,
    sourceObservationLineageDigest: observation().sourceObservationLineageDigest,
    artifactId: '9745163020',
    artifactDigest: hex('8'),
    datasetIdentity: persisted.dataset.datasetIdentity,
    datasetDigest: persisted.dataset.datasetDigest,
    datasetRelativePath: persisted.datasetRelativePath,
    insertedObservationCount: 1,
    duplicateObservationCount: 0,
    durableDatasetPersistencePerformed: true,
    canonicalDatasetCreditApplied: true,
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
  return Object.freeze({
    ...body,
    receiptDigest: computePublicForwardPartialFillReceiptDigest(body),
  });
}

async function recover(root: string, receipt: PublicForwardPartialFillCaptureIngestResult) {
  return recoverPublicForwardPartialFillCalibrationDatasetPointer({
    stateRoot: root,
    researchRepoRoot,
    ingestReceipt: receipt,
  });
}

test('R01 finalized canonical ingest receipt recovers exact immutable pointer without sample mutation', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const result = await recover(root, receipt);
    assert.equal(result.pointerCreated, true);
    assert.equal(result.immutableDatasetCreated, true);
    assert.equal(result.datasetIdentity, persisted.dataset.datasetIdentity);
    assert.equal(result.datasetDigest, persisted.dataset.datasetDigest);
    assert.equal(result.sourceIngestReceiptDigest, receipt.receiptDigest);
    assert.equal(result.observationInsertCount, 0);
    assert.equal(result.sampleCreditDelta, 0);
    assert.equal(result.releaseBindingPublicationPerformed, false);
    assert.equal(result.runtimeActivationPerformed, false);
  });
});

test('R02 exact recovery is idempotent and never re-ingests the observation', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const first = await recover(root, receipt);
    const second = await recover(root, receipt);
    assert.equal(first.pointerDigest, second.pointerDigest);
    assert.equal(second.pointerCreated, false);
    assert.equal(second.immutableDatasetCreated, false);
    assert.equal(second.observationInsertCount, 0);
    assert.equal(second.duplicateCreditCount, 0);
  });
});

test('R03 mutable canonical dataset bytes are unchanged by pointer recovery', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const path = resolve(root, persisted.datasetRelativePath);
    const before = await readFile(path);
    await recover(root, receipt);
    const after = await readFile(path);
    assert.equal(before.equals(after), true);
  });
});

test('R04 tampered finalized ingest receipt digest fails closed', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    await assert.rejects(
      () => recover(root, { ...receipt, receiptDigest: hex('9') }),
      /POINTER_RECOVERY_INGEST_RECEIPT_DIGEST_MISMATCH/u,
    );
  });
});

test('R05 dataset digest mismatch fails before pointer publication', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const body = { ...receipt, datasetDigest: hex('b') };
    const { receiptDigest: _ignored, ...unsigned } = body;
    const mismatched = { ...unsigned, receiptDigest: computePublicForwardPartialFillReceiptDigest(unsigned) };
    await assert.rejects(() => recover(root, mismatched), /POINTER_RECOVERY_DATASET_DIGEST_MISMATCH/u);
  });
});

test('R06 symlink mutable dataset is rejected', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const path = resolve(root, persisted.datasetRelativePath);
    const moved = `${path}.real`;
    await rename(path, moved);
    await symlink(moved, path);
    await assert.rejects(() => recover(root, receipt), /POINTER_RECOVERY_DATASET_LOCATOR_INVALID/u);
  });
});

test('R07 decoy newer dataset path cannot become recovery authority', async () => {
  await withStateRoot(async (root) => {
    const persisted = await persistedDataset(root);
    const receipt = finalizedReceipt(persisted);
    const decoyPath = resolve(root, 'forward/partial-fill-calibration-v1/decoy/dataset.json');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(decoyPath), { recursive: true }));
    await writeFile(decoyPath, JSON.stringify({ datasetDigest: hex('c'), observationCount: 999 }));
    const result = await recover(root, receipt);
    assert.equal(result.datasetDigest, persisted.dataset.datasetDigest);
    assert.equal(result.observationCount, 1);
  });
});

test('R08 safety contract forbids selection heuristics, economic promotion and trading authority', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.directoryScanAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.latestSelectionAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.mtimeSelectionAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.largestNSelectionAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.ingestReplayAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.sampleCreditDelta, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.productionPolicyAuthorityConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_POINTER_RECOVERY_SAFETY.executionAuthority, 'NONE');
});
