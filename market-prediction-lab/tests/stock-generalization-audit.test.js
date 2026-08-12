import test from "node:test";
import assert from "node:assert/strict";
import { auditFrozenStockStrategy, buildRollingAuditWindows } from "../src/stock-generalization-audit.js";

function breakoutSeries(count = 900, seed = 0) {
  const rows = [];
  let close = 100 + seed;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 40;
    const impulse = cycle === 30 ? 3.2 : cycle < 30 ? 0.10 : -0.02;
    const open = close + (cycle === 31 ? 0.1 : 0);
    close = Math.max(5, open + impulse);
    rows.push({
      timestamp: Date.UTC(2018, 0, 1) + index * 86_400_000,
      open,
      high: Math.max(open, close) + 0.7,
      low: Math.min(open, close) - 0.7,
      close,
      volume: cycle === 30 ? 300 : 100 + ((index + seed) % 9),
    });
  }
  return rows;
}

const frozenParams = {
  breakoutLookback: 20,
  maPeriod: 20,
  atrPeriod: 14,
  atrStopMultiplier: 2,
  rewardRisk: 1.5,
  maxHoldBars: 15,
  relativeVolumePeriod: 20,
  minRelativeVolume: 1.2,
  maxGapPercent: 5,
};

test("rolling audit windows are chronological and cover the requested tail", () => {
  const windows = buildRollingAuditWindows({ windowCount: 5, startRatio: 0.2 });
  assert.equal(windows.length, 5);
  assert.equal(windows[0].startRatio, 0.2);
  assert.equal(windows.at(-1).endRatio, 1);
  for (let index = 1; index < windows.length; index += 1) {
    assert.ok(windows[index - 1].endRatio <= windows[index].startRatio + Number.EPSILON);
  }
});

test("frozen audit never retunes on holdout symbols and keeps live execution disabled", () => {
  const result = auditFrozenStockStrategy({
    market: "KR_STOCK",
    datasets: [
      { symbol: "AAA", candles: breakoutSeries(900, 1) },
      { symbol: "BBB", candles: breakoutSeries(900, 2) },
      { symbol: "CCC", candles: breakoutSeries(900, 3) },
      { symbol: "DDD", candles: breakoutSeries(900, 4) },
    ],
    params: frozenParams,
    costRatePerSide: 0.001,
    stressMultiplier: 1.5,
    windowCount: 5,
  });
  assert.equal(result.auditContract.frozenParams, true);
  assert.equal(result.auditContract.paramsRetunedOnHoldouts, false);
  assert.equal(result.auditContract.holdoutDataUsedForSelection, false);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.equal(result.symbols.length, 4);
  assert.equal(result.rolling.length, 5);
  assert.ok(["generalization_candidate", "research_hold"].includes(result.status));
});
