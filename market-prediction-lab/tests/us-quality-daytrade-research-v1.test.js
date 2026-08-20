import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityDaytradeParameterGrid,
  classifyUsQualityUniverse,
  evaluateUsQualityDaytradeSetup,
} from "../src/us-quality-daytrade-research-v1.js";

function qualityInstrument(overrides = {}) {
  return {
    symbol: "MRK",
    exchange: "NYSE",
    securityType: "COMMON_STOCK",
    priceUsd: 150,
    marketCapUsd: 350_000_000_000,
    averageDollarVolumeUsd: 900_000_000,
    floatShares: 2_000_000_000,
    recentReverseSplit: false,
    listingRisk: false,
    manipulationRisk: false,
    dilutionRisk: false,
    recentOffering: false,
    goingConcernRisk: false,
    ...overrides,
  };
}

function qualitySmallCapInstrument(overrides = {}) {
  return qualityInstrument({
    symbol: "QLTY",
    exchange: "NASDAQ",
    priceUsd: 12,
    marketCapUsd: 2_000_000_000,
    averageDollarVolumeUsd: 30_000_000,
    floatShares: 35_000_000,
    ...overrides,
  });
}

function regularCandles() {
  return [
    { open: 100.0, high: 100.8, low: 99.9, close: 100.6, volume: 100, session: "REGULAR", timestamp: 1 },
    { open: 100.6, high: 102.0, low: 100.5, close: 101.8, volume: 130, session: "REGULAR", timestamp: 2 },
    { open: 101.8, high: 104.0, low: 101.7, close: 103.8, volume: 160, session: "REGULAR", timestamp: 3 },
    { open: 103.8, high: 103.9, low: 103.1, close: 103.3, volume: 90, session: "REGULAR", timestamp: 4 },
    { open: 103.3, high: 103.5, low: 102.9, close: 103.0, volume: 85, session: "REGULAR", timestamp: 5 },
    { open: 103.0, high: 103.6, low: 103.0, close: 103.5, volume: 100, session: "REGULAR", timestamp: 6 },
    { open: 103.5, high: 103.9, low: 103.3, close: 103.8, volume: 110, session: "REGULAR", timestamp: 7 },
    { open: 103.8, high: 104.6, low: 103.5, close: 104.5, volume: 250, session: "REGULAR", timestamp: 8 },
  ];
}

function setup(overrides = {}) {
  return {
    instrument: qualityInstrument(),
    candles: regularCandles(),
    candleEvidence: {
      timeframeMs: 10_000,
      sessionStartTimestampMs: 1,
      coverageStartTimestampMs: 1,
      lastCompleteCandleTimestampMs: 8,
      sessionCoverageComplete: true,
    },
    quote: { bid: 104.45, ask: 104.55, timestampMs: 8_000 },
    asOfMs: 8_500,
    relativeVolume: 2.2,
    catalyst: { verified: true, type: "EARNINGS" },
    ...overrides,
  };
}

