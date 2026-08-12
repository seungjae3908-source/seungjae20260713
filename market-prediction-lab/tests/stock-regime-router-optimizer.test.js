import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStockRegime,
  expandStockRegimeGrid,
  simulateStockRegimeRouter,
} from "../src/stock-regime-router-optimizer.js";

function trendCandles(count = 500) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 25;
    const drift = cycle < 18 ? 0.35 : -0.12;
    const open = close;
    close = Math.max(10, open + drift);
    rows.push({
      timestamp: Date.UTC(2021, 0, 1) + index * 86_400_000,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + (cycle === 18 ? 40 : index % 7),
    });
  }
  return rows;
}

function rangeCandles(count = 500) {
  return Array.from({ length: count }, (_, index) => {
    const prior = 100 + Math.sin(Math.max(0, index - 1) / 5) * 5;
    const close = 100 + Math.sin(index / 5) * 5;
    return {
      timestamp: Date.UTC(2021, 0, 1) + index * 86_400_000,
      open: prior,
      high: Math.max(prior, close) + 0.8,
      low: Math.min(prior, close) - 0.8,
      close,
      volume: 100 + index % 5,
    };
  });
}

const params = {
  regimeLookback: 20,
  regimeMaPeriod: 50,
  trendEfficiencyMin: 0.25,
  rangeEfficiencyMax: 0.20,
  rangeMaxMaSlopePercent: 2,
  trendPullbackLookback: 10,
  trendMaxPullbackAtr: 2.5,
  trendMinRelativeVolume: 0.8,
  trendStopAtr: 2,
  trendRewardRisk: 1.5,
  rangeZPeriod: 20,
  rangeEntryZ: -1.5,
  rangeExitZ: 0,
  rangeStopAtr: 2,
  maxHoldBars: 20,
  maxGapPercent: 4,
};

test("regime classifier distinguishes persistent trend from low-efficiency range", () => {
  const trend = trendCandles();
  const range = rangeCandles();
  const trendLabels = trend.slice(150).map((_, offset) => classifyStockRegime(trend, offset + 150, params).regime);
  const rangeLabels = range.slice(150).map((_, offset) => classifyStockRegime(range, offset + 150, params).regime);
  assert.ok(trendLabels.includes("trend"));
  assert.ok(rangeLabels.includes("range"));
});

test("stock regime strategy only enters on next session and applies cost", () => {
  const candles = [...trendCandles(260), ...rangeCandles(260).map((row, index) => ({
    ...row,
    timestamp: Date.UTC(2021, 0, 1) + (260 + index) * 86_400_000,
  }))];
  const free = simulateStockRegimeRouter({ candles, params, costRatePerSide: 0 });
  const costly = simulateStockRegimeRouter({ candles, params, costRatePerSide: 0.002 });
  assert.equal(free.trades.length, costly.trades.length);
  assert.ok(free.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1));
  if (free.trades.length > 0) assert.ok(costly.metrics.expectancy <= free.metrics.expectancy + 1e-12);
});

test("registered market grid remains bounded and preserves both regime dimensions", () => {
  const grid = expandStockRegimeGrid({
    regimeLookback: [20, 40],
    regimeMaPeriod: [50, 100],
    trendEfficiencyMin: [0.25, 0.35],
    rangeEfficiencyMax: [0.12, 0.20],
    trendMaxPullbackAtr: [1.5, 2.5],
    trendMinRelativeVolume: [0.8],
    trendStopAtr: [2],
    trendRewardRisk: [1.5, 2],
    rangeEntryZ: [-1.5, -2],
    rangeExitZ: [0],
    rangeStopAtr: [2],
    maxHoldBars: [10, 20],
    maxGapPercent: [4],
  });
  assert.equal(grid.length, 256);
  assert.ok(grid.every((row) => row.trendEfficiencyMin > row.rangeEfficiencyMax));
});
