import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION } from './public-forward-partial-fill-calibration-collector.service';
import {
  computePublicForwardPartialFillReceiptDigest,
  ingestPublicForwardPartialFillCalibrationCapture,
} from './public-forward-partial-fill-calibration-capture-ingest.service';

const mainSha = 'a'.repeat(40);
const repository = 'owner/repo';
const artifactId = '999';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const artifactDigest = digest('artifact');
const researchRepoRoot = join(tmpdir(), 'investment-research-current');

function observation() {
  return {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_COLLECTOR_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_SIMULATION_OBSERVATION' as const,
    sourceType: 'PUBLIC_FORWARD_SIMULATION' as const,
    sampleClass: 'FORWARD_NATURAL_SAMPLE' as const,
    observationId: 'obs-1',
    market: 'CRYPTO_FUTURES' as const,
    symbol: 'BTCUSDT',
    side: 'LONG' as const,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-Q1',
    collectorCodeSha: mainSha,
    windowStartMs: 1_000,
    windowEndMs: 1_500,
    observedAtMs: 1_600,
    passiveLimitPrice: 100,
    requestedQuantity: 2,
    eligiblePublicTouchQuantityUpperBound: 1,
    opportunityFillRatioUpperBound: 0.5,
    eligiblePublicExecutionIds: ['exec-1'],
    actualFillFraction: null,
    actualFillObserved: false as const,
    queuePositionKnown: false as const,
    partialFillCostPercent: null,
    sourceIdentity: 'BITGET_PUBLIC_FORWARD_PASSIVE_QUEUE_OPPORTUNITY_V1' as const,
    sourceDigest: digest('source'),
    sourceObservationLineageId: 'lineage-1',
    sourceObservationLineageDigest: digest('lineage'),
    preEventBookDigest: digest('pre'),
    forwardPublicFillsDigest: digest('fills'),
    postEventBookDigest: digest('post'),
    endpoints: ['/api/v3/market/orderbook', '/api/v3/market/fills'] as const,
    forwardCalibrationSampleCredit: 1 as const,
    historicalBackfillCredit: 0 as const,
    testFixtureCredit: 0 as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    calibrationArtifactProduced: false as const,
    durablePersistencePerformed: false as const,
    calibrationSampleSufficient: false as const,
    partialFillStatus: 'BLOCKED_DATA' as const,
    fullCostReady: false as const,
    privateApiUsed: false as const,
    executionAuthority: 'NONE' as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  };
}

function captureReceipt(status: 'PRESENT' | 'BLOCKED_DATA' = 'PRESENT') {
  const current = observation();
  const body = {
    schemaVersion: 'public-forward-partial-fill-capture-receipt-v1',
    evidenceClass: 'PUBLIC_FORWARD_PARTIAL_FILL_CAPTURE_RECEIPT',
    triggerSource: 'MANUAL_WORKFLOW_DISPATCH',
    runId: '123',
    runAttempt: '1',
    repository,
    exactMainSha: mainSha,
    collectorCodeSha: mainSha,
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-Q1',
    eventWindowMs: 500,
    captureStatus: status,
    blockers: status === 'PRESENT' ? [] : ['NO_ELIGIBLE_PUBLIC_FILLS'],
    observation: status === 'PRESENT' ? current : null,
    durableDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: false,
    calibrationArtifactProduced: false,
    partialFillCostPresent: false,
    fullCostReady: false,
    evidenceCompleteCredit: 0,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    realOrders: 0,
  };
  return { ...body, receiptDigest: computePublicForwardPartialFillReceiptDigest(body) };
}

function artifactReceipt(capture = captureReceipt()) {
  const current = capture.observation!;
  const body = {
    schemaVersion: 'public-forward-partial-fill-capture-artifact-receipt-v1',
    captureReceiptDigest: capture.receiptDigest,
    captureStatus: capture.captureStatus,
    exactMainSha: capture.exactMainSha,
    observationId: current.observationId,
    sourceObservationLineageId: current.sourceObservationLineageId,
    sourceObservationLineageDigest: current.sourceObservationLineageDigest,
    artifactId,
    artifactName: `public-forward-partial-fill-capture-${capture.runId}-${capture.runAttempt}`,
    artifactDigest,
    artifactReference: `https://github.com/${repository}/actions/runs/${capture.runId}/artifacts/${artifactId}`,
    durableDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    calibrationArtifactProduced: false,
    partialFillCostPresent: false,
    fullCostReady: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
  };
  return { ...body, receiptDigest: computePublicForwardPartialFillReceiptDigest(body) };
}

function resign<T extends Record<string, unknown>>(value: T) {
  const { receiptDigest: _ignored, ...body } = value;
  return { ...body, receiptDigest: computePublicForwardPartialFillReceiptDigest(body) };
}

function baseInput(stateRoot: string, capture = captureReceipt(), artifact = artifactReceipt(capture)) {
  return {
    stateRoot,
    researchRepoRoot,
    expectedMainSha: mainSha,
    expectedRepository: repository,
    expectedArtifactId: artifactId,
    expectedArtifactDigest: artifactDigest,
    captureReceipt: capture,
    artifactReceipt: artifact,
    nowMs: 2_000,
  };
}

