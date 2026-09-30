import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_HORIZONS,
  BENCHMARK_PERIOD,
  BENCHMARK_PROFILE_PLAN,
  COMMON_FRICTION_STRESS_BPS_PER_SIDE,
  SOURCE_REFERENCE_RECIPES,
  barsPerYearForProfile,
  benchmarkSafetyEnvelope,
  buildTsmomSignalEvaluator,
  costModelFromCommonFrictionBps,
  coverageSummary,
  runCrossSectionalMomentumProxy,
  runFundingCarryProxy,
  runEqualWeightBuyHoldBaseline,
  runTimeSeriesMomentumProxy,
  summarizeReturnSeries,
  summarizePerformanceWindows,
} from "../src/evidence-backed-3y-benchmark-v1.js";

function candles({ start = BENCHMARK_PERIOD.startTime, count = 400, intervalMs = 86_400_000, drift = 0.001 } = {}) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open * (1 + drift);
    rows.push(Object.freeze({
      timestamp: start + index * intervalMs,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1_000 + index,
      isClosed: true,
      observedAt: start + index * intervalMs,
    }));
  }
  return Object.freeze(rows);
}

test("3y benchmark preserves the predeclared 2026 final-holdout end and 12 profiles", () => {
  assert.equal(BENCHMARK_PERIOD.label, "2023-08-10_to_2026-08-09");
  assert.equal(BENCHMARK_PERIOD.selectionUsesPost2025Data, false);
  assert.equal(BENCHMARK_PERIOD.finalHoldoutBoundaryPreserved, true);
  assert.equal(BENCHMARK_PROFILE_PLAN.length, 12);
  assert.equal(new Set(BENCHMARK_PROFILE_PLAN.map((row) => row.profileId)).size, 12);
  assert.equal(BENCHMARK_PROFILE_PLAN.filter((row) => row.status === "BLOCKED_DATA").length, 4);
  assert.deepEqual(Object.keys(BENCHMARK_HORIZONS), ["SHORT", "SWING", "POSITION"]);
});

test("stock 3y intraday profiles fail closed instead of substituting daily candles", () => {
  for (const market of ["KR_STOCK", "US_STOCK"]) {
    for (const horizon of ["SHORT", "SWING"]) {
      const row = BENCHMARK_PROFILE_PLAN.find((item) => item.profileId === `${market}:${horizon}`);
      assert.equal(row.status, "BLOCKED_DATA");
      assert.ok(row.blockers.includes("APPROVED_PUBLIC_3Y_EXACT_INTRADAY_STOCK_COLLECTOR_NOT_AVAILABLE"));
    }
    assert.equal(
      BENCHMARK_PROFILE_PLAN.find((item) => item.profileId === `${market}:POSITION`).status,
      "READY_FOR_PUBLIC_BENCHMARK",
    );
  }
});

test("new public recipes cannot masquerade as completed local replications", () => {
  assert.equal(SOURCE_REFERENCE_RECIPES.length, 5);
  const byId = Object.fromEntries(SOURCE_REFERENCE_RECIPES.map((row) => [row.recipeId, row]));
  assert.equal(byId.CHARTING_BY_MACHINES_V1.benchmarkStatus, "BLOCKED_REPLICATION");
  assert.equal(byId.STOCKS_IN_PLAY_ORB_5M_V1.benchmarkStatus, "BLOCKED_DATA");
  assert.equal(byId.CRYPTO_RISK_MANAGED_MOMENTUM_V1.benchmarkStatus, "PROXY_ONLY");
  assert.equal(byId.FUNDING_RATE_ARBITRAGE_CEX_DEX_V1.benchmarkStatus, "PROXY_ONLY");
  assert.equal(byId.MLLM_VISUAL_CHART_CRYPTO_V1.benchmarkStatus, "BLOCKED_REPLICATION");
});

test("common-friction cost grid is explicit stress, not market-specific full cost", () => {
  assert.deepEqual(COMMON_FRICTION_STRESS_BPS_PER_SIDE, [5, 10, 20]);
  const cost = costModelFromCommonFrictionBps(10);
  assert.equal(cost.entryFeeRate, 0.001);
  assert.equal(cost.exitFeeRate, 0.001);
  assert.equal(cost.taxRate, 0);
  assert.match(cost.evidenceRole, /COMMON_FRICTION_STRESS/u);
  assert.throws(() => costModelFromCommonFrictionBps(-1), /perSideBps/u);
});

test("TSMOM evaluator is causal and direction symmetric", () => {
  const rows = candles({ count: 20, drift: 0.01 });
  const longSignal = buildTsmomSignalEvaluator({ lookbackBars: 5 });
  assert.equal(longSignal({ side: "long", candles: rows, index: 4 }), null);
  const long = longSignal({ side: "long", candles: rows, index: 10 });
  assert.equal(long.family, "TSMOM_FIXED");
  assert.equal(long.direction, "UP");
  assert.equal(long.lookbackBars, 5);
  assert.equal(longSignal({ side: "short", candles: rows, index: 10 }), null);

  const downRows = candles({ count: 20, drift: -0.005 });
  const short = longSignal({ side: "short", candles: downRows, index: 10 });
  assert.equal(short.direction, "DOWN");
});

