import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStockOosSegments,
  expandStockParameterGrid,
  optimizeStockSwingMarket,
  simulateStockSwingStrategy,
} from "../src/stock-swing-optimizer.js";

function breakoutSeries(count = 500, seed = 0) {
  const rows = [];
  let close = 100 + seed;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 35;
    const drift = cycle < 25 ? 0.12 : cycle === 25 ? 2.8 : -0.03;
    const open = close + (cycle === 26 ? 0.15 : 0);
    close = Math.max(5, open + drift);
    const volume = cycle === 25 ? 260 : 100 + (index % 7);
    rows.push({
      timestamp: Date.UTC(2020, 0, 1) + index * 86_400_000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume,
    });
  }
  return rows;
}

const params = {
  breakoutLookback: 10,
  maPeriod: 20,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  rewardRisk: 1.5,
  maxHoldBars: 10,
  relativeVolumePeriod: 10,
  minRelativeVolume: 1.4,
  maxGapPercent: 5,
};

test("strategy uses signal close then next-bar open and includes per-side execution cost", () => {
  const candles = breakoutSeries();
  const free = simulateStockSwingStrategy({ candles, params, costRatePerSide: 0 });
  const costly = simulateStockSwingStrategy({ candles, params, costRatePerSide: 0.002 });
  assert.ok(free.trades.length > 0);
  assert.equal(free.trades[0].entryIndex, free.trades[0].signalIndex + 1);
  assert.equal(free.trades[0].entryOpen, candles[free.trades[0].entryIndex].open);
  assert.ok(costly.metrics.expectancy < free.metrics.expectancy);
});

test("same-bar stop and target resolves conservatively to stop", () => {
  const candles = breakoutSeries(160);
  const first = simulateStockSwingStrategy({ candles, params, costRatePerSide: 0 });
  assert.ok(first.trades.length > 0);
  const trade = first.trades[0];
  const modified = candles.map((row) => ({ ...row }));
  modified[trade.entryIndex].high = trade.targetPrice + 1;
  modified[trade.entryIndex].low = trade.stopPrice - 1;
  const rerun = simulateStockSwingStrategy({ candles: modified, params, costRatePerSide: 0 });
  assert.equal(rerun.trades[0].exitReason, "stop_same_bar_conservative");
  assert.ok(rerun.trades[0].netReturn < 0);
});

test("OOS segment test window is chronologically after train and validation", () => {
  const segments = buildStockOosSegments(1000);
  assert.ok(segments.train.endIndex < segments.validation.startIndex);
  assert.ok(segments.validation.endIndex < segments.test.startIndex);
  assert.equal(segments.test.endIndex, 999);
});

test("parameter grid remains bounded and deterministic", () => {
  const grid = expandStockParameterGrid({
    breakoutLookback: [10, 20],
    maPeriod: [20],
    atrStopMultiplier: [1.5, 2],
    rewardRisk: [1.5],
    maxHoldBars: [5],
    minRelativeVolume: [1, 1.2],
    maxGapPercent: [4],
  });
  assert.equal(grid.length, 8);
  assert.deepEqual(grid[0], {
    breakoutLookback: 10,
    maPeriod: 20,
    atrPeriod: 14,
    atrStopMultiplier: 1.5,
    rewardRisk: 1.5,
    maxHoldBars: 5,
    relativeVolumePeriod: 20,
    minRelativeVolume: 1,
    maxGapPercent: 4,
  });
});

test("market optimizer never uses test for selection and keeps live execution disabled", () => {
  const result = optimizeStockSwingMarket({
    market: "US_STOCK",
    datasets: [
      { symbol: "AAA", candles: breakoutSeries(600, 0) },
      { symbol: "BBB", candles: breakoutSeries(600, 10) },
      { symbol: "CCC", candles: breakoutSeries(600, 20) },
    ],
    costRatePerSide: 0.001,
    stressMultiplier: 1.5,
    grid: {
      breakoutLookback: [10, 20],
      maPeriod: [20, 40],
      atrStopMultiplier: [1.5, 2],
      rewardRisk: [1.5, 2],
      maxHoldBars: [5, 10],
      minRelativeVolume: [1.1, 1.4],
      maxGapPercent: [4],
    },
  });
  assert.equal(result.selectionContract.testUsedForSelection, false);
  assert.equal(result.selectionContract.nextBarOpenEntry, true);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.ok(["oos_candidate", "research_hold"].includes(result.status));
});
