import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeBacktestLoss } from './backtest-loss-attribution';
import type { BacktestResult } from './backtest';

function fixture(): BacktestResult {
  return {
    ok: true,
    mode: 'backtest-only',
    orderSubmitted: false,
    symbol: 'BTCUSDT',
    timeframe: '4H',
    strategy: 'breakout',
    initialCapital: 10000,
    finalCapital: 9200,
    totalReturnPercent: -8,
    annualizedReturnPercent: -8,
    totalTrades: 4,
    winningTrades: 1,
    losingTrades: 3,
    winRate: 25,
    expectancy: -20,
    profitFactor: 0.7,
    averageRMultiple: -0.2,
    maximumDrawdown: 1200,
    maximumDrawdownPercent: 12,
    sharpeRatio: -0.5,
    sortinoRatio: -0.7,
    calmarRatio: -0.6,
    totalFees: 120,
    totalSlippage: 80,
    totalFunding: 40,
    longPerformance: { trades: 2, wins: 1, losses: 1, winRate: 50, netPnl: 200, averageRMultiple: 0.1, expectancy: 20, profitFactor: 1.2 },
    shortPerformance: { trades: 2, wins: 0, losses: 2, winRate: 0, netPnl: -1000, averageRMultiple: -0.5, expectancy: -500, profitFactor: 0 },
    validationPerformance: [
      { name: 'training', startTime: 1, endTime: 2, maximumDrawdown: 100, maximumDrawdownPercent: 1, trades: 2, wins: 2, losses: 0, winRate: 100, netPnl: 300, averageRMultiple: 0.5, expectancy: 150, profitFactor: null },
      { name: 'validation', startTime: 3, endTime: 4, maximumDrawdown: 300, maximumDrawdownPercent: 3, trades: 1, wins: 0, losses: 1, winRate: 0, netPnl: -400, averageRMultiple: -0.4, expectancy: -400, profitFactor: 0 },
      { name: 'test', startTime: 5, endTime: 6, maximumDrawdown: 700, maximumDrawdownPercent: 7, trades: 1, wins: 0, losses: 1, winRate: 0, netPnl: -700, averageRMultiple: -0.7, expectancy: -700, profitFactor: 0 },
    ],
    walkForward: [],
    monthlyPerformance: [
      { month: '2026-07', trades: 1, netPnl: 100, returnPercent: 1 },
      { month: '2026-08', trades: 2, netPnl: -300, returnPercent: -3 },
      { month: '2026-09', trades: 1, netPnl: -600, returnPercent: -6 },
    ],
    regimePerformance: [],
    equityCurve: [],
    drawdownCurve: [],
    trades: [
      { id:'1', side:'long', entryTime:1, exitTime:2, entryPrice:100, exitPrice:110, quantity:1, grossPnl:100, netPnl:80, entryFee:5, exitFee:5, slippageCost:5, fundingCost:5, rMultiple:1, exitReason:'take_profit', marketRegime:'uptrend' },
      { id:'2', side:'short', entryTime:3, exitTime:4, entryPrice:110, exitPrice:120, quantity:1, grossPnl:-100, netPnl:-300, entryFee:5, exitFee:5, slippageCost:5, fundingCost:5, rMultiple:-1, exitReason:'stop_loss', marketRegime:'ranging' },
      { id:'3', side:'short', entryTime:5, exitTime:6, entryPrice:120, exitPrice:130, quantity:1, grossPnl:-100, netPnl:-500, entryFee:5, exitFee:5, slippageCost:5, fundingCost:5, rMultiple:-1.2, exitReason:'stop_loss', marketRegime:'ranging' },
      { id:'4', side:'long', entryTime:7, exitTime:8, entryPrice:130, exitPrice:125, quantity:1, grossPnl:-50, netPnl:-80, entryFee:5, exitFee:5, slippageCost:5, fundingCost:5, rMultiple:-0.5, exitReason:'strategy_exit', marketRegime:'downtrend' },
    ],
    warnings: [],
    calculatedAt: '2026-09-29T00:00:00.000Z',
  };
}

test('loss attribution identifies side, regime, exit, validation and cost evidence deterministically', () => {
  const result = analyzeBacktestLoss(fixture());
  assert.equal(result.status, 'LOSS');
  assert.equal(result.worstSide, 'short');
  assert.equal(result.worstRegime, 'ranging');
  assert.equal(result.worstExitReason, 'stop_loss');
  assert.equal(result.validationWeakness, true);
  assert.equal(result.externalAiCalled, false);
  assert.equal(result.deterministic, true);
  assert.ok(result.findings.some((row) => row.key === 'validation'));
  assert.ok(result.findings.some((row) => row.key === 'cost'));
});

test('loss attribution never fabricates a loss cause when there are no losing trades', () => {
  const value = fixture();
  value.totalReturnPercent = 3;
  value.trades = value.trades.filter((trade) => trade.netPnl > 0);
  value.monthlyPerformance = [{ month:'2026-09', trades:1, netPnl:80, returnPercent:0.8 }];
  value.validationPerformance = [];
  value.totalFees = 0;
  value.totalSlippage = 0;
  value.totalFunding = 0;
  const result = analyzeBacktestLoss(value);
  assert.equal(result.status, 'PROFIT');
  assert.equal(result.worstSide, null);
  assert.equal(result.worstRegime, null);
  assert.equal(result.findings[0]?.key, 'insufficient');
});
