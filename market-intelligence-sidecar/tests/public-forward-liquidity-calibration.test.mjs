import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  CALIBRATION_RESEARCH_SAMPLE,
  FORWARD_NATURAL_SAMPLE,
  PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
  assessPublicCalibrationCapability,
  buildPublicLiquidityObservationBatch,
  collectBitgetForwardLiquidityObservationBatch,
  mergeLiquidityCalibrationBatch,
  persistLiquidityCalibrationBatch,
  verifyLiquidityCalibrationDataset,
} from '../src/public-forward-liquidity-calibration.mjs';

const collectorSha = 'a'.repeat(40);

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

function tradesFrame({
  eventTimestampMs = 1_200,
  requestStartedAtMs = 1_100,
  receiveTimestampMs = 1_300,
  side = 'buy',
  price = 101,
  size = 2,
  execId = 'public-exec-1',
} = {}) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: [{
        execId,
        execLinkId: `${execId}-link`,
        price: String(price),
        size: String(size),
        side,
        ts: String(eventTimestampMs),
        isRPI: 'NO',
      }],
    },
    requestStartedAtMs,
    receiveTimestampMs,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function validBatch(overrides = {}) {
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
    collectorCodeSha: collectorSha,
    ...overrides,
  });
}

test('real provider field contract is capability-complete without private data', () => {
  const capability = assessPublicCalibrationCapability({
    orderBookFrame: bookFrame(),
    tradeFrame: tradesFrame(),
  });
  assert.equal(capability.PUBLIC_CALIBRATION_DATA_CAPABLE, true);
  assert.equal(capability.status, 'CAPABLE');
  assert.deepEqual(capability.blockers, []);
  assert.equal(capability.privateApiUsed, false);
  assert.ok(Object.values(capability.fields).every(Boolean));
});

test('Natural Forward collection waits for a real event window before fetching public trades', async () => {
  const calls = [];
  const books = [
    bookFrame(),
    bookFrame({
      marketTimestampMs: 1_500,
      requestStartedAtMs: 1_350,
      receiveTimestampMs: 1_550,
      bids: [[101, 2], [100, 5]],
      asks: [[102, 4], [103, 5]],
    }),
  ];
  const batch = await collectBitgetForwardLiquidityObservationBatch({
    collectorCodeSha: collectorSha,
    eventObservationDelayMs: 7,
    postObservationDelaysMs: [11],
    fetchOrderBookFrame: async () => {
      calls.push('book');
      return books.shift();
    },
    fetchTradesFrame: async () => {
      calls.push('trades');
      return tradesFrame();
    },
    sleep: async (delayMs) => calls.push(`sleep:${delayMs}`),
  });
  assert.deepEqual(calls, ['book', 'sleep:7', 'trades', 'sleep:11', 'book']);
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].sampleClass, FORWARD_NATURAL_SAMPLE);
});

test('malformed public event and missing price are rejected instead of fabricated', () => {
  const base = {
    symbol: 'BTCUSDT',
    requestStartedAtMs: 1_100,
    receiveTimestampMs: 1_300,
  };
  assert.throws(() => normalizeBitgetPublicTradesFrame({
    ...base,
    payload: { code: '00000', data: [{ execId: 'x', price: '101', side: 'buy', ts: '1200' }] },
  }), /BITGET_PUBLIC_FILL_QUANTITY_INVALID/u);
  assert.throws(() => normalizeBitgetPublicTradesFrame({
    ...base,
    payload: { code: '00000', data: [{ execId: 'x', size: '1', side: 'buy', ts: '1200' }] },
  }), /BITGET_PUBLIC_FILL_PRICE_INVALID/u);
});

test('missing trade or book timestamp is rejected', () => {
  assert.throws(() => normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: [{ execId: 'x', price: '101', size: '1', side: 'buy' }] },
    requestStartedAtMs: 1_100,
    receiveTimestampMs: 1_300,
  }), /BITGET_PUBLIC_FILL_TIMESTAMP_MISSING/u);
  assert.throws(() => normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: { b: [[100, 1]], a: [[101, 1]] } },
    requestStartedAtMs: 900,
    receiveTimestampMs: 1_050,
  }), /BITGET_PUBLIC_BOOK_TIMESTAMP_MISSING/u);
});

test('stale or incorrectly ordered public L2 is rejected', () => {
  assert.throws(() => normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: { ts: '1000', b: [[100, 1]], a: [[101, 1]] } },
    requestStartedAtMs: 19_000,
    receiveTimestampMs: 20_000,
    maxFrameAgeMs: 5_000,
  }), /BITGET_PUBLIC_BOOK_STALE/u);
  assert.throws(() => bookFrame({ bids: [[99, 1], [100, 1]] }), /BITGET_PUBLIC_BOOK_BIDS_ORDER_INVALID/u);

  const staleForEvent = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame({ eventTimestampMs: 7_000, receiveTimestampMs: 7_100, requestStartedAtMs: 6_900 }),
    postEventBooks: [],
    collectorCodeSha: collectorSha,
    maxPreEventBookAgeMs: 5_000,
  });
  assert.equal(staleForEvent.observations.length, 0);
  assert.equal(staleForEvent.droppedEvents[0].reason, 'PRE_EVENT_BOOK_STALE_FOR_EVENT');
});

