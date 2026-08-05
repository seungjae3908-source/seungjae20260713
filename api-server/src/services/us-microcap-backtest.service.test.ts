import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_US_MICROCAP_STRATEGIES,
  detectUsMicrocapSignal,
  normalizeUsMicrocapCandles,
  optimizeUsMicrocapStrategy,
  runUsMicrocapBacktest,
  type UsMicrocapCandle,
  type UsMicrocapStrategyConfig,
} from './us-microcap-backtest.service';

const DAY = 24 * 60 * 60_000;

function flatSeries(days = 35, symbol = 'TEST'): UsMicrocapCandle[] {
  return Array.from({ length: days }, (_, index) => ({
    symbol,
    timestamp: Date.UTC(2025, 0, 1) + index * DAY,
    open: 2,
    high: 2.05,
    low: 1.95,
    close: 2,
    volume: 2_000_000,
  }));
}

function testConfig(overrides: Partial<UsMicrocapStrategyConfig> = {}): UsMicrocapStrategyConfig {
  return {
    ...DEFAULT_US_MICROCAP_STRATEGIES[1],
    id: 'test',
    label: '테스트',
    averageVolumeLookback: 20,
    breakoutLookback: 20,
    minimumAverageDollarVolume: 100_000,
    minimumRelativeVolume: 2,
    minimumDailyChangePercent: 5,
    maximumDailyChangePercent: 40,
    maximumFiveDayReturnPercent: 100,
    maximumTwentyDayReturnPercent: 200,
    minimumCloseLocation: 0.6,
    maximumUpperWickPercent: 30,
    stopLossPercent: 7,
    takeProfitPercent: 12,
    maximumHoldingDays: 3,
    roundTripCostPercent: 0.35,
    slippagePercent: 0.3,
    ...overrides,
  };
}

test('detects only a liquid high-relative-volume breakout without future data', () => {
  const candles = flatSeries(35);
  candles[30] = {
    ...candles[30],
    open: 2.02,
    high: 2.34,
    low: 2,
    close: 2.3,
    volume: 7_000_000,
  };
  const signal = detectUsMicrocapSignal(candles, 30, testConfig());
  assert.ok(signal);
  if (!signal) throw new Error('expected signal');
  assert.equal(signal.symbol, 'TEST');
  assert.equal(signal.entryTime, candles[31].timestamp);
  assert.ok(signal.relativeVolume >= 3);
  assert.ok(signal.score >= 0 && signal.score <= 100);
});

test('rejects a breakout candle with an excessive upper wick', () => {
  const candles = flatSeries(35);
  candles[30] = {
    ...candles[30],
    open: 2.02,
    high: 3.2,
    low: 2,
    close: 2.3,
    volume: 7_000_000,
  };
  assert.equal(detectUsMicrocapSignal(candles, 30, testConfig()), null);
});

test('uses next-session open, stop-first intrabar priority, and includes costs', () => {
  const candles = flatSeries(36);
  candles[30] = {
    ...candles[30],
    open: 2.02,
    high: 2.34,
    low: 2,
    close: 2.3,
    volume: 7_000_000,
  };
  candles[31] = {
    ...candles[31],
    open: 2.3,
    high: 2.7,
    low: 2.25,
    close: 2.6,
    volume: 1_000_000,
  };
  const performance = runUsMicrocapBacktest(candles, testConfig());
  assert.equal(performance.totalTrades, 1);
  assert.equal(performance.trades[0]?.entryPrice, 2.3);
  assert.equal(performance.trades[0]?.exitReason, 'TARGET');
  assert.ok((performance.trades[0]?.costs ?? 0) > 0);
  assert.ok(performance.finalCapital > performance.initialCapital);
});

test('deduplicates symbol and timestamp pairs deterministically', () => {
  const candle = flatSeries(1)[0];
  const rows = normalizeUsMicrocapCandles([candle, { ...candle, symbol: 'test' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.symbol, 'TEST');
});

test('fails closed when there is not enough history for walk-forward validation', () => {
  const result = optimizeUsMicrocapStrategy(flatSeries(80));
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.liveEligible, false);
  assert.equal(result.selectedStrategy, null);
  assert.ok(result.warnings.some((warning) => warning.includes('최소 100거래일')));
});
