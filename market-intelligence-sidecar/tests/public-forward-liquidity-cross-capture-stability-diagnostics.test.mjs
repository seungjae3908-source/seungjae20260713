import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  analyzePublicForwardLiquidityCrossCaptureStability,
  PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY,
} from '../src/public-forward-liquidity-cross-capture-stability-diagnostics.mjs';

const collectorSha = 'a'.repeat(40);
const canonicalEndpoints = ['/api/v3/market/orderbook', '/api/v3/market/fills'];

function bookFrame({
  marketTimestampMs,
  requestStartedAtMs,
  receiveTimestampMs,
  bestBid,
  bestAsk,
}) {
  return normalizeBitgetPublicOrderBookFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: {
        ts: String(marketTimestampMs),
        b: [[bestBid, 100], [bestBid - 1, 100]],
        a: [[bestAsk, 100], [bestAsk + 1, 100]],
      },
    },
    requestStartedAtMs,
    receiveTimestampMs,
    maxFrameAgeMs: 10_000,
    endpoint: canonicalEndpoints[0],
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=50',
  });
}

function tradesFrame({ trades, requestStartedAtMs, receiveTimestampMs }) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: trades.map((trade) => ({
        execId: trade.execId,
        execLinkId: `${trade.execId}-link`,
        price: String(trade.price),
        size: '1',
        side: trade.side,
        ts: String(trade.timestamp),
        isRPI: 'NO',
      })),
    },
    requestStartedAtMs,
    receiveTimestampMs,
    endpoint: canonicalEndpoints[1],
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function capture({
  captureIndex = 1,
  acceptedCount = 1,
  droppedCount = 0,
  side = 'SELL',
  postShift = 0,
} = {}) {
  const baseTimestampMs = 1_700_000_000_000 + (captureIndex * 10_000);
  const bestBid = 100 + captureIndex;
  const bestAsk = bestBid + 1;
  const accepted = Array.from({ length: acceptedCount }, (_, index) => ({
    execId: `capture-${captureIndex}-accepted-${index}`,
    price: side === 'BUY' ? bestAsk : bestBid,
    side: side.toLowerCase(),
    timestamp: baseTimestampMs + 200 + index,
  }));
  const dropped = Array.from({ length: droppedCount }, (_, index) => ({
    execId: `capture-${captureIndex}-dropped-${index}`,
    price: side === 'BUY' ? bestAsk : bestBid,
    side: side === 'BUY' ? 'sell' : 'buy',
    timestamp: baseTimestampMs + 300 + index,
  }));
  const preEventBook = bookFrame({
    marketTimestampMs: baseTimestampMs,
    requestStartedAtMs: baseTimestampMs - 100,
    receiveTimestampMs: baseTimestampMs + 100,
    bestBid,
    bestAsk,
  });
  return structuredClone(buildPublicLiquidityObservationBatch({
    preEventBook,
    tradeFrame: tradesFrame({
      trades: [...accepted, ...dropped],
      requestStartedAtMs: baseTimestampMs + 150,
      receiveTimestampMs: baseTimestampMs + 500,
    }),
    postEventBooks: [bookFrame({
      marketTimestampMs: baseTimestampMs + 1_000,
      requestStartedAtMs: baseTimestampMs + 900,
      receiveTimestampMs: baseTimestampMs + 1_050,
      bestBid: bestBid + 1 + postShift,
      bestAsk: bestAsk + 1 + postShift,
    })],
    collectorCodeSha: collectorSha,
  }));
}

function replaceObservations(batch, observations) {
  batch.observations = structuredClone(observations);
  batch.datasetProvenance.eventCount = observations.length;
  batch.datasetProvenance.firstObservedAtMs = observations.length
    ? Math.min(...observations.map((item) => item.eventTimestampMs))
    : null;
  batch.datasetProvenance.lastObservedAtMs = observations.length
    ? Math.max(...observations.map((item) => item.eventTimestampMs))
    : null;
  batch.datasetProvenance.normalizedDigest = sha256(canonicalJson(batch.observations));
  return batch;
}

