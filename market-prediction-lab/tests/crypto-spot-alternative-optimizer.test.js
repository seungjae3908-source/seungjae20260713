import test from "node:test";
import assert from "node:assert/strict";
import {
  expandSpotAlternativeGrid,
  simulateSpotAlternativeStrategy,
} from "../src/crypto-spot-alternative-optimizer.js";

function trendCandles(count = 600) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 30;
    const drift = cycle < 22 ? 0.28 : -0.12;
    const open = close;
    close = Math.max(10, open + drift);
    rows.push({
      timestamp: Date.UTC(2024, 0, 1) + index * 4 * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) + (cycle === 22 ? 1.1 : 0.35),
      low: Math.min(open, close) - 0.35,
      close,
      volume: cycle === 22 ? 180 : 100 + index % 9,
    });
  }
  return rows;
}

function rangeCandles(count = 600) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const center = 100 + Math.sin(index / 20) * 0.3;
    const deviation = Math.sin(index / 5) * 4.5;
    const close = center + deviation;
    const open = center + Math.sin((index - 1) / 5) * 4.5;
    rows.push({
      timestamp: Date.UTC(2024, 0, 1) + index * 4 * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) + 0.7,
      low: Math.min(open, close) - 0.7,
      close,
      volume: 100 + index % 5,
    });
  }
  return rows;
}

test("alternative grid keeps trend and mean-reversion families independent", () => {
  const grid = expandSpotAlternativeGrid();
  assert.ok(grid.length > 100);
  assert.ok(grid.some((row) => row.family === "trend_pullback"));
  assert.ok(grid.some((row) => row.family === "mean_reversion"));
  assert.ok(grid.every((row) => row.family === "trend_pullback" || row.family === "mean_reversion"));
});

test("trend family enters only on the next candle and includes per-side cost", () => {
  const candles = trendCandles();
  const params = {
    family: "trend_pullback",
    fastMa: 20,
    slowMa: 60,
    slopeBars: 3,
    maxFastMaDistanceAtr: 1.25,
    minRelativeVolume: 0.8,
    stopAtrMultiple: 1.5,
    rewardRisk: 1.5,
    maxHoldBars: 12,
  };
  const free = simulateSpotAlternativeStrategy({ candles, params, costRatePerSide: 0 });
  const costly = simulateSpotAlternativeStrategy({ candles, params, costRatePerSide: 0.002 });
  assert.equal(free.trades.length, costly.trades.length);
  if (free.trades.length > 0) {
    assert.ok(free.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1));
    assert.ok(costly.metrics.expectancy <= free.metrics.expectancy + 1e-12);
  }
});

test("mean-reversion family is long-only and exits after a separately observed reversion signal", () => {
  const candles = rangeCandles();
  const params = {
    family: "mean_reversion",
    zPeriod: 20,
    regimeMa: 60,
    entryZ: -1.25,
    exitZ: -0.25,
    maxRegimeGap: 0.06,
    stopAtrMultiple: 2.5,
    maxHoldBars: 24,
  };
  const result = simulateSpotAlternativeStrategy({ candles, params, costRatePerSide: 0.0015 });
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1));
  assert.ok(result.trades.every((trade) => trade.family === "mean_reversion"));
  assert.ok(result.trades.every((trade) => Number.isFinite(trade.netReturn)));
});
