import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCandle } from './futures-market-data.service';
import { measureBacktestPerformance, type BacktestRequest } from './backtest-engine.service';

const STEP = 15 * 60_000;
const START = Date.UTC(2025, 0, 1);

function candles(count: number): NormalizedCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 20) * 0.5;
    return {
      timestamp: START + index * STEP,
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 100,
      quoteVolume: close * 100,
      timeframe: '15m',
      symbol: 'BTCUSDT',
      market: 'crypto-futures',
      source: 'performance-fixture',
      isClosed: true,
      isDelayed: false,
      updatedAt: new Date(START + index * STEP).toISOString(),
    };
  });
}

function request(count: number): BacktestRequest {
  return {
    market: 'crypto-futures', symbol: 'BTCUSDT', timeframe: '15m',
    startTime: START, endTime: START + (count - 1) * STEP, initialCapital: 10_000,
    strategy: 'breakout', side: 'both',
    parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 2 },
    riskPercent: 0.5, leverage: 2,
    entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005,
    fundingRatePerInterval: 0.0001, fundingIntervalHours: 8,
    stopLossMode: 'percent', stopLossValue: 1,
    takeProfitMode: 'risk_multiple', takeProfitValue: 2,
    trailingStop: { enabled: false },
    maximumConcurrentPositions: 1, maximumTradesPerDay: 10,
    intrabarPriority: 'stop_first',
    quantityStep: 0.001, quantityPrecision: 3,
    minimumQuantity: 0.001, minimumNotional: 5,
    maximumLeverage: 125, contractRulesStatus: 'live',
  };
}

for (const [count, limitMs] of [[1_000, 2_000], [10_000, 5_000], [20_000, 10_000]] as const) {
  test(`backtest performance remains bounded for ${count} candles`, () => {
    const measured = measureBacktestPerformance(request(count), candles(count));
    console.log(JSON.stringify({ kind: 'phase5-performance', ...measured }));
    assert.equal(measured.candleCount, count);
    assert.equal(measured.timedOut, false);
    assert.ok(measured.durationMs < limitMs, `${count} candles took ${measured.durationMs.toFixed(1)}ms`);
    assert.ok(Number.isFinite(measured.heapDeltaBytes));
  });
}
