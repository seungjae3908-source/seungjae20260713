import test from "node:test";
import assert from "node:assert/strict";
import {
  FINAL_HOLDOUT_END,
  FINAL_HOLDOUT_START,
  FROZEN_CANDIDATE_MANIFEST_SHA256,
  FROZEN_FINAL_HOLDOUT_CANDIDATES,
  buildFinalHoldoutPeriod,
  classifyFinalHoldout,
} from "../src/final-holdout-evaluator.js";
import {
  runIndependentSignalBacktest,
  runIndependentSignalFinalHoldout,
} from "../src/independent-strategy-backtest.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function candles(count = 140) {
  const start = Date.UTC(2025, 8, 1);
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.05;
    return Object.freeze({
      symbol: "USDT-ETH",
      timestamp: start + index * DAY_MS,
      observedAt: start + index * DAY_MS,
      isClosed: true,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.1,
      volume: 1000 + index,
    });
  });
}

const input = Object.freeze({
  market: "CRYPTO_SPOT",
  symbol: "USDT-ETH",
  side: "long",
  timeframe: "1d",
  initialCapital: 1_000_000,
  candles: candles(),
  costModel: Object.freeze({ entryFeeRate: 0.001, exitFeeRate: 0.001, slippageRate: 0.0002, spreadRate: 0.0002 }),
  riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
});

test("final holdout manifest is frozen and contains only preapproved candidates", () => {
  assert.equal(FROZEN_FINAL_HOLDOUT_CANDIDATES.length, 5);
  assert.deepEqual(FROZEN_FINAL_HOLDOUT_CANDIDATES.map((row) => row.id), [
    "btc-spot-long-v2",
    "btc-futures-long-v2",
    "btc-futures-short-v2",
    "eth-spot-long-v6",
    "eth-futures-long-v6",
  ]);
  assert.match(FROZEN_CANDIDATE_MANIFEST_SHA256, /^[a-f0-9]{64}$/u);
});

test("final holdout period is exactly 2026 and cannot extend beyond the frozen end", () => {
  assert.deepEqual(buildFinalHoldoutPeriod(), {
    startTime: FINAL_HOLDOUT_START,
    endTime: FINAL_HOLDOUT_END,
    includeFinalHoldout: true,
  });
  assert.throws(() => buildFinalHoldoutPeriod(FINAL_HOLDOUT_END + 1), /predeclared one-shot window/u);
});

test("selection engine still rejects any attempt to read the final holdout", () => {
  assert.throws(() => runIndependentSignalBacktest({
    backtestInput: input,
    strategy: "test",
    strategyVersion: "TEST",
    parameters: { atrPeriod: 14, stopAtrMultiple: 1, targetRiskMultiple: 2 },
    period: { startTime: FINAL_HOLDOUT_START, endTime: FINAL_HOLDOUT_START + 30 * DAY_MS, includeFinalHoldout: true },
    signalEvaluator: () => null,
  }), /cannot use the 2026 final holdout/u);
});

test("explicit final-holdout runner allows evaluation but never selection or orders", () => {
  const result = runIndependentSignalFinalHoldout({
    backtestInput: input,
    strategy: "test",
    strategyVersion: "TEST_FINAL",
    parameters: { atrPeriod: 14, stopAtrMultiple: 1, targetRiskMultiple: 2 },
    period: { startTime: FINAL_HOLDOUT_START, endTime: FINAL_HOLDOUT_START + 20 * DAY_MS, includeFinalHoldout: true },
    signalEvaluator: () => null,
  });
  assert.equal(result.totalTrades, 0);
  assert.equal(result.period.finalHoldoutEvaluation, true);
  assert.equal(result.period.selectionAllowed, false);
  assert.equal(result.safeguards.orderSubmitted, false);
  assert.equal(result.safeguards.privateAccountRequestAllowed, false);
});

test("holdout assessment separates effect direction from sample sufficiency", () => {
  assert.deepEqual(classifyFinalHoldout({ totalTrades: 0 }), {
    effect: "no_signals",
    sample: "insufficient",
    promotionEvidence: false,
  });
  assert.deepEqual(classifyFinalHoldout({ totalTrades: 4, totalReturnPercent: 2, expectancy: 1000, profitFactor: 1.5 }), {
    effect: "positive",
    sample: "low",
    promotionEvidence: false,
  });
  assert.deepEqual(classifyFinalHoldout({ totalTrades: 30, totalReturnPercent: -1, expectancy: -100, profitFactor: 0.8 }), {
    effect: "negative_or_unstable",
    sample: "research_sufficient",
    promotionEvidence: false,
  });
});
