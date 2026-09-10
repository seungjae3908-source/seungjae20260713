import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeBitgetPublicOrderBookFrame,
  normalizeBitgetPublicTradesFrame,
} from '../src/public-data.mjs';
import {
  buildPublicLiquidityObservationBatch,
  canonicalJson,
  mergeLiquidityCalibrationBatch,
  sha256,
} from '../src/public-forward-liquidity-calibration.mjs';
import {
  analyzePublicForwardLiquiditySampleCoverage,
  PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_SAFETY,
} from '../src/public-forward-liquidity-sample-coverage-diagnostics.mjs';

const collectorSha = 'b'.repeat(40);

function bookFrame({
  marketTimestampMs = 1_000,
  requestStartedAtMs = 900,
  receiveTimestampMs = 1_050,
  bids = [[100, 10], [99, 10]],
  asks = [[101, 10], [102, 10]],
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
  trades = [
    { execId: 'exec-buy-1', price: 101, size: 1, side: 'buy', ts: 1_200 },
    { execId: 'exec-sell-1', price: 100, size: 2, side: 'sell', ts: 1_400 },
    { execId: 'exec-buy-2', price: 102, size: 4, side: 'buy', ts: 1_600 },
  ],
  requestStartedAtMs = 1_100,
  receiveTimestampMs = 1_800,
} = {}) {
  return normalizeBitgetPublicTradesFrame({
    symbol: 'BTCUSDT',
    payload: {
      code: '00000',
      data: trades.map((trade) => ({
        execId: trade.execId,
        execLinkId: `${trade.execId}-link`,
        price: String(trade.price),
        size: String(trade.size),
        side: trade.side,
        ts: String(trade.ts),
        isRPI: 'NO',
      })),
    },
    requestStartedAtMs,
    receiveTimestampMs,
    endpoint: '/api/v3/market/fills',
    query: 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100',
  });
}

function coverageBatch() {
  return buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame(),
    postEventBooks: [
      bookFrame({
        marketTimestampMs: 2_000,
        requestStartedAtMs: 1_900,
        receiveTimestampMs: 2_050,
        bids: [[101, 10], [100, 10]],
        asks: [[102, 10], [103, 10]],
      }),
      bookFrame({
        marketTimestampMs: 3_000,
        requestStartedAtMs: 2_900,
        receiveTimestampMs: 3_050,
        bids: [[102, 10], [101, 10]],
        asks: [[103, 10], [104, 10]],
      }),
    ],
    collectorCodeSha: collectorSha,
  });
}

function refreshNormalizedDigest(batch) {
  batch.datasetProvenance.normalizedDigest = sha256(canonicalJson(batch.observations));
  return batch;
}

test('reports empirical accepted-sample coverage and source-frame clustering without representativeness claims', () => {
  const report = analyzePublicForwardLiquiditySampleCoverage(coverageBatch());

  assert.equal(report.inputKind, 'BATCH');
  assert.equal(report.acceptedSampleCount, 3);
  assert.equal(report.droppedSampleCountObservedInSource, 0);
  assert.deepEqual(report.identityCoverage, {
    uniqueObservationIdCount: 3,
    uniqueEventTimestampCount: 3,
  });
  assert.deepEqual(report.temporalCoverage, {
    firstEventTimestampMs: 1_200,
    lastEventTimestampMs: 1_600,
    observedSpanMs: 400,
    interEventGapMs: { count: 2, min: 200, p50: 200, p90: 200, max: 200 },
  });
  assert.deepEqual(report.sideCoverage.counts, { BUY: 2, SELL: 1 });
  assert.equal(report.sideCoverage.shares.BUY, 2 / 3);
  assert.equal(report.sideCoverage.shares.SELL, 1 / 3);
  assert.deepEqual(report.marketCoverage, { CRYPTO_FUTURES: 3 });
  assert.deepEqual(report.symbolCoverage, { BTCUSDT: 3 });
  assert.deepEqual(report.quantityCoverage, { count: 3, min: 1, p50: 2, p90: 2, max: 4 });
  assert.deepEqual(report.notionalCoverage, { count: 3, min: 101, p50: 200, p90: 200, max: 408 });
  assert.equal(report.preEventSpreadBpsCoverage.count, 3);
  assert.deepEqual(report.postEventHorizonCoverage.exactHorizonMsCounts, [
    { value: 400, count: 1 },
    { value: 600, count: 1 },
    { value: 800, count: 1 },
    { value: 1_400, count: 1 },
    { value: 1_600, count: 1 },
    { value: 1_800, count: 1 },
  ]);
  assert.equal(report.postEventHorizonCoverage.observationsWithPostEventDrift, 3);
  assert.equal(report.postEventHorizonCoverage.observationsWithoutPostEventDrift, 0);
  assert.deepEqual(report.sourceFrameCoverage, {
    uniquePreEventBookFrameCount: 1,
    uniquePublicTradeFrameCount: 1,
    uniqueCompositeSourceFrameGroupCount: 1,
    compositeSourceFrameGroupSize: { count: 1, min: 3, p50: 3, p90: 3, max: 3 },
    observationsInClusteredSourceFrameGroups: 3,
    shareOfAcceptedInClusteredSourceFrameGroups: 1,
    sourceFrameIndependenceProven: false,
    effectiveIndependentSampleCount: null,
  });
  assert.deepEqual(report.empiricalCoverageGaps, ['SOURCE_FRAME_CLUSTERING_OBSERVED']);
  assert.equal(report.representativeness.populationBaselineAvailable, false);
  assert.equal(report.representativeness.representativenessProven, false);
  assert.equal(report.authority.sourceFrameIndependenceProven, false);
  assert.equal(report.authority.effectiveIndependentSampleCountCredit, false);
  assert.equal(report.authority.sampleSufficiencyCredit, false);
  assert.equal(report.authority.thresholdOrWindowRelaxationAuthorized, false);
});

