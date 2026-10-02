import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_PRICE_STRUCTURE_V2_VERSION,
  buildAdaptiveMultiEvidencePriceStructureV2,
} from "../src/adaptive-multi-evidence-price-structure-v2.js";

const START = Date.parse("2026-09-14T00:00:00.000Z");
const STEP = 15 * 60 * 1000;

function candle(index, close, overrides = {}) {
  const event = START + index * STEP;
  return {
    eventTime: new Date(event).toISOString(),
    publishedAt: new Date(event + 1_000).toISOString(),
    availableAt: new Date(event + 2_000).toISOString(),
    observedAt: new Date(event + 3_000).toISOString(),
    isClosed: true,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + index,
    ...overrides,
  };
}

function input(values, overrides = {}) {
  const candles = values.map((value, index) => candle(index, value));
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
    options: {
      atrPeriod: 3,
      volumeLookback: 3,
      pivotLeftBars: 1,
      pivotRightBars: 1,
      compressionLookback: 2,
      retestToleranceAtr: 0.25,
    },
    ...overrides,
  };
}

test("measurable candle features are correct and remain evidence-only", () => {
  const source = input([10, 11, 12, 13, 14, 15]);
  source.candles[source.candles.length - 1] = candle(5, 13, {
    open: 12, high: 16, low: 10, close: 13, volume: 206,
  });
  const result = buildAdaptiveMultiEvidencePriceStructureV2(source);
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_PRICE_STRUCTURE_V2_VERSION);
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.deepEqual({
    bodySize: result.features.candle.bodySize,
    range: result.features.candle.range,
    bodyRangeRatio: result.features.candle.bodyRangeRatio,
    upperWickRatio: result.features.candle.upperWickRatio,
    lowerWickRatio: result.features.candle.lowerWickRatio,
    closeLocation: result.features.candle.closeLocation,
  }, {
    bodySize: 1,
    range: 6,
    bodyRangeRatio: 0.1666666667,
    upperWickRatio: 0.5,
    lowerWickRatio: 0.3333333333,
    closeLocation: 0.5,
  });
  assert.equal(result.features.candle.gapPct, -0.1428571429);
  assert.equal(result.features.candle.relativeVolume, 2);
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, "NONE");
});

test("confirmed swings classify HH and HL without future references", () => {
  const result = buildAdaptiveMultiEvidencePriceStructureV2(input([
    10, 12, 15, 12, 9, 11, 16, 13, 10, 12, 17, 14, 11, 13, 18, 15, 12, 14, 19, 16, 13,
  ]));
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(result.features.priceStructure.trend, "BULLISH");
  assert.equal(result.features.priceStructure.latestHighClassification, "HH");
  assert.equal(result.features.priceStructure.latestLowClassification, "HL");
  assert.ok(result.features.priceStructure.support > 0);
  assert.ok(result.features.priceStructure.resistance > result.features.priceStructure.support);
  assert.ok(result.features.pivots.every((pivot) => Date.parse(pivot.confirmedAt) <= Date.parse(result.decisionTime)));
});

test("a future candle cannot alter earlier features or point-in-time evidence ids", () => {
  const base = input([10, 11, 12, 11, 10, 12, 13, 12]);
  const before = buildAdaptiveMultiEvidencePriceStructureV2(base);
  const future = candle(20, 999, {
    open: 900,
    high: 1_000,
    low: 899,
    close: 999,
    volume: 999_999,
  });
  const after = buildAdaptiveMultiEvidencePriceStructureV2({ ...base, candles: [...base.candles, future] });
  assert.deepEqual(after.features, before.features);
  assert.equal(after.contentDigest, before.contentDigest);
  assert.equal(after.evidence.priceStructure.evidenceId, before.evidence.priceStructure.evidenceId);
  assert.equal(after.excluded.futureOrUnavailable, 1);
});

test("an unclosed candle cannot confirm a pivot or pattern", () => {
  const base = input([10, 12, 15, 12, 9, 11, 16, 13]);
  const before = buildAdaptiveMultiEvidencePriceStructureV2(base);
  const open = candle(8, 30, { isClosed: false, high: 35, low: 1, volume: 1_000_000 });
  const after = buildAdaptiveMultiEvidencePriceStructureV2({ ...base, candles: [...base.candles, open] });
  assert.deepEqual(after.features, before.features);
  assert.equal(after.evidence.pattern.evidenceId, before.evidence.pattern.evidenceId);
  assert.equal(after.excluded.unclosed, 1);
});

test("breakout and later retest are measurable but never trade authority", () => {
  const values = [10, 12, 15, 12, 10, 12, 14, 12, 11, 12, 16, 15];
  const source = input(values);
  source.candles[source.candles.length - 1] = candle(11, 15, {
    open: 16, high: 16.5, low: 14.8, close: 15.2, volume: 160,
  });
  const result = buildAdaptiveMultiEvidencePriceStructureV2(source);
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(result.features.pattern.namedPattern, "RETEST_HELD");
  assert.equal(result.features.pattern.breakoutDirection, "UP");
  assert.equal(result.features.pattern.retestHold, true);
  assert.equal(result.evidence.pattern.evidence.decisionAuthority, "EVIDENCE_ONLY");
  assert.equal(result.evidence.pattern.evidence.executionAuthority, "NONE");
});

test("failed breakout is distinguished from a held retest", () => {
  const values = [10, 12, 15, 12, 10, 12, 14, 12, 11, 12, 16, 13];
  const source = input(values);
  source.candles[source.candles.length - 1] = candle(11, 13, {
    open: 16, high: 16.2, low: 12.5, close: 13, volume: 160,
  });
  const result = buildAdaptiveMultiEvidencePriceStructureV2(source);
  assert.equal(result.features.pattern.namedPattern, "FAILED_BREAKOUT");
  assert.equal(result.features.pattern.retestHold, false);
  assert.ok(result.features.pattern.failedBreakoutDistanceAtr > 0);
});