test('out-of-order post-event data and future timestamps cannot leak', () => {
  const outOfOrder = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame(),
    postEventBooks: [bookFrame({
      marketTimestampMs: 1_100,
      requestStartedAtMs: 1_350,
      receiveTimestampMs: 1_500,
    })],
    collectorCodeSha: collectorSha,
  });
  assert.equal(outOfOrder.observations.length, 0);
  assert.equal(outOfOrder.droppedEvents[0].reason, 'POST_EVENT_CHRONOLOGY_INVALID');

  assert.throws(() => normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: { code: '00000', data: { ts: '10000', b: [[100, 1]], a: [[101, 1]] } },
    requestStartedAtMs: 1_000,
    receiveTimestampMs: 2_000,
  }), /BITGET_PUBLIC_BOOK_FUTURE_TIMESTAMP/u);
});

test('public trade side must verify at the pre-event BBO', () => {
  const rejected = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame({ side: 'buy', price: 100 }),
    postEventBooks: [],
    collectorCodeSha: collectorSha,
  });
  assert.equal(rejected.observations.length, 0);
  assert.equal(rejected.droppedEvents[0].reason, 'AGGRESSIVE_SIDE_NOT_VERIFIED_AT_PRE_EVENT_BBO');
});

test('source and normalized digests are deterministic', () => {
  const first = validBatch();
  const second = validBatch();
  assert.equal(first.observations[0].sourceDigest, second.observations[0].sourceDigest);
  assert.equal(first.datasetProvenance.rawDigest, second.datasetProvenance.rawDigest);
  assert.equal(first.datasetProvenance.normalizedDigest, second.datasetProvenance.normalizedDigest);
  assert.equal(first.observations[0].collectorCodeSha, collectorSha);
});

test('instantaneous book walk and subsequent drift have separate identities and authority', () => {
  const observation = validBatch().observations[0];
  assert.match(observation.instantaneousVisibleDepthBookWalk.identity, /^book-walk:/u);
  assert.match(observation.subsequentPublicPriceDrift[0].identity, /^post-drift:/u);
  assert.notEqual(
    observation.instantaneousVisibleDepthBookWalk.identity,
    observation.subsequentPublicPriceDrift[0].identity,
  );
  assert.equal(observation.instantaneousVisibleDepthBookWalk.ownership, 'SLIPPAGE_VISIBLE_L2_BOOK_WALK_ONLY');
  assert.equal(observation.instantaneousVisibleDepthBookWalk.permanentMarketImpactEstimated, false);
  assert.equal(observation.subsequentPublicPriceDrift[0].executionCostEligible, false);
  assert.equal(observation.liquidityImpactCoefficient, null);
  assert.equal(observation.causalMarketImpactClaim, false);
});

test('historical research and Natural Forward samples remain separate', () => {
  const natural = validBatch({ sampleClass: FORWARD_NATURAL_SAMPLE });
  const historical = validBatch({ sampleClass: CALIBRATION_RESEARCH_SAMPLE });
  assert.equal(natural.observations[0].forwardCalibrationSampleCredit, 1);
  assert.equal(historical.observations[0].forwardCalibrationSampleCredit, 0);
  assert.equal(historical.observations[0].historicalBackfillForwardCredit, 0);
  const naturalDataset = mergeLiquidityCalibrationBatch(null, natural).dataset;
  assert.throws(
    () => mergeLiquidityCalibrationBatch(naturalDataset, historical),
    /CALIBRATION_DATASET_IDENTITY_MIXING_FORBIDDEN/u,
  );
});

test('duplicate observation is persisted once with zero duplicate credit', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'research-production-state-'));
  try {
    const batch = validBatch();
    const first = await persistLiquidityCalibrationBatch({
      stateRoot,
      storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
      batch,
    });
    const second = await persistLiquidityCalibrationBatch({
      stateRoot,
      storeContract: PUBLIC_LIQUIDITY_CALIBRATION_STORE_CONTRACT,
      batch,
    });
    assert.equal(first.insertedObservationCount, 1);
    assert.equal(second.insertedObservationCount, 0);
    assert.equal(second.duplicateObservationCount, 1);
    assert.equal(second.forwardNaturalSampleCreditDelta, 0);
    assert.equal(second.historicalBackfillForwardCreditDelta, 0);
    const stored = JSON.parse(await readFile(second.datasetPath, 'utf8'));
    assert.equal(stored.observations.length, 1);
    assert.equal(stored.duplicateAttempts.length, 1);
    assert.deepEqual(stored.datasetProvenance.droppedReasons, {});
    assert.equal(stored.datasetProvenance.rawSource.provider, 'BITGET_PUBLIC_UTA_V3');
    assert.deepEqual(verifyLiquidityCalibrationDataset(stored), { valid: true, reason: null });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('storage fails closed unless the canonical Research Production contract is explicit', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'research-production-state-'));
  try {
    await assert.rejects(
      persistLiquidityCalibrationBatch({ stateRoot, storeContract: 'ARBITRARY_STORE', batch: validBatch() }),
      /BLOCKED_STORAGE/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('dataset truth remains collector-ready but impact and full cost blocked', () => {
  const batch = validBatch();
  assert.equal(batch.readiness.LIQUIDITY_CALIBRATION_DATA_COLLECTOR_READY, true);
  assert.equal(batch.readiness.LIQUIDITY_IMPACT_PRESENT, false);
  assert.equal(batch.readiness.CALIBRATION_SAMPLE_SUFFICIENT, false);
  assert.equal(batch.readiness.LIQUIDITY_IMPACT_STATUS, 'BLOCKED_DATA');
  assert.equal(batch.readiness.FULL_COST_READY, false);
  assert.equal(batch.safety.simulatedPaperOrderIsMarketImpactEvent, false);
  assert.equal(batch.safety.privateTradingApiAllowed, false);
  assert.equal(batch.safety.realOrderAllowed, false);
});
