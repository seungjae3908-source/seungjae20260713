import assert from 'node:assert/strict';
import test from 'node:test';

import { getIndexQuote, getQuote } from './yahoo';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function updatedAtOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('updatedAt' in value)) return undefined;
  const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}

function chartResult(options: {
  regularMarketTime?: number;
  timestamp?: number;
  price?: number;
} = {}) {
  const price = options.price ?? 250;
  const timestamp = options.timestamp ?? Math.floor(Date.parse('2026-09-10T09:30:00.000Z') / 1000);
  return {
    chart: {
      result: [{
        meta: {
          currency: 'USD',
          regularMarketPrice: price,
          regularMarketTime: options.regularMarketTime,
          previousClose: price - 1,
        },
        timestamp: [timestamp],
        indicators: {
          quote: [{
            open: [price - 0.5],
            high: [price + 1],
            low: [price - 1],
            close: [price],
            volume: [1000],
          }],
        },
      }],
    },
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

test('preserves Yahoo regularMarketTime instead of request wall clock', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  const providerTime = Math.floor(Date.parse('2026-09-10T09:42:17.000Z') / 1000);
  globalThis.fetch = async () => response(chartResult({ regularMarketTime: providerTime }));

  const quote = await getQuote('AAPL');
  assert.equal(updatedAtOf(quote), '2026-09-10T09:42:17.000Z');
  assert.notEqual(updatedAtOf(quote), new Date(Date.now()).toISOString());
});

test('uses the timestamp aligned with the last valid Yahoo candle when meta time is absent', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  const candleTime = Math.floor(Date.parse('2026-09-10T09:31:00.000Z') / 1000);
  globalThis.fetch = async () => response(chartResult({ timestamp: candleTime }));

  const quote = await getQuote('MSFT');
  const index = await getIndexQuote('^GSPC');
  assert.equal(updatedAtOf(quote), '2026-09-10T09:31:00.000Z');
  assert.equal(index.updatedAt, '2026-09-10T09:31:00.000Z');
});

test('fails closed on materially future Yahoo provider time', async () => {
  Date.now = () => Date.parse('2026-09-10T10:00:00.000Z');
  const futureTime = Math.floor(Date.parse('2026-09-10T10:10:01.000Z') / 1000);
  globalThis.fetch = async () => response(chartResult({ regularMarketTime: futureTime }));

  await assert.rejects(getQuote('NVDA'), /YAHOO_PROVIDER_TIMESTAMP_INVALID/);
});

function dailySeriesResult(options: {
  symbol: string;
  closes: number[];
  dayStarts: string[];
  regularMarketPrice: number;
  regularMarketTime: string;
  chartPreviousClose: number;
  previousClose?: number;
}) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: options.symbol,
          currency: 'KRW',
          regularMarketPrice: options.regularMarketPrice,
          regularMarketTime: Math.floor(Date.parse(options.regularMarketTime) / 1000),
          chartPreviousClose: options.chartPreviousClose,
          previousClose: options.previousClose,
          gmtoffset: 32_400,
        },
        timestamp: options.dayStarts.map(value => Math.floor(Date.parse(value) / 1000)),
        indicators: {
          quote: [{
            open: options.closes,
            high: options.closes,
            low: options.closes,
            close: options.closes,
            volume: options.closes.map(() => 100),
          }],
        },
      }],
    },
  };
}

test('daily change uses the prior daily bar, never the 1mo chartPreviousClose', async () => {
  Date.now = () => Date.parse('2026-10-16T07:00:00.000Z');
  globalThis.fetch = async () => response(dailySeriesResult({
    symbol: '^KS11',
    closes: [3000, 3100, 3200],
    dayStarts: ['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'],
    regularMarketPrice: 3200,
    regularMarketTime: '2026-10-16T06:30:00.000Z',
    chartPreviousClose: 3800,
  }));

  const index = await getIndexQuote('^KS11');
  assert.equal(index.changeAmount, 100);
  assert.ok(Math.abs(index.changePercent - (100 / 3100) * 100) < 1e-9);

  globalThis.fetch = async () => response(dailySeriesResult({
    symbol: '005930.KS',
    closes: [70000, 71000, 72000],
    dayStarts: ['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'],
    regularMarketPrice: 72000,
    regularMarketTime: '2026-10-16T06:30:00.000Z',
    chartPreviousClose: 85000,
  }));
  const quote = await getQuote('005930.KS') as { previousClose?: number; changeAmount?: number };
  assert.equal(quote.previousClose, 71000);
  assert.equal(quote.changeAmount, 1000);
});

test('uses the last bar as previous close when today has no daily bar yet', async () => {
  Date.now = () => Date.parse('2026-10-16T01:00:00.000Z');
  globalThis.fetch = async () => response(dailySeriesResult({
    symbol: '^KS11',
    closes: [3000, 3100],
    dayStarts: ['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z'],
    regularMarketPrice: 3131,
    regularMarketTime: '2026-10-16T00:30:00.000Z',
    chartPreviousClose: 3800,
  }));

  const index = await getIndexQuote('^KS11');
  assert.equal(index.changeAmount, 31);
});

test('falls back to meta.previousClose only when the series has no prior bar', async () => {
  Date.now = () => Date.parse('2026-10-16T07:00:00.000Z');
  globalThis.fetch = async () => response(dailySeriesResult({
    symbol: '^KS11',
    closes: [3200],
    dayStarts: ['2026-10-16T00:00:00.000Z'],
    regularMarketPrice: 3200,
    regularMarketTime: '2026-10-16T06:30:00.000Z',
    chartPreviousClose: 3800,
    previousClose: 3150,
  }));

  const index = await getIndexQuote('^KS11');
  assert.equal(index.changeAmount, 50);
});
