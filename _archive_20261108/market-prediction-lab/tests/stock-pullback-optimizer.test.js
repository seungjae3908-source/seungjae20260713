import test from "node:test";
import assert from "node:assert/strict";
import { optimizeUsStockPullback, simulateStockPullbackStrategy } from "../src/stock-pullback-optimizer.js";

function pullbackSeries(count = 900, seed = 0) {
  const rows = [];
  let close = 100 + seed;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 30;
    let move = 0.16;
    if (cycle >= 20 && cycle <= 23) move = -0.9;
    if (cycle === 24) move = 0.7;
    if (cycle === 25) move = 1.0;
    const open = close - (cycle === 24 ? 0.2 : 0);
    close = Math.max(5, open + move);
    rows.push({
      timestamp: Date.UTC(2018, 0, 1) + index * 86_400_000,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: cycle === 24 ? 145 : 100 + ((index + seed) % 8),
    });
  }
  return rows;
}

const params = {
  trendMaPeriod: 50,
  slopeLookback: 5,
  pullbackLookback: 10,
  minPullbackAtr: 0.5,
  maxPullbackAtr: 2.5,
  atrStopMultiplier: 1.5,
  rewardRisk: 1.5,
  maxHoldBars: 10,
  minRelativeVolume: 0.8,
  maxGapPercent: 4,
};

test("pullback strategy remains next-bar and cost aware", () => {
  const candles = pullbackSeries();
  const free = simulateStockPullbackStrategy({ candles, params, costRatePerSide: 0 });
  const costly = simulateStockPullbackStrategy({ candles, params, costRatePerSide: 0.002 });
  if (free.trades.length > 0 && costly.trades.length > 0) {
    assert.equal(free.trades[0].entryIndex, free.trades[0].signalIndex + 1);
    assert.ok(costly.metrics.expectancy <= free.metrics.expectancy);
  }
});

test("US pullback optimizer keeps seed and holdout symbols separate and never promotes live execution", () => {
  const result = optimizeUsStockPullback({
    seedDatasets: [
      { symbol: "AAA", candles: pullbackSeries(900, 1) },
      { symbol: "BBB", candles: pullbackSeries(900, 2) },
      { symbol: "CCC", candles: pullbackSeries(900, 3) },
    ],
    holdoutDatasets: [
      { symbol: "DDD", candles: pullbackSeries(900, 4) },
      { symbol: "EEE", candles: pullbackSeries(900, 5) },
      { symbol: "FFF", candles: pullbackSeries(900, 6) },
    ],
    costRatePerSide: 0.001,
    stressMultiplier: 1.5,
    grid: {
      trendMaPeriod: [50],
      pullbackLookback: [5, 10],
      maxPullbackAtr: [1.5, 2.5],
      atrStopMultiplier: [1.5],
      rewardRisk: [1.5],
      maxHoldBars: [5, 10],
      minRelativeVolume: [0.8, 1],
      maxGapPercent: [4],
    },
  });
  assert.equal(result.selectionContract.testUsedForSelection, false);
  assert.equal(result.selectionContract.holdoutSymbolsUsedForSelection, false);
  assert.deepEqual(result.selectionContract.seedSymbols, ["AAA", "BBB", "CCC"]);
  assert.deepEqual(result.selectionContract.holdoutSymbols, ["DDD", "EEE", "FFF"]);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.ok(["cross_symbol_research_candidate", "research_hold"].includes(result.status));
});
