import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradeVolatility } from "../src/us-quality-daytrade-volatility-v1.js";

function input() {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.4,
    high: 100.8 + index * 0.4,
    low: 99.8 + index * 0.4,
    close: 100.5 + index * 0.4,
    volume: 1_000 + index * 50,
    session: "REGULAR",
    timestamp: index + 1,
  }));
  return {
    asOfMs: 10,
    candles,
    candleEvidence: {
      sessionCoverageComplete: true,
      lastCompleteCandleTimestampMs: 8,
    },
  };
}

test("validated completed candles produce lookahead-free ATR and realized volatility", () => {
  const result = evaluateUsQualityDaytradeVolatility(input());
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "POINT_IN_TIME_INTRADAY_VOLATILITY_COMPUTED");
  assert.equal(result.atrLookbackRequested, 14);
  assert.equal(result.atrLookbackUsed, 8);
  assert.ok(result.atrUsd > 0);
  assert.ok(result.atrPct > 0);
  assert.ok(result.realizedVolatilityPct > 0);
  assert.ok(result.sessionRangePct > 0);
  assert.equal(result.lookaheadFree, true);
  assert.equal(result.pointInTime, true);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
});

test("future volatility candle evidence fails closed", () => {
  const raw = input();
  raw.candleEvidence.lastCompleteCandleTimestampMs = 11;
  const result = evaluateUsQualityDaytradeVolatility(raw);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "VOLATILITY_EVIDENCE_FROM_FUTURE");
});

test("cross-session candles cannot be used to compute one volatility metric", () => {
  const raw = input();
  raw.candles[4] = { ...raw.candles[4], session: "AFTER_HOURS" };
  const result = evaluateUsQualityDaytradeVolatility(raw);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "VOLATILITY_SESSION_MISMATCH");
});

test("last complete candle identity must match the candle set", () => {
  const raw = input();
  raw.candleEvidence.lastCompleteCandleTimestampMs = 7;
  const result = evaluateUsQualityDaytradeVolatility(raw);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "VOLATILITY_LAST_COMPLETE_CANDLE_MISMATCH");
});
