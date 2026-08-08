import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../sample/types';
import { aggregateUsSessionCandles } from './stock-signal-scanner.service';

function row(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return { time, open, high, low, close, volume };
}

function simple(time: string, value: number): Candle {
  return row(time, value, value + 2, value - 2, value + 1, value * 10);
}

test('US 3m aggregation sorts lower bars and preserves exact OHLCV', () => {
  const result = aggregateUsSessionCandles([
    row('2026-08-05T13:32:00.000Z', 12, 14, 11, 13, 30),
    row('2026-08-05T13:30:00.000Z', 10, 12, 9, 11, 10),
    row('2026-08-05T13:31:00.000Z', 11, 15, 8, 12, 20),
  ], 1, 3);

  assert.deepEqual(result, [{
    time: '2026-08-05T13:30:00.000Z',
    open: 10,
    high: 15,
    low: 8,
    close: 13,
    volume: 60,
  }]);
});

test('US 3m aggregation drops incomplete or missing lower-bar buckets without shifting later anchors', () => {
  const result = aggregateUsSessionCandles([
    simple('2026-08-05T13:33:00.000Z', 10),
    simple('2026-08-05T13:35:00.000Z', 11),
    simple('2026-08-05T13:36:00.000Z', 20),
    simple('2026-08-05T13:37:00.000Z', 21),
    simple('2026-08-05T13:38:00.000Z', 22),
  ], 1, 3);

  assert.equal(result.length, 1);
  assert.equal(result[0].time, '2026-08-05T13:36:00.000Z');
  assert.equal(result[0].open, 20);
  assert.equal(result[0].close, 23);
});

test('US 3m aggregation never crosses premarket, regular, after-hours or day boundaries', () => {
  const result = aggregateUsSessionCandles([
    simple('2026-08-05T13:27:00.000Z', 1),
    simple('2026-08-05T13:28:00.000Z', 2),
    simple('2026-08-05T13:29:00.000Z', 3),
    simple('2026-08-05T13:30:00.000Z', 10),
    simple('2026-08-05T13:31:00.000Z', 11),
    simple('2026-08-05T13:32:00.000Z', 12),
    simple('2026-08-05T20:00:00.000Z', 20),
    simple('2026-08-05T20:01:00.000Z', 21),
    simple('2026-08-05T20:02:00.000Z', 22),
    simple('2026-08-06T13:30:00.000Z', 30),
    simple('2026-08-06T13:31:00.000Z', 31),
    simple('2026-08-06T13:32:00.000Z', 32),
  ], 1, 3);

  assert.deepEqual(result.map((item) => item.time), [
    '2026-08-05T13:27:00.000Z',
    '2026-08-05T13:30:00.000Z',
    '2026-08-05T20:00:00.000Z',
    '2026-08-06T13:30:00.000Z',
  ]);
});

test('US 4H aggregation anchors at each session start and drops structural incomplete buckets', () => {
  const result = aggregateUsSessionCandles([
    simple('2026-08-05T08:00:00.000Z', 1),
    simple('2026-08-05T09:00:00.000Z', 2),
    simple('2026-08-05T10:00:00.000Z', 3),
    simple('2026-08-05T11:00:00.000Z', 4),
    simple('2026-08-05T13:30:00.000Z', 10),
    simple('2026-08-05T14:30:00.000Z', 11),
    simple('2026-08-05T15:30:00.000Z', 12),
    simple('2026-08-05T16:30:00.000Z', 13),
    simple('2026-08-05T17:30:00.000Z', 14),
    simple('2026-08-05T18:30:00.000Z', 15),
    simple('2026-08-05T20:00:00.000Z', 20),
    simple('2026-08-05T21:00:00.000Z', 21),
    simple('2026-08-05T22:00:00.000Z', 22),
    simple('2026-08-05T23:00:00.000Z', 23),
  ], 60, 240);

  assert.deepEqual(result.map((item) => item.time), [
    '2026-08-05T08:00:00.000Z',
    '2026-08-05T13:30:00.000Z',
    '2026-08-05T20:00:00.000Z',
  ]);
});

test('US session anchors remain correct across DST offsets', () => {
  const summer = aggregateUsSessionCandles([
    simple('2026-08-05T13:30:00.000Z', 1),
    simple('2026-08-05T14:30:00.000Z', 2),
    simple('2026-08-05T15:30:00.000Z', 3),
    simple('2026-08-05T16:30:00.000Z', 4),
  ], 60, 240);
  const winter = aggregateUsSessionCandles([
    simple('2026-01-05T14:30:00.000Z', 1),
    simple('2026-01-05T15:30:00.000Z', 2),
    simple('2026-01-05T16:30:00.000Z', 3),
    simple('2026-01-05T17:30:00.000Z', 4),
  ], 60, 240);

  assert.equal(summer.length, 1);
  assert.equal(summer[0].time, '2026-08-05T13:30:00.000Z');
  assert.equal(winter.length, 1);
  assert.equal(winter[0].time, '2026-01-05T14:30:00.000Z');
});
