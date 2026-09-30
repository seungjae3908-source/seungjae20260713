import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_HORIZONS_V1,
  PUBLIC_REFERENCE_REPLICATION_READINESS_V1,
  buildPublicStrategyBenchmarkPlanV1,
  simulateRelativeMomentumProxyV1,
  simulateTimeSeriesMomentumProxyV1,
} from "../src/public-strategy-benchmark-v1.js";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2024, 0, 1);

function candles({ count = 800, start = START, step = HOUR, initial = 100, drift = 0.0008, volume = 1000 } = {}) {
  const rows = [];
  let close = initial;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open * (1 + drift);
    rows.push(Object.freeze({
      timestamp: start + index * step,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume,
    }));
  }
  return Object.freeze(rows);
}

test("benchmark plan exposes exactly 12 market-horizon profiles and keeps source recipes fail-closed", () => {
  const plan = buildPublicStrategyBenchmarkPlanV1();
  assert.equal(plan.profileCount, 12);
  assert.equal(new Set(plan.profiles.map((row) => row.profileId)).size, 12);
  assert.equal(plan.safety.profitabilityProven, false);
  assert.equal(plan.safety.winnerDeclared, false);
  assert.equal(plan.safety.executionAuthority, "NONE");

  const blockedReferences = PUBLIC_REFERENCE_REPLICATION_READINESS_V1.filter((row) => row.status === "BLOCKED_DATA");
  assert.equal(blockedReferences.length, 5);
  for (const row of blockedReferences) {
    assert.equal(row.executableProxyAllowed, false);
    assert.ok(row.blocker);
  }

  for (const profile of plan.profiles.filter((row) => ["KR_STOCK", "US_STOCK"].includes(row.market) && row.horizon !== "POSITION")) {
    assert.equal(profile.dataStatus, "BLOCKED_DATA");
    assert.equal(profile.executableStrategies.length, 0);
  }
});

test("cash-market TSMOM proxy uses positive momentum only and 1.5x costs cannot improve the same path", () => {
  const series = candles({ drift: 0.001 });
  const base = simulateTimeSeriesMomentumProxyV1({
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    horizon: "SWING",
    candles: series,
    costMultiplier: 1,
  });
  const stress = simulateTimeSeriesMomentumProxyV1({
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    horizon: "SWING",
    candles: series,
    costMultiplier: 1.5,
  });
  assert.equal(base.status, "EXECUTED_PROXY");
  assert.ok(base.performance.sampleCount > 0);
  assert.ok(base.performance.totalReturnPercent > 0);
  assert.ok(stress.performance.totalReturnPercent <= base.performance.totalReturnPercent + 1e-9);
  assert.equal(base.safeguards.nextBarOpenExecution, true);
  assert.equal(base.safeguards.fixedParametersNoOosRetuning, true);
  assert.equal(base.safeguards.economicCreditAllowed, false);
});

test("futures TSMOM proxy can take a SHORT on negative momentum without granting execution authority", () => {
  const series = candles({ drift: -0.001 });
  const result = simulateTimeSeriesMomentumProxyV1({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    horizon: "SWING",
    candles: series,
    fundingRates: [],
  });
  assert.equal(result.status, "EXECUTED_PROXY");
  assert.ok(result.performance.sampleCount > 0);
  assert.ok(result.trades.every((trade) => trade.action === "SHORT"));
  assert.equal(result.safeguards.executionAuthority, "NONE");
});

test("relative momentum proxy selects the stronger asset from point-in-time aligned histories", () => {
  const strong = candles({ drift: 0.0012 });
  const weak = candles({ drift: 0.00005 });
  const result = simulateRelativeMomentumProxyV1({
    market: "CRYPTO_SPOT",
    horizon: "SWING",
    datasets: [
      { symbol: "BTCUSDT", candles: strong },
      { symbol: "ETHUSDT", candles: weak },
    ],
  });
  assert.equal(result.status, "EXECUTED_PROXY");
  assert.ok(result.performance.sampleCount > 0);
  assert.ok(result.trades.every((trade) => trade.symbol === "BTCUSDT"));
  assert.equal(result.safeguards.sourceFaithfulReplication, false);
  assert.equal(result.safeguards.survivorshipAndPITUniverseCreditAllowed, false);
});

test("insufficient history is blocked instead of fabricating a zero-return result", () => {
  const required = BENCHMARK_HORIZONS_V1.POSITION.lookbackBars + 5;
  const result = simulateTimeSeriesMomentumProxyV1({
    market: "US_STOCK",
    symbol: "AAPL",
    horizon: "POSITION",
    candles: candles({ count: required, step: 24 * HOUR, drift: 0.001 }),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "INSUFFICIENT_CANDLES_FOR_FIXED_PROXY");
});
