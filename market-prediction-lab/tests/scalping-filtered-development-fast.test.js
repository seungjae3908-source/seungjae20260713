import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { runFastFilteredDevelopment } from "../src/scalping-filtered-development-fast.js";
import { runV3FilteredBacktest } from "../src/v3-market-filter-optimizer.js";
import { runV4FilteredBacktest } from "../src/v4-momentum-regime-optimizer.js";
import { runV5FilteredBacktest } from "../src/v5-price-structure-optimizer.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function buildCandles(count = 900) {
  const rows = [];
  let previousClose = 100;
  for (let index = 0; index < count; index += 1) {
    const trend = index * 0.025;
    const wave = Math.sin(index / 4) * 1.8 + Math.sin(index / 17) * 0.8;
    const close = 100 + trend + wave;
    const open = previousClose;
    const high = Math.max(open, close) + 0.7 + Math.abs(Math.sin(index / 5)) * 0.3;
    const low = Math.min(open, close) - 0.7 - Math.abs(Math.cos(index / 6)) * 0.3;
    rows.push(Object.freeze({
      timestamp: RESEARCH_BACKTEST_PERIOD.startTime + index * FIFTEEN_MINUTES_MS,
      open,
      high,
      low,
      close,
      volume: 1000 + (index % 13) * 37 + Math.round(Math.abs(Math.sin(index / 3)) * 250),
      isClosed: true,
    }));
    previousClose = close;
  }
  return Object.freeze(rows);
}

const parameters = Object.freeze({
  fastPeriod: 8,
  slowPeriod: 21,
  atrPeriod: 7,
  pullbackTolerancePct: 4,
  stopAtrMultiple: 1.25,
  targetRiskMultiple: 1.5,
});

const period = Object.freeze({
  startTime: RESEARCH_BACKTEST_PERIOD.startTime,
  endTime: RESEARCH_BACKTEST_PERIOD.startTime + 899 * FIFTEEN_MINUTES_MS,
  includeFinalHoldout: false,
});

const backtestInput = Object.freeze({
  market: "CRYPTO_SPOT",
  symbol: "USDT-BTC",
  side: "long",
  timeframe: "15m",
  initialCapital: 1_000_000,
  candles: buildCandles(),
  fundingRates: Object.freeze([]),
  riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1, quantityStep: null }),
  costModel: Object.freeze({ entryFeeRate: 0.0004, exitFeeRate: 0.0004, taxRate: 0, slippageRate: 0.0002, spreadRate: 0.0001, latencyBars: 0, latencyDriftRate: 0, schedule: Object.freeze([]) }),
});

function comparable(result) {
  return {
    totalTrades: result.totalTrades,
    totalReturnPercent: result.totalReturnPercent,
    successRatePercent: result.successRatePercent,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    expectancy: result.expectancy,
    finalCapital: result.finalCapital,
    trades: result.trades.map((trade) => ({
      signalTime: trade.signalTime,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      exitReason: trade.exitReason,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      targetPrice: trade.targetPrice,
      quantity: trade.quantity,
      netPnl: trade.netPnl,
      equityBefore: trade.equityBefore,
      equityAfter: trade.equityAfter,
    })),
  };
}

const cases = [
  ["V3", runV3FilteredBacktest, Object.freeze({ rvolMin: 0.5, volumeExpansionMin: 0.5, trendStrengthMin: 0.01 })],
  ["V4", runV4FilteredBacktest, Object.freeze({ requireRegimeAlignment: false, emaSlopeAtrMin: 0, rsiDirectionalThreshold: 50, macdMode: "directional" })],
  ["V5", runV5FilteredBacktest, Object.freeze({ structureLookback: 5, breakoutRecencyBars: 10, retestToleranceAtr: 3, atrPctMin: 0 })],
];

for (const [version, referenceRunner, filter] of cases) {
  test(`${version} fast development path is trade-for-trade equivalent to the reference filtered backtest`, () => {
    const reference = referenceRunner({ backtestInput, parameters, filter, period });
    const fast = runFastFilteredDevelopment({ version, backtestInput, parameters, filter, period });
    assert.deepEqual(comparable(fast), comparable(reference));
    assert.equal(fast.safeguards.singlePassDevelopmentSearch, true);
    assert.equal(fast.safeguards.finalHoldoutUsedForSelection, false);
    assert.equal(fast.safeguards.orderSubmitted, false);
    assert.equal(fast.safeguards.privateAccountRequestAllowed, false);
  });
}
