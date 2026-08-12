import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFuturesDonchianSegments,
  expandFuturesDonchianGrid,
  optimizeFuturesDonchianTrend,
  simulateFuturesDonchianTrend,
} from "../src/futures-donchian-trend.js";
import {
  FUTURES_DONCHIAN_TREND_CANDIDATE,
  FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256,
} from "../src/futures-donchian-trend-candidate.js";

const BAR = 15 * 60 * 1000;

function candles(count = 1800, phase = 0) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = (index + phase) % 240;
    const drift = cycle < 100 ? 0.22 : cycle < 120 ? -0.05 : cycle < 220 ? -0.20 : 0.04;
    const open = close;
    close = Math.max(20, open + drift);
    rows.push({
      timestamp: Date.UTC(2025, 0, 1) + index * BAR,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 1000 + index % 30,
    });
  }
  return rows;
}

function funding(rows, rate = 0) {
  const result = [];
  for (let index = 0; index < rows.length; index += 32) result.push({ timestamp: rows[index].timestamp, rate });
  return result;
}

function dataset(symbol, phase) {
  const rows = candles(1800, phase);
  return Object.freeze({ symbol, candles: rows, fundingRates: funding(rows, 0) });
}

const baseParams = Object.freeze({
  breakoutLookback: 20,
  trendMaPeriod: 100,
  stopAtrMultiple: 2,
  maxHoldBars: 32,
  maxAtrFraction: 0.025,
  fundingCrowdingAbsRate: 0.0003,
});

test("candidate preregisters fresh assets and never uses a model", () => {
  assert.equal(FUTURES_DONCHIAN_TREND_CANDIDATE.safeguards.modelUsed, false);
  assert.equal(FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256.length, 64);
  const prior = new Set(FUTURES_DONCHIAN_TREND_CANDIDATE.priorResearchSymbols);
  assert.ok([...FUTURES_DONCHIAN_TREND_CANDIDATE.designSymbols, ...FUTURES_DONCHIAN_TREND_CANDIDATE.holdoutSymbols].every((symbol) => !prior.has(symbol)));
  assert.equal(expandFuturesDonchianGrid().length, 96);
});

test("Donchian trend uses next-bar entries, two-sided signals, costs and no real orders", () => {
  const rows = candles();
  const result = simulateFuturesDonchianTrend({
    symbol: "LTCUSDT",
    candles: rows,
    fundingRates: funding(rows, 0),
    params: baseParams,
  });
  assert.ok(result.trades.length > 10);
  assert.ok(result.trades.every((trade) => trade.entryTimestamp > trade.signalTimestamp));
  assert.ok(result.trades.every((trade) => trade.costsIncluded === true));
  assert.ok(result.metrics.directionCounts.LONG > 0);
  assert.ok(result.metrics.directionCounts.SHORT > 0);
  assert.equal(result.safeguards.actualOrders, 0);
  assert.equal(result.safeguards.liveExecutionAllowed, false);
});

test("execution cost stress cannot improve the same frozen Donchian trades", () => {
  const rows = candles();
  const common = { symbol: "LTCUSDT", candles: rows, fundingRates: funding(rows, 0), params: baseParams };
  const base = simulateFuturesDonchianTrend({ ...common, costMultiplier: 1 });
  const stressed = simulateFuturesDonchianTrend({ ...common, costMultiplier: 1.5 });
  assert.equal(base.trades.length, stressed.trades.length);
  assert.ok(stressed.metrics.totalExecutionCost >= base.metrics.totalExecutionCost);
  assert.ok(stressed.metrics.netPnl <= base.metrics.netPnl + 1e-9);
});

test("chronological segments are ordered and holdout is never used for selection", () => {
  const split = buildFuturesDonchianSegments(1800);
  assert.ok(split.train.endIndex < split.validation.startIndex);
  assert.ok(split.validation.endIndex < split.test.startIndex);
  const designDatasets = [dataset("LTCUSDT", 0), dataset("BCHUSDT", 17)];
  const holdoutDatasets = [dataset("LINKUSDT", 41), dataset("DOTUSDT", 73)];
  const result = optimizeFuturesDonchianTrend({ designDatasets, holdoutDatasets });
  assert.equal(result.selectionContract.scalarWeightedScoreUsed, false);
  assert.equal(result.selectionContract.modelUsed, false);
  assert.equal(result.selectionContract.priorResearchSymbolsUsedForSelection, false);
  assert.equal(result.selectionContract.designTestUsedForSelection, false);
  assert.equal(result.selectionContract.holdoutUsedForSelection, false);
  assert.equal(result.selectionContract.holdoutStressUsedForSelection, false);
  assert.equal(result.selectionContract.rollingUsedForSelection, false);
  assert.equal(result.safeguards.actualOrders, 0);
});

test("prior research symbols cannot be reused in the independent family", () => {
  const designDatasets = [dataset("BTCUSDT", 0), dataset("BCHUSDT", 17)];
  const holdoutDatasets = [dataset("LINKUSDT", 41), dataset("DOTUSDT", 73)];
  assert.throws(() => optimizeFuturesDonchianTrend({ designDatasets, holdoutDatasets }), /design symbols must match preregistered/);
});
