import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import stocksRouter from './stocks';
import cryptoRouter from './crypto';

const BEFORE = Date.parse('2026-09-16T12:00:00.000Z');
const YAHOO_TIMES = [BEFORE - 2 * 86_400_000, BEFORE - 86_400_000, BEFORE];

function yahooFixture() {
  return {
    chart: {
      result: [{
        timestamp: YAHOO_TIMES.map((time) => time / 1_000),
        indicators: {
          quote: [{
            open: [100, 101, 102],
            high: [104, 105, 106],
            low: [95, 96, 97],
            close: [101, 102, 103],
            volume: [10, 20, 30],
          }],
        },
      }],
    },
  };
}

function upbitCandle(time: number) {
  return {
    candle_date_time_utc: new Date(time).toISOString().replace(/Z$/u, ''),
    opening_price: 100, high_price: 104, low_price: 95, trade_price: 101,
    candle_acc_trade_volume: 5, candle_acc_trade_price: 505,
  };
}

function bitgetCandle(time: number) {
  return [String(time), '100', '104', '95', '101', '5', '505'];
}

function assertPublicOnly(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  for (const key of ['authorization', 'access-key', 'access-sign', 'access-passphrase', 'x-api-key']) {
    assert.equal(headers.has(key), false, `public candle read must not send ${key}`);
  }
  assert.ok(!init?.method || init.method === 'GET', 'historical candle provider only supports public GET');
}

