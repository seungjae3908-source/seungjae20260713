import assert from 'node:assert/strict';
import test from 'node:test';

import type { fetchPublicMarketJson } from './public-market-http';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_SAFETY,
  buildPublicForwardPartialFillCalibrationObservation,
  collectBitgetPublicForwardPartialFillCalibrationObservation,
  normalizePublicForwardPartialFillBookFrame,
  normalizePublicForwardPartialFillTradeFrame,
} from './public-forward-partial-fill-calibration-collector.service';

const collectorCodeSha = 'a'.repeat(40);

function bookPayload(timestampMs: number, bid = 100, ask = 101) {
  return {
    code: '00000',
    msg: 'success',
    data: {
      ts: String(timestampMs),
      b: [[String(bid), '5'], [String(bid - 1), '8']],
      a: [[String(ask), '6'], [String(ask + 1), '9']],
    },
  };
}

function fillsPayload(rows: ReadonlyArray<Readonly<{
  execId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  ts: number;
}>>) {
  return {
    code: '00000',
    msg: 'success',
    data: rows.map((row) => ({
      execId: row.execId,
      execLinkId: `link-${row.execId}`,
      side: row.side,
      price: String(row.price),
      size: String(row.size),
      ts: String(row.ts),
    })),
  };
}

function frames() {
  const preEventBook = normalizePublicForwardPartialFillBookFrame({
    symbol: 'BTCUSDT',
    payload: bookPayload(990),
    receiveTimestampMs: 1_000,
  });
  const forwardTrades = normalizePublicForwardPartialFillTradeFrame({
    symbol: 'BTCUSDT',
    payload: fillsPayload([
      { execId: 'sell-touch-1', side: 'sell', price: 100, size: 0.5, ts: 2_000 },
      { execId: 'sell-touch-2', side: 'sell', price: 99.9, size: 0.7, ts: 2_500 },
      { execId: 'sell-away', side: 'sell', price: 100.5, size: 4, ts: 2_700 },
      { execId: 'buy-other-side', side: 'buy', price: 101, size: 5, ts: 2_800 },
    ]),
    receiveTimestampMs: 4_000,
  });
  const postEventBook = normalizePublicForwardPartialFillBookFrame({
    symbol: 'BTCUSDT',
    payload: bookPayload(4_400, 100.2, 101.2),
    receiveTimestampMs: 4_500,
  });
  assert.ok(preEventBook);
  assert.ok(forwardTrades);
  assert.ok(postEventBook);
  return { preEventBook, forwardTrades, postEventBook };
}

test('forward observation records only passive queue opportunity upper bound, never an actual fill or cost', () => {
  const result = buildPublicForwardPartialFillCalibrationObservation({
    ...frames(),
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.observation);
  assert.equal(result.observation.eligiblePublicTouchQuantityUpperBound, 1.2);
  assert.equal(result.observation.opportunityFillRatioUpperBound, 0.6);
  assert.deepEqual(result.observation.eligiblePublicExecutionIds, ['sell-touch-1', 'sell-touch-2']);
  assert.equal(result.observation.actualFillFraction, null);
  assert.equal(result.observation.actualFillObserved, false);
  assert.equal(result.observation.queuePositionKnown, false);
  assert.equal(result.observation.partialFillCostPercent, null);
  assert.equal(result.observation.runtimeCostCredit, 0);
  assert.equal(result.observation.naturalEntryCredit, 0);
  assert.equal(result.observation.calibrationArtifactProduced, false);
  assert.equal(result.observation.partialFillStatus, 'BLOCKED_DATA');
  assert.equal(result.observation.fullCostReady, false);
});

test('zero public touch opportunity is measured zero opportunity, not zero partial-fill cost', () => {
  const current = frames();
  const buysOnly = normalizePublicForwardPartialFillTradeFrame({
    symbol: 'BTCUSDT',
    payload: fillsPayload([
      { execId: 'buy-1', side: 'buy', price: 101, size: 10, ts: 2_000 },
    ]),
    receiveTimestampMs: 4_000,
  });
  assert.ok(buysOnly);
  const result = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    forwardTrades: buysOnly,
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.observation);
  assert.equal(result.observation.eligiblePublicTouchQuantityUpperBound, 0);
  assert.equal(result.observation.opportunityFillRatioUpperBound, 0);
  assert.equal(result.observation.actualFillFraction, null);
  assert.equal(result.observation.partialFillCostPercent, null);
});

test('SHORT passive observation uses public buys at or above the pre-event ask', () => {
  const current = frames();
  const buys = normalizePublicForwardPartialFillTradeFrame({
    symbol: 'BTCUSDT',
    payload: fillsPayload([
      { execId: 'buy-touch', side: 'buy', price: 101, size: 0.4, ts: 2_000 },
      { execId: 'buy-through', side: 'buy', price: 101.2, size: 0.6, ts: 2_100 },
      { execId: 'buy-away', side: 'buy', price: 100.8, size: 8, ts: 2_200 },
    ]),
    receiveTimestampMs: 4_000,
  });
  assert.ok(buys);
  const result = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    forwardTrades: buys,
    side: 'SHORT',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-SHORT-QTY-2',
    collectorCodeSha,
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.observation);
  assert.equal(result.observation.passiveLimitPrice, 101);
  assert.equal(result.observation.eligiblePublicTouchQuantityUpperBound, 1);
  assert.equal(result.observation.opportunityFillRatioUpperBound, 0.5);
});

