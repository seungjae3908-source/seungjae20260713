import test from 'node:test';
import assert from 'node:assert/strict';
import './scanner-adaptive-threshold-arena.smoke.test';
import './forward-recommendation-observer.service.test';
import {
  calculateScalpingBacktestMetrics,
  calculateSwingBacktestMetrics,
  type ScannerBacktestTrade,
} from './scanner-backtest-metrics.service';

const trades: ScannerBacktestTrade[] = [
  { returnPercent: 1.2, holdingMinutes: 8, maePercent: -0.4, mfePercent: 1.5, slippageBps: 4 },
  { returnPercent: -0.6, holdingMinutes: 12, maePercent: -0.8, mfePercent: 0.3, slippageBps: 7 },
  { returnPercent: 2.1, holdingMinutes: 240, maePercent: -0.7, mfePercent: 2.8, slippageBps: 5 },
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
