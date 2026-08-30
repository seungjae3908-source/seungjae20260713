import test from 'node:test';
import assert from 'node:assert/strict';
import './scanner-adaptive-threshold-arena.smoke.test';
import './forward-recommendation-observer.service.test';
import {
  calculatePositionBacktestMetrics,
  calculateScalpingBacktestMetrics,
  calculateSwingBacktestMetrics,
  type ScannerBacktestTrade,
} from './scanner-backtest-metrics.service';

const trades: ScannerBacktestTrade[] = [
  { returnPercent: 1.2, holdingMinutes: 8, maePercent: -0.4, mfePercent: 1.5, slippageBps: 4 },
  { returnPercent: -0.6, holdingMinutes: 12, maePercent: -0.8, mfePercent: 0.3, slippageBps: 7 },
  { returnPercent: 2.1, holdingMinutes: 240, maePercent: -0.7, mfePercent: 2.8, slippageBps: 5 },
];

const positionTrades: ScannerBacktestTrade[] = [
  { returnPercent: 12, holdingMinutes: 7 * 24 * 60, maePercent: -4, mfePercent: 15 },
  { returnPercent: -5, holdingMinutes: 30 * 24 * 60, maePercent: -7, mfePercent: 2 },
  { returnPercent: 8, holdingMinutes: 14 * 24 * 60, maePercent: -3, mfePercent: 11 },
];

test('scalping metrics retain execution-oriented and profitability fields', () => {
  const result = calculateScalpingBacktestMetrics(trades);
  assert.equal(result.strategy, 'scalping');
  assert.equal(result.trades, 3);
  assert.equal(result.medianHoldingMinutes, 12);
  assert.equal(result.averageWinPercent, 1.65);
  assert.equal(result.averageLossPercent, -0.6);
  assert.ok(result.averageSlippageBps != null);
  assert.ok(result.maxAdverseExcursionPercent != null);
  assert.ok(result.maxDrawdownPercent != null && result.maxDrawdownPercent < 0);
  assert.ok(result.tradeSharpe != null && Number.isFinite(result.tradeSharpe));
  assert.ok(result.netReturnPercent > 0);
  assert.equal('medianHoldingHours' in result, false);
});

test('swing metrics retain holding, downside and risk-adjusted fields without scalping slippage contract', () => {
  const result = calculateSwingBacktestMetrics(trades);
  assert.equal(result.strategy, 'swing');
  assert.equal(result.trades, 3);
  assert.equal(result.medianHoldingHours, 0.2);
  assert.equal(result.averageWinPercent, 1.65);
  assert.equal(result.averageLossPercent, -0.6);
  assert.ok(result.averageMfePercent != null);
  assert.ok(result.averageMaePercent != null);
  assert.ok(result.maxDrawdownPercent != null && result.maxDrawdownPercent < 0);
  assert.ok(result.tradeSharpe != null);
  assert.equal('averageSlippageBps' in result, false);
});

test('position metrics retain one complete eligible trade universe and disclose cost authority', () => {
  const result = calculatePositionBacktestMetrics(positionTrades);
  assert.equal(result.strategy, 'position');
  assert.equal(result.inputTrades, 3);
  assert.equal(result.trades, 3);
  assert.equal(result.excludedTrades, 0);
  assert.equal(result.sampleComplete, true);
  assert.equal(result.medianHoldingDays, 14);
  assert.equal(result.averageWinPercent, 10);
  assert.equal(result.averageLossPercent, -5);
  assert.equal(result.averageMfePercent, 28 / 3);
  assert.equal(result.averageMaePercent, -14 / 3);
  assert.ok(result.expectancyPercent != null && result.expectancyPercent > 0);
  assert.ok(result.profitFactor != null && result.profitFactor > 1);
  assert.ok(result.maxDrawdownPercent != null && result.maxDrawdownPercent < 0);
  assert.ok(result.tradeSharpe != null && Number.isFinite(result.tradeSharpe));
  assert.ok(result.netReturnPercent != null && result.netReturnPercent > 0);
  assert.equal(result.returnCostBasis, 'UNVERIFIED_UPSTREAM_RETURN');
  assert.equal(result.fullCostAdjusted, false);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal('medianHoldingHours' in result, false);
  assert.equal('averageSlippageBps' in result, false);
});

test('position no-trade result does not fabricate neutral profitability metrics', () => {
  const result = calculatePositionBacktestMetrics([]);
  assert.equal(result.inputTrades, 0);
  assert.equal(result.trades, 0);
  assert.equal(result.excludedTrades, 0);
  assert.equal(result.sampleComplete, true);
  assert.equal(result.winRate, null);
  assert.equal(result.expectancyPercent, null);
  assert.equal(result.profitFactor, null);
  assert.equal(result.averageWinPercent, null);
  assert.equal(result.averageLossPercent, null);
  assert.equal(result.maxDrawdownPercent, null);
  assert.equal(result.tradeSharpe, null);
  assert.equal(result.netReturnPercent, null);
  assert.equal(result.medianHoldingDays, null);
  assert.equal(result.averageMaePercent, null);
  assert.equal(result.averageMfePercent, null);
  assert.equal(result.profitabilityClaimAllowed, false);
});

