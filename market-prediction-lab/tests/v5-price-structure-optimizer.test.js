import test from "node:test";
import assert from "node:assert/strict";
import {
  buildV5FilterCandidates,
  calculateV5SignalFeatures,
  evaluateV5Validation,
  optimizeV5PriceStructure,
  runV5FilteredBacktest,
} from "../src/v5-price-structure-optimizer.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

function candle(timestamp, open, high, low, close, volume = 100) {
  return { timestamp, observedAt: timestamp, isClosed: true, open, high, low, close, volume };
}

test("V5 candidate grid is bounded and deterministic", () => {
  const candidates = buildV5FilterCandidates();
  assert.equal(candidates.length, 36);
  assert.equal(new Set(candidates.map((row) => JSON.stringify(row))).size, 36);
});

test("V5 detects a prior upside breakout followed by a closed-candle retest", () => {
  const day = 24 * 60 * 60 * 1000;
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    candles.push(candle(Date.UTC(2024, 0, 1) + index * day, 100, 101, 99, 100));
  }
  candles.push(candle(Date.UTC(2024, 0, 27), 100, 106, 100, 105));
  candles.push(candle(Date.UTC(2024, 0, 28), 105, 106, 102, 104));
  candles.push(candle(Date.UTC(2024, 0, 29), 104, 105, 102, 103));
  candles.push(candle(Date.UTC(2024, 0, 30), 103, 104, 101.2, 102));
  const indicators = { atr: new Array(candles.length).fill(2) };
  const result = calculateV5SignalFeatures({
    side: "long",
    candles,
    indicators,
    index: candles.length - 1,
    filter: { structureLookback: 20, breakoutRecencyBars: 5, retestToleranceAtr: 0.5, atrPctMin: 0.01 },
  });
  assert.equal(result?.structureConfirmed, true);
  assert.equal(result?.breakoutIndex, 26);
  assert.equal(result?.structureLevel, 101);
  assert.equal(result?.usesOnlyClosedHistoryThroughSignal, true);
});

test("V5 validation requires return and success non-regression", () => {
  const baseline = { returnPercent: 5, successRatePercent: 50, profitFactor: 1.5, maximumDrawdownPercent: 4, trades: 20 };
  const better = { returnPercent: 6, successRatePercent: 55, profitFactor: 1.6, maximumDrawdownPercent: 3.5, trades: 18 };
  const tradeoff = { returnPercent: 8, successRatePercent: 45, profitFactor: 1.7, maximumDrawdownPercent: 3, trades: 18 };
  assert.equal(evaluateV5Validation({ baseline, candidate: better }).verdict, "adopt_candidate");
  assert.equal(evaluateV5Validation({ baseline, candidate: tradeoff }).verdict, "tradeoff_review");
});

test("V5 preserves frozen V2 candidates without retuning", () => {
  const result = optimizeV5PriceStructure({
    backtestInput: { market: "CRYPTO_FUTURES", symbol: "BTCUSDT", side: "long" },
    v2Optimization: {
      status: "v2_candidate_frozen_for_holdout",
      periods: { finalHoldoutUsedForSelection: false },
      preferred: { parameters: { fastPeriod: 8, slowPeriod: 30, atrPeriod: 14, pullbackTolerancePct: 0.75, stopAtrMultiple: 2, targetRiskMultiple: 3 } },
    },
  });
  assert.equal(result.status, "v2_frozen_not_retested");
  assert.equal(result.candidateCount, 0);
});

test("V5 refuses any selection period touching the 2026 final holdout", () => {
  assert.throws(() => runV5FilteredBacktest({
    backtestInput: { market: "CRYPTO_SPOT", symbol: "USDT-ETH", side: "long", candles: [] },
    parameters: { fastPeriod: 10, slowPeriod: 80, atrPeriod: 14, pullbackTolerancePct: 0.25, stopAtrMultiple: 1.25, targetRiskMultiple: 2.5 },
    filter: { structureLookback: 20, breakoutRecencyBars: 5, retestToleranceAtr: 0.5, atrPctMin: 0 },
    period: { startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime, endTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime, includeFinalHoldout: false },
  }), (error) => error?.code === "V5_HOLDOUT_LOCKED");
});
