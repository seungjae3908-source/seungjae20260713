import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedChartCandle } from './chart-candle-normalizer';
import {
  bollingerSeries,
  computeChartIndicators,
  indicatorSeries,
} from './chart-indicator-engine';

function candles(count = 140): NormalizedChartCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.35 + Math.sin(index / 4) * 3;
    const open = base - Math.cos(index / 3) * 0.7;
    const close = base + Math.sin(index / 5) * 0.8;
    return {
      time: 1_700_000_000 + index * 300,
      sourceTime: String(1_700_000_000 + index * 300),
      open,
      high: Math.max(open, close) + 1.2,
      low: Math.min(open, close) - 1.1,
      close,
      volume: 1_000 + index * 7 + (index % 5) * 100,
      isClosed: true,
      closeStateSource: 'provider' as const,
    };
  });
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(values: number[], period: number): number | null {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    value = (values[index] - value) * multiplier + value;
  }
  return value;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]).slice(-period);
  const gain = changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / period;
  const loss = changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / period;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(rows: NormalizedChartCandle[], period = 14): number | null {
  if (rows.length < 2) return null;
  const ranges = rows.slice(1).map((row, index) => {
    const previous = rows[index];
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previous.close),
      Math.abs(row.low - previous.close),
    );
  });
  return average(ranges.slice(-period));
}

function closeEnough(actual: number | null, expected: number | null, tolerance = 1e-9) {
  if (actual == null || expected == null) {
    assert.equal(actual, expected);
    return;
  }
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('single-pass latest values match legacy-compatible reference calculations', () => {
  const rows = candles();
  const closes = rows.map((row) => row.close);
  const volumes = rows.map((row) => row.volume);
  const result = computeChartIndicators(rows);
  const latest = result.latest!;

  closeEnough(latest.sma5, sma(closes, 5));
  closeEnough(latest.sma20, sma(closes, 20));
  closeEnough(latest.sma60, sma(closes, 60));
  closeEnough(latest.sma120, sma(closes, 120));
  closeEnough(latest.ema12, ema(closes, 12));
  closeEnough(latest.ema26, ema(closes, 26));
  closeEnough(latest.rsi14, rsi(closes));
  closeEnough(latest.atr14, atr(rows));
  closeEnough(latest.volumeRatio20, rows.at(-1)!.volume / (average(volumes.slice(-21, -1)) ?? 1));
});

test('MACD signal and histogram use only MACD values available up to each candle', () => {
  const rows = candles();
  const closes = rows.map((row) => row.close);
  const macdValues: number[] = [];
  for (let length = 26; length <= closes.length; length += 1) {
    const fast = ema(closes.slice(0, length), 12);
    const slow = ema(closes.slice(0, length), 26);
    if (fast != null && slow != null) macdValues.push(fast - slow);
  }
  const expectedMacd = macdValues.at(-1)!;
  const expectedSignal = ema(macdValues, 9)!;
  const latest = computeChartIndicators(rows).latest!;
  closeEnough(latest.macd, expectedMacd);
  closeEnough(latest.macdSignal, expectedSignal);
  closeEnough(latest.macdHistogram, expectedMacd - expectedSignal);
});

test('Bollinger and VWAP series contain no NaN or Infinity', () => {
  const rows = candles();
  const result = computeChartIndicators(rows);
  const band = bollingerSeries(result);
  assert.equal(band.middle.length, rows.length - 19);
  for (const point of [...band.upper, ...band.middle, ...band.lower, ...indicatorSeries(result, 'vwap')]) {
    assert.ok(Number.isFinite(point.time));
    assert.ok(Number.isFinite(point.value));
  }
});

test('volume ratio compares the current candle only with previous candles', () => {
  const rows = candles(22);
  rows[21] = { ...rows[21], volume: 100_000 };
  const result = computeChartIndicators(rows);
  const expectedAverage = average(rows.slice(1, 21).map((row) => row.volume))!;
  closeEnough(result.latest!.volumeRatio20, 100_000 / expectedAverage);
});

test('insufficient history stays unavailable instead of inventing indicator values', () => {
  const result = computeChartIndicators(candles(4));
  assert.equal(result.latest!.sma5, null);
  assert.equal(result.latest!.sma20, null);
  assert.equal(result.latest!.ema12, null);
  assert.equal(result.latest!.rsi14, null);
  assert.equal(result.latest!.macd, null);
  assert.equal(result.latest!.bollinger20, null);
  assert.ok(result.latest!.atr14 != null);
});