test('position all-winner result keeps undefined profit-factor denominator null instead of Infinity', () => {
  const result = calculatePositionBacktestMetrics([
    { returnPercent: 4, holdingMinutes: 2 * 24 * 60, maePercent: -1, mfePercent: 5 },
    { returnPercent: 8, holdingMinutes: 6 * 24 * 60, maePercent: -2, mfePercent: 10 },
  ]);
  assert.equal(result.winRate, 100);
  assert.equal(result.profitFactor, null);
  assert.equal(result.averageLossPercent, null);
  assert.equal(result.averageWinPercent, 6);
  assert.ok(result.netReturnPercent != null && Number.isFinite(result.netReturnPercent));
});

test('position all-loser result measures zero profit factor without inventing winners', () => {
  const result = calculatePositionBacktestMetrics([
    { returnPercent: -4, holdingMinutes: 2 * 24 * 60, maePercent: -6, mfePercent: 1 },
    { returnPercent: -8, holdingMinutes: 6 * 24 * 60, maePercent: -9, mfePercent: 2 },
  ]);
  assert.equal(result.winRate, 0);
  assert.equal(result.profitFactor, 0);
  assert.equal(result.averageWinPercent, null);
  assert.equal(result.averageLossPercent, -6);
  assert.ok(result.netReturnPercent != null && result.netReturnPercent < 0);
});

test('position zero-variance and insufficient trade distributions keep trade Sharpe null', () => {
  const equalReturns = calculatePositionBacktestMetrics([
    { returnPercent: 2, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 3 },
    { returnPercent: 2, holdingMinutes: 48 * 60, maePercent: -1, mfePercent: 3 },
  ]);
  assert.equal(equalReturns.tradeSharpe, null);

  const oneTrade = calculatePositionBacktestMetrics([
    { returnPercent: 2, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 3 },
  ]);
  assert.equal(oneTrade.tradeSharpe, null);
  assert.equal(oneTrade.trades, 1);
  assert.equal(oneTrade.sampleComplete, true);
});

test('position malformed or incomplete trade input fails the whole metric set closed', () => {
  const malformed: ScannerBacktestTrade[] = [
    { returnPercent: 3, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 4 },
    { returnPercent: Number.NaN, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 4 },
    { returnPercent: 2, holdingMinutes: -1, maePercent: -1, mfePercent: 4 },
    { returnPercent: 2, holdingMinutes: 24 * 60, maePercent: 0.1, mfePercent: 4 },
    { returnPercent: 2, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: -0.1 },
  ];
  const result = calculatePositionBacktestMetrics(malformed);
  assert.equal(result.inputTrades, 5);
  assert.equal(result.trades, 1);
  assert.equal(result.excludedTrades, 4);
  assert.equal(result.sampleComplete, false);
  assert.equal(result.winRate, null);
  assert.equal(result.expectancyPercent, null);
  assert.equal(result.profitFactor, null);
  assert.equal(result.netReturnPercent, null);
  assert.equal(result.medianHoldingDays, null);
  assert.equal(result.averageMaePercent, null);
  assert.equal(result.averageMfePercent, null);
});

test('position result never exposes NaN or Infinity through numeric result fields', () => {
  const result = calculatePositionBacktestMetrics([
    { returnPercent: Number.MAX_VALUE, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 4 },
    { returnPercent: Number.MAX_VALUE, holdingMinutes: 48 * 60, maePercent: -1, mfePercent: 5 },
  ]);
  for (const value of Object.values(result)) {
    if (typeof value === 'number') assert.equal(Number.isFinite(value), true);
  }
  assert.equal(result.expectancyPercent, null);
  assert.equal(result.profitFactor, null);
  assert.equal(result.tradeSharpe, null);
  assert.equal(result.netReturnPercent, null);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('position breakeven trades stay in the win-rate denominator without becoming winners', () => {
  const result = calculatePositionBacktestMetrics([
    { returnPercent: 5, holdingMinutes: 24 * 60, maePercent: -1, mfePercent: 6 },
    { returnPercent: 0, holdingMinutes: 24 * 60, maePercent: 0, mfePercent: 0 },
  ]);
  assert.equal(result.trades, 2);
  assert.equal(result.winRate, 50);
  assert.equal(result.averageWinPercent, 5);
  assert.equal(result.averageLossPercent, null);
});

test('high win rate does not hide negative expectancy and profit factor below one', () => {
  const badPayoff: ScannerBacktestTrade[] = [
    ...Array.from({ length: 9 }, () => ({ returnPercent: 0.2, holdingMinutes: 10, maePercent: -0.1, mfePercent: 0.3 })),
    { returnPercent: -3, holdingMinutes: 10, maePercent: -3.2, mfePercent: 0.1 },
  ];
  const result = calculateScalpingBacktestMetrics(badPayoff);
  assert.equal(result.winRate, 90);
  assert.ok(result.expectancyPercent < 0);
  assert.ok(result.profitFactor != null && result.profitFactor < 1);
  assert.ok(result.netReturnPercent < 0);
});
