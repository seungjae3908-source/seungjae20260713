import assert from "node:assert/strict";
import test from "node:test";

import { runIndependentSignalBacktest } from "../src/independent-strategy-backtest.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2025, 0, 1);

function candles(overrides = {}) {
  return Array.from({ length: 10 }, (_, index) => Object.freeze({
    timestamp: START + (index * DAY),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000 + index,
    ...(overrides[index] ?? {}),
  }));
}

function run({ candleOverrides = {}, parameters = {}, signalIndex = 2 } = {}) {
  return runIndependentSignalBacktest({
    backtestInput: {
      market: "US_STOCK",
      symbol: "AAPL",
      timeframe: "1d",
      side: "long",
      candles: candles(candleOverrides),
      initialCapital: 10_000,
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
      costModel: {
        entryFeeRate: 0,
        exitFeeRate: 0,
        taxRate: 0,
        slippageRate: 0,
        spreadRate: 0,
        latencyBars: 0,
        latencyDriftRate: 0,
      },
      fundingRates: [],
    },
    strategy: "FORMULA_EXIT_PARITY_TEST",
    strategyVersion: "V1",
    parameters: {
      atrPeriod: 2,
      stopAtrMultiple: 10,
      ...parameters,
    },
    signalEvaluator: ({ index }) => index === signalIndex ? { setup: "fixture" } : null,
    period: {
      startTime: START,
      endTime: START + (9 * DAY),
    },
  });
}

test("legacy risk-multiple calls preserve the exact legacy parameter and safeguard shape", () => {
  const result = run({ parameters: { targetRiskMultiple: 2 } });

  assert.deepEqual(result.parameters, {
    atrPeriod: 2,
    stopAtrMultiple: 10,
    targetRiskMultiple: 2,
  });
  assert.deepEqual(Object.keys(result.safeguards).sort(), [
    "entryUsesNextCandleOpen",
    "executionUsesSharedCalculateExecutionAwareTrade",
    "finalHoldoutEvaluation",
    "finalHoldoutUsedForSelection",
    "fundingIncludedForFutures",
    "orderSubmitted",
    "privateAccountRequestAllowed",
    "selectionAllowed",
    "signalUsesClosedCandle",
    "stopFirstOnAmbiguousBar",
  ].sort());
  assert.equal("targetDistance" in result.parameters, false);
  assert.equal("timeBars" in result.parameters, false);
  assert.equal("priceFractionTargetUsed" in result.safeguards, false);
  assert.equal("timeExitUsed" in result.safeguards, false);
});

test("price-fraction TARGET uses entry price rather than ATR risk multiple", () => {
  const result = run({
    candleOverrides: {
      3: { high: 101, low: 99, close: 100.5 },
      4: { high: 103, low: 100, close: 102.5 },
    },
    parameters: { targetDistance: 0.02 },
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 100);
  assert.equal(result.trades[0].targetPrice, 102);
  assert.equal(result.trades[0].requestedExitPrice, 102);
  assert.equal(result.trades[0].exitReason, "take_profit");
  assert.deepEqual(result.parameters, {
    atrPeriod: 2,
    stopAtrMultiple: 10,
    targetDistance: 0.02,
  });
  assert.equal(result.safeguards.priceFractionTargetUsed, true);
  assert.equal(result.safeguards.timeExitUsed, false);
});

test("TIME_EXIT closes at the configured held-bar close after stop/target checks", () => {
  const result = run({
    candleOverrides: {
      3: { high: 101, low: 99, close: 100.2 },
      4: { high: 101, low: 99, close: 100.4 },
    },
    parameters: { targetDistance: 0.5, timeBars: 2 },
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, START + (3 * DAY));
  assert.equal(result.trades[0].exitTime, START + (4 * DAY));
  assert.equal(result.trades[0].requestedExitPrice, 100.4);
  assert.equal(result.trades[0].exitReason, "time_exit");
  assert.equal(result.safeguards.timeExitUsed, true);
  assert.equal(result.safeguards.stopTargetBeforeTimeExit, true);
});

test("target hit on the time-exit bar wins before time exit", () => {
  const result = run({
    candleOverrides: {
      3: { high: 101, low: 99, close: 100.2 },
      4: { high: 103, low: 99, close: 100.4 },
    },
    parameters: { targetDistance: 0.02, timeBars: 2 },
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitTime, START + (4 * DAY));
  assert.equal(result.trades[0].exitReason, "take_profit");
  assert.equal(result.trades[0].requestedExitPrice, 102);
});

test("same-bar stop and target remains conservatively stop-first even with timeBars", () => {
  const result = run({
    candleOverrides: {
      1: { high: 101, low: 99, close: 100 },
      2: { high: 101, low: 99, close: 100 },
      3: { high: 103, low: 97, close: 100 },
    },
    parameters: { stopAtrMultiple: 1, targetDistance: 0.02, timeBars: 1 },
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].stopPrice, 98);
  assert.equal(result.trades[0].targetPrice, 102);
  assert.equal(result.trades[0].exitReason, "stop_loss_same_bar");
  assert.equal(result.trades[0].requestedExitPrice, 98);
});

test("invalid or ambiguous formula exit parameters fail closed", () => {
  assert.throws(() => run({ parameters: { targetDistance: 0 } }), /NON_POSITIVE_NUMBER/u);
  assert.throws(() => run({ parameters: { targetDistance: 1.01 } }), /INVALID_TARGET_DISTANCE/u);
  assert.throws(() => run({ parameters: { timeBars: 0 } }), /INVALID_TIME_BARS/u);
  assert.throws(() => run({ parameters: { timeBars: 1.5 } }), /INVALID_TIME_BARS/u);
  assert.throws(
    () => run({ parameters: { targetDistance: 0.02, targetRiskMultiple: 2 } }),
    /AMBIGUOUS_TARGET_MODEL/u,
  );
});
