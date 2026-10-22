import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCandle } from './futures-market-data.service';
import { averageVolumeSeries, rollingHighestSeries, rollingLowestSeries, sanitizeClosedCandles, smaSeries, utcSessionVwapSeries, emaSeries, rsiSeries, atrSeries } from './backtest-indicators.service';

const START = Date.UTC(2026, 0, 1);

function candle(index: number, overrides: Partial<NormalizedCandle> = {}): NormalizedCandle {
  return {
    timestamp: START + index * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    quoteVolume: 1_000,
    timeframe: '1m',
    symbol: 'BTCUSDT',
    market: 'crypto-futures',
    source: 'fixture',
    isClosed: true,
    isDelayed: false,
    updatedAt: new Date(START + index * 60_000).toISOString(),
    ...overrides,
  };
}

test('SMA returns null for every window containing NaN', () => {
  assert.deepEqual(smaSeries([1, Number.NaN, 3, 4], 2), [null, null, null, 3.5]);
});

test('SMA returns null for every window containing Infinity', () => {
  assert.deepEqual(smaSeries([1, Number.POSITIVE_INFINITY, 3, 4], 2), [null, null, null, 3.5]);
});

test('average volume does not leak an invalid volume into a later window', () => {
  const rows = [candle(0, { volume: 10 }), candle(1, { volume: Number.NaN }), candle(2, { volume: 30 }), candle(3, { volume: 40 })];
  assert.deepEqual(averageVolumeSeries(rows, 2), [null, null, null, 35]);
});

test('rolling highest returns null when a window contains NaN', () => {
  assert.deepEqual(rollingHighestSeries([1, Number.NaN, 3], 2), [null, null, null]);
});

test('rolling lowest returns null when a window contains Infinity', () => {
  assert.deepEqual(rollingLowestSeries([1, Number.NEGATIVE_INFINITY, 3], 2), [null, null, null]);
});

test('UTC VWAP never emits NaN or Infinity from invalid input', () => {
  const result = utcSessionVwapSeries([candle(0), candle(1, { volume: Number.NaN }), candle(2)]);
  assert.equal(result[1], null);
  assert.ok(result.every((value) => value == null || Number.isFinite(value)));
});

test('sanitizer removes NaN OHLC candles', () => {
  const result = sanitizeClosedCandles([candle(0), candle(1, { close: Number.NaN })]);
  assert.equal(result.data.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('유효하지 않은 캔들')));
});

test('sanitizer removes Infinity volume candles', () => {
  const result = sanitizeClosedCandles([candle(0), candle(1, { volume: Number.POSITIVE_INFINITY })]);
  assert.equal(result.data.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('유효하지 않은 캔들')));
});

// ---------------------------------------------------------------
// A-2-3 확장: 룩어헤드·경계값·타임존·초기 구간 계약 검증
// ---------------------------------------------------------------
test('SMA returns null for period=0,-1 and identity for period=1', () => {
  const values = [1, 2, 3, 4, 5];
  assert.ok(smaSeries(values, 0).every((v) => v === null));
  assert.deepEqual(smaSeries(values, 1), [1, 2, 3, 4, 5]);
  assert.ok(smaSeries(values, -1).every((v) => v === null));
});

test('EMA null before period-1 and seeds with SMA', () => {
  const values = [2, 4, 6, 8, 10, 12, 14];
  const period = 3;
  const series = emaSeries(values, period);
  for (let i = 0; i < period - 1; i += 1) assert.equal(series[i], null);
  assert.equal(series[period - 1], 4);
});

test('RSI null until period closed', () => {
  const values = Array.from({ length: 20 }, (_, i) => 100 + i);
  const series = rsiSeries(values, 14);
  for (let i = 0; i < 14; i += 1) assert.equal(series[i], null);
  assert.notEqual(series[14], null);
});

test('ATR null before period completed true-range bars', () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    openTime: i * 60_000,
    closeTime: (i + 1) * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i + 0.5,
    volume: 1000,
  }));
  const series = atrSeries(candles as any, 14);
  for (let i = 0; i < 13; i += 1) assert.equal(series[i], null);
  assert.notEqual(series[14], null);
});

test('rollingHighest returns null when period exceeds length', () => {
  assert.deepEqual(rollingHighestSeries([1, 2, 3], 5), [null, null, null]);
});