test('test fixture and non-forward evidence receive zero runtime credit by fail-closed rejection', () => {
  const current = frames();
  const fixture = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    side: 'LONG',
    requestedQuantity: 1,
    quantityNotionalBucketIdentity: 'FIXTURE',
    collectorCodeSha,
    testOnly: true,
  });
  assert.equal(fixture.status, 'BLOCKED_DATA');
  assert.ok(fixture.blockers.includes('PARTIAL_FILL_TEST_FIXTURE_RUNTIME_CREDIT_FORBIDDEN'));
  assert.equal(fixture.observation, null);

  const notForward = normalizePublicForwardPartialFillTradeFrame({
    symbol: 'BTCUSDT',
    payload: fillsPayload([{ execId: 'same-window', side: 'sell', price: 100, size: 1, ts: 1_000 }]),
    receiveTimestampMs: 1_000,
  });
  assert.ok(notForward);
  const blocked = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    forwardTrades: notForward,
    side: 'LONG',
    requestedQuantity: 1,
    quantityNotionalBucketIdentity: 'NON-FORWARD',
    collectorCodeSha,
  });
  assert.equal(blocked.status, 'BLOCKED_DATA');
  assert.ok(blocked.blockers.includes('FORWARD_WINDOW_NOT_OBSERVED'));
});

test('competing cost source digest and observation lineage reuse are rejected', () => {
  const current = frames();
  const first = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
  });
  assert.equal(first.status, 'PRESENT');
  assert.ok(first.observation);

  const sourceCollision = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
    forbiddenSourceDigests: [first.observation.sourceDigest],
  });
  assert.equal(sourceCollision.status, 'BLOCKED_DATA');
  assert.ok(sourceCollision.blockers.includes('PARTIAL_FILL_SOURCE_DIGEST_REUSED'));

  const lineageCollision = buildPublicForwardPartialFillCalibrationObservation({
    ...current,
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'BTCUSDT-LONG-QTY-2',
    collectorCodeSha,
    forbiddenObservationLineageIds: [first.observation.sourceObservationLineageId],
  });
  assert.equal(lineageCollision.status, 'BLOCKED_DATA');
  assert.ok(lineageCollision.blockers.includes('PARTIAL_FILL_SOURCE_OBSERVATION_LINEAGE_REUSED'));
});

test('research sample can be observed but receives no forward calibration sample credit', () => {
  const result = buildPublicForwardPartialFillCalibrationObservation({
    ...frames(),
    side: 'LONG',
    requestedQuantity: 2,
    quantityNotionalBucketIdentity: 'RESEARCH-ONLY',
    collectorCodeSha,
    sampleClass: 'CALIBRATION_RESEARCH_SAMPLE',
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.observation);
  assert.equal(result.observation.forwardCalibrationSampleCredit, 0);
  assert.equal(result.observation.historicalBackfillCredit, 0);
  assert.equal(result.observation.naturalEntryCredit, 0);
});

test('network collector uses only allow-listed public Bitget market endpoints and remains mutation-free', async () => {
  const payloads = [
    bookPayload(990),
    fillsPayload([{ execId: 'forward-sell', side: 'sell', price: 100, size: 0.5, ts: 2_000 }]),
    bookPayload(4_400, 100.1, 101.1),
  ];
  const requestedUrls: string[] = [];
  const fakeFetch: typeof fetchPublicMarketJson = async (value) => {
    requestedUrls.push(String(value));
    const next = payloads.shift();
    assert.ok(next);
    return next;
  };
  const timestamps = [1_000, 4_000, 4_500];
  const result = await collectBitgetPublicForwardPartialFillCalibrationObservation({
    symbol: 'BTCUSDT',
    side: 'LONG',
    requestedQuantity: 1,
    quantityNotionalBucketIdentity: 'NETWORK-CONTRACT',
    collectorCodeSha,
    eventWindowMs: 500,
  }, {
    fetchJson: fakeFetch,
    now: () => timestamps.shift() ?? 4_500,
    sleep: async () => undefined,
  });
  assert.equal(result.status, 'PRESENT');
  assert.ok(result.observation);
  assert.equal(requestedUrls.length, 3);
  assert.ok(requestedUrls[0].includes('/api/v3/market/orderbook'));
  assert.ok(requestedUrls[1].includes('/api/v3/market/fills'));
  assert.ok(requestedUrls[2].includes('/api/v3/market/orderbook'));
  assert.equal(requestedUrls.some((url) => /account|order|position|withdraw|transfer/iu.test(url)), false);
  assert.equal(result.observation.privateApiUsed, false);
  assert.equal(result.observation.executionAuthority, 'NONE');
  assert.equal(result.observation.liveTrading, false);
  assert.equal(result.observation.orderSubmitted, false);
});

test('safety contract pins all activation and cost-credit boundaries off', () => {
  assert.deepEqual(PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_SAFETY, {
    publicDataOnly: true,
    sourceType: 'PUBLIC_FORWARD_SIMULATION',
    actualFillClaimAllowed: false,
    queuePriorityClaimAllowed: false,
    partialFillCostProduced: false,
    calibrationArtifactProduced: false,
    historicalBackfillCredit: 0,
    testFixtureCredit: 0,
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
