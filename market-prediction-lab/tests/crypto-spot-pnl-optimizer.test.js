import test from "node:test";
import assert from "node:assert/strict";
import { optimizeCryptoSpotPnl } from "../src/crypto-spot-pnl-optimizer.js";

function series(count = 1100, seed = 0) {
  const rows = [];
  let close = 100 + seed;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 48;
    const impulse = cycle === 36 ? 3.5 : cycle < 36 ? 0.06 : -0.02;
    const open = close + (cycle === 37 ? 0.08 : 0);
    close = Math.max(5, open + impulse);
    rows.push({
      timestamp: Date.UTC(2023, 0, 1) + index * 4 * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: cycle === 36 ? 320 : 110 + ((index + seed) % 11),
    });
  }
  return rows;
}

test("spot optimizer is long-only research and never selects on test", () => {
  const result = optimizeCryptoSpotPnl({
    datasets: [
      { symbol: "BTC", candles: series(1100, 0) },
      { symbol: "ETH", candles: series(1100, 10) },
    ],
    costRatePerSide: 0.001,
    stressMultiplier: 1.5,
    grid: {
      breakoutLookback: [12, 24],
      maPeriod: [24],
      atrStopMultiplier: [1.5, 2],
      rewardRisk: [1.5],
      maxHoldBars: [6, 12],
      minRelativeVolume: [1, 1.2],
      maxGapPercent: [2],
    },
  });
  assert.equal(result.market, "CRYPTO_SPOT");
  assert.equal(result.exchange, "UPBIT");
  assert.equal(result.longOnly, true);
  assert.equal(result.selectionContract.testUsedForSelection, false);
  assert.equal(result.selectionContract.nextBarOpenEntry, true);
  assert.equal(result.selectionContract.bothSymbolsMustBePositive, true);
  assert.equal(result.liveExecutionAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.ok(["oos_candidate", "research_hold"].includes(result.status));
});