test("quality universe rejects penny/microcap style instruments", () => {
  const result = classifyUsQualityUniverse(qualityInstrument({
    priceUsd: 4,
    marketCapUsd: 800_000_000,
    averageDollarVolumeUsd: 10_000_000,
    floatShares: 8_000_000,
    securityType: "MICROCAP",
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.tier, null);
  assert.ok(result.reasons.includes("SECURITY_TYPE_EXCLUDED:MICROCAP"));
});

test("quality universe accepts liquid large/mid cap as Tier A", () => {
  const result = classifyUsQualityUniverse(qualityInstrument());
  assert.equal(result.eligible, true);
  assert.equal(result.tier, "A");
  assert.equal(result.riskBudgetMultiplier, 1);
  assert.deepEqual(result.reasons, []);
});

test("quality universe accepts only liquid well-floated small cap as Tier B", () => {
  const result = classifyUsQualityUniverse(qualitySmallCapInstrument());
  assert.equal(result.eligible, true);
  assert.equal(result.tier, "B");
  assert.equal(result.riskBudgetMultiplier, 0.5);
  assert.deepEqual(result.reasons, []);
});

test("Tier B requires point-in-time float evidence and rejects ultra-low float", () => {
  const missing = classifyUsQualityUniverse(qualitySmallCapInstrument({ floatShares: null }));
  assert.equal(missing.eligible, false);
  assert.ok(missing.reasons.includes("FLOAT_EVIDENCE_REQUIRED_FOR_TIER_B"));

  const lowFloat = classifyUsQualityUniverse(qualitySmallCapInstrument({ floatShares: 8_000_000 }));
  assert.equal(lowFloat.eligible, false);
  assert.ok(lowFloat.reasons.includes("FLOAT_BELOW_TIER_B_MINIMUM"));
});

test("Tier B rejects dilution, recent offering and going-concern risk", () => {
  for (const [field, reason] of [
    ["dilutionRisk", "DILUTION_RISK"],
    ["recentOffering", "RECENT_OFFERING"],
    ["goingConcernRisk", "GOING_CONCERN_RISK"],
  ]) {
    const result = classifyUsQualityUniverse(qualitySmallCapInstrument({ [field]: true }));
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(reason));
  }
});

test("Tier B rejects sub-billion and illiquid small caps", () => {
  const tooSmall = classifyUsQualityUniverse(qualitySmallCapInstrument({ marketCapUsd: 900_000_000 }));
  assert.equal(tooSmall.eligible, false);
  assert.ok(tooSmall.reasons.includes("MARKET_CAP_BELOW_TIER_B_MINIMUM"));

  const illiquid = classifyUsQualityUniverse(qualitySmallCapInstrument({ averageDollarVolumeUsd: 8_000_000 }));
  assert.equal(illiquid.eligible, false);
  assert.ok(illiquid.reasons.includes("DOLLAR_VOLUME_BELOW_TIER_B_MINIMUM"));
});

test("setup requires real bid/ask evidence", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({ quote: null }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "VALID_BID_ASK_REQUIRED");
});

test("setup requires quote timestamp and evaluation as-of evidence", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({ quote: { bid: 104.45, ask: 104.55 }, asOfMs: null }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "QUOTE_FRESHNESS_EVIDENCE_REQUIRED");
});

test("setup fails closed on stale quote evidence", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    quote: { bid: 104.45, ask: 104.55, timestampMs: 8_000 },
    asOfMs: 30_001,
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "STALE_QUOTE");
  assert.equal(result.quoteAgeMs, 22_001);
  assert.equal(result.maxQuoteAgeMs, 15_000);
});

test("setup fails closed when quote timestamp is in the future", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    quote: { bid: 104.45, ask: 104.55, timestampMs: 9_000 },
    asOfMs: 8_500,
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "QUOTE_TIMESTAMP_IN_FUTURE");
});

test("setup requires candle freshness and session coverage evidence", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({ candleEvidence: null }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CANDLE_FRESHNESS_EVIDENCE_REQUIRED");
});

test("setup fails closed when full-session VWAP coverage is unproven", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    candleEvidence: {
      timeframeMs: 10_000,
      sessionStartTimestampMs: 1,
      coverageStartTimestampMs: 1,
      lastCompleteCandleTimestampMs: 8,
      sessionCoverageComplete: false,
    },
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "SESSION_VWAP_COVERAGE_UNPROVEN");
});

test("setup fails closed when VWAP coverage starts materially after session open", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    candleEvidence: {
      timeframeMs: 10_000,
      sessionStartTimestampMs: 1,
      coverageStartTimestampMs: 15_002,
      lastCompleteCandleTimestampMs: 20_000,
      sessionCoverageComplete: true,
    },
    candles: regularCandles().map((row, index) => ({ ...row, timestamp: 19_993 + index })),
    quote: { bid: 104.45, ask: 104.55, timestampMs: 20_000 },
    asOfMs: 20_001,
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "SESSION_START_VWAP_COVERAGE_INCOMPLETE");
});

test("setup fails closed when the last complete candle is stale for its timeframe", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    quote: { bid: 104.45, ask: 104.55, timestampMs: 20_000 },
    asOfMs: 20_001,
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "STALE_CANDLES");
  assert.equal(result.candleAgeMs, 19_993);
  assert.equal(result.maxCandleAgeMs, 15_000);
});

test("setup rejects non-monotonic candle timestamps", () => {
  const candles = regularCandles();
  candles[5] = { ...candles[5], timestamp: 4 };
  assert.throws(
    () => evaluateUsQualityDaytradeSetup(setup({ candles })),
    /candle timestamps must be strictly increasing/,
  );
});

