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
          symbol: 'AAPL',
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