test('diagnoses a verified persisted dataset without granting calibration or independent-N credit', () => {
  const dataset = mergeLiquidityCalibrationBatch(null, coverageBatch()).dataset;
  const report = analyzePublicForwardLiquiditySampleCoverage(dataset);

  assert.equal(report.inputKind, 'DATASET');
  assert.equal(report.acceptedSampleCount, 3);
  assert.equal(report.identityCoverage.uniqueObservationIdCount, 3);
  assert.equal(report.sourceFrameCoverage.uniqueCompositeSourceFrameGroupCount, 1);
  assert.equal(report.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.equal(report.authority.effectiveIndependentSampleCountCredit, false);
  assert.equal(report.authority.calibrationCredit, false);
  assert.equal(report.authority.oosCredit, false);
  assert.equal(report.authority.fullCostCredit, false);
  assert.equal(report.safety.FULL_COST_READY, false);
});

test('zero accepted observations are reported as an empirical gap rather than manufactured sample credit', () => {
  const batch = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame({
      trades: [{ execId: 'rejected-side', price: 100, size: 1, side: 'buy', ts: 1_200 }],
      receiveTimestampMs: 1_300,
    }),
    postEventBooks: [],
    collectorCodeSha: collectorSha,
  });

  const report = analyzePublicForwardLiquiditySampleCoverage(batch);
  assert.equal(report.acceptedSampleCount, 0);
  assert.equal(report.droppedSampleCountObservedInSource, 1);
  assert.deepEqual(report.empiricalCoverageGaps, ['NO_ACCEPTED_OBSERVATIONS']);
  assert.equal(report.temporalCoverage.observedSpanMs, null);
  assert.equal(report.quantityCoverage.count, 0);
  assert.equal(report.sideCoverage.shares.BUY, null);
  assert.equal(report.sourceFrameCoverage.uniqueCompositeSourceFrameGroupCount, 0);
  assert.equal(report.sourceFrameCoverage.shareOfAcceptedInClusteredSourceFrameGroups, null);
  assert.equal(report.sourceFrameCoverage.effectiveIndependentSampleCount, null);
  assert.equal(report.authority.naturalEntryCredit, 0);
  assert.equal(report.authority.settlementCredit, 0);
});

test('single-side, missing post-event, and source-frame clustering are surfaced without relaxed gates', () => {
  const batch = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame({
      trades: [
        { execId: 'buy-only-1', price: 101, size: 1, side: 'buy', ts: 1_200 },
        { execId: 'buy-only-2', price: 102, size: 2, side: 'buy', ts: 1_400 },
      ],
      receiveTimestampMs: 1_500,
    }),
    postEventBooks: [],
    collectorCodeSha: collectorSha,
  });

  const report = analyzePublicForwardLiquiditySampleCoverage(batch);
  assert.deepEqual(report.empiricalCoverageGaps, [
    'ACCEPTED_MISSING_DATA_FLAGS_PRESENT',
    'NO_POST_EVENT_HORIZON_OBSERVED',
    'SINGLE_AGGRESSIVE_SIDE_OBSERVED',
    'SOURCE_FRAME_CLUSTERING_OBSERVED',
  ]);
  assert.equal(report.acceptedMissingDataCoverage.flagCounts.POST_EVENT_PUBLIC_OBSERVATION_MISSING, 2);
  assert.equal(report.sourceFrameCoverage.observationsInClusteredSourceFrameGroups, 2);
  assert.equal(report.investigationTargets.every((target) => !target.includes('RELAX')), true);
  assert.equal(report.authority.thresholdOrWindowRelaxationAuthorized, false);
});

