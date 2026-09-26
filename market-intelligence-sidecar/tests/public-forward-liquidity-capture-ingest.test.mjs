import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  sha256,
  verifyLiquidityCalibrationDataset,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
  ingestPublicForwardLiquidityCapture,
} from '../src/public-forward-liquidity-capture-ingest.mjs';

const FALLBACK_MAIN_SHA = 'a'.repeat(40);
const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const ARTIFACT_ID = '123456';
const ARTIFACT_DIGEST = 'b'.repeat(64);
const COLLECTOR_IMPLEMENTATION_PATH = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initializeExactCollectorCheckout(researchRepoRoot) {
  const collectorPath = join(researchRepoRoot, COLLECTOR_IMPLEMENTATION_PATH);
  await mkdir(dirname(collectorPath), { recursive: true });
  await writeFile(collectorPath, 'export const fixtureCollectorImplementation = true;\n', 'utf8');
  git(researchRepoRoot, ['init', '-q']);
  git(researchRepoRoot, ['config', 'user.email', 'fixture@example.invalid']);
  git(researchRepoRoot, ['config', 'user.name', 'Fixture']);
  git(researchRepoRoot, ['add', COLLECTOR_IMPLEMENTATION_PATH]);
  git(researchRepoRoot, ['commit', '-q', '-m', 'collector fixture']);
  const mainSha = git(researchRepoRoot, ['rev-parse', 'HEAD']);
  const collectorImplementationBlobSha = git(
    researchRepoRoot,
    ['rev-parse', `${mainSha}:${COLLECTOR_IMPLEMENTATION_PATH}`],
  );
  return { mainSha, collectorImplementationBlobSha };
}

function bookFrame({
  marketTimestampMs = 1_000,
  requestStartedAtMs = 900,
  receiveTimestampMs = 1_050,
  bids = [[100, 4], [99, 5]],
  asks = [[101, 3], [102, 6]],
} = {}) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: { ts: String(marketTimestampMs), b: bids, a: asks } },
    requestStartedAtMs,
    receiveTimestampMs,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=50',
  });
}

function tradesFrame() {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: [{
        execId: 'public-exec-1',
        execLinkId: 'public-exec-1-link',
        price: '101',
        size: '2',
        side: 'buy',
        ts: '1200',
        isRPI: 'NO',
      }],
    },
    requestStartedAtMs: 1_100,
    receiveTimestampMs: 1_300,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function validBatch(mainSha = FALLBACK_MAIN_SHA) {
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame(),
    postEventBooks: [bookFrame({
      marketTimestampMs: 1_500,
      requestStartedAtMs: 1_350,
      receiveTimestampMs: 1_550,
      bids: [[101, 2], [100, 5]],
      asks: [[102, 4], [103, 5]],
    })],
    collectorCodeSha: mainSha,
  });
}

function captureReceipt(batch, mainSha = FALLBACK_MAIN_SHA) {
  return {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT_VERSION,
    evidenceClass: 'PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT',
    triggerSource: 'MANUAL_WORKFLOW_DISPATCH',
    runId: '33225113204',
    runAttempt: '1',
    repository: REPOSITORY,
    exactMainSha: mainSha,
    collectorCodeSha: mainSha,
    symbol: 'BTCUSDT',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    eventObservationDelayMs: 2_000,
    postObservationDelaysMs: [1_000, 5_000],
    maxPreEventBookAgeMs: 5_000,
    captureStatus: 'PRESENT',
    blockers: [],
    prospectiveObservationCount: batch.observations.length,
    droppedObservationCount: batch.droppedEvents.length,
    datasetProvenance: batch.datasetProvenance,
    rawBatchDigest: sha256(canonicalJson(batch)),
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
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
}

function artifactReceipt(capture, overrides = {}) {
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_ARTIFACT_RECEIPT_VERSION,
    exactMainSha: capture.exactMainSha,
    collectorCodeSha: capture.collectorCodeSha,
    captureStatus: capture.captureStatus,
    rawBatchDigest: capture.rawBatchDigest,
    prospectiveObservationCount: capture.prospectiveObservationCount,
    artifactId: ARTIFACT_ID,
    artifactName: `public-forward-liquidity-capture-${capture.runId}-${capture.runAttempt}`,
    artifactDigest: ARTIFACT_DIGEST,
    artifactReference: `https://github.com/${REPOSITORY}/actions/runs/${capture.runId}/artifacts/${ARTIFACT_ID}`,
    canonicalDatasetPersistencePerformed: false,
    canonicalDatasetCreditApplied: false,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    fullCostReady: false,
    naturalEntryCredit: 0,
    runtimeCostCredit: 0,
    executionAuthority: 'NONE',
    privateApiUsed: false,
    liveTrading: false,
    orderSubmitted: false,
    ...overrides,
  };
  return { ...body, receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body) };
}

