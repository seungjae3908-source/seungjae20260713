import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKrMomentumSegments,
  expandKrMomentumGrid,
  optimizeKrCrossSectionalMomentum,
  simulateKrCrossSectionalMomentum,
} from "../src/kr-cross-sectional-momentum.js";

const DAY = 24 * 60 * 60 * 1000;

function dataset(symbol, drift, count = 900) {
  const candles = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = Math.sin(index / 17) * 0.12;
    const open = close;
    close = Math.max(10, open * (1 + drift + cycle / 100));
    candles.push({
      timestamp: Date.UTC(2020, 0, 1) + index * DAY,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1_000_000 + index * 100,
    });
  }
  return { symbol, candles };
}

function universe(prefix, drifts) {
  return drifts.map((drift, index) => dataset(`${prefix}${String(index + 1).padStart(2, "0")}`, drift));
}

test("KR momentum grid is bounded and does not hide metrics behind a weighted score", () => {
  const grid = expandKrMomentumGrid();
  assert.equal(grid.length, 48);
  assert.ok(grid.every((row) => [60, 120, 180].includes(row.momentumLookback)));
  assert.ok(grid.every((row) => [100, 200].includes(row.trendMaPeriod)));
});

test("cross-sectional signals use only closed ranking data and enter at the next session open", () => {
  const datasets = universe("10", [0.0012, 0.0010, 0.0008, 0.0006, 0.0004, 0.0002]);
  const params = { momentumLookback: 60, trendMaPeriod: 100, topCount: 2, rebalanceBars: 20, stopAtrMultiple: 8 };
  const free = simulateKrCrossSectionalMomentum({ datasets, params, costRatePerSide: 0 });
  const costly = simulateKrCrossSectionalMomentum({ datasets, params, costRatePerSide: 0.0025 });
  assert.ok(free.trades.length > 10);
  assert.equal(free.trades.length, costly.trades.length);
  assert.ok(free.trades.every((trade) => trade.entryTimestamp > trade.signalTimestamp));
  assert.ok(costly.metrics.netReturn < free.metrics.netReturn);
  assert.ok(free.metrics.selectedSymbolCount <= 2);
});

test("temporal segments are ordered and optimizer never selects on design test or unseen holdout", () => {
  const designDatasets = universe("20", [0.0013, 0.0011, 0.0009, 0.0007, 0.0005, 0.0003]);
  const holdoutDatasets = universe("30", [0.00125, 0.00105, 0.00085, 0.00065, 0.00045, 0.00025]);
  const segments = buildKrMomentumSegments(900);
  assert.ok(segments.train.endIndex < segments.validation.startIndex);
  assert.ok(segments.validation.endIndex < segments.test.startIndex);
  const result = optimizeKrCrossSectionalMomentum({
    designDatasets,
    holdoutDatasets,
    grid: {
      momentumLookback: [60],
      trendMaPeriod: [100],
      topCount: [2],
      rebalanceBars: [20],
      stopAtrMultiple: [3.5],
    },
  });
  assert.equal(result.selectionContract.scalarWeightedScoreUsed, false);
  assert.equal(result.selectionContract.designTestUsedForSelection, false);
  assert.equal(result.selectionContract.holdoutUsedForSelection, false);
  assert.equal(result.selectionContract.parametersRetunedOnHoldout, false);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.safeguards.actualOrders, 0);
});

test("design and holdout overlap is rejected", () => {
  const designDatasets = universe("40", [0.0012, 0.0010, 0.0008, 0.0006]);
  const holdoutDatasets = [designDatasets[0], ...universe("50", [0.0011, 0.0009, 0.0007])];
  assert.throws(() => optimizeKrCrossSectionalMomentum({
    designDatasets,
    holdoutDatasets,
    grid: { momentumLookback: [60], trendMaPeriod: [100], topCount: [2], rebalanceBars: [20], stopAtrMultiple: [3.5] },
  }), /must not overlap/);
});
