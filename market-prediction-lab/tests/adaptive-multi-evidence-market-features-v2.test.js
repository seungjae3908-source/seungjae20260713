import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION,
  buildAdaptiveMultiEvidenceMarketFeaturesV2,
} from "../src/adaptive-multi-evidence-market-features-v2.js";
import { buildAdaptiveMultiEvidencePriceStructureV2 } from "../src/adaptive-multi-evidence-price-structure-v2.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const START = Date.parse("2026-09-14T00:00:00.000Z");
const STEP = 15 * 60 * 1000;
const PHASE_2_OPTIONS = Object.freeze({
  atrPeriod: 3,
  volumeLookback: 3,
  pivotLeftBars: 1,
  pivotRightBars: 1,
  compressionLookback: 2,
  retestToleranceAtr: 0.25,
});
const PHASE_3_OPTIONS = Object.freeze({
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
  return Array.from({ length: count }, (_, index) => 100 + index * drift + Math.sin(index * 1.15) * amplitude);
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
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    market: "US_STOCK",
    symbol: "TEST",
    timeframe: "15m",
    side: "BUY",
    decisionTime: new Date(START + (candles.length + 1) * STEP).toISOString(),
    source: {
      sourceId: "public-ohlcv:test",
      originalSourceId: "exchange:test",
      sourceType: "PUBLIC_OHLCV",
      sourceUrl: "https://example.com/ohlcv",
      documentId: null,
    },
    candles,
    options: PHASE_2_OPTIONS,
    ...overrides,
  };
}

function marketInput(closes = values(), overrides = {}) {
  const base = priceInput(closes);
  return {
    ...base,
    options: PHASE_3_OPTIONS,
    priceStructureOptions: PHASE_2_OPTIONS,
    ...overrides,
  };
}

function completeInput() {
  const closes = values();
  const base = marketInput(closes);
  const higherTimeframe = buildAdaptiveMultiEvidencePriceStructureV2(priceInput(closes, {
    timeframe: "1h",
    decisionTime: base.decisionTime,
    source: {
      sourceId: "public-ohlcv:test-1h",
      originalSourceId: "exchange:test",
      sourceType: "PUBLIC_OHLCV",
      sourceUrl: "https://example.com/ohlcv-1h",
      documentId: null,
    },
  }));
  const benchmark = priceInput(values(36, 0.2, 0.8), {
    symbol: "BENCH",
    side: "NEUTRAL",
    decisionTime: base.decisionTime,
    source: {
      sourceId: "public-ohlcv:benchmark",
      originalSourceId: "exchange:benchmark",
      sourceType: "PUBLIC_OHLCV",
      sourceUrl: "https://example.com/benchmark",
      documentId: null,
    },
  });
  return { ...base, benchmark, higherTimeframeEvidence: [higherTimeframe] };
}

test("trend, momentum, volume, and volatility are measurable point-in-time evidence", () => {
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION);
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(result.qualityStatus, "COMPLETE_INPUT_CONTEXT");
  assert.ok(result.features.trend.emaFast > 0);
  assert.ok(result.features.trend.emaSlow > 0);
  assert.ok(result.features.trend.adx >= 0);
  assert.ok(result.features.trend.donchianUpper > result.features.trend.donchianLower);
  assert.match(result.features.trend.multiTimeframeAlignment, /^ALIGNED_|MIXED_OR_UNALIGNED$/u);
  assert.ok(Number.isFinite(result.features.momentum.roc));
  assert.ok(Number.isFinite(result.features.momentum.rsi));
  assert.ok(Number.isFinite(result.features.momentum.macdHistogramPct));
  assert.ok(Number.isFinite(result.features.momentum.relativeStrengthRoc));
  assert.ok(Number.isFinite(result.features.volume.relativeVolume));
  assert.ok(Number.isFinite(result.features.volume.priceVolumeCorrelation));
  assert.ok(Number.isFinite(result.features.volatility.atrPct));
  assert.ok(Number.isFinite(result.features.volatility.realizedVolatility));
  assert.match(result.priceActionSourceContentDigest, /^[a-f0-9]{64}$/u);
  assert.equal(
    result.priceActionSourceDigest,
    sha256Canonical({
      sourceContentDigest: result.priceActionSourceContentDigest,
      priceAction: result.features.priceAction,
    }),
  );
});

