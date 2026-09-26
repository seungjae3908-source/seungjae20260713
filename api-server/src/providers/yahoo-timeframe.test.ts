import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateYahooDerivedTimeframe, yahooChartParams } from './yahoo';

function candle(time: string, open: number, high: number, low: number, close: number, volume: number) {
  return { time, open, high, low, close, volume };
}

test('Yahoo intraday requests preserve the requested supported interval', () => {
  assert.deepEqual(yahooChartParams('1m'), { range: '7d', interval: '1m' });
  assert.deepEqual(yahooChartParams('5m'), { range: '1mo', interval: '5m' });
  assert.deepEqual(yahooChartParams('15m'), { range: '1mo', interval: '15m' });
  assert.deepEqual(yahooChartParams('30m'), { range: '1mo', interval: '30m' });
  assert.deepEqual(yahooChartParams('1H'), { range: '2y', interval: '60m' });
});

test('Yahoo direct requests reject unsupported intervals instead of returning mislabeled candles', () => {
  assert.throws(() => yahooChartParams('3m'), /YAHOO_UNSUPPORTED_TIMEFRAME:3m/);
  assert.throws(() => yahooChartParams('4H'), /YAHOO_UNSUPPORTED_TIMEFRAME:4H/);
  assert.throws(() => yahooChartParams('unknown'), /YAHOO_UNSUPPORTED_TIMEFRAME:unknown/);
});

test('Yahoo derives a real 3m candle from three contiguous observed 1m candles', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 102, 99, 101, 10),
    candle('2026-08-18T14:31:00.000Z', 101, 104, 100, 103, 20),
    candle('2026-08-18T14:32:00.000Z', 103, 105, 102, 104, 30),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('3m', rows), [
    candle('2026-08-18T14:30:00.000Z', 100, 105, 99, 104, 60),
  ]);
});

test('Yahoo derives a real 4H candle from four contiguous observed 60m candles', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 102, 99, 101, 10),
    candle('2026-08-18T15:30:00.000Z', 101, 104, 100, 103, 20),
    candle('2026-08-18T16:30:00.000Z', 103, 106, 102, 105, 30),
    candle('2026-08-18T17:30:00.000Z', 105, 108, 104, 107, 40),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('4H', rows), [
    candle('2026-08-18T14:30:00.000Z', 100, 108, 99, 107, 100),
  ]);
});

test('Yahoo derived timeframes never bridge an overnight or missing-data gap', () => {
  const rows = [
    candle('2026-08-18T14:30:00.000Z', 100, 101, 99, 100, 10),
    candle('2026-08-18T14:31:00.000Z', 100, 101, 99, 100, 10),
    candle('2026-08-19T14:30:00.000Z', 110, 111, 109, 110, 10),
    candle('2026-08-19T14:31:00.000Z', 110, 111, 109, 110, 10),
    candle('2026-08-19T14:32:00.000Z', 110, 112, 109, 111, 10),
  ];

  assert.deepEqual(aggregateYahooDerivedTimeframe('3m', rows), [
    candle('2026-08-19T14:30:00.000Z', 110, 112, 109, 111, 30),
  ]);
});
