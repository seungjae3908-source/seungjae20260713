import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdaptiveMultiEvidenceMarketFeaturesV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-market-features-v2.js';
import {
  buildAdaptiveMultiEvidencePriceStructureV2,
} from '../../../market-prediction-lab/src/adaptive-multi-evidence-price-structure-v2.js';
import {
  classifyCanonicalIndicatorRunnerState,
} from '../src/indicator-policy.mjs';
import {
  evaluateMomentumGuardForwardV1,
} from '../src/momentum-guard.mjs';

const START = Date.parse('2026-09-14T00:00:00.000Z');
const STEP = 15 * 60 * 1000;
const PRICE_OPTIONS = Object.freeze({
  atrPeriod: 3,
  volumeLookback: 3,
  pivotLeftBars: 1,
  pivotRightBars: 1,
  compressionLookback: 2,
  retestToleranceAtr: 0.25,
});
const FEATURE_OPTIONS = Object.freeze({
  emaFastPeriod: 5,
  emaSlowPeriod: 10,
  slopeLookback: 3,
  adxPeriod: 3,
  atrPeriod: 3,
  donchianPeriod: 8,
  rocPeriod: 4,
  rsiPeriod: 4,
  macdFastPeriod: 3,
  macdSlowPeriod: 6,
  macdSignalPeriod: 3,
  momentumPersistenceLookback: 6,
  relativeStrengthLookback: 5,
  volumeLookback: 5,
  realizedVolatilityLookback: 5,
  rangeLookback: 4,
  abnormalZThreshold: 2,
  structurePersistenceSwings: 4,
});

function values(count = 36, drift = 0.45, amplitude = 1.8) {
  return Array.from({ length: count }, (_, index) =>
    100 + index * drift + Math.sin(index * 1.15) * amplitude);
}
function candle(index, close, overrides = {}) {
  const event = START + index * STEP;
  return {
    eventTime: new Date(event).toISOString(),
    publishedAt: new Date(event + 1_000).toISOString(),
    availableAt: new Date(event + 2_000).toISOString(),
    observedAt: new Date(event + 3_000).toISOString(),
    isClosed: true,
    open: close - 0.2,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index * 4,
    ...overrides,
  };
}
function priceInput(closes, overrides = {}) {
  const candles = closes.map((close, index) => candle(index, close));
  return {
    lineageId: 'ADAPTIVE_MULTI_EVIDENCE_V2',
    market: 'US_STOCK',
    symbol: 'TEST',
    timeframe: '15m',
    side: 'BUY',
    decisionTime: new Date(START + (candles.length + 1) * STEP).toISOString(),
    source: {
      sourceId: 'public-ohlcv:move-hunter-test',
      originalSourceId: 'exchange:move-hunter-test',
      sourceType: 'PUBLIC_OHLCV',
      sourceUrl: 'https://example.com/ohlcv',
      documentId: null,
    },
    candles,
    options: PRICE_OPTIONS,
    ...overrides,
  };
}
function completeInput() {
  const closes = values();
  const base = {
    ...priceInput(closes),
    options: FEATURE_OPTIONS,
    priceStructureOptions: PRICE_OPTIONS,
  };
  const higher = buildAdaptiveMultiEvidencePriceStructureV2(priceInput(closes, {
    timeframe: '1h',
    decisionTime: base.decisionTime,
    source: {
      sourceId: 'public-ohlcv:move-hunter-test-1h',
      originalSourceId: 'exchange:move-hunter-test',
      sourceType: 'PUBLIC_OHLCV',
      sourceUrl: 'https://example.com/ohlcv-1h',
      documentId: null,
    },
  }));
  const benchmark = priceInput(values(36, 0.2, 0.8), {
    symbol: 'BENCH',
    side: 'NEUTRAL',
    decisionTime: base.decisionTime,
    source: {
      sourceId: 'public-ohlcv:move-hunter-benchmark',
      originalSourceId: 'exchange:move-hunter-benchmark',
      sourceType: 'PUBLIC_OHLCV',
      sourceUrl: 'https://example.com/benchmark',
      documentId: null,
    },
  });
  return { ...base, benchmark, higherTimeframeEvidence: [higher] };
}

test('canonical Market Features V2 feeds Move Hunter indicator policy without duplicate indicator engine', () => {
  const canonical = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.equal(canonical.status, 'READY_FOR_SPECIALIST_RESEARCH_ONLY');
  assert.equal(canonical.decisionAuthority, 'EVIDENCE_ONLY');
  assert.equal(canonical.executionAuthority, 'NONE');
  assert.ok(Number.isFinite(canonical.features.trend.adx));
  assert.ok(Number.isFinite(canonical.features.momentum.rsi));
  assert.ok(Number.isFinite(canonical.features.momentum.macdHistogramPct));
  assert.ok(Number.isFinite(canonical.features.momentum.relativeStrengthRoc));
  assert.ok(Number.isFinite(canonical.features.volume.relativeVolume));
  assert.ok(Number.isFinite(canonical.features.volatility.atrPct));

  const control = classifyCanonicalIndicatorRunnerState(canonical);
  assert.ok(['ACCELERATION','NORMAL','WARNING','INVALID'].includes(control.state));
  assert.ok([1.5,2,3,4].includes(control.trailAtrMult));
  assert.equal(control.automaticEntryAuthority, false);
  assert.equal(control.executionAuthority, 'NONE');
});

test('future and unclosed bars remain excluded before Runner state classification', () => {
  const source = completeInput();
  const before = buildAdaptiveMultiEvidenceMarketFeaturesV2(source);
  const future = candle(source.candles.length + 20, 999, {
    open: 900,
    high: 1000,
    low: 899,
    volume: 999_999,
  });
  const unclosed = candle(source.candles.length, 700, {
    isClosed: false,
    open: 600,
    high: 800,
    low: 500,
    volume: 777_777,
  });
  const after = buildAdaptiveMultiEvidenceMarketFeaturesV2({
    ...source,
    candles: [...source.candles, future, unclosed],
  });
  assert.deepEqual(after.features, before.features);
  assert.equal(after.contentDigest, before.contentDigest);
  assert.equal(after.excluded.futureOrUnavailable, 1);
  assert.equal(after.excluded.unclosed, 1);
  assert.deepEqual(
    classifyCanonicalIndicatorRunnerState(after),
    classifyCanonicalIndicatorRunnerState(before),
  );
});


test('canonical Market Features V2 feeds frozen Momentum Guard with zero execution authority', () => {
  const canonical = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.equal(canonical.status, 'READY_FOR_SPECIALIST_RESEARCH_ONLY');
  const guard = evaluateMomentumGuardForwardV1(canonical);
  assert.equal(guard.status, 'RESEARCH_EVIDENCE_ONLY');
  assert.equal(typeof guard.eligible, 'boolean');
  assert.equal(guard.automaticEntryAuthority, false);
  assert.equal(guard.automaticPromotionAuthority, false);
  assert.equal(guard.observedHistoryMayCountAsOos, false);
  assert.equal(guard.economicSampleCredit, 0);
  assert.equal(guard.executionAuthority, 'NONE');
});