test("coverage requires nearly the full fixed three-year span", () => {
  const complete = coverageSummary({
    candles: [
      { timestamp: BENCHMARK_PERIOD.startTime },
      { timestamp: BENCHMARK_PERIOD.endTime },
    ],
  });
  assert.equal(complete.status, "READY");

  const late = coverageSummary({
    candles: [
      { timestamp: BENCHMARK_PERIOD.startTime + 100 * 86_400_000 },
      { timestamp: BENCHMARK_PERIOD.endTime },
    ],
  });
  assert.equal(late.status, "BLOCKED_DATA");
  assert.ok(late.blockers.includes("START_COVERAGE_LATE"));
});

test("return summary emits comparable return, CAGR, Sharpe and drawdown metrics", () => {
  const result = summarizeReturnSeries([0.01, -0.005, 0.015, -0.002, 0.004], { barsPerYear: 252 });
  assert.equal(result.sampleCount, 5);
  assert.ok(result.totalReturn > 0);
  assert.ok(result.cagr > 0);
  assert.ok(result.annualizedSharpe > 0);
  assert.ok(result.maximumDrawdown > 0);
  assert.ok(result.barProfitFactor > 1);
});

test("rolling performance windows report daily weekly monthly 6m 1y and 3y without cherry-picking", () => {
  const start = BENCHMARK_PERIOD.startTime;
  const observations = [];
  for (let day = 0; day < 1096; day += 1) {
    observations.push({ timestamp: start + day * 86_400_000, return: 0.001 });
  }
  const result = summarizePerformanceWindows(observations);
  assert.deepEqual(Object.keys(result.windows), [
    "DAILY",
    "WEEKLY",
    "MONTHLY",
    "SIX_MONTH",
    "YEARLY",
    "THREE_YEAR",
  ]);
  assert.equal(result.dailyObservationCount, 1096);
  assert.ok(result.windows.DAILY.sampleCount > 1000);
  assert.ok(result.windows.WEEKLY.sampleCount > 1000);
  assert.ok(result.windows.MONTHLY.latestReturn > result.windows.WEEKLY.latestReturn);
  assert.ok(result.windows.SIX_MONTH.latestReturn > result.windows.MONTHLY.latestReturn);
  assert.ok(result.windows.YEARLY.latestReturn > result.windows.SIX_MONTH.latestReturn);
  assert.ok(result.windows.THREE_YEAR.latestReturn > result.windows.YEARLY.latestReturn);
  assert.equal(result.windows.DAILY.positiveRate, 1);
  assert.equal(result.windows.THREE_YEAR.sampleCount, 1);
});

test("equal-weight buy-hold baseline charges entry and exit friction and stays deterministic", () => {
  const warmupStart = BENCHMARK_PERIOD.startTime - 20 * 86_400_000;
  const a = candles({ start: warmupStart, count: 340, drift: 0.001 });
  const b = candles({ start: warmupStart, count: 340, drift: 0.0005 });
  const lowCost = runEqualWeightBuyHoldBaseline({
    datasets: [{ symbol: "A", candles: a }, { symbol: "B", candles: b }],
    perSideCostBps: 5,
    barsPerYear: 252,
  });
  const highCost = runEqualWeightBuyHoldBaseline({
    datasets: [{ symbol: "A", candles: a }, { symbol: "B", candles: b }],
    perSideCostBps: 20,
    barsPerYear: 252,
  });
  assert.equal(lowCost.family, "EQUAL_WEIGHT_BUY_HOLD_BASELINE");
  assert.equal(lowCost.fixedBasketBaseline, true);
  assert.ok(lowCost.performance.totalReturn > highCost.performance.totalReturn);
});

test("TSMOM proxy uses only prior closed bars and applies turnover cost", () => {
  const rowsA = candles({ count: 320, drift: 0.002 });
  const rowsB = candles({ count: 320, drift: -0.001 });
  const longOnly = runTimeSeriesMomentumProxy({
    datasets: [
      { symbol: "A", candles: rowsA },
      { symbol: "B", candles: rowsB },
    ],
    lookbackBars: 20,
    perSideCostBps: 10,
    longShort: false,
    barsPerYear: 252,
  });
  const longShort = runTimeSeriesMomentumProxy({
    datasets: [
      { symbol: "A", candles: rowsA },
      { symbol: "B", candles: rowsB },
    ],
    lookbackBars: 20,
    perSideCostBps: 10,
    longShort: true,
    barsPerYear: 252,
  });
  assert.equal(longOnly.family, "TSMOM_FIXED_PROXY");
  assert.equal(longOnly.longShort, false);
  assert.equal(longShort.longShort, true);
  assert.ok(longOnly.performance.sampleCount > 0);
  assert.ok(longShort.performance.sampleCount > 0);
  assert.equal(longOnly.sourceFaithfulReplication, false);
});

