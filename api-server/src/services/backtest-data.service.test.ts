import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHistoricalBacktestCandles } from './backtest-data.service';
import { BacktestValidationError } from './backtest-engine.service';

const STEP = 15 * 60_000;
const START = Date.UTC(2026, 0, 1);
const NOW = START + 10 * STEP;

function row(index: number, close = 100) {
  const timestamp = START + index * STEP;
  return [String(timestamp), String(close), String(close + 1), String(close - 1), String(close), '100', '10000'];
}

function fetchRows(rows: unknown[]) {
  return (async () => new Response(JSON.stringify({ code: '00000', msg: 'success', data: rows }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
}

test('historical loader returns sorted completed candles', async () => {
  const result = await loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '15m', startTime: START, endTime: START + 2 * STEP,
    now: NOW, fetchImpl: fetchRows([row(2), row(0), row(1)]),
  });
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [START, START + STEP, START + 2 * STEP]);
});

test('historical loader removes duplicate timestamps', async () => {
  const result = await loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '15m', startTime: START, endTime: START + STEP,
    now: NOW, fetchImpl: fetchRows([row(0), row(0, 101), row(1)]),
  });
  assert.equal(result.candles.length, 2);
});

test('historical loader excludes incomplete final candles', async () => {
  const result = await loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '15m', startTime: START, endTime: NOW,
    now: NOW, fetchImpl: fetchRows([row(0), row(10)]),
  });
  assert.equal(result.candles.some((candle) => candle.timestamp === NOW), false);
});

test('historical loader reports gaps without inventing candles', async () => {
  const result = await loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '15m', startTime: START, endTime: START + 3 * STEP,
    now: NOW, fetchImpl: fetchRows([row(0), row(3)]),
  });
  assert.equal(result.candles.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes('누락 구간')));
});

test('historical loader rejects unsupported timeframe before network', async () => {
  await assert.rejects(() => loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '2m', startTime: START, endTime: START + STEP,
    fetchImpl: fetchRows([]),
  }), (error: unknown) => error instanceof BacktestValidationError && error.code === 'INVALID_TIMEFRAME');
});

test('historical loader rejects requests above maximum candle count', async () => {
  await assert.rejects(() => loadHistoricalBacktestCandles({
    symbol: 'BTCUSDT', timeframe: '1m', startTime: START, endTime: START + 20_001 * 60_000,
    fetchImpl: fetchRows([]),
  }), (error: unknown) => error instanceof BacktestValidationError && error.code === 'CANDLE_LIMIT_EXCEEDED');
});
