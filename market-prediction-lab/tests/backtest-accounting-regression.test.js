import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateExecutionAwareTrade,
  summarizeResearchPerformance,
} from "../src/research-validation-layer.js";

function segmentedTrade(netPnl, netReturnOnMargin) {
  return {
    netPnl,
    netReturnOnMargin,
    entryNotional: 1_000,
    market: "KR_STOCK",
    strategy: "drawdown-regression",
    timeframe: "1h",
    regime: "mixed",
  };
}

test("maximum drawdown percent stays bound to the peak that produced the drawdown", () => {
  const summary = summarizeResearchPerformance([
    segmentedTrade(100, 0.10),
    segmentedTrade(-220, -0.20),
    segmentedTrade(1_120, 1.00),
  ], { initialCapital: 1_000 });

  assert.equal(summary.overall.finalCapital, 2_000);
  assert.equal(summary.overall.maximumDrawdown, 220);
  assert.ok(Math.abs(summary.overall.maximumDrawdownPercent - 0.20) < 1e-12);
});

test("execution-aware PnL reconciles requested gross PnL to every modeled execution cost", () => {
  const result = calculateExecutionAwareTrade({
    market: "KR_STOCK",
    action: "BUY",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    leverage: 1,
    entryFeeRate: 0.001,
    exitFeeRate: 0.001,
    taxRate: 0.002,
    slippageRate: 0.001,
    spreadRate: 0.002,
    latencyBars: 2,
    latencyDriftRate: 0.001,
  });

  const reconciledNetPnl = result.preExecutionGrossPnl - result.costs.total;
  assert.ok(Math.abs(reconciledNetPnl - result.netPnl) < 1e-9);
  assert.ok(result.costs.spread > 0);
  assert.ok(result.costs.latency > 0);
  assert.ok(result.costs.slippage > 0);
});