test('reports descriptive cross-capture variability without grading stability or independent N', () => {
  const reports = analyzePublicForwardLiquidityCrossCaptureStability([
    capture({
      captureIndex: 1,
      acceptedCount: 2,
      droppedCount: 8,
    }),
    capture({
      captureIndex: 2,
      acceptedCount: 8,
      droppedCount: 2,
    }),
    capture({
      captureIndex: 3,
      acceptedCount: 1,
      droppedCount: 9,
    }),
  ]);

  assert.equal(reports.captureCount, 3);
  assert.deepEqual(reports.perCapture.map(({ acceptanceRate }) => acceptanceRate), [0.2, 0.8, 0.1]);
  assert.ok(Math.abs(reports.captureVariability.acceptanceRate.range - 0.7) < 1e-12);
  assert.equal(reports.captureVariability.gradingStatus, 'NOT_GRADED_NO_PREDECLARED_POLICY');
  assert.equal(reports.captureVariability.stabilityPolicyAvailable, false);
  assert.equal(reports.captureVariability.stabilityProven, false);
  assert.equal(reports.aggregate.totalEvents, 30);
  assert.equal(reports.aggregate.acceptedEvents, 11);
  assert.deepEqual(reports.aggregate.sideCounts, { BUY: 0, SELL: 11 });
  assert.equal(reports.sourceFrameCoverage.uniqueCompositeSourceFrameGroupCount, 3);
  assert.equal(reports.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.ok(reports.empiricalGaps.includes('ACCEPTANCE_RATE_VARIABILITY_OBSERVED'));
  assert.ok(reports.empiricalGaps.includes('SINGLE_AGGRESSIVE_SIDE_ACROSS_ACCEPTED_CAPTURES'));
  assert.ok(reports.empiricalGaps.includes('WITHIN_CAPTURE_SOURCE_FRAME_CLUSTERING_OBSERVED'));
  assert.equal(reports.authority.thresholdOrWindowRelaxationAuthorized, false);
});

test('surfaces cross-capture duplicate observation identities without converting them to sample credit', () => {
  const first = capture({ captureIndex: 1 });
  const second = capture({ captureIndex: 1, postShift: 1 });
  const report = analyzePublicForwardLiquidityCrossCaptureStability([
    first,
    second,
  ]);

  assert.equal(report.aggregate.crossCaptureDuplicateObservationIdCount, 1);
  assert.deepEqual(
    report.aggregate.crossCaptureDuplicateObservationIds,
    [first.observations[0].observationId],
  );
  assert.ok(report.empiricalGaps.includes('CROSS_CAPTURE_DUPLICATE_OBSERVATION_IDS_OBSERVED'));
  assert.equal(report.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.equal(report.authority.sampleSufficiencyCredit, false);
});

test('rejects forged repeated source-frame evidence before any independence claim', () => {
  const first = capture({ captureIndex: 1 });
  const forged = replaceObservations(
    capture({ captureIndex: 2 }),
    first.observations,
  );

  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([first, forged]),
    /CROSS_CAPTURE_RAW_DIGEST_MISMATCH/u,
  );
});

test('rejects duplicate raw capture identity so the same immutable batch cannot inflate capture count', () => {
  const first = capture({ captureIndex: 1 });
  const second = structuredClone(first);
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([first, second]),
    /CROSS_CAPTURE_DUPLICATE_RAW_DIGEST/u,
  );
});

test('fails closed on private provenance, missing canonical endpoints, mutated safety, observation authority, and count mismatch', () => {
  const privateCapture = capture({ captureIndex: 1 });
  privateCapture.datasetProvenance.rawSource.privateApiUsed = true;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      privateCapture,
      capture({ captureIndex: 2 }),
    ]),
    /CROSS_CAPTURE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const missingEndpoint = capture({ captureIndex: 1 });
  missingEndpoint.datasetProvenance.rawSource.endpoints = ['/api/v3/market/orderbook'];
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      missingEndpoint,
      capture({ captureIndex: 2 }),
    ]),
    /CROSS_CAPTURE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const unsafe = capture({ captureIndex: 1 });
  unsafe.safety.liveTradingAllowed = true;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      unsafe,
      capture({ captureIndex: 2 }),
    ]),
    /CROSS_CAPTURE_SOURCE_SAFETY_INVALID/u,
  );

  const escalatedObservation = capture({ captureIndex: 1 });
  escalatedObservation.observations[0].executionCostEligible = true;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      escalatedObservation,
      capture({ captureIndex: 2 }),
    ]),
    /CROSS_CAPTURE_OBSERVATION_AUTHORITY_INVALID/u,
  );

  const mismatch = capture({ captureIndex: 1 });
  mismatch.datasetProvenance.eventCount = 2;
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      mismatch,
      capture({ captureIndex: 2 }),
    ]),
    /CROSS_CAPTURE_EVENT_COUNT_MISMATCH/u,
  );
});

