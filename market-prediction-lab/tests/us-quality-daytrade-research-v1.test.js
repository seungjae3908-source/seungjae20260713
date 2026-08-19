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
    recentReverseSplit: false,
    listingRisk: false,
    manipulationRisk: false,
    ...overrides,
  };
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
    securityType: "MICROCAP",
  }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("PRICE_BELOW_MINIMUM"));
  assert.ok(result.reasons.includes("MARKET_CAP_BELOW_MINIMUM"));
  assert.ok(result.reasons.includes("DOLLAR_VOLUME_BELOW_MINIMUM"));
  assert.ok(result.reasons.includes("SECURITY_TYPE_EXCLUDED:MICROCAP"));
});

test("quality universe accepts liquid NYSE/Nasdaq common stock", () => {
  const result = classifyUsQualityUniverse(qualityInstrument());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
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

test("setup rejects non-monotonic candle timestamps", () => {
  const candles = regularCandles();
  candles[5] = { ...candles[5], timestamp: 4 };
  assert.throws(
    () => evaluateUsQualityDaytradeSetup(setup({ candles })),
    /candle timestamps must be strictly increasing/,
  );
});

test("setup abstains when spread is too wide", () => {
  const result = evaluateUsQualityDaytradeSetup(setup({ quote: { bid: 103, ask: 105, timestampMs: 8_000 } }));
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "SPREAD_TOO_WIDE");
});

test("setup recognizes first-pullback VWAP rebreak with volume reacceleration", () => {
  const result = evaluateUsQualityDaytradeSetup(setup());
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.reason, "VWAP_FIRST_PULLBACK_REBREAK");
  assert.equal(result.session, "REGULAR");
  assert.equal(result.catalystClass, "VERIFIED_CATALYST");
  assert.equal(result.quoteAgeMs, 500);
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

test("research grid explores exits but treats 4% stop as a stress ceiling", () => {
  const normal = buildQualityDaytradeParameterGrid();
  const catalyst = buildQualityDaytradeParameterGrid({ catalystDay: true });
  assert.equal(normal.combinations.length, 432);
  assert.equal(catalyst.combinations.length, 432);
  assert.equal(Math.max(...normal.combinations.map((row) => row.takeProfitPct)), 5);
  assert.equal(Math.max(...catalyst.combinations.map((row) => row.takeProfitPct)), 10);
  assert.ok(normal.combinations.some((row) => row.fixedStopPct === 4));
  assert.match(normal.note, /stress ceiling/i);
  assert.equal(normal.optimizationRule, "COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT");
  assert.equal(normal.selectionMetric, "NET_EXPECTANCY_WITH_PF_MDD_COST_STRESS");
});
