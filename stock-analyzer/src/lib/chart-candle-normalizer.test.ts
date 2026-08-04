import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChartCandles,
  parseChartCandleTime,
  type ChartCandleTimeframe,
} from './chart-candle-normalizer';

function candle(time: unknown, close: number, extra: Record<string, unknown> = {}) {
  return {
    time,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100,
    ...extra,
  };
}

test('timestamps are parsed without inventing a current-time fallback', () => {
  assert.equal(parseChartCandleTime(1_700_000_000), 1_700_000_000);
  assert.equal(parseChartCandleTime(1_700_000_000_000), 1_700_000_000);
  assert.equal(parseChartCandleTime('20260102030405'), Date.UTC(2026, 0, 2, 3, 4, 5) / 1_000);
  assert.equal(parseChartCandleTime('not-a-time'), null);
  assert.equal(parseChartCandleTime(''), null);
});

test('normalization sorts candles, drops invalid rows, and keeps the latest duplicate', () => {
  const result = normalizeChartCandles(
    [
      candle(1_700_000_300, 102),
      candle('missing', 999),
      candle(1_700_000_000, 100),
      candle(1_700_000_300, 103, { volume: 200 }),
      candle(1_700_000_600, 104, { high: 90 }),
    ],
    '5m',
    1_700_000_400,
  );
  assert.deepEqual(result.candles.map((item) => item.time), [1_700_000_000, 1_700_000_300]);
  assert.equal(result.candles[1].close, 103);
  assert.equal(result.candles[1].volume, 200);
  assert.equal(result.droppedRows, 2);
  assert.equal(result.duplicateRows, 1);
});

test('provider close state is authoritative', () => {
  const result = normalizeChartCandles(
    [candle(1_700_000_000, 100, { isClosed: false }), candle(1_700_000_300, 101, { isClosed: true })],
    '5m',
    1_700_100_000,
  );
  assert.equal(result.candles[0].isClosed, false);
  assert.equal(result.candles[0].closeStateSource, 'provider');
  assert.equal(result.candles[1].isClosed, true);
  assert.equal(result.candles[1].closeStateSource, 'provider');
});

test('a following candle closes the previous candle without closing the active candle early', () => {
  const result = normalizeChartCandles(
    [candle(1_700_000_000, 100), candle(1_700_000_300, 101)],
    '5m',
    1_700_000_450,
  );
  assert.equal(result.candles[0].isClosed, true);
  assert.equal(result.candles[0].closeStateSource, 'sequence');
  assert.equal(result.candles[1].isClosed, false);
  assert.equal(result.candles[1].closeStateSource, 'unknown');
});

test('the clock closes only a candle whose interval and grace have elapsed', () => {
  const open = normalizeChartCandles([candle(1_700_000_000, 100)], '5m', 1_700_000_304);
  const closed = normalizeChartCandles([candle(1_700_000_000, 100)], '5m', 1_700_000_305);
  assert.equal(open.candles[0].isClosed, false);
  assert.equal(closed.candles[0].isClosed, true);
  assert.equal(closed.candles[0].closeStateSource, 'clock');
});

test('time discontinuities are reported without synthesizing missing bars', () => {
  const result = normalizeChartCandles(
    [candle(1_700_000_000, 100), candle(1_700_000_900, 103)],
    '5m',
    1_700_001_500,
  );
  assert.equal(result.candles.length, 2);
  assert.equal(result.discontinuities.length, 1);
  assert.equal(result.discontinuities[0].estimatedMissingBars, 2);
  assert.match(result.warnings.join(' '), /시간 불연속 구간/);
});

test('all supported timeframes normalize without changing their source timestamps', () => {
  const timeframes: ChartCandleTimeframe[] = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '5D', '20D'];
  for (const timeframe of timeframes) {
    const result = normalizeChartCandles([candle(1_700_000_000, 100, { final: true })], timeframe, 1_700_000_001);
    assert.equal(result.candles[0].time, 1_700_000_000);
    assert.equal(result.candles[0].isClosed, true);
  }
});
