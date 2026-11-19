import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_BACKTEST_PERIOD,
  buildBacktestTable,
  buildYearRange,
  compareBacktestVersions,
  runV1Backtest,
  runV1UniverseBacktest,
} from "../src/multi-market-backtest-engine.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_PARAMETERS = Object.freeze({
  fastPeriod: 2,
  slowPeriod: 4,
  atrPeriod: 2,
  pullbackTolerancePct: 100,
  stopAtrMultiple: 1,
  targetRiskMultiple: 1,
});

function candles({
  symbol,
  startTime = Date.UTC(2024, 0, 1),
  count = 30,
  startPrice = 100,
  step = 1,
  intervalMs = DAY_MS,
}) {
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + step * index;
    const open = close - step * 0.25;
    const pad = Math.max(1.5, Math.abs(step) * 1.5);
    return Object.freeze({
      symbol,
      timestamp: startTime + index * intervalMs,
      observedAt: startTime + index * intervalMs,
      isClosed: true,
      open,
      high: Math.max(open, close) + pad,
      low: Math.min(open, close) - pad,
      close,
      volume: 1_000 + index,
    });
  });
}

function baseInput(overrides = {}) {
  const market = overrides.market ?? "US_STOCK";
  const symbol = overrides.symbol ?? "AAPL";
  return {
    market,
    symbol,
    side: overrides.side ?? "long",
    timeframe: "1d",
    initialCapital: 1_000_000,
    candles: overrides.candles ?? candles({ symbol }),
    parameters: TEST_PARAMETERS,
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
    costModel: {},
    period: {
      startTime: overrides.period?.startTime ?? Date.UTC(2024, 0, 1),
      endTime: overrides.period?.endTime ?? Date.UTC(2024, 11, 31, 23, 59, 59, 999),
      includeFinalHoldout: overrides.period?.includeFinalHoldout ?? false,
    },
    ...(overrides.extra ?? {}),
  };
}

test("V1 uses one million won by default, enters only after a closed signal candle, and never submits orders", () => {
  const input = baseInput({});
  delete input.initialCapital;
  const result = runV1Backtest(input);
  assert.equal(result.initialCapital, 1_000_000);
  assert.equal(result.mode, "backtest-only");
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.equal(result.safeguards.signalUsesClosedCandle, true);
  assert.equal(result.safeguards.entryUsesNextCandleOpen, true);
  assert.ok(result.totalTrades > 0);
  const timestamps = new Map(input.candles.map((row, index) => [row.timestamp, index]));
  for (const trade of result.trades) {
    assert.ok(trade.entryTime > trade.signalTime);
    assert.equal(timestamps.get(trade.entryTime), timestamps.get(trade.signalTime) + 1);
    assert.equal(trade.costsIncluded, true);
  }
});

test("cash markets are long-only while futures long and short are independently testable", () => {
  assert.throws(() => runV1Backtest(baseInput({ side: "short" })), (error) => error?.code === "CASH_SHORT_NOT_ALLOWED");

  const futuresSymbol = "BTCUSDT";
  const shortResult = runV1Backtest(baseInput({
    market: "CRYPTO_FUTURES",
    symbol: futuresSymbol,
    side: "short",
    candles: candles({ symbol: futuresSymbol, startPrice: 200, step: -2 }),
  }));
  assert.equal(shortResult.market, "CRYPTO_FUTURES");
  assert.equal(shortResult.side, "short");
  assert.ok(shortResult.totalTrades > 0);
  assert.ok(shortResult.trades.every((trade) => trade.action === "SHORT"));
});

test("fees, spread and slippage lower realized performance and success is based on net PnL", () => {
  const input = baseInput({});
  const free = runV1Backtest(input);
  const costly = runV1Backtest({
    ...input,
    costModel: {
      entryFeeRate: 0.002,
      exitFeeRate: 0.002,
      taxRate: 0.001,
      slippageRate: 0.002,
      spreadRate: 0.002,
      latencyBars: 1,
      latencyDriftRate: 0.001,
    },
  });
  assert.ok(costly.netPnl < free.netPnl);
  assert.ok(costly.totalExecutionCost > free.totalExecutionCost);
  assert.equal(costly.successRatePercent, costly.trades.filter((trade) => trade.netPnl > 0).length / costly.totalTrades * 100);
});

test("historical fee and tax schedules can change by timestamp without overlapping rows", () => {
  const input = baseInput({});
  const result = runV1Backtest({
    ...input,
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0.001,
      schedule: [
        { startTime: Date.UTC(2024, 0, 1), endTime: Date.UTC(2024, 5, 30, 23, 59, 59, 999), taxRate: 0.001 },
        { startTime: Date.UTC(2024, 6, 1), endTime: Date.UTC(2024, 11, 31, 23, 59, 59, 999), taxRate: 0.002 },
      ],
    },
  });
  assert.ok(result.totalTrades > 0);
  assert.ok(result.totalExecutionCost > 0);

  assert.throws(() => runV1Backtest({
    ...input,
    costModel: {
      schedule: [
        { startTime: Date.UTC(2024, 0, 1), endTime: Date.UTC(2024, 0, 20, 23, 59, 59, 999), taxRate: 0.001 },
        { startTime: Date.UTC(2024, 0, 3), endTime: Date.UTC(2024, 0, 25, 23, 59, 59, 999), taxRate: 0.002 },
      ],
    },
  }), (error) => error?.code === "OVERLAPPING_COST_SCHEDULE");
});