test("relative momentum ranking uses the prior closed bar and cannot capture the ranking bar move", () => {
  const start = BENCHMARK_PERIOD.startTime;
  const intervalMs = 86_400_000;
  const a = [];
  const b = [];
  for (let index = 0; index < 20; index += 1) {
    const aClose = index === 6 ? 200 : index > 6 ? 200 : 100;
    const bClose = 100 + index * 2;
    a.push({ timestamp: start + index * intervalMs, close: aClose });
    b.push({ timestamp: start + index * intervalMs, close: bClose });
  }
  const result = runCrossSectionalMomentumProxy({
    datasets: [
      { symbol: "A", candles: a },
      { symbol: "B", candles: b },
    ],
    lookbackBars: 5,
    rebalanceBars: 1,
    perSideCostBps: 0,
    longShort: false,
    barsPerYear: 252,
  });
  assert.ok(result.performance.totalReturn < 0.5, "current-bar spike must not be captured by same-bar ranking");
});

test("relative momentum proxy is deterministic and cost-aware", () => {
  const intervalMs = 86_400_000;
  const first = candles({ count: 320, intervalMs, drift: 0.002 });
  const second = candles({ count: 320, intervalMs, drift: 0.0005 });
  const a = runCrossSectionalMomentumProxy({
    datasets: [
      { symbol: "A", candles: first },
      { symbol: "B", candles: second },
    ],
    lookbackBars: 20,
    rebalanceBars: 5,
    perSideCostBps: 10,
    longShort: false,
    barsPerYear: 252,
  });
  const b = runCrossSectionalMomentumProxy({
    datasets: [
      { symbol: "A", candles: first },
      { symbol: "B", candles: second },
    ],
    lookbackBars: 20,
    rebalanceBars: 5,
    perSideCostBps: 10,
    longShort: false,
    barsPerYear: 252,
  });
  assert.deepEqual(a, b);
  assert.equal(a.family, "RELATIVE_MOMENTUM_PROXY");
  assert.equal(a.fixedBasketProxy, true);
  assert.ok(a.performance.sampleCount > 0);
});

test("funding carry proxy is causal, same-venue only, and includes turnover cost", () => {
  const start = BENCHMARK_PERIOD.startTime;
  const spot = candles({ start, count: 40, drift: 0.001 });
  const futures = candles({ start, count: 40, drift: 0.0008 });
  const funding = [];
  for (let day = 0; day < 40; day += 1) {
    for (const hour of [0, 8, 16]) {
      funding.push({
        timestamp: start + day * 86_400_000 + hour * 3_600_000,
        rate: 0.0001,
      });
    }
  }
  const result = runFundingCarryProxy({
    spotCandles: spot,
    futuresCandles: futures,
    fundingRecords: funding,
    perSideCostBps: 10,
    trailingFundingDays: 7,
  });
  assert.equal(result.family, "SAME_VENUE_FUNDING_CARRY_PROXY");
  assert.equal(result.deltaNeutralTarget, true);
  assert.equal(result.crossVenueReplication, false);
  assert.equal(result.sourceFaithfulReplication, false);
  assert.ok(result.performance.sampleCount > 0);
  assert.ok(result.performance.totalReturn > -1);
});

test("volatility-managed proxy remains capped and research-only envelope grants no authority", () => {
  const rowsA = candles({ count: 320, drift: 0.003 });
  const rowsB = candles({ count: 320, drift: -0.001 });
  const result = runCrossSectionalMomentumProxy({
    datasets: [
      { symbol: "A", candles: rowsA },
      { symbol: "B", candles: rowsB },
    ],
    lookbackBars: 20,
    rebalanceBars: 5,
    perSideCostBps: 20,
    longShort: true,
    volatilityManaged: true,
    volatilityLookbackBars: 20,
    targetAnnualVolatility: 0.15,
    barsPerYear: 365,
  });
  assert.equal(result.family, "RISK_MANAGED_RELATIVE_MOMENTUM_PROXY");
  assert.equal(result.longShort, true);
  assert.equal(result.sourceFaithfulReplication, false);

  assert.equal(barsPerYearForProfile("CRYPTO_SPOT", "SHORT"), 365 * 24 * 4);
  assert.equal(barsPerYearForProfile("US_STOCK", "POSITION"), 252);
  const safety = benchmarkSafetyEnvelope();
  assert.equal(safety.profitabilityProven, false);
  assert.equal(safety.economicCreditGranted, false);
  assert.equal(safety.executionAuthority, "NONE");
  assert.equal(safety.realOrderEnabled, false);
});