test('accepts the canonical bounded five-second event clock lead', () => {
  const batch = buildPublicLiquidityObservationBatch({
    preEventBook: bookFrame(),
    tradeFrame: tradesFrame({
      trades: [{ execId: 'bounded-clock-lead', price: 101, size: 1, side: 'buy', ts: 1_200 }],
      requestStartedAtMs: 1_060,
      receiveTimestampMs: 1_100,
    }),
    postEventBooks: [],
    collectorCodeSha: collectorSha,
  });

  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].eventTimestampMs, 1_200);
  assert.equal(batch.observations[0].receiveTimestampMs, 1_100);
  const report = analyzePublicForwardLiquiditySampleCoverage(batch);
  assert.equal(report.acceptedSampleCount, 1);
});

test('rejects an event clock lead beyond the canonical five-second tolerance', () => {
  const batch = structuredClone(coverageBatch());
  batch.observations[0].eventTimestampMs = batch.observations[0].receiveTimestampMs + 5_001;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(batch),
    /COVERAGE_EVENT_TIMESTAMP_AFTER_LOCAL_RECEIVE/u,
  );
});

test('fails closed on private provenance, malformed frame provenance, and accepted observation identity', () => {
  const privateBatch = structuredClone(coverageBatch());
  privateBatch.datasetProvenance.rawSource.privateApiUsed = true;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(privateBatch),
    /COVERAGE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const malformedFrameBatch = structuredClone(coverageBatch());
  malformedFrameBatch.observations[0].rawSourceProvenance.publicTrade.rawFrameDigest = 'not-a-digest';
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(malformedFrameBatch),
    /COVERAGE_PUBLIC_TRADE_FRAME_DIGEST_INVALID/u,
  );

  const duplicateBatch = structuredClone(coverageBatch());
  duplicateBatch.observations[1].observationId = duplicateBatch.observations[0].observationId;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(duplicateBatch),
    /COVERAGE_DUPLICATE_OBSERVATION_ID/u,
  );
});

test('fails closed when source safety authority is absent or mutated', () => {
  const mutated = structuredClone(coverageBatch());
  mutated.safety.liveTradingAllowed = true;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(mutated),
    /COVERAGE_SOURCE_SAFETY_INVALID/u,
  );

  const missing = structuredClone(coverageBatch());
  delete missing.safety;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(missing),
    /COVERAGE_SOURCE_SAFETY_INVALID/u,
  );
});

test('requires the exact public endpoint set and full read-only producer safety', () => {
  const extraEndpoint = structuredClone(coverageBatch());
  extraEndpoint.datasetProvenance.rawSource.endpoints.push('/api/v3/account/assets');
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(extraEndpoint),
    /COVERAGE_PUBLIC_PROVENANCE_INVALID/u,
  );

  const missingPublicOnly = structuredClone(coverageBatch());
  delete missingPublicOnly.safety.publicDataOnly;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(missingPublicOnly),
    /COVERAGE_SOURCE_SAFETY_INVALID/u,
  );

  const mutationAuthority = structuredClone(coverageBatch());
  mutationAuthority.safety.financialMutationAllowed = true;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(mutationAuthority),
    /COVERAGE_SOURCE_SAFETY_INVALID/u,
  );

  const extraQueryIdentity = structuredClone(coverageBatch());
  extraQueryIdentity.observations[0].rawSourceProvenance.publicTrade.query += '&accountType=private';
  refreshNormalizedDigest(extraQueryIdentity);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(extraQueryIdentity),
    /COVERAGE_PUBLIC_TRADE_QUERY_INVALID/u,
  );
});

test('binds the normalized digest to the exact canonical observations', () => {
  const batch = structuredClone(coverageBatch());
  batch.observations[0].unboundCoverageClaim = 'fabricated';
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(batch),
    /COVERAGE_NORMALIZED_DIGEST_MISMATCH/u,
  );
});

test('rejects observation identity and source-value drift even after normalized digest recomputation', () => {
  const identityDrift = structuredClone(coverageBatch());
  identityDrift.observations[0].observationId = `liquidity-observation:${'c'.repeat(64)}`;
  refreshNormalizedDigest(identityDrift);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(identityDrift),
    /COVERAGE_OBSERVATION_IDENTITY_MISMATCH/u,
  );

  const sourceValueDrift = structuredClone(coverageBatch());
  const observation = sourceValueDrift.observations[0];
  observation.tradeFlowQuantity += 1;
  observation.tradeFlowNotional = observation.tradeFlowQuantity * observation.publicExecutionPrice;
  observation.instantaneousVisibleDepthBookWalk.requestedQuantity = observation.tradeFlowQuantity;
  refreshNormalizedDigest(sourceValueDrift);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(sourceValueDrift),
    /COVERAGE_OBSERVATION_SOURCE_DIGEST_MISMATCH/u,
  );
});