test("2026 final holdout is locked by default and only included with explicit unlock", () => {
  const symbol = "AAPL";
  const startTime = Date.UTC(2025, 11, 20);
  const rows = candles({ symbol, startTime, count: 40, startPrice: 100, step: 1 });
  const locked = runV1Backtest(baseInput({
    symbol,
    candles: rows,
    period: { startTime, endTime: Date.UTC(2026, 0, 28), includeFinalHoldout: false },
  }));
  assert.equal(locked.period.finalHoldoutLocked, true);
  assert.equal(locked.period.effectiveEndTime, RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime - 1);
  assert.ok(locked.trades.every((trade) => trade.exitTime < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime));

  const unlocked = runV1Backtest(baseInput({
    symbol,
    candles: rows,
    period: { startTime, endTime: Date.UTC(2026, 0, 28), includeFinalHoldout: true },
  }));
  assert.equal(unlocked.period.finalHoldoutLocked, false);
  assert.ok(unlocked.byYear.some((row) => row.year === 2026));
  assert.ok(unlocked.trades.some((trade) => trade.exitTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime));
});

test("universe runner treats one million won as total capital and splits it into equal sleeves", () => {
  const result = runV1UniverseBacktest({
    market: "US_STOCK",
    side: "long",
    timeframe: "1d",
    initialCapital: 1_000_000,
    datasets: [
      { symbol: "AAPL", candles: candles({ symbol: "AAPL", startPrice: 100, step: 1 }) },
      { symbol: "MSFT", candles: candles({ symbol: "MSFT", startPrice: 200, step: 2 }) },
    ],
    parameters: TEST_PARAMETERS,
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
    costModel: {},
    period: { startTime: Date.UTC(2024, 0, 1), endTime: Date.UTC(2024, 11, 31), includeFinalHoldout: false },
  });
  assert.equal(result.initialCapital, 1_000_000);
  assert.equal(result.sleeveCapital, 500_000);
  assert.equal(result.symbolResults.length, 2);
  assert.equal(result.symbolResults.reduce((sum, row) => sum + row.initialCapital, 0), 1_000_000);
  assert.equal(result.finalCapital, result.symbolResults.reduce((sum, row) => sum + row.finalCapital, 0));
  assert.equal(result.orderSubmitted, false);
});

test("version comparison never hides return and success-rate tradeoffs behind a weighted score", () => {
  const baseline = {
    market: "CRYPTO_SPOT",
    side: "long",
    initialCapital: 1_000_000,
    strategyVersion: "V1",
    totalReturnPercent: 20,
    successRatePercent: 55,
    maximumDrawdownPercent: 12,
    profitFactor: 1.4,
    totalTrades: 100,
  };
  const improved = compareBacktestVersions({
    baseline,
    candidate: { ...baseline, strategyVersion: "V2", totalReturnPercent: 24, successRatePercent: 57, maximumDrawdownPercent: 10, profitFactor: 1.5 },
  });
  assert.equal(improved.verdict, "adopt");
  assert.equal(improved.weightedScoreUsed, false);
  assert.equal(improved.returnDeltaPercentagePoints, 4);
  assert.equal(improved.successRateDeltaPercentagePoints, 2);

  const tradeoff = compareBacktestVersions({
    baseline,
    candidate: { ...baseline, strategyVersion: "V3", totalReturnPercent: 30, successRatePercent: 48, maximumDrawdownPercent: 12, profitFactor: 1.6 },
  });
  assert.equal(tradeoff.verdict, "tradeoff_review");
});

test("table and year helpers produce the requested easy-to-read research dimensions", () => {
  const result = runV1Backtest(baseInput({}));
  const table = buildBacktestTable([result]);
  assert.deepEqual(Object.keys(table[0]), [
    "market",
    "side",
    "version",
    "initialCapital",
    "finalCapital",
    "netReturnPercent",
    "successRatePercent",
    "profitFactor",
    "maximumDrawdownPercent",
    "trades",
  ]);
  assert.equal(table[0].initialCapital, 1_000_000);

  const years = buildYearRange();
  assert.deepEqual(years.map((row) => row.year), [2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.equal(years[0].startTime, Date.UTC(2020, 0, 1));
  assert.equal(years.at(-1).endTime, RESEARCH_BACKTEST_PERIOD.defaultEndTime);
});
