import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradeLiquidityEvidence } from "../src/us-quality-daytrade-liquidity-evidence-v1.js";

function liquidityEvidence(overrides = {}) {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.2,
    high: 100.4 + index * 0.2,
    low: 99.9 + index * 0.2,
    close: 100.3 + index * 0.2,
    volume: 100 + index * 10,
    session: "PREMARKET",
    timestamp: (index + 2) * 1_000,
  }));

  return {
    asOfMs: 10_000,
    candleEvidence: {
      sourceId: "public-intraday-candle-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session: "PREMARKET",
      timeframeMs: 1_000,
      sessionStartTimestampMs: 2_000,
      coverageStartTimestampMs: 2_000,
      lastCompleteCandleTimestampMs: 9_000,
      sessionCoverageComplete: true,
      candles,
    },
    relativeVolumeEvidence: {
      sourceId: "public-rvol-same-phase",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session: "PREMARKET",
      sameSessionPhase: true,
      lookaheadFree: true,
      observedAtMs: 9_000,
      currentCumulativeVolume: 2_000,
    },
    ...overrides,
  };
}

test("source-backed completed candles produce point-in-time session dollar volume", () => {
  const input = liquidityEvidence();
  const expectedDollarVolume = input.candleEvidence.candles.reduce((sum, candle) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    return sum + typicalPrice * candle.volume;
  }, 0);
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "POINT_IN_TIME_SESSION_DOLLAR_VOLUME_READY");
  assert.equal(result.session, "PREMARKET");
  assert.equal(result.sessionCumulativeShareVolume, 1_080);
  assert.equal(result.candleDerivedSessionDollarVolumeUsd, expectedDollarVolume);
  assert.equal(result.candleDerivedAveragePriceUsd, expectedDollarVolume / 1_080);
  assert.equal(result.dollarVolumeBasis, "TYPICAL_PRICE_X_COMPLETED_CANDLE_VOLUME");
  assert.equal(result.completedThroughMs, 9_000);
  assert.equal(result.rvolCurrentCumulativeVolume, 2_000);
  assert.equal(result.provenance.candleSourceId, "public-intraday-candle-feed");
  assert.equal(result.provenance.relativeVolumeSourceId, "public-rvol-same-phase");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("RVOL cumulative volume cannot trail already completed candle volume", () => {
  const input = liquidityEvidence();
  input.relativeVolumeEvidence.currentCumulativeVolume = 1_000;
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_RVOL_CUMULATIVE_VOLUME_BEHIND_CANDLES");
  assert.equal(result.currentCumulativeVolume, 1_000);
  assert.equal(result.completedShareVolume, 1_080);
});

test("future completed-candle evidence fails closed", () => {
  const input = liquidityEvidence();
  input.candleEvidence.lastCompleteCandleTimestampMs = 11_000;
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_CANDLE_EVIDENCE_FROM_FUTURE");
});

test("mixed-session candles fail closed", () => {
  const input = liquidityEvidence();
  input.candleEvidence.candles[3] = {
    ...input.candleEvidence.candles[3],
    session: "REGULAR",
  };
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_CANDLE_SESSION_MISMATCH");
});

test("stale completed candles fail closed", () => {
  const input = liquidityEvidence({
    asOfMs: 12_000,
    liquidityPolicy: {
      maxCandleLagIntervals: 1.5,
      maxRvolAgeMs: 15_000,
    },
  });
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_CANDLES_STALE");
});

test("private candle evidence cannot become canonical dollar-volume evidence", () => {
  const input = liquidityEvidence();
  input.candleEvidence.publicReadOnly = false;
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_CANDLE_PUBLIC_READ_ONLY_REQUIRED");
});

test("zero completed-session volume is DATA_BLOCKED instead of fabricating liquidity", () => {
  const input = liquidityEvidence();
  input.candleEvidence.candles = input.candleEvidence.candles.map((candle) => ({ ...candle, volume: 0 }));
  const result = evaluateUsQualityDaytradeLiquidityEvidence(input);

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_SESSION_DOLLAR_VOLUME_UNAVAILABLE");
});
