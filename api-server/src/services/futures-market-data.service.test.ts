import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBasis,
  calculateOpenInterestChangePercent,
  calculateSpreadPercent,
  classifyDataStatus,
  normalizeBitgetCandles,
  normalizeFuturesSymbol,
  toFiniteNumber,
} from './futures-market-data.service';

test('toFiniteNumber keeps valid numbers and zero', () => {
  assert.equal(toFiniteNumber('12.5'), 12.5);
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber('0'), 0);
});

test('toFiniteNumber rejects empty and non-finite values', () => {
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber('   '), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(Number.NaN), null);
  assert.equal(toFiniteNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(toFiniteNumber(Number.NEGATIVE_INFINITY), null);
});

test('futures symbol normalization accepts supported input shapes', () => {
  for (const value of ['BTC', 'BTCUSDT', 'BTC-USDT', 'BTC/USDT', 'btcusdt']) {
    assert.equal(normalizeFuturesSymbol(value), 'BTCUSDT');
  }
  assert.equal(normalizeFuturesSymbol('BTC$USDT'), null);
});

test('basis calculation follows mark minus index formula', () => {
  assert.deepEqual(calculateBasis(101, 100), { basis: 1, basisPercent: 1 });
});

test('basis calculation blocks zero division and missing values', () => {
  assert.deepEqual(calculateBasis(101, 0), { basis: null, basisPercent: null });
  assert.deepEqual(calculateBasis(null, 100), { basis: null, basisPercent: null });
});

test('spread calculation uses midpoint and rejects inverted book', () => {
  assert.equal(calculateSpreadPercent(99, 101), 2);
  assert.equal(calculateSpreadPercent(101, 99), null);
  assert.equal(calculateSpreadPercent(0, 1), null);
});

test('open interest change calculation rejects invalid previous values', () => {
  assert.equal(calculateOpenInterestChangePercent(110, 100), 10);
  assert.equal(calculateOpenInterestChangePercent(110, 0), null);
  assert.equal(calculateOpenInterestChangePercent(110, null), null);
});

test('candle normalization sorts timestamps and removes duplicates', () => {
  const now = Date.UTC(2026, 0, 1, 1, 0, 0);
  const result = normalizeBitgetCandles([
    ['1767225600000', '100', '105', '99', '103', '10', '1000'],
    ['1767225540000', '98', '102', '97', '100', '9', '900'],
    ['1767225600000', '100', '106', '99', '104', '11', '1100'],
  ], 'BTCUSDT', '1m', now);
  assert.equal(result.data.length, 2);
  assert.ok(result.data[0].timestamp < result.data[1].timestamp);
  assert.equal(result.data[1].close, 104);
  assert.ok(result.warnings.some((warning) => warning.includes('중복 timestamp')));
});

test('candle normalization removes invalid OHLC rows', () => {
  const result = normalizeBitgetCandles([
    ['1767225600000', '100', '90', '95', '96', '10', '1000'],
    ['1767225660000', '100', '105', '99', '106', '10', '1000'],
    ['1767225720000', '100', '105', '99', '103', '10', '1000'],
  ], 'BTCUSDT', '1m', Date.UTC(2026, 0, 1, 1, 0, 0));
  assert.equal(result.data.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('OHLC')));
});

test('data status uses timeframe-aware stale threshold', () => {
  const now = 1_000_000;
  assert.equal(classifyDataStatus({
    now,
    lastTimestamp: now - 80_000,
    timeframeMs: 60_000,
    count: 30,
    minimumCount: 25,
  }), 'live');
  assert.equal(classifyDataStatus({
    now,
    lastTimestamp: now - 200_000,
    timeframeMs: 60_000,
    count: 30,
    minimumCount: 25,
  }), 'delayed');
});

test('empty candle data is insufficient without fabricated rows', () => {
  const result = normalizeBitgetCandles([], 'BTCUSDT', '15m', Date.now());
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.data, []);
  assert.ok(result.warnings.some((warning) => warning.includes('사용 가능한 캔들')));
});
