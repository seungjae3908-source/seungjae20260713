import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateOneMinuteCandles } from './intraday-candle-aggregation';

const start = Date.parse('2026-09-18T13:30:00Z');
const now = start + 60 * 60_000;
const row = (minute: number) => ({
  time: new Date(start + minute * 60_000).toISOString(),
  open: 100 + minute, high: 102 + minute, low: 99 + minute, close: 101 + minute, volume: 10,
});

test('complete clock-aligned intervals preserve real OHLCV and chronological order', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i)).reverse();
  assert.deepEqual(aggregateOneMinuteCandles(rows, 5, now), [
    { time: row(0).time, open: 100, high: 106, low: 99, close: 105, volume: 50 },
    { time: row(5).time, open: 105, high: 111, low: 104, close: 110, volume: 50 },
  ]);
});

test('missing minutes and overnight gaps never become contiguous candles', () => {
  assert.deepEqual(aggregateOneMinuteCandles([0, 1, 3, 4, 5].map(row), 5, now), []);
  assert.deepEqual(aggregateOneMinuteCandles([0, 1, 1440, 1441, 1442].map(row), 5, now + 86_400_000), []);
});

test('partial leading and trailing buckets are omitted instead of shifting interval boundaries', () => {
  const result = aggregateOneMinuteCandles(Array.from({ length: 10 }, (_, i) => row(i + 1)), 5, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].time, row(5).time);
});

test('duplicate minutes, invalid OHLCV, and ambiguous timestamps cannot supply a complete bar', () => {
  assert.deepEqual(aggregateOneMinuteCandles([0, 1, 1, 3, 4].map(row), 5, now), []);
  const rows = [0, 1, 2, 3, 4].map(row);
  assert.deepEqual(aggregateOneMinuteCandles([...rows, row(1)], 5, now), []);
  assert.deepEqual(aggregateOneMinuteCandles(rows.map((r) => ({ ...r, time: r.time.replace('Z', '') })), 5, now), []);
  assert.deepEqual(aggregateOneMinuteCandles(rows.map((r) => ({ ...r, volume: NaN })), 5, now), []);
});

test('open and future buckets are excluded; explicit KST retains the same absolute instant', () => {
  const rows = [0, 1, 2, 3, 4].map(row);
  assert.deepEqual(aggregateOneMinuteCandles(rows, 5, start + 4 * 60_000), []);
  const kstRows = rows.map((r, i) => ({ ...r, time: `2026-09-18T22:3${i}:00+09:00` }));
  const result = aggregateOneMinuteCandles(kstRows, 5, start + 5 * 60_000);
  assert.equal(result.length, 1);
  assert.equal(Date.parse(String(result[0].time)), start);
  assert.equal(result[0].close, 105);
});
