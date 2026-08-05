import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChartCandles,
  parseChartCandleTime,
  type ChartCandleTimeframe,
} from './chart-candle-normalizer';
import {
  UnifiedChartDataError,
  buildUnifiedChartUrls,
  fetchUnifiedChartData,
  normalizeUnifiedSymbol,
} from './unified-chart-data';

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

test('multi-market request builder maps every required market and timeframe', () => {
  assert.deepEqual(
    buildUnifiedChartUrls({ market: 'KR', symbol: '005930', timeframe: '1m' }),
    ['/api/stocks/005930/chart?tf=1m', '/api/stocks/005930/candles?tf=1m'],
  );
  assert.deepEqual(
    buildUnifiedChartUrls({ market: 'US', symbol: 'aapl', timeframe: '4H' }),
    ['/api/stocks/AAPL/chart?tf=4H', '/api/stocks/AAPL/candles?tf=4H'],
  );
  assert.deepEqual(
    buildUnifiedChartUrls({ market: 'UPBIT', symbol: 'KRW-BTC', timeframe: '1H' }),
    ['/api/crypto/spot/candles?symbol=BTC&count=200&unit=60'],
  );
  assert.deepEqual(
    buildUnifiedChartUrls({ market: 'UPBIT', symbol: 'BTC', timeframe: '1D' }),
    ['/api/crypto/spot/candles?symbol=BTC&count=200&tf=1D'],
  );
  assert.deepEqual(
    buildUnifiedChartUrls({ market: 'BITGET', symbol: 'btc-usdt', timeframe: '15m' }),
    ['/api/crypto/futures/candles?symbol=BTCUSDT&granularity=15m&limit=300'],
  );
});

test('symbols are normalized without silently replacing an invalid market symbol', () => {
  assert.equal(normalizeUnifiedSymbol('KR', ' 005930 '), '005930');
  assert.equal(normalizeUnifiedSymbol('US', 'brk.b'), 'BRK.B');
  assert.equal(normalizeUnifiedSymbol('UPBIT', 'KRW-BTC'), 'BTC');
  assert.equal(normalizeUnifiedSymbol('BITGET', 'btc/usdt'), 'BTCUSDT');
  assert.equal(normalizeUnifiedSymbol('KR', 'INVALID'), '');
});

test('stock chart falls back only after a missing primary route and keeps strict normalization', async () => {
  const calls: string[] = [];
  const result = await fetchUnifiedChartData({
    market: 'KR',
    symbol: '005930',
    timeframe: '5m',
    fetcher: async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        provider: 'test',
        fetchedAt: '2026-08-04T00:00:00.000Z',
        candles: [
          candle(1_700_000_000, 100),
          candle('invalid-time', 999),
          candle(1_700_000_300, 101),
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.normalization.candles.length, 2);
  assert.equal(result.normalization.droppedRows, 1);
  assert.equal(result.provider, 'test');
});

test('HTTP 429 is classified as retryable rate limiting without using the fallback route', async () => {
  let calls = 0;
  await assert.rejects(
    fetchUnifiedChartData({
      market: 'US',
      symbol: 'AAPL',
      timeframe: '1m',
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof UnifiedChartDataError);
      assert.equal(error.kind, 'rate-limited');
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('malformed successful payload is rejected and an empty candle list stays explicit', async () => {
  await assert.rejects(
    fetchUnifiedChartData({
      market: 'UPBIT',
      symbol: 'BTC',
      timeframe: '15m',
      fetcher: async () => new Response('not-json', { status: 200 }),
    }),
    (error: unknown) => error instanceof UnifiedChartDataError && error.kind === 'malformed-response',
  );

  const empty = await fetchUnifiedChartData({
    market: 'BITGET',
    symbol: 'EMPTYUSDT',
    timeframe: '15m',
    fetcher: async () => new Response(JSON.stringify({ provider: 'test', candles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  assert.equal(empty.normalization.candles.length, 0);
});