test('rejects post-event horizon and source-frame drift after digest recomputation', () => {
  const horizonDrift = structuredClone(coverageBatch());
  horizonDrift.observations[0].subsequentPublicPriceDrift[0].horizonMs += 1;
  refreshNormalizedDigest(horizonDrift);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(horizonDrift),
    /COVERAGE_POST_EVENT_HORIZON_MISMATCH/u,
  );

  const frameDrift = structuredClone(coverageBatch());
  frameDrift.observations[0].subsequentPublicPriceDrift[0].rawSourceDigest = 'd'.repeat(64);
  refreshNormalizedDigest(frameDrift);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(frameDrift),
    /COVERAGE_POST_EVENT_SOURCE_FRAME_MISMATCH/u,
  );
});

test('rejects missing-flag drift and non-canonical numeric coercion', () => {
  const missingFlagDrift = structuredClone(coverageBatch());
  missingFlagDrift.observations[0].missingDataFlags.push('UNRECOGNIZED_FLAG');
  refreshNormalizedDigest(missingFlagDrift);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(missingFlagDrift),
    /COVERAGE_MISSING_FLAG_INVALID/u,
  );

  const numericString = structuredClone(coverageBatch());
  numericString.observations[0].tradeFlowQuantity = String(numericString.observations[0].tradeFlowQuantity);
  refreshNormalizedDigest(numericString);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(numericString),
    /COVERAGE_QUANTITY_INVALID/u,
  );

  const falseDepthFlag = structuredClone(coverageBatch());
  falseDepthFlag.observations[0].instantaneousVisibleDepthBookWalk.completeWithinVisibleDepth = false;
  falseDepthFlag.observations[0].missingDataFlags.push('VISIBLE_DEPTH_INSUFFICIENT_FOR_FLOW_QUANTITY');
  refreshNormalizedDigest(falseDepthFlag);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(falseDepthFlag),
    /COVERAGE_BOOK_WALK_QUANTITY_MISMATCH/u,
  );
});

test('binds dropped counts to per-event reasons and rejects empty evidence', () => {
  const droppedCountDrift = structuredClone(coverageBatch());
  droppedCountDrift.datasetProvenance.droppedCount = 1;
  droppedCountDrift.datasetProvenance.droppedReasons = { FABRICATED_DROP: 1 };
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(droppedCountDrift),
    /DROP_DIAGNOSTIC_DROPPED_COUNT_MISMATCH/u,
  );

  const observedPeriodDrift = structuredClone(coverageBatch());
  observedPeriodDrift.datasetProvenance.firstObservedAtMs += 1;
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(observedPeriodDrift),
    /COVERAGE_OBSERVED_PERIOD_MISMATCH/u,
  );

  const empty = structuredClone(coverageBatch());
  empty.observations = [];
  empty.droppedEvents = [];
  empty.datasetProvenance.eventCount = 0;
  empty.datasetProvenance.droppedCount = 0;
  empty.datasetProvenance.droppedReasons = {};
  empty.datasetProvenance.firstObservedAtMs = null;
  empty.datasetProvenance.lastObservedAtMs = null;
  refreshNormalizedDigest(empty);
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(empty),
    /DROP_DIAGNOSTIC_EVIDENCE_REQUIRED/u,
  );
});

test('fails closed on duplicate missing-data flags instead of double-counting coverage', () => {
  const batch = structuredClone(coverageBatch());
  batch.observations[0].missingDataFlags = ['FLAG_X', 'FLAG_X'];
  assert.throws(
    () => analyzePublicForwardLiquiditySampleCoverage(batch),
    /COVERAGE_DUPLICATE_MISSING_FLAG/u,
  );
});

test('safety contract cannot be interpreted as independent N, sufficiency, OOS, cost, Natural, Settlement, Promotion, or trading authority', () => {
  assert.deepEqual(PUBLIC_FORWARD_LIQUIDITY_SAMPLE_COVERAGE_SAFETY, {
    coverageDiagnosticOnly: true,
    populationBaselineAvailable: false,
    representativenessProven: false,
    sourceFrameIndependenceProven: false,
    effectiveIndependentSampleCountCredit: false,
    sampleSufficiencyCredit: false,
    calibrationCredit: false,
    oosCredit: false,
    fullCostCredit: false,
    FULL_COST_READY: false,
    naturalEntryCredit: 0,
    settlementCredit: 0,
    promotionCredit: false,
    championCredit: false,
    tuningAuthorized: false,
    thresholdChangeAuthorized: false,
    eventWindowChangeAuthorized: false,
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    liveTradingAllowed: false,
    realOrderAllowed: false,
  });
});