test('four-market historical HTTP routes use genuine prior-to provider windows, exclude boundary rows, and send no secrets', async () => {
  const nativeFetch = globalThis.fetch;
  const publicCalls: URL[] = [];
  let upbitOverlapOnly = false;
  let bitgetOverlapOnly = false;
  let bitgetAscendingWithDuplicate = false;
  let upbitHistoryMode: 'normal' | 'empty' | 'empty-once' = 'normal';
  let upbitHistoryRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw);
    if (url.hostname === '127.0.0.1') return nativeFetch(input, init);
    publicCalls.push(url);
    assertPublicOnly(init);
    if (url.hostname === 'query1.finance.yahoo.com' || url.hostname === 'query2.finance.yahoo.com') {
      assert.equal(url.searchParams.has('range'), false, 'historical Yahoo request must not ignore cursor');
      assert.equal(url.searchParams.get('period2'), String(BEFORE / 1_000));
      assert.equal(url.searchParams.get('interval'), '1d');
      if (url.pathname.endsWith('/005930.KS')) return Response.json({ error: 'not listed on KOSPI' }, { status: 404 });
      assert.ok(url.pathname.endsWith('/AAPL') || url.pathname.endsWith('/005930.KQ'));
      return Response.json(yahooFixture());
    }
    if (url.hostname === 'api.upbit.com') {
      assert.equal(url.pathname, '/v1/candles/minutes/5');
      assert.equal(url.searchParams.get('market'), 'KRW-BTC');
      assert.equal(url.searchParams.get('to'), new Date(BEFORE).toISOString());
      if (upbitHistoryMode === 'empty' || (upbitHistoryMode === 'empty-once' && ++upbitHistoryRequests === 1)) {
        if (upbitHistoryMode === 'empty') upbitHistoryRequests += 1;
        return Response.json([]);
      }
      return Response.json(upbitOverlapOnly ? [upbitCandle(BEFORE)] : [
        upbitCandle(BEFORE), upbitCandle(BEFORE - 300_000),
      ]);
    }
    if (url.hostname === 'api.bitget.com') {
      assert.equal(url.pathname, '/api/v2/mix/market/history-candles');
      assert.equal(url.searchParams.get('productType'), 'USDT-FUTURES');
      assert.equal(url.searchParams.get('granularity'), '5m');
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
      assert.equal(url.searchParams.get('endTime'), String(BEFORE - 1));
      return Response.json({
        code: '00000', data: bitgetOverlapOnly
          ? [bitgetCandle(BEFORE)]
          : bitgetAscendingWithDuplicate
            ? [
                bitgetCandle(BEFORE - 600_000),
                bitgetCandle(BEFORE - 300_000),
                bitgetCandle(BEFORE - 300_000),
                bitgetCandle(BEFORE),
              ]
            : [bitgetCandle(BEFORE), bitgetCandle(BEFORE - 300_000)],
      });
    }
    throw new Error(`UNEXPECTED_PUBLIC_HISTORICAL_PROVIDER:${url.origin}`);
  }) as typeof fetch;

  const app = express();
  app.use('/api/stocks', stocksRouter);
  app.use('/api', cryptoRouter);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (route: string) => {
      const response = await nativeFetch(`${base}${route}`);
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body };
    };

    for (const symbol of ['AAPL', '005930']) {
      const { status, body } = await call(`/api/stocks/${symbol}/history-candles?tf=1D&before=${BEFORE}`);
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      const candles = body.candles as Array<{ time: string }>;
      assert.equal(candles.length, 2, 'historical stock endpoint must exclude equal-to-cursor bar');
      assert.ok(candles.every((bar) => Date.parse(bar.time) < BEFORE));
    }
    assert.ok(publicCalls.some((url) => url.pathname.endsWith('/005930.KS')));
    assert.ok(publicCalls.some((url) => url.pathname.endsWith('/005930.KQ')),
      'KOSDAQ fallback must resolve a real Yahoo .KQ symbol');

    const spot = await call(`/api/crypto/spot/candles?symbol=BTC&unit=5&before=${encodeURIComponent(new Date(BEFORE).toISOString())}`);
    assert.equal(spot.status, 200);
    assert.equal(spot.body.ok, true);
    assert.equal(spot.body.count, 1);
    assert.ok((spot.body.candles as Array<{ time: string }>).every((bar) => Date.parse(bar.time) < BEFORE));

    const futures = await call(`/api/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&before=${BEFORE}`);
    assert.equal(futures.status, 200);
    assert.equal(futures.body.ok, true);
    assert.equal(futures.body.count, 1);
    assert.ok((futures.body.candles as Array<{ time: number }>).every((bar) => bar.time < BEFORE));

    const priorCalls = publicCalls.length;
    for (const route of [
      '/api/stocks/AAPL/history-candles?tf=1D&before=invalid',
      '/api/crypto/spot/candles?symbol=BTC&unit=5&before=invalid',
      '/api/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&before=-1',
      `/api/crypto/futures/candles?symbol=BTCUSDT&granularity=2m&before=${BEFORE}`,
    ]) {
      const response = await call(route);
      assert.equal(response.status, 400);
    }
    assert.equal(publicCalls.length, priorCalls, 'invalid cursors must not contact market providers');

    upbitOverlapOnly = true;
    const overlap = await call(`/api/crypto/spot/candles?symbol=BTC&unit=5&before=${encodeURIComponent(new Date(BEFORE).toISOString())}`);
    assert.equal(overlap.status, 502);
    assert.equal(overlap.body.error, 'UPBIT_HISTORY_CURSOR_NO_PROGRESS');
    assert.deepEqual(overlap.body.candles, []);


    // Prior overlap-only probe must not contaminate the empty/recovery cases.
    upbitOverlapOnly = false;

    // Two genuine successful empty upstream history pages can mean the earliest
    // available Upbit candle has been reached. Unlike an initial chart request,
    // this is a valid no-older-bars result, not a provider failure.
    upbitHistoryMode = 'empty';
    upbitHistoryRequests = 0;
    const emptyHistory = await call(`/api/crypto/spot/candles?symbol=BTC&unit=5&before=${encodeURIComponent(new Date(BEFORE).toISOString())}`);
    assert.equal(emptyHistory.status, 200);
    assert.equal(emptyHistory.body.ok, true);
    assert.deepEqual(emptyHistory.body.candles, []);
    assert.equal(emptyHistory.body.count, 0);
    assert.equal(emptyHistory.body.sourceExhausted, true);
    assert.equal(upbitHistoryRequests, 2, 'one bounded confirmation retry must precede exhaustion');

    // One transient empty page followed by real source candles must recover.
    upbitHistoryMode = 'empty-once';
    upbitHistoryRequests = 0;
    const recoveredHistory = await call(`/api/crypto/spot/candles?symbol=BTC&unit=5&before=${encodeURIComponent(new Date(BEFORE).toISOString())}`);
    assert.equal(recoveredHistory.status, 200);
    assert.equal(recoveredHistory.body.count, 1);
    assert.equal(recoveredHistory.body.sourceExhausted, false);
    assert.equal(upbitHistoryRequests, 2);
    upbitHistoryMode = 'normal';

    bitgetOverlapOnly = true;
    const futuresOverlap = await call(`/api/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&before=${BEFORE}`);
    assert.equal(futuresOverlap.status, 502);
    assert.equal(futuresOverlap.body.error, 'BITGET_HISTORY_CURSOR_NO_PROGRESS');
    assert.deepEqual(futuresOverlap.body.candles, []);

    // Some real Bitget history responses are already ascending. Blind
    // reverse() would corrupt chronological order; duplicate source times
    // must not produce duplicate chart bars.
    bitgetOverlapOnly = false;
    bitgetAscendingWithDuplicate = true;
    const orderedFutures = await call(`/api/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&before=${BEFORE}`);
    assert.equal(orderedFutures.status, 200);
    assert.equal(orderedFutures.body.ok, true);
    assert.deepEqual((orderedFutures.body.candles as Array<{ time: number }>).map((row) => row.time),
      [BEFORE - 600_000, BEFORE - 300_000]);
    assert.equal(orderedFutures.body.count, 2);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
