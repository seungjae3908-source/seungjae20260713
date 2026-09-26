import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  mergeLiquidityCalibrationBatch,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
  computePublicForwardLiquidityCaptureIngestReceiptDigest,
} from '../src/public-forward-liquidity-capture-ingest.mjs';
import {
  verifyPublicForwardLiquidityIngestReceiptChain,
} from '../src/public-forward-liquidity-ingest-receipt-chain.mjs';

const COLLECTOR_SHA = 'a'.repeat(40);
const COLLECTOR_BLOB = 'b'.repeat(40);
const COLLECTOR_PATH = 'market-intelligence-sidecar/src/public-forward-liquidity-calibration.mjs';
const DATASET_PATH = `forward/liquidity-calibration-v1/forward_natural_sample/${COLLECTOR_SHA}/dataset.json`;

function bookFrame({ marketTimestampMs, seed }) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: {
        ts: String(marketTimestampMs),
        b: [[100, 20 + seed], [99, 30 + seed]],
        a: [[101, 20 + seed], [102, 30 + seed]],
      },
    },
    requestStartedAtMs: marketTimestampMs - 50,
    receiveTimestampMs: marketTimestampMs + 10,
    maxFrameAgeMs: 10_000,
    endpoint: '/api/v3/market/orderbook',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=50&seed=${seed}`,
  });
}

function tradeFrame({ events, receiveTimestampMs, seed }) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: events.map((event) => ({
        execId: event.execId,
        execLinkId: `${event.execId}-link`,
        price: String(event.price ?? 101),
        size: String(event.quantity ?? 1),
        side: event.side ?? 'buy',
        ts: String(event.eventTimestampMs),
        isRPI: 'NO',
      })),
    },
    requestStartedAtMs: receiveTimestampMs - 50,
    receiveTimestampMs,
    endpoint: '/api/v3/market/fills',
    query: `category=USDT-FUTURES&symbol=BTCUSDT&limit=100&seed=${seed}`,
  });
}

function batch({ base, seed, execId }) {
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame({ marketTimestampMs: base - 100, seed }),
    tradeFrame: tradeFrame({
      events: [{ execId, eventTimestampMs: base, quantity: 1 }],
      receiveTimestampMs: base + 300,
      seed,
    }),
    postEventBooks: [bookFrame({ marketTimestampMs: base + 600, seed: seed + 100 })],
    collectorCodeSha: COLLECTOR_SHA,
    maxPreEventBookAgeMs: 5_000,
  });
}

function receiptForStep({ dataset, batchObservationIds, index, artifactId, blobSha = COLLECTOR_BLOB }) {
  const ids = [...batchObservationIds].sort();
  const idSet = new Set(ids);
  const batchObservations = dataset.observations
    .filter((observation) => idSet.has(observation.observationId))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const previousObservationIds = new Set(
    dataset.batchProvenance.slice(0, index).flatMap((_, provenanceIndex) => {
      if (provenanceIndex >= index) return [];
      return [];
    }),
  );
  void previousObservationIds;
  const provenance = dataset.batchProvenance[index];
  const duplicateObservationCount = index === 0
    ? 0
    : ids.filter((id) => dataset.duplicateAttempts
      .slice(0, dataset.duplicateAttempts.length)
      .some((attempt) => attempt.observationId === id)).length;
  const insertedObservationCount = ids.length - duplicateObservationCount;
  const body = {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_CAPTURE_INGEST_RECEIPT_VERSION,
    exactMainSha: COLLECTOR_SHA,
    collectorCodeSha: COLLECTOR_SHA,
    collectorImplementationPath: COLLECTOR_PATH,
    collectorImplementationBlobSha: blobSha,
    repository: 'seungjae3908-source/seungjae20260713',
    sampleClass: dataset.sampleClass,
    storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
    captureRunId: String(9000 + index),
    captureRunAttempt: '1',
    rawBatchDigest: provenance.rawDigest,
    batchObservationIds: ids,
    batchObservationCount: ids.length,
    batchObservationDigest: sha256(canonicalJson(batchObservations)),
    batchDatasetProvenanceDigest: sha256(canonicalJson(provenance)),
    batchProvenanceIndex: index,
    captureArtifactReceiptDigest: sha256(`capture-artifact-receipt-${artifactId}`),
    artifactId: String(artifactId),
    artifactDigest: sha256(`capture-artifact-${artifactId}`),
    predecessorDatasetDigest: dataset.predecessorDigest ?? null,
    datasetDigest: dataset.datasetDigest,
    datasetRelativePath: DATASET_PATH,
    datasetObservationCount: dataset.observations.length,
    datasetBatchProvenanceCount: dataset.batchProvenance.length,
    datasetDuplicateAttemptCount: dataset.duplicateAttempts.length,
    insertedObservationCount,
    duplicateObservationCount,
    rawIngestObservationDelta: insertedObservationCount,
    forwardCalibrationSampleCreditDelta: 0,
    independenceEvaluated: false,
    effectiveIndependentCalibrationN: null,
    calibrationSampleSufficient: false,
    independentSampleCreditAuthority: 'NONE_UNTIL_CANONICAL_INDEPENDENCE_TRANSFORM',
    canonicalDatasetPersistencePerformed: true,
    canonicalDatasetCreditApplied: false,
    duplicateCreditEvaluated: true,
    splitAssignmentPerformed: false,
    oosValidationComplete: false,
    calibrationArtifactProduced: false,
    liquidityImpactPresent: false,
    liquidityImpactStatus: 'BLOCKED_DATA',
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
  return { ...body, receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body) };
}

function resign(receipt, overrides) {
  const body = { ...receipt, ...overrides };
  delete body.receiptDigest;
  return { ...body, receiptDigest: computePublicForwardLiquidityCaptureIngestReceiptDigest(body) };
}

function chainFixture({ duplicateLast = false } = {}) {
  const batches = [
    batch({ base: 10_000, seed: 1, execId: 'chain-event-1' }),
    batch({ base: 20_000, seed: 2, execId: 'chain-event-2' }),
    duplicateLast
      ? batch({ base: 10_000, seed: 1, execId: 'chain-event-1' })
      : batch({ base: 30_000, seed: 3, execId: 'chain-event-3' }),
  ];
  let dataset = null;
  const receipts = [];
  for (let index = 0; index < batches.length; index += 1) {
    const current = batches[index];
    const batchObservationIds = current.observations.map((observation) => observation.observationId);
    dataset = mergeLiquidityCalibrationBatch(dataset, current).dataset;
    receipts.push(receiptForStep({
      dataset,
      batchObservationIds,
      index,
      artifactId: 9100 + index,
    }));
  }
  return { dataset, receipts };
}

function verify(fixture) {
  return verifyPublicForwardLiquidityIngestReceiptChain({
    dataset: fixture.dataset,
    ingestReceipts: fixture.receipts,
    datasetRelativePath: DATASET_PATH,
    collectorImplementationPath: COLLECTOR_PATH,
  });
}

function expectBlocked(fixture, pattern) {
  assert.throws(() => verify(fixture), pattern);
}

test('single batch authenticates as exactly one immutable ingest receipt', () => {
  const fixture = chainFixture();
  const one = {
    dataset: mergeLiquidityCalibrationBatch(null, batch({ base: 10_000, seed: 1, execId: 'single-event' })).dataset,
    receipts: [],
  };
  one.receipts = [receiptForStep({
    dataset: one.dataset,
    batchObservationIds: one.dataset.observations.map((observation) => observation.observationId),
    index: 0,
    artifactId: 9200,
  })];
  const result = verify(one);
  assert.equal(result.receiptCount, 1);
  assert.equal(result.finalDatasetDigest, one.dataset.datasetDigest);
  assert.ok(result.receiptChainDigest);
  assert.equal(fixture.receipts.length, 3);
});

test('cumulative three-batch dataset requires three ordered immutable receipts', () => {
  const fixture = chainFixture();
  const result = verify(fixture);
  assert.equal(result.receiptCount, 3);
  assert.deepEqual(result.receiptDigests, fixture.receipts.map((receipt) => receipt.receiptDigest));
  assert.equal(result.finalReceiptDigest, fixture.receipts.at(-1).receiptDigest);
  assert.equal(result.finalDatasetDigest, fixture.dataset.datasetDigest);
});

test('deleting first receipt fails closed', () => {
  const fixture = chainFixture();
  fixture.receipts = fixture.receipts.slice(1);
  expectBlocked(fixture, /UPSTREAM_INGEST_RECEIPT_CHAIN_LENGTH_MISMATCH/u);
});

test('deleting middle receipt fails closed', () => {
  const fixture = chainFixture();
  fixture.receipts.splice(1, 1);
  expectBlocked(fixture, /UPSTREAM_INGEST_RECEIPT_CHAIN_LENGTH_MISMATCH/u);
});

test('swapping receipt order fails closed', () => {
  const fixture = chainFixture();
  [fixture.receipts[0], fixture.receipts[1]] = [fixture.receipts[1], fixture.receipts[0]];
  expectBlocked(fixture, /UPSTREAM_RECEIPT_BATCH_INDEX_MISMATCH/u);
});

test('duplicating a receipt in the ordered chain fails closed', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = fixture.receipts[0];
  expectBlocked(fixture, /UPSTREAM_RECEIPT_BATCH_INDEX_MISMATCH/u);
});

test('wrong predecessor fails closed even with a freshly signed receipt digest', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = resign(fixture.receipts[1], { predecessorDatasetDigest: 'f'.repeat(64) });
  expectBlocked(fixture, /UPSTREAM_RECEIPT_CHAIN_PREDECESSOR_MISMATCH/u);
});

test('wrong batchProvenanceIndex fails closed even with a freshly signed receipt digest', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = resign(fixture.receipts[1], { batchProvenanceIndex: 2 });
  expectBlocked(fixture, /UPSTREAM_RECEIPT_BATCH_INDEX_MISMATCH/u);
});

test('forged batchObservationDigest fails closed even with a freshly signed receipt digest', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = resign(fixture.receipts[1], { batchObservationDigest: 'f'.repeat(64) });
  expectBlocked(fixture, /UPSTREAM_BATCH_OBSERVATION_DIGEST_MISMATCH/u);
});

test('forged batchDatasetProvenanceDigest fails closed even with a freshly signed receipt digest', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = resign(fixture.receipts[1], { batchDatasetProvenanceDigest: 'f'.repeat(64) });
  expectBlocked(fixture, /UPSTREAM_BATCH_PROVENANCE_DIGEST_MISMATCH/u);
});

test('different collector implementation blob inside one cumulative cohort fails closed', () => {
  const fixture = chainFixture();
  fixture.receipts[1] = resign(fixture.receipts[1], { collectorImplementationBlobSha: 'c'.repeat(40) });
  expectBlocked(fixture, /UPSTREAM_COLLECTOR_IMPLEMENTATION_CHAIN_MISMATCH/u);
});

test('duplicate attempt history remains zero-credit authoritative lineage', () => {
  const fixture = chainFixture({ duplicateLast: true });
  const result = verify(fixture);
  assert.equal(fixture.dataset.observations.length, 2);
  assert.equal(fixture.dataset.duplicateAttempts.length, 1);
  assert.equal(fixture.dataset.duplicateAttempts[0].sampleCountDelta, 0);
  assert.equal(fixture.receipts.at(-1).insertedObservationCount, 0);
  assert.equal(fixture.receipts.at(-1).duplicateObservationCount, 1);
  assert.equal(result.receiptCount, 3);
});

test('forged final receipt dataset digest cannot authenticate the final canonical dataset', () => {
  const fixture = chainFixture();
  fixture.receipts[2] = resign(fixture.receipts[2], { datasetDigest: 'f'.repeat(64) });
  expectBlocked(fixture, /UPSTREAM_RECEIPT_(INTERMEDIATE_DATASET_DIGEST|CHAIN_FINAL_DATASET_DIGEST)_MISMATCH/u);
});