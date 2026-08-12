import test from "node:test";
import assert from "node:assert/strict";

import { calculateV1Signal, runV1Backtest } from "../src/multi-market-backtest-engine.js";
import { runIndependentSignalBacktest } from "../src/independent-strategy-backtest.js";

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function atrSeries(candles, period) {
  const result = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const trueRanges = new Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    trueRanges[index] = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (index >= period) {
      const window = trueRanges.slice(index - period + 1, index + 1);
      if (window.every(Number.isFinite)) result[index] = mean(window);
    }
  }
  return result;
}

function buildIndicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  });
}

function buildTrendCandles({ direction = 1, count = 360 } = {}) {
  const start = Date.UTC(2024, 0, 1);
  const step = 15 * 60 * 1000;
  let anchor = direction > 0 ? 100 : 220;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    anchor += direction * 0.16;
    const phase = index % 24;
    let close = anchor;
    if (phase === 19) close -= direction * 1.8;
    if (phase === 20) close += direction * 0.8;
    const previousClose = rows.at(-1)?.close ?? close;
    const open = previousClose + direction * 0.03;
    const high = Math.max(open, close) + 0.7;
    const low = Math.min(open, close) - 0.7;
    rows.push(Object.freeze({
      timestamp: start + index * step,
      isClosed: true,
      open,
      high,
      low,
      close,
      volume: 1000 + (index % 11) * 25,
    }));
  }
  return Object.freeze(rows);
}

const PARAMETERS = Object.freeze({
  fastPeriod: 5,
  slowPeriod: 15,
  atrPeriod: 5,
  pullbackTolerancePct: 1,
  stopAtrMultiple: 1,
  targetRiskMultiple: 1.5,
});

function periodFor(candles) {
  return Object.freeze({
    startTime: candles[30].timestamp,
    endTime: candles.at(-1).timestamp,
    includeFinalHoldout: false,
  });
}

function economicTrade(trade) {
  return {
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice,
    requestedExitPrice: trade.requestedExitPrice,
    stopPrice: trade.stopPrice,
    targetPrice: trade.targetPrice,
    quantity: trade.quantity,
    leverage: trade.leverage,
    riskBudget: trade.riskBudget,
    exitReason: trade.exitReason,
    netPnl: trade.netPnl,
    grossPnl: trade.grossPnl,
    netReturnOnMargin: trade.netReturnOnMargin,
    entryNotional: trade.entryNotional,
    costs: trade.costs,
    execution: trade.execution,
    maximumFavorableExcursion: trade.maximumFavorableExcursion,
    maximumAdverseExcursion: trade.maximumAdverseExcursion,
    equityBefore: trade.equityBefore,
    equityAfter: trade.equityAfter,
  };
}

function runPair({ market, side, symbol, candles, riskModel, costModel, fundingRates = [] }) {
  const period = periodFor(candles);
  const backtestInput = {
    market,
    side,
    symbol,
    timeframe: "15m",
    candles,
    initialCapital: 1_000_000,
    riskModel,
    costModel,
    fundingRates,
  };
  const baseline = runV1Backtest({ ...backtestInput, parameters: PARAMETERS, period });
  const eligibleCandles = [...candles].filter((candle) => candle.timestamp <= period.endTime).sort((left, right) => left.timestamp - right.timestamp);
  const indicators = buildIndicators(eligibleCandles, PARAMETERS);
  const onePass = runIndependentSignalBacktest({
    backtestInput,
    strategy: "v1_equivalence_probe",
    strategyVersion: "V1_EQ",
    parameters: PARAMETERS,
    period,
    signalEvaluator: ({ market: signalMarket, side: signalSide, candles: signalCandles, index }) => (
      calculateV1Signal({
        market: signalMarket,
        side: signalSide,
        candles: signalCandles,
        indicators,
        index,
        parameters: PARAMETERS,
      })
        ? Object.freeze({ v1Signal: true, equivalenceProbe: true })
        : null
    ),
  });
  return { baseline, onePass };
}

function assertEconomicEquivalence({ baseline, onePass }) {
  assert.ok(baseline.totalTrades > 0, "fixture must produce at least one V1 trade");
  assert.equal(onePass.totalTrades, baseline.totalTrades);
  assert.equal(onePass.finalCapital, baseline.finalCapital);
  assert.equal(onePass.totalReturnPercent, baseline.totalReturnPercent);
  assert.equal(onePass.successRatePercent, baseline.successRatePercent);
  assert.equal(onePass.profitFactor, baseline.profitFactor);
  assert.equal(onePass.maximumDrawdownPercent, baseline.maximumDrawdownPercent);
  assert.equal(onePass.expectancy, baseline.expectancy);
  assert.deepEqual(onePass.trades.map(economicTrade), baseline.trades.map(economicTrade));
  assert.equal(onePass.safeguards.executionUsesSharedCalculateExecutionAwareTrade, true);
  assert.equal(onePass.safeguards.orderSubmitted, false);
  assert.equal(onePass.safeguards.privateAccountRequestAllowed, false);
}

test("one-pass independent engine is economically equivalent to V1 for spot long with execution costs", () => {
  const candles = buildTrendCandles({ direction: 1 });
  const result = runPair({
    market: "CRYPTO_SPOT",
    side: "long",
    symbol: "USDT-BTC",
    candles,
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 0.8, leverage: 1, quantityStep: 0.0001 },
    costModel: {
      entryFeeRate: 0.0004,
      exitFeeRate: 0.0004,
      slippageRate: 0.0002,
      spreadRate: 0.0001,
      latencyBars: 1,
      latencyDriftRate: 0.00005,
    },
  });
  assertEconomicEquivalence(result);
});

test("one-pass independent engine is economically equivalent to V1 for futures short with funding", () => {
  const candles = buildTrendCandles({ direction: -1 });
  const fundingRates = candles
    .filter((_, index) => index > 30 && index % 16 === 0)
    .map((candle, index) => Object.freeze({ timestamp: candle.timestamp, rate: index % 2 === 0 ? 0.0001 : -0.00005 }));
  const result = runPair({
    market: "CRYPTO_FUTURES",
    side: "short",
    symbol: "BTCUSDT",
    candles,
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 0.7, leverage: 3, quantityStep: 0.001 },
    costModel: {
      entryFeeRate: 0.0004,
      exitFeeRate: 0.0004,
      slippageRate: 0.00025,
      spreadRate: 0.00015,
      latencyBars: 1,
      latencyDriftRate: 0.00005,
    },
    fundingRates,
  });
  assertEconomicEquivalence(result);
});
