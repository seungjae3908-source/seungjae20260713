import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT,
  benchmarkDrawdownBlocksLong,
  createBtcBenchmarkDrawdownReader,
  drawdownFromPeakPercent,
  isNewCryptoLongEntry,
} from './crypto-benchmark-regime.service';

test('drawdown is measured from the peak close to the last close', () => {
  assert.equal(drawdownFromPeakPercent([100, 110, 99]), 10);
  assert.equal(drawdownFromPeakPercent([100, 101, 102]), 0);
  assert.equal(drawdownFromPeakPercent([100]), null);
  assert.equal(drawdownFromPeakPercent([]), null);
});

test('block threshold is 6% and unknown values never block', () => {
  assert.equal(BENCHMARK_DRAWDOWN_LONG_BLOCK_PERCENT, 6);
  assert.equal(benchmarkDrawdownBlocksLong(6), true);
  assert.equal(benchmarkDrawdownBlocksLong(5.99), false);
  assert.equal(benchmarkDrawdownBlocksLong(null), false);
  assert.equal(benchmarkDrawdownBlocksLong(undefined), false);
  assert.equal(benchmarkDrawdownBlocksLong(Number.NaN), false);
});

test('only new crypto long/buy entries are subject to the filter', () => {
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'long' }, false), true);
  assert.equal(isNewCryptoLongEntry({ exchange: 'upbit', side: 'buy' }, false), true);
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'short' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'upbit', side: 'sell' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'kiwoom', side: 'buy' }, false), false);
  assert.equal(isNewCryptoLongEntry({ exchange: 'bitget', side: 'long' }, true), false);
});

function bitgetCandles(closes: number[], startMs: number) {
  return {
    code: '00000',
    msg: 'success',
    data: closes.map((close, index) => [
      String(startMs + index * 300_000), String(close), String(close), String(close), String(close), '1', String(close),
    ]),
  };
}

test('reader computes drawdown from closed Bitget candles, caches for a minute and fails open', async () => {
  const startMs = Date.UTC(2026, 9, 17, 0, 0, 0);
  const nowMs = startMs + 10 * 300_000;
  let calls = 0;
  const reader = createBtcBenchmarkDrawdownReader(async () => {
    calls += 1;
    return bitgetCandles([100, 100, 100, 100, 100, 100, 100, 100, 100, 92], startMs);
  });
  assert.equal(await reader(nowMs), 8);
  assert.equal(await reader(nowMs + 30_000), 8);
  assert.equal(calls, 1);

  const failing = createBtcBenchmarkDrawdownReader(async () => { throw new Error('network'); });
  assert.equal(await failing(nowMs), null);
  const malformed = createBtcBenchmarkDrawdownReader(async () => ({ code: '40001', data: null }));
  assert.equal(await malformed(nowMs), null);
});