async function withRoots(callback) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'liquidity-state-'));
  const researchRepoRoot = await mkdtemp(join(tmpdir(), 'research-repo-'));
  try {
    const identity = await initializeExactCollectorCheckout(researchRepoRoot);
    await callback({ stateRoot, researchRepoRoot, ...identity });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(researchRepoRoot, { recursive: true, force: true });
  }
}

test('ingests immutable #795-style capture into the existing #776 canonical dataset store without independent sample credit', async () => {
  await withRoots(async ({ stateRoot, researchRepoRoot, mainSha, collectorImplementationBlobSha }) => {
    const rawBatch = validBatch(mainSha);
    const capture = captureReceipt(rawBatch, mainSha);
    const artifact = artifactReceipt(capture);
    const result = await ingestPublicForwardLiquidityCapture({
      stateRoot,
      researchRepoRoot,
      expectedMainSha: mainSha,
      expectedRepository: REPOSITORY,
      expectedArtifactId: ARTIFACT_ID,
      expectedArtifactDigest: ARTIFACT_DIGEST,
      rawBatch,
      captureReceipt: capture,
      artifactReceipt: artifact,
    });
    assert.equal(result.schemaVersion, PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION);
    assert.equal(result.collectorCodeSha, mainSha);
    assert.equal(result.collectorImplementationPath, COLLECTOR_IMPLEMENTATION_PATH);
    assert.equal(result.collectorImplementationBlobSha, collectorImplementationBlobSha);
    assert.equal(result.sampleClass, 'FORWARD_NATURAL_SAMPLE');
    assert.equal(result.storeContract, PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT);
    assert.equal(result.predecessorDatasetDigest, null);
    assert.equal(result.insertedObservationCount, 1);
    assert.equal(result.duplicateObservationCount, 0);
    assert.equal(result.rawIngestObservationDelta, 1);
    assert.equal(result.canonicalDatasetPersistencePerformed, true);
    assert.equal(result.canonicalDatasetCreditApplied, false);
    assert.equal(result.forwardCalibrationSampleCreditDelta, 0);
    assert.equal(result.independenceEvaluated, false);
    assert.equal(result.effectiveIndependentCalibrationN, null);
    assert.equal(result.calibrationSampleSufficient, false);
    assert.equal(result.independentSampleCreditAuthority, 'NONE_UNTIL_CANONICAL_INDEPENDENCE_TRANSFORM');
    assert.equal(result.splitAssignmentPerformed, false);
    assert.equal(result.oosValidationComplete, false);
    assert.equal(result.calibrationArtifactProduced, false);
    assert.equal(result.liquidityImpactPresent, false);
    assert.equal(result.fullCostReady, false);
    assert.equal(result.naturalEntryCredit, 0);
    assert.equal(result.runtimeCostCredit, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.match(result.datasetDigest, /^[a-f0-9]{64}$/u);
    assert.match(result.receiptDigest, /^[a-f0-9]{64}$/u);
    const stored = JSON.parse(await readFile(join(stateRoot, result.datasetRelativePath), 'utf8'));
    assert.equal(stored.observations.length, 1);
    assert.equal(stored.datasetDigest, result.datasetDigest);
    assert.deepEqual(verifyLiquidityCalibrationDataset(stored), { valid: true, reason: null });
  });
});

test('re-ingesting the same immutable capture binds the predecessor dataset while keeping sample credit zero', async () => {
  await withRoots(async ({ stateRoot, researchRepoRoot, mainSha, collectorImplementationBlobSha }) => {
    const rawBatch = validBatch(mainSha);
    const capture = captureReceipt(rawBatch, mainSha);
    const artifact = artifactReceipt(capture);
    const input = {
      stateRoot,
      researchRepoRoot,
      expectedMainSha: mainSha,
      expectedRepository: REPOSITORY,
      expectedArtifactId: ARTIFACT_ID,
      expectedArtifactDigest: ARTIFACT_DIGEST,
      rawBatch,
      captureReceipt: capture,
      artifactReceipt: artifact,
    };
    const first = await ingestPublicForwardLiquidityCapture(input);
    const second = await ingestPublicForwardLiquidityCapture(input);
    assert.equal(first.predecessorDatasetDigest, null);
    assert.equal(first.collectorImplementationBlobSha, collectorImplementationBlobSha);
    assert.equal(first.insertedObservationCount, 1);
    assert.equal(first.rawIngestObservationDelta, 1);
    assert.equal(first.forwardCalibrationSampleCreditDelta, 0);
    assert.equal(second.predecessorDatasetDigest, first.datasetDigest);
    assert.equal(second.collectorImplementationBlobSha, collectorImplementationBlobSha);
    assert.equal(second.storeContract, PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT);
    assert.equal(second.sampleClass, 'FORWARD_NATURAL_SAMPLE');
    assert.equal(second.collectorCodeSha, mainSha);
    assert.equal(second.insertedObservationCount, 0);
    assert.equal(second.rawIngestObservationDelta, 0);
    assert.equal(second.duplicateObservationCount, 1);
    assert.equal(second.forwardCalibrationSampleCreditDelta, 0);
    assert.equal(second.canonicalDatasetCreditApplied, false);
    assert.equal(second.effectiveIndependentCalibrationN, null);
    assert.notEqual(first.datasetDigest, second.datasetDigest);
    const stored = JSON.parse(await readFile(join(stateRoot, second.datasetRelativePath), 'utf8'));
    assert.equal(stored.predecessorDigest, first.datasetDigest);
    assert.equal(stored.observations.length, 1);
    assert.equal(stored.duplicateAttempts.length, 1);
  });
});

test('fails closed when the exact collector implementation blob cannot be proven from the captured checkout', async () => {
  await withRoots(async ({ stateRoot, researchRepoRoot, mainSha }) => {
    const rawBatch = validBatch(mainSha);
    const capture = captureReceipt(rawBatch, mainSha);
    const artifact = artifactReceipt(capture);
    await rm(join(researchRepoRoot, '.git'), { recursive: true, force: true });
    await assert.rejects(
      ingestPublicForwardLiquidityCapture({
        stateRoot,
        researchRepoRoot,
        expectedMainSha: mainSha,
        expectedRepository: REPOSITORY,
        expectedArtifactId: ARTIFACT_ID,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        rawBatch,
        captureReceipt: capture,
        artifactReceipt: artifact,
      }),
      /COLLECTOR_IMPLEMENTATION_BLOB_UNPROVEN/u,
    );
  });
});

test('rejects forged raw batch digest and immutable artifact digest mismatch', async () => {
  await withRoots(async ({ stateRoot, researchRepoRoot, mainSha }) => {
    const rawBatch = validBatch(mainSha);
    const capture = { ...captureReceipt(rawBatch, mainSha), rawBatchDigest: 'c'.repeat(64) };
    const artifact = artifactReceipt(capture);
    await assert.rejects(
      ingestPublicForwardLiquidityCapture({
        stateRoot,
        researchRepoRoot,
        expectedMainSha: mainSha,
        expectedRepository: REPOSITORY,
        expectedArtifactId: ARTIFACT_ID,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        rawBatch,
        captureReceipt: capture,
        artifactReceipt: artifact,
      }),
      /CAPTURE_RAW_BATCH_DIGEST_MISMATCH/u,
    );

    const validCapture = captureReceipt(rawBatch, mainSha);
    const wrongArtifact = artifactReceipt(validCapture, { artifactDigest: 'd'.repeat(64) });
    await assert.rejects(
      ingestPublicForwardLiquidityCapture({
        stateRoot,
        researchRepoRoot,
        expectedMainSha: mainSha,
        expectedRepository: REPOSITORY,
        expectedArtifactId: ARTIFACT_ID,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        rawBatch,
        captureReceipt: validCapture,
        artifactReceipt: wrongArtifact,
      }),
      /ARTIFACT_DIGEST_EXPECTATION_MISMATCH/u,
    );
  });
});

test('rejects authority escalation or an unverified empty capture', async () => {
  await withRoots(async ({ stateRoot, researchRepoRoot, mainSha }) => {
    const rawBatch = validBatch(mainSha);
    const capture = captureReceipt(rawBatch, mainSha);
    const escalated = { ...capture, liquidityImpactPresent: true };
    await assert.rejects(
      ingestPublicForwardLiquidityCapture({
        stateRoot,
        researchRepoRoot,
        expectedMainSha: mainSha,
        expectedRepository: REPOSITORY,
        expectedArtifactId: ARTIFACT_ID,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        rawBatch,
        captureReceipt: escalated,
        artifactReceipt: artifactReceipt(capture),
      }),
      /CAPTURE_TRUTH_BOUNDARY_INVALID/u,
    );
    const empty = { ...capture, captureStatus: 'BLOCKED_DATA', blockers: ['FORWARD_OBSERVATIONS_EMPTY'] };
    await assert.rejects(
      ingestPublicForwardLiquidityCapture({
        stateRoot,
        researchRepoRoot,
        expectedMainSha: mainSha,
        expectedRepository: REPOSITORY,
        expectedArtifactId: ARTIFACT_ID,
        expectedArtifactDigest: ARTIFACT_DIGEST,
        rawBatch,
        captureReceipt: empty,
        artifactReceipt: artifactReceipt(capture),
      }),
      /CAPTURE_NOT_PRESENT/u,
    );
  });
});

test('blocks protected application storage, repository overlap, and relative state roots before mutation', async () => {
  const rawBatch = validBatch();
  const capture = captureReceipt(rawBatch);
  const artifact = artifactReceipt(capture);
  const common = {
    researchRepoRoot: '/tmp/research-repo',
    expectedMainSha: FALLBACK_MAIN_SHA,
    expectedRepository: REPOSITORY,
    expectedArtifactId: ARTIFACT_ID,
    expectedArtifactDigest: ARTIFACT_DIGEST,
    rawBatch,
    captureReceipt: capture,
    artifactReceipt: artifact,
  };
  await assert.rejects(
    ingestPublicForwardLiquidityCapture({ ...common, stateRoot: 'relative/state' }),
    /STATE_ROOT_MUST_BE_ABSOLUTE/u,
  );
  await assert.rejects(
    ingestPublicForwardLiquidityCapture({ ...common, stateRoot: '/opt/stock-app-data/research' }),
    /OVERLAPS_PROTECTED_APPLICATION_STORAGE/u,
  );
  await assert.rejects(
    ingestPublicForwardLiquidityCapture({ ...common, stateRoot: '/tmp/research-repo' }),
    /STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT/u,
  );
  await assert.rejects(
    ingestPublicForwardLiquidityCapture({ ...common, stateRoot: '/tmp/research-repo/runtime-state' }),
    /STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT/u,
  );
  await assert.rejects(
    ingestPublicForwardLiquidityCapture({ ...common, stateRoot: '/tmp' }),
    /STATE_ROOT_OVERLAPS_RESEARCH_CHECKOUT/u,
  );
});

test('receipt digest is deterministic and ignores only the receiptDigest field', () => {
  const body = { schemaVersion: 'x', value: 1, nested: { b: 2, a: 1 } };
  const digest = computePublicForwardLiquidityCaptureIngestReceiptDigest(body);
  assert.equal(digest, computePublicForwardLiquidityCaptureIngestReceiptDigest({ ...body, receiptDigest: digest }));
  assert.notEqual(digest, computePublicForwardLiquidityCaptureIngestReceiptDigest({ ...body, value: 2 }));
});
