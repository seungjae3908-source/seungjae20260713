import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { runIndependentSignalBacktest } from "../src/independent-strategy-backtest.js";
import {
  buildV6Candidates,
  calculateV6Signal,
  optimizeV6IndependentBreakoutRetest,
} from "../src/v6-independent-breakout-retest-optimizer.js";

function candle(timestamp, open, high, low, close) {
  return Object.freeze({ timestamp, open, high, low, close, volume: 1000, isClosed: true });
}

test("V6 grid is bounded to 36 independent structure candidates", () => {
  const candidates = buildV6Candidates();
  assert.equal(candidates.length, 36);
  assert.equal(new Set(candidates.map((row) => JSON.stringify(row))).size, 36);
});

test("V6 signal detects prior breakout and current retest without V1 entry dependency", () => {
  const day = 86_400_000;
  const candles = [];
  for (let index = 0; index < 12; index += 1) candles.push(candle(day * (index + 1), 100, 101, 99, 100));
  candles.push(candle(day * 13, 100, 103, 100, 102.5));
  candles.push(candle(day * 14, 102.4, 102.8, 100.8, 102.2));
  const atr = new Array(candles.length).fill(2);
  const signal = calculateV6Signal({
    side: "long",
    candles,
    atr,
    index: 13,
    filter: { structureLookback: 10, breakoutRecencyBars: 3, retestToleranceAtr: 0.5, confirmationMode: "close_reclaim" },
  });
  assert.ok(signal);
  assert.equal(signal.independentSignal, true);
  assert.equal(signal.usesV1EntrySignal, false);
  assert.equal(signal.usesOnlyClosedHistoryThroughSignal, true);
});

test("independent strategy executor refuses the 2026 final holdout during research selection", () => {
  assert.throws(() => runIndependentSignalBacktest({
    backtestInput: { market: "CRYPTO_SPOT", symbol: "USDT-ETH", side: "long", candles: [] },
    strategy: "test",
    strategyVersion: "V6",
    parameters: { atrPeriod: 14, stopAtrMultiple: 1.5, targetRiskMultiple: 2 },
    signalEvaluator: () => null,
    period: { startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime, endTime: RESEARCH_BACKTEST_PERIOD.defaultEndTime, includeFinalHoldout: false },
  }), (error) => error?.code === "INDEPENDENT_HOLDOUT_LOCKED");
});

test("V6 does not retune a V2 candidate already frozen for BTC holdout", () => {
  const result = optimizeV6IndependentBreakoutRetest({
    backtestInput: { market: "CRYPTO_FUTURES", symbol: "BTCUSDT", side: "long" },
    v2Optimization: { status: "v2_candidate_frozen_for_holdout", periods: { finalHoldoutUsedForSelection: false } },
  });
  assert.equal(result.status, "v2_frozen_not_retested");
  assert.equal(result.candidateCount, 0);
  assert.equal(result.preferred, null);
  assert.equal(result.liveOrderAllowed, false);
});