test("missing point-in-time availability fails closed instead of becoming zero", () => {
  const source = input([10, 11, 12, 11, 10, 12]);
  source.candles[2] = { ...source.candles[2], availableAt: null };
  const result = buildAdaptiveMultiEvidencePriceStructureV2(source);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.features, null);
  assert.ok(result.blockers.includes("V2_PRICE_STRUCTURE_CANDLE_AVAILABLE_AT_REQUIRED"));
  assert.ok(result.missingEvidence.includes("candles[2].availableAt"));
  assert.equal(result.economicSampleCredit, 0);
});

test("a provably future bar is excluded even when later availability fields are absent", () => {
  const base = input([10, 11, 12, 11, 10, 12]);
  const before = buildAdaptiveMultiEvidencePriceStructureV2(base);
  const future = {
    ...candle(20, 999),
    publishedAt: null,
    availableAt: null,
    observedAt: null,
  };
  const after = buildAdaptiveMultiEvidencePriceStructureV2({ ...base, candles: [...base.candles, future] });
  assert.equal(after.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.deepEqual(after.features, before.features);
  assert.equal(after.excluded.futureOrUnavailable, 1);
});

test("malformed eligible OHLCV and duplicate candle time fail closed", () => {
  const malformed = input([10, 11, 12, 11, 10, 12]);
  malformed.candles[2] = { ...malformed.candles[2], high: 5 };
  assert.ok(buildAdaptiveMultiEvidencePriceStructureV2(malformed).blockers.includes(
    "V2_PRICE_STRUCTURE_CANDLE_OHLC_RELATIONSHIP_INVALID",
  ));

  const duplicate = input([10, 11, 12, 11, 10, 12]);
  duplicate.candles.push({ ...duplicate.candles.at(-1) });
  assert.ok(buildAdaptiveMultiEvidencePriceStructureV2(duplicate).blockers.includes(
    "V2_PRICE_STRUCTURE_DUPLICATE_CANDLE_TIME",
  ));
});

test("V1 lineage cannot enter Phase 2 and all three derived families share correlation", () => {
  const values = [10, 12, 15, 12, 9, 11, 16, 13];
  const rejected = buildAdaptiveMultiEvidencePriceStructureV2(input(values, { lineageId: "FROZEN_CHALLENGER_V1" }));
  assert.equal(rejected.status, "BLOCKED_DATA");
  assert.ok(rejected.blockers.includes("V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN"));

  const accepted = buildAdaptiveMultiEvidencePriceStructureV2(input(values));
  assert.deepEqual(Object.keys(accepted.evidence).sort(), ["candle", "pattern", "priceStructure"]);
  for (const item of Object.values(accepted.evidence)) {
    assert.equal(item.status, "ADMISSIBLE");
    assert.equal(item.evidence.lineageId, "ADAPTIVE_MULTI_EVIDENCE_V2");
    assert.equal(item.economicSampleCredit, 0);
  }
  assert.match(accepted.correlationGroup, /^SHARED_OHLCV:/u);
  assert.equal(accepted.independenceStatus, "NOT_YET_PROVEN");
});


test("candlestick labels quantify engulfing and pin-bar structure without adding authority", () => {
  const source = input([10, 11, 12, 11, 10, 12, 13, 12]);
  source.candles[6] = candle(6, 11.8, {
    open: 13.2, high: 13.4, low: 11.5, close: 11.8, volume: 106,
  });
  source.candles[7] = candle(7, 13.3, {
    open: 11.7, high: 13.5, low: 11.6, close: 13.3, volume: 180,
  });
  const engulfing = buildAdaptiveMultiEvidencePriceStructureV2(source);
  assert.equal(engulfing.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.ok(engulfing.features.candle.namedPatterns.includes("BULLISH_ENGULFING"));
  assert.equal(engulfing.evidence.candle.economicSampleCredit, 0);
  assert.equal(engulfing.executionAuthority, "NONE");

  const pinSource = input([10, 11, 12, 11, 10, 12, 13, 12]);
  pinSource.candles[7] = candle(7, 12.3, {
    open: 12.1, high: 12.45, low: 10.4, close: 12.3, volume: 180,
  });
  const pin = buildAdaptiveMultiEvidencePriceStructureV2(pinSource);
  assert.ok(pin.features.candle.namedPatterns.includes("BULLISH_PIN_BAR"));
});

test("bullish structure breakout is labeled BOS and wave metrics stay numeric research features", () => {
  const result = buildAdaptiveMultiEvidencePriceStructureV2(input([
    10, 12, 15, 12, 9, 11, 16, 13, 10, 12, 17, 14, 11, 13, 18, 15, 12, 14, 19, 16, 13, 22,
  ]));
  assert.equal(result.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(result.features.priceStructure.trend, "BULLISH");
  assert.equal(result.features.priceStructure.structureTransition, "BOS_UP");
  assert.equal(result.features.pattern.structureTransition, "BOS_UP");
  assert.equal(result.features.pattern.priorStructureTrend, "BULLISH");
  assert.ok(result.features.pattern.swingSequence.length >= 3);
  assert.ok(Number.isFinite(result.features.pattern.latestSwingLegAtr));
  assert.ok(Number.isFinite(result.features.pattern.priorSwingLegAtr));
  assert.ok(Number.isFinite(result.features.pattern.swingRetracementRatio));
  assert.equal(result.independentVoteCredit, 0);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.decisionAuthority, "EVIDENCE_ONLY");
});
