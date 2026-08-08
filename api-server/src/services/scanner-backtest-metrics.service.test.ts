import test from 'node:test';
import assert from 'node:assert/strict';
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

test('scalping metrics retain execution-oriented fields', () => {
  const result = calculateScalpingBacktestMetrics(trades);
  assert.equal(result.strategy, 'scalping');
  assert.equal(result.trades, 3);
  assert.equal(result.medianHoldingMinutes, 12);
  assert.ok(result.averageSlippageBps != null);
  assert.ok(result.maxAdverseExcursionPercent != null);
  assert.equal('medianHoldingHours' in result, false);
});

test('swing metrics retain holding and excursion fields without scalping slippage contract', () => {
  const result = calculateSwingBacktestMetrics(trades);
  assert.equal(result.strategy, 'swing');
  assert.equal(result.trades, 3);
  assert.equal(result.medianHoldingHours, 0.2);
  assert.ok(result.averageMfePercent != null);
  assert.ok(result.averageMaePercent != null);
  assert.equal('averageSlippageBps' in result, false);
});
