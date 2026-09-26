import test from "node:test";
import assert from "node:assert/strict";
import {
  buildV3FilterCandidates,
  calculateV3SignalFeatures,
  evaluateV3Validation,
  optimizeV3MarketFilters,
} from "../src/v3-market-filter-optimizer.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function candles(count = 40) {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    symbol: "USDT-ETH",
    timestamp: Date.UTC(2024, 0, 1) + index * DAY_MS,
    observedAt: Date.UTC(2024, 0, 1) + index * DAY_MS,
    isClosed: true,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1000 + index * 10,
  }));
}

test("V3 filter grid is deliberately bounded", () => {
  const candidates = buildV3FilterCandidates();
  assert.equal(candidates.length, 27);
  assert.equal(new Set(candidates.map((row) => JSON.stringify(row))).size, 27);
});

test("V3 signal features use only closed history through the signal index", () => {
  const rows = candles(40);
  const indicators = {
    fast: Array.from({ length: 40 }, (_, index) => 100 + index),
    slow: Array.from({ length: 40 }, (_, index) => 99 + index * 0.8),
    atr: Array.from({ length: 40 }, () => 2),
  };
  const before = calculateV3SignalFeatures({ candles: rows, indicators, index: 25 });
  const changedFuture = rows.map((row, index) => index > 25 ? Object.freeze({ ...row, volume: row.volume * 100 }) : row);
  const after = calculateV3SignalFeatures({ candles: changedFuture, indicators, index: 25 });
  assert.deepEqual(after, before);
  assert.equal(before.usesOnlyClosedHistoryThroughSignal, true);
});

test("V3 validation never hides return-success tradeoffs behind a scalar score", () => {
  const baseline = { returnPercent: 2, successRatePercent: 40, profitFactor: 1.2, maximumDrawdownPercent: 5, trades: 20 };
  const candidate = { returnPercent: 3, successRatePercent: 35, profitFactor: 1.3, maximumDrawdownPercent: 4, trades: 18 };
  const verdict = evaluateV3Validation({ baseline, candidate });
  assert.equal(verdict.verdict, "tradeoff_review");
  assert.equal(verdict.weightedScoreUsed, false);
});

test("a frozen V2 candidate is not retuned by V3 before the 2026 holdout", () => {
  const result = optimizeV3MarketFilters({
    backtestInput: { market: "CRYPTO_SPOT", symbol: "USDT-ETH", side: "long", timeframe: "1d", candles: candles() },
    v2Optimization: {
      status: "v2_candidate_frozen_for_holdout",
      preferred: { parameters: { fastPeriod: 10, slowPeriod: 80, atrPeriod: 14, pullbackTolerancePct: 0.5, stopAtrMultiple: 1.5, targetRiskMultiple: 2 } },
    },
  });
  assert.equal(result.status, "v2_frozen_not_retested");
  assert.equal(result.candidateCount, 0);
  assert.equal(result.periods.finalHoldoutUsedForSelection, false);
});