test('requires at least two distinct captures', () => {
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      capture({ captureIndex: 1 }),
    ]),
    /CROSS_CAPTURE_AT_LEAST_TWO_CAPTURES_REQUIRED/u,
  );
});

test('fails closed on canonical observation drift even when the normalized digest is recomputed', () => {
  const manipulated = capture({ captureIndex: 1 });
  manipulated.observations[0].publicExecutionPrice += 1;
  manipulated.observations[0].tradeFlowNotional =
    manipulated.observations[0].tradeFlowQuantity * manipulated.observations[0].publicExecutionPrice;
  manipulated.datasetProvenance.normalizedDigest = sha256(canonicalJson(manipulated.observations));

  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      manipulated,
      capture({ captureIndex: 2 }),
    ]),
    /COVERAGE_OBSERVATION_SOURCE_DIGEST_MISMATCH/u,
  );
});

test('requires the exact canonical public endpoint set and strict producer timestamps', () => {
  const extraEndpoint = capture({ captureIndex: 1 });
  extraEndpoint.datasetProvenance.rawSource.endpoints.push('/api/private/account');
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      extraEndpoint,
      capture({ captureIndex: 2 }),
    ]),
    /COVERAGE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const coercedTimestamp = capture({ captureIndex: 1 });
  coercedTimestamp.observations[0].eventTimestampMs =
    String(coercedTimestamp.observations[0].eventTimestampMs);
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([
      coercedTimestamp,
      capture({ captureIndex: 2 }),
    ]),
    /COVERAGE_EVENT_TIMESTAMP_INVALID/u,
  );
});

test('rejects a forged raw digest label even when normalized observations are canonical', () => {
  const first = capture({ captureIndex: 1 });
  const second = replaceObservations(
    capture({ captureIndex: 2 }),
    first.observations,
  );
  assert.notEqual(second.datasetProvenance.rawDigest, first.datasetProvenance.rawDigest);
  assert.equal(second.datasetProvenance.normalizedDigest, first.datasetProvenance.normalizedDigest);
  assert.throws(
    () => analyzePublicForwardLiquidityCrossCaptureStability([first, second]),
    /CROSS_CAPTURE_RAW_DIGEST_MISMATCH/u,
  );
});

test('keeps distinct zero-accepted captures truthful instead of treating missing evidence as duplicate credit', () => {
  const report = analyzePublicForwardLiquidityCrossCaptureStability([
    capture({ captureIndex: 1, acceptedCount: 0, droppedCount: 1 }),
    capture({ captureIndex: 2, acceptedCount: 0, droppedCount: 1 }),
  ]);

  assert.equal(report.aggregate.acceptedEvents, 0);
  assert.equal(report.aggregate.droppedEvents, 2);
  assert.equal(report.aggregate.uniqueObservationIdCount, 0);
  assert.ok(report.empiricalGaps.includes('NO_ACCEPTED_OBSERVATIONS'));
  assert.equal(report.sourceFrameCoverage.effectiveIndependentSampleCount, null);
});

test('safety contract grants no stability, sufficiency, cost, Natural, Settlement, Promotion, Champion, or trading credit', () => {
  const safety = PUBLIC_FORWARD_LIQUIDITY_CROSS_CAPTURE_STABILITY_SAFETY;
  assert.equal(safety.diagnosticOnly, true);
  assert.equal(safety.stabilityPolicyAvailable, false);
  assert.equal(safety.stabilityProven, false);
  assert.equal(safety.representativenessProven, false);
  assert.equal(safety.sourceFrameIndependenceProven, false);
  assert.equal(safety.effectiveIndependentSampleCountCredit, false);
  assert.equal(safety.sampleSufficiencyCredit, false);
  assert.equal(safety.calibrationCredit, false);
  assert.equal(safety.oosCredit, false);
  assert.equal(safety.fullCostCredit, false);
  assert.equal(safety.FULL_COST_READY, false);
  assert.equal(safety.naturalEntryCredit, 0);
  assert.equal(safety.settlementCredit, 0);
  assert.equal(safety.promotionCredit, false);
  assert.equal(safety.championCredit, false);
  assert.equal(safety.tuningAuthorized, false);
  assert.equal(safety.thresholdChangeAuthorized, false);
  assert.equal(safety.eventWindowChangeAuthorized, false);
  assert.equal(safety.executionAuthority, 'NONE');
  assert.equal(safety.privateTradingApiAllowed, false);
  assert.equal(safety.liveTradingAllowed, false);
  assert.equal(safety.realOrderAllowed, false);
});