test("missing optional benchmark and higher timeframe context stays explicit instead of becoming zero", () => {
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(marketInput());
  assert.equal(result.status, "PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(result.qualityStatus, "MISSING_OPTIONAL_CONTEXT");
  assert.deepEqual(result.missingEvidence, ["benchmark", "higherTimeframeEvidence"]);
  assert.equal(result.features.momentum.relativeStrengthRoc, null);
  assert.equal(result.features.momentum.benchmarkEvidenceId, null);
  assert.equal(result.features.trend.multiTimeframeStatus, "MISSING");
  assert.equal(result.features.trend.multiTimeframeAlignment, null);
});

test("future and unclosed bars cannot alter features or evidence identity", () => {
  const source = completeInput();
  const before = buildAdaptiveMultiEvidenceMarketFeaturesV2(source);
  const future = candle(source.candles.length + 20, 999, {
    open: 900,
    high: 1_000,
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
  assert.equal(after.priceActionSourceDigest, before.priceActionSourceDigest);
  assert.deepEqual(
    Object.values(after.evidence).map((item) => item.evidenceId),
    Object.values(before.evidence).map((item) => item.evidenceId),
  );
  assert.equal(after.excluded.futureOrUnavailable, 1);
  assert.equal(after.excluded.unclosed, 1);
});

test("missing eligible point-in-time availability fails closed", () => {
  const source = marketInput();
  source.candles[4] = { ...source.candles[4], availableAt: null };
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(source);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.features, null);
  assert.ok(result.blockers.includes("V2_PRICE_STRUCTURE_CANDLE_AVAILABLE_AT_REQUIRED"));
  assert.ok(result.missingEvidence.includes("candles[4].availableAt"));
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, "NONE");
});

test("provider volume is required and never fabricated", () => {
  const source = marketInput();
  source.candles[5] = { ...source.candles[5], volume: null };
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(source);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_PRICE_STRUCTURE_CANDLE_VOLUME_INVALID"));

  const zeroVolume = marketInput();
  zeroVolume.candles = zeroVolume.candles.map((item) => ({ ...item, volume: 0 }));
  const zeroResult = buildAdaptiveMultiEvidenceMarketFeaturesV2(zeroVolume);
  assert.equal(zeroResult.features.volume.baselineStatus, "ZERO_BASELINE");
  assert.equal(zeroResult.features.volume.relativeVolume, null);
  assert.equal(zeroResult.features.volume.priceVolumeDisagreement, null);
});

test("supplied benchmark and higher-timeframe context must itself be admissible", () => {
  const benchmarkMismatch = completeInput();
  benchmarkMismatch.benchmark = { ...benchmarkMismatch.benchmark, decisionTime: "2026-09-13T00:00:00.000Z" };
  const rejectedBenchmark = buildAdaptiveMultiEvidenceMarketFeaturesV2(benchmarkMismatch);
  assert.equal(rejectedBenchmark.status, "BLOCKED_DATA");
  assert.ok(rejectedBenchmark.blockers.includes("V2_MARKET_FEATURES_BENCHMARK_EVIDENCE_NOT_ADMISSIBLE"));

  const higherMismatch = completeInput();
  higherMismatch.higherTimeframeEvidence = [{ status: "READY_FOR_SPECIALIST_RESEARCH_ONLY" }];
  const rejectedHigher = buildAdaptiveMultiEvidenceMarketFeaturesV2(higherMismatch);
  assert.equal(rejectedHigher.status, "BLOCKED_DATA");
  assert.ok(rejectedHigher.blockers.includes("V2_MARKET_FEATURES_HIGHER_TIMEFRAME_EVIDENCE_NOT_ADMISSIBLE"));
});

test("all tape-derived families share one correlation group and receive no independent vote", () => {
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.deepEqual(Object.keys(result.evidence).sort(), ["momentum", "trend", "volatility", "volume"]);
  assert.equal(new Set(Object.values(result.correlationGroups)).size, 1);
  assert.match(result.correlationGroups.trend, /^SHARED_MARKET_TAPE:/u);
  for (const item of Object.values(result.evidence)) {
    assert.equal(item.status, "ADMISSIBLE");
    assert.equal(item.evidence.lineageId, "ADAPTIVE_MULTI_EVIDENCE_V2");
    assert.equal(item.evidence.independenceStatus, "NOT_YET_PROVEN");
    assert.equal(item.economicSampleCredit, 0);
    assert.equal(item.executionAuthority, "NONE");
  }
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
});

test("momentum and volatility remain evidence-only with explicit downstream guardrails", () => {
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.equal(result.decisionAuthority, "EVIDENCE_ONLY");
  assert.equal(result.momentumOverrideAuthority, "NONE");
  assert.equal(result.volatilitySizingAuthority, "NONE");
  assert.equal(result.features.volatility.stopPolicy, "NO_AUTOMATIC_TIGHTER_STOP");
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("V1 lineage and invalid indicator configuration fail closed", () => {
  const frozen = buildAdaptiveMultiEvidenceMarketFeaturesV2(marketInput(values(), {
    lineageId: "FROZEN_CHALLENGER_V1",
  }));
  assert.equal(frozen.status, "BLOCKED_DATA");
  assert.ok(frozen.blockers.includes("V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN"));

  const invalid = buildAdaptiveMultiEvidenceMarketFeaturesV2(marketInput(values(), {
    options: { ...PHASE_3_OPTIONS, emaFastPeriod: 10, emaSlowPeriod: 5 },
  }));
  assert.equal(invalid.status, "BLOCKED_DATA");
  assert.ok(invalid.blockers.includes("V2_MARKET_FEATURES_EMA_PERIOD_ORDER_INVALID"));
});


test("wave, candlestick, and BOS/CHOCH context is exposed downstream without an extra vote", () => {
  const result = buildAdaptiveMultiEvidenceMarketFeaturesV2(completeInput());
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.ok(result.features.priceAction);
  assert.ok(["BULLISH", "BEARISH", "MIXED", "INSUFFICIENT"].includes(
    result.features.priceAction.structureTrend,
  ));
  assert.ok(Array.isArray(result.features.priceAction.candlestickPatterns));
  assert.ok(Array.isArray(result.features.priceAction.swingSequence));
  assert.equal(
    result.features.priceAction.priceStructureEvidenceId,
    buildAdaptiveMultiEvidencePriceStructureV2({
      ...completeInput(),
      options: PHASE_2_OPTIONS,
    }).evidence.priceStructure.evidenceId,
  );
  assert.match(
    result.features.priceAction.priceStructureEvidenceId,
    /^adaptive-v2-evidence:[a-f0-9]{64}$/u,
  );
  assert.match(
    result.features.priceAction.candleEvidenceId,
    /^adaptive-v2-evidence:[a-f0-9]{64}$/u,
  );
  assert.match(
    result.features.priceAction.patternEvidenceId,
    /^adaptive-v2-evidence:[a-f0-9]{64}$/u,
  );
  assert.equal(result.features.priceAction.authority, "CONTEXT_ONLY_NO_INDEPENDENT_VOTE");
  assert.equal(result.correlationGroups.priceAction, result.correlationGroups.trend);
  assert.equal(result.priceActionAuthority, "CONTEXT_ONLY_NO_INDEPENDENT_VOTE");
  assert.equal(Object.keys(result.evidence).length, 4);
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, "NONE");
});