test('persists one verified genuine capture into the existing canonical state root and stays fail-closed for cost', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'partial-fill-ingest-'));
  try {
    const capture = captureReceipt();
    const artifact = artifactReceipt(capture);
    const first = await ingestPublicForwardPartialFillCalibrationCapture(baseInput(stateRoot, capture, artifact));
    assert.equal(first.insertedObservationCount, 1);
    assert.equal(first.duplicateObservationCount, 0);
    assert.equal(first.durableDatasetPersistencePerformed, true);
    assert.equal(first.canonicalDatasetCreditApplied, true);
    assert.equal(first.captureRunId, '123');
    assert.equal(first.captureRunAttempt, '1');
    assert.equal(first.artifactId, artifactId);
    assert.equal(first.artifactDigest, artifactDigest);
    assert.equal(first.calibrationArtifactProduced, false);
    assert.equal(first.partialFillCostPresent, false);
    assert.equal(first.fullCostReady, false);
    assert.equal(first.naturalEntryCredit, 0);
    assert.equal(first.runtimeCostCredit, 0);
    assert.equal(first.executionAuthority, 'NONE');

    const duplicate = await ingestPublicForwardPartialFillCalibrationCapture({
      ...baseInput(stateRoot, capture, artifact),
      nowMs: 3_000,
    });
    assert.equal(duplicate.insertedObservationCount, 0);
    assert.equal(duplicate.duplicateObservationCount, 1);
    assert.equal(duplicate.durableDatasetPersistencePerformed, false);
    assert.equal(duplicate.canonicalDatasetCreditApplied, false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('rejects protected application storage and research checkout overlap before persistence', async () => {
  for (const stateRoot of [
    '/opt/stock-app-data/partial-fill',
    '/srv/stock-app/partial-fill',
    '/var/lib/stock-app/partial-fill',
  ]) {
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture(baseInput(stateRoot)),
      /BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_APPLICATION_STORAGE/,
    );
  }

  await assert.rejects(
    ingestPublicForwardPartialFillCalibrationCapture({
      ...baseInput(join(researchRepoRoot, 'stock-analyzer', 'partial-fill')),
      researchRepoRoot,
    }),
    /BLOCKED_STORAGE:STATE_ROOT_OVERLAPS_PROTECTED_RESEARCH_CHECKOUT/,
  );
});

test('rejects non-absolute research storage inputs before persistence', async () => {
  await assert.rejects(
    ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput('relative-state-root'), stateRoot: 'relative-state-root' }),
    /BLOCKED_STORAGE:STATE_ROOT_MUST_BE_ABSOLUTE/,
  );
  const stateRoot = await mkdtemp(join(tmpdir(), 'partial-fill-ingest-'));
  try {
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot), researchRepoRoot: 'relative-repo-root' }),
      /BLOCKED_STORAGE:RESEARCH_REPO_ROOT_MUST_BE_ABSOLUTE/,
    );
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('rejects tampered raw receipt digest before persistence', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'partial-fill-ingest-'));
  try {
    const capture = { ...captureReceipt(), requestedQuantity: 3 };
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot), captureReceipt: capture }),
      /CAPTURE_RECEIPT_DIGEST_INVALID/,
    );
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('rejects blocked capture, wrong main, broken lineage and immutable artifact metadata mismatch', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'partial-fill-ingest-'));
  try {
    const blocked = captureReceipt('BLOCKED_DATA');
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot), captureReceipt: blocked, artifactReceipt: {} }),
      /CAPTURE_NOT_PRESENT/,
    );

    const capture = captureReceipt();
    const artifact = artifactReceipt(capture);
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, artifact), expectedMainSha: 'b'.repeat(40) }),
      /CAPTURE_MAIN_SHA_MISMATCH/,
    );

    const brokenLineage = resign({ ...artifact, sourceObservationLineageDigest: digest('wrong') });
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, brokenLineage), artifactReceipt: brokenLineage }),
      /ARTIFACT_LINEAGE_MISMATCH/,
    );

    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, artifact), expectedArtifactId: '1000' }),
      /ARTIFACT_ID_EXPECTATION_MISMATCH/,
    );
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, artifact), expectedArtifactDigest: digest('different') }),
      /ARTIFACT_DIGEST_EXPECTATION_MISMATCH/,
    );
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('rejects a validly re-signed artifact receipt that points at another workflow run', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'partial-fill-ingest-'));
  try {
    const capture = captureReceipt();
    const artifact = artifactReceipt(capture);
    const wrongRun = resign({
      ...artifact,
      artifactName: 'public-forward-partial-fill-capture-777-1',
      artifactReference: `https://github.com/${repository}/actions/runs/777/artifacts/${artifactId}`,
    });
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, wrongRun), artifactReceipt: wrongRun }),
      /ARTIFACT_NAME_MISMATCH/,
    );

    const wrongReference = resign({
      ...artifact,
      artifactReference: `https://github.com/${repository}/actions/runs/777/artifacts/${artifactId}`,
    });
    await assert.rejects(
      ingestPublicForwardPartialFillCalibrationCapture({ ...baseInput(stateRoot, capture, wrongReference), artifactReceipt: wrongReference }),
      /ARTIFACT_REFERENCE_MISMATCH/,
    );
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});
