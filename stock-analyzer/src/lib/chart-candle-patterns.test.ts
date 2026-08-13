import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedChartCandle } from './chart-candle-normalizer';
import { detectLatestCandlePatterns } from './chart-candle-patterns';

function candle(
  index: number,
  values: { open: number; high: number; low: number; close: number; isClosed?: boolean },
): NormalizedChartCandle {
  const time = 1_700_000_000 + index * 300;
  return {
    time,
    sourceTime: String(time),
    open: values.open,
    high: values.high,
    low: values.low,
    close: values.close,
    volume: 1_000 + index * 10,
    isClosed: values.isClosed ?? true,
    closeStateSource: 'provider',
  };
}

function hasType(candles: NormalizedChartCandle[], type: string): boolean {
  return detectLatestCandlePatterns(candles).some((pattern) => pattern.type === type);
}

test('hammer requires a confirmed long lower wick and compact body', () => {
  const input = [candle(0, { open: 10, high: 10.3, low: 9, close: 10.2 })];
  const result = detectLatestCandlePatterns(input).find((pattern) => pattern.type === 'hammer');
  assert.ok(result);
  assert.equal(result?.bias, 'bullish');
  assert.equal(result?.status, 'confirmed');
  assert.deepEqual(result?.candleTimes, [input[0].time]);
});

test('shooting star mirrors the wick evidence without inventing a target price', () => {
  const input = [candle(0, { open: 10, high: 11, low: 9.7, close: 9.8 })];
  const result = detectLatestCandlePatterns(input).find((pattern) => pattern.type === 'shooting-star');
  assert.ok(result);
  assert.equal(result?.bias, 'bearish');
  assert.equal(result?.reasons.length, 3);
});

test('bullish and bearish engulfing require opposite bodies and full real-body engulfment', () => {
  const bullish = [
    candle(0, { open: 10, high: 10.2, low: 8.8, close: 9 }),
    candle(1, { open: 8.8, high: 10.4, low: 8.7, close: 10.3 }),
  ];
  const bearish = [
    candle(0, { open: 9, high: 10.2, low: 8.8, close: 10 }),
    candle(1, { open: 10.2, high: 10.3, low: 8.5, close: 8.7 }),
  ];
  assert.equal(hasType(bullish, 'bullish-engulfing'), true);
  assert.equal(hasType(bearish, 'bearish-engulfing'), true);
});

test('morning and evening stars require three closed evidence candles and midpoint recovery/rejection', () => {
  const morning = [
    candle(0, { open: 10, high: 10.2, low: 7.8, close: 8 }),
    candle(1, { open: 8.1, high: 8.4, low: 7.9, close: 8.2 }),
    candle(2, { open: 8.2, high: 9.7, low: 8.1, close: 9.5 }),
  ];
  const evening = [
    candle(0, { open: 8, high: 10.2, low: 7.8, close: 10 }),
    candle(1, { open: 10, high: 10.2, low: 9.7, close: 9.9 }),
    candle(2, { open: 9.8, high: 9.9, low: 8.3, close: 8.5 }),
  ];
  assert.equal(hasType(morning, 'morning-star'), true);
  assert.equal(hasType(evening, 'evening-star'), true);
});

test('an open candle cannot become the confirming candle for a new pattern', () => {
  const input = [
    candle(0, { open: 10, high: 10.2, low: 8.8, close: 9 }),
    candle(1, { open: 8.8, high: 10.4, low: 8.7, close: 10.3, isClosed: false }),
  ];
  assert.equal(hasType(input, 'bullish-engulfing'), false);
});

test('invalid OHLC evidence fails closed instead of emitting a pattern', () => {
  const input = [candle(0, { open: 10, high: 9, low: 11, close: 10.2 })];
  assert.deepEqual(detectLatestCandlePatterns(input), []);
});