test("Tier A setup abstains when spread is above Tier A ceiling", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({ quote: { bid: 104.4, ask: 104.65, timestampMs: 8_000 } }));
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "SPREAD_TOO_WIDE");
  assert.equal(result.universe.tier, "A");
  assert.equal(result.maxSpreadBps, 20);
});

test("Tier B permits only the bounded wider spread ceiling and stronger RVOL", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    instrument: qualitySmallCapInstrument(),
    quote: { bid: 104.4, ask: 104.65, timestampMs: 8_000 },
    relativeVolume: 2.2,
  }));
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.qualityTier, "B");
  assert.equal(result.riskBudgetMultiplier, 0.5);
  assert.equal(result.hardRiskCeilingPct, 4);
  assert.ok(result.spreadBps > 20 && result.spreadBps < 30);
});

test("Tier B fails closed to abstain when RVOL does not meet its stricter gate", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({
    instrument: qualitySmallCapInstrument(),
    relativeVolume: 1.7,
  }));
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "RVOL_TOO_LOW");
});

test("setup recognizes first-pullback VWAP rebreak with volume reacceleration", () => {
  const result = evaluateUsQualityDaytradeSetup(setup());
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.reason, "VWAP_FIRST_PULLBACK_REBREAK");
  assert.equal(result.session, "REGULAR");
  assert.equal(result.catalystClass, "VERIFIED_CATALYST");
  assert.equal(result.qualityTier, "A");
  assert.equal(result.riskBudgetMultiplier, 1);
  assert.equal(result.quoteAgeMs, 500);
  assert.equal(result.candleAgeMs, 8_492);
  assert.ok(result.vwap > 0);
  assert.ok(result.pullbackPct > 0);
  assert.ok(result.volumeReacceleration > 1.25);
  assert.deepEqual(result.checks, {
    impulsePass: true,
    pullbackPass: true,
    higherLow: true,
    vwapHold: true,
    rebreak: true,
    volumePass: true,
  });
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("setup does not count pre-impulse lows as the first pullback", () => {
  const candles = regularCandles();
  candles[0] = { ...candles[0], low: 90 };
  const result = evaluateUsQualityDaytradeSetup(setup({ candles }));
  assert.equal(result.status, "CANDIDATE");
  assert.ok(result.pullbackPct < 2);
});

test("setup abstains without a rebreak", () => {
  const candles = regularCandles();
  candles[candles.length - 1] = {
    ...candles.at(-1),
    high: 103.85,
    low: 103.4,
    close: 103.7,
  };
  const result = evaluateUsQualityDaytradeSetup(setup({ candles }));
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "SETUP_NOT_COMPLETE");
  assert.equal(result.checks.rebreak, false);
});

test("mixed session candles fail closed instead of relabeling VWAP", () => {
  const candles = regularCandles();
  candles[0] = { ...candles[0], session: "PREMARKET" };
  const result = evaluateUsQualityDaytradeSetup(setup({ candles }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MIXED_SESSION_CANDLES");
});

test("research grid separates Tier A and quality-small-cap Tier B risk profiles", () => {
  const normalA = buildQualityDaytradeParameterGrid();
  const catalystA = buildQualityDaytradeParameterGrid({ catalystDay: true });
  const normalB = buildQualityDaytradeParameterGrid({ qualityTier: "B" });
  const catalystB = buildQualityDaytradeParameterGrid({ qualityTier: "B", catalystDay: true });

  assert.equal(normalA.combinations.length, 432);
  assert.equal(catalystA.combinations.length, 432);
  assert.equal(normalB.combinations.length, 432);
  assert.equal(catalystB.combinations.length, 432);
  assert.equal(Math.max(...normalA.combinations.map((row) => row.takeProfitPct)), 5);
  assert.equal(Math.max(...catalystA.combinations.map((row) => row.takeProfitPct)), 10);
  assert.equal(Math.max(...normalB.combinations.map((row) => row.takeProfitPct)), 7.5);
  assert.equal(Math.max(...catalystB.combinations.map((row) => row.takeProfitPct)), 10);
  assert.equal(normalA.riskBudgetMultiplier, 1);
  assert.equal(normalB.riskBudgetMultiplier, 0.5);
  assert.ok(normalB.combinations.some((row) => row.fixedStopPct === 4));
  assert.match(normalB.note, /half risk budget/i);
  assert.equal(normalA.optimizationRule, "COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT");
  assert.equal(normalA.selectionMetric, "NET_EXPECTANCY_WITH_PF_MDD_COST_STRESS");
});