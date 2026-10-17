import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedChartCandle } from './chart-candle-normalizer';
import { analyzeAutoDrawing, zigZagSwings } from './chart-auto-drawing';

function candle(index: number, close: number, closed = true): NormalizedChartCandle {
  const time = 1_788_000_000 + index * 300;
  return {
    time, sourceTime: new Date(time * 1000).toISOString(),
    open: close - 1, high: close + 2, low: close - 3, close,
    volume: 100 + index, isClosed: closed,
    closeStateSource: closed ? 'provider' : 'unknown',
  };
}

test('an extreme still-forming bar never changes confirmed patterns, waves or completed asOf', () => {
  const closed = [100, 98, 96, 101, 106, 103, 97, 94, 100, 107, 102].map((value, i) => candle(i, value));
  const baseline = analyzeAutoDrawing(closed);
  const forming = candle(closed.length, 1200, false);
  const next = analyzeAutoDrawing([...closed, forming]);
  assert.deepEqual(next, baseline);
  assert.equal(next.asOf, closed.at(-1)!.time);
  assert.equal(next.swings.some(point => point.time === forming.time), false);
});

test('direct zig-zag observation does not confirm a forming candle high or low', () => {
  const completed = [100, 104, 97, 91, 105, 109].map((value, i) => candle(i, value));
  const forming = candle(completed.length, 900, false);
  const points = zigZagSwings([...completed, forming], 0.1);
  assert.ok(points.every(point => !point.confirmed || point.time !== forming.time));
});
