import { test, expect } from '@playwright/test';
import {
  fetchUnifiedChartData,
  type UnifiedChartFetch,
} from '../src/lib/unified-chart-data';

test('US stock chart falls back when primary endpoint exceeds its bounded attempt', async () => {
  const calls: string[] = [];
  const fetcher: UnifiedChartFetch = async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url.includes('/candles?')) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) {
          rejectAbort();
          return;
        }
        signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }

    return new Response(JSON.stringify({
      provider: 'fallback-fixture',
      fetchedAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
      candles: [
        { time: '2026-08-18T00:00:00Z', open: 100, high: 105, low: 99, close: 104, volume: 10 },
        { time: '2026-08-19T00:00:00Z', open: 104, high: 107, low: 103, close: 106, volume: 11 },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const data = await fetchUnifiedChartData({
    market: 'US',
    symbol: 'AAPL',
    timeframe: '1D',
    timeoutMs: 1_200,
    fetcher,
  });

  expect(calls).toEqual([
    '/api/stocks/AAPL/candles?tf=1D',
    '/api/stocks/AAPL/chart?tf=1D',
  ]);
  expect(data.sourceUrl).toBe('/api/stocks/AAPL/chart?tf=1D');
  expect(data.provider).toBe('fallback-fixture');
  expect(data.normalization.candles).toHaveLength(2);
});

test('US stock fallback is already in flight before the slow primary cutoff', async () => {
  const calls: Array<{ url: string; startedAt: number }> = [];
  const startedAt = Date.now();
  const fetcher: UnifiedChartFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, startedAt: Date.now() - startedAt });
    if (url.includes('/candles?')) {
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    return new Response(JSON.stringify({
      provider: 'hedged-fallback-fixture',
      candles: [
        { time: '2026-08-18T00:00:00Z', open: 100, high: 105, low: 99, close: 104, volume: 10 },
        { time: '2026-08-19T00:00:00Z', open: 104, high: 107, low: 103, close: 106, volume: 11 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const data = await fetchUnifiedChartData({
    market: 'US',
    symbol: 'AAPL',
    timeframe: '1D',
    timeoutMs: 5_000,
    fetcher,
  });

  expect(calls.map(({ url }) => url)).toEqual([
    '/api/stocks/AAPL/candles?tf=1D',
    '/api/stocks/AAPL/chart?tf=1D',
  ]);
  expect(calls[1].startedAt).toBeLessThan(3_000);
  expect(data.sourceUrl).toBe('/api/stocks/AAPL/chart?tf=1D');
  expect(data.normalization.candles).toHaveLength(2);
});


test('US stock soft deadline selects fallback without aborting the in-flight primary request', async () => {
  let primaryAborted = false;
  const fetcher: UnifiedChartFetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/candles?')) {
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          primaryAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return new Response(JSON.stringify({
      provider: 'soft-deadline-fallback-fixture',
      candles: [
        { time: '2026-08-18T00:00:00Z', open: 100, high: 105, low: 99, close: 104, volume: 10 },
        { time: '2026-08-19T00:00:00Z', open: 104, high: 107, low: 103, close: 106, volume: 11 },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const data = await fetchUnifiedChartData({
    market: 'US',
    symbol: 'AAPL',
    timeframe: '1D',
    timeoutMs: 1_200,
    fetcher,
  });

  expect(data.sourceUrl).toBe('/api/stocks/AAPL/chart?tf=1D');
  expect(primaryAborted).toBe(false);
});
