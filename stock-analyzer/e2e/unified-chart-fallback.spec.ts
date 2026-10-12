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

const preflightBars = [
  { time: '2026-10-10T00:00:00Z', open: 100, high: 103, low: 99, close: 102, volume: 10 },
  { time: '2026-10-10T00:05:00Z', open: 102, high: 104, low: 101, close: 103, volume: 11 },
];

test('stock primary HTTP 502 recovers through bounded read-only /chart alternate', async () => {
  const calls: string[] = [];
  const result = await fetchUnifiedChartData({
    market: 'US', symbol: 'AAPL', timeframe: '5m', timeoutMs: 5_000,
    fetcher: async input => {
      const url = String(input);
      calls.push(url);
      return new Response(url.includes('/candles?')
        ? JSON.stringify({ ok: false, message: 'provider unavailable' })
        : JSON.stringify({ ok: true, ticker: 'AAPL', timeframe: '5m', provider: 'verified-alternate', candles: preflightBars }),
        { status: url.includes('/candles?') ? 502 : 200 });
    },
  });
  expect(calls).toEqual(['/api/stocks/AAPL/candles?tf=5m', '/api/stocks/AAPL/chart?tf=5m']);
  expect(result.provider).toBe('verified-alternate');
  expect(result.normalization.candles).toHaveLength(2);
});

test('stock network failure reaches alternate but HTTP 429 never fans out', async () => {
  const calls: string[] = [];
  const result = await fetchUnifiedChartData({
    market: 'US', symbol: 'AAPL', timeframe: '5m', timeoutMs: 5_000,
    fetcher: async input => {
      const url = String(input); calls.push(url);
      if (url.includes('/candles?')) throw new TypeError('network offline');
      return new Response(JSON.stringify({ ticker: 'AAPL', timeframe: '5m', candles: preflightBars }), { status: 200 });
    },
  });
  expect(result.normalization.candles).toHaveLength(2);
  expect(calls).toHaveLength(2);
  const rateCalls: string[] = [];
  await expect(fetchUnifiedChartData({
    market: 'US', symbol: 'AAPL', timeframe: '5m', timeoutMs: 5_000,
    fetcher: async input => {
      rateCalls.push(String(input));
      return new Response(JSON.stringify({ message: 'Rate limited' }), { status: 429 });
    },
  })).rejects.toMatchObject({ kind: 'rate-limited', status: 429 });
  expect(rateCalls).toEqual(['/api/stocks/AAPL/candles?tf=5m']);
});

test('cross-symbol and cross-timeframe HTTP 200 candles fail closed for all four markets', async () => {
  const cases = [
    { market: 'KR' as const, symbol: '005930', meta: { ticker: '000660', timeframe: '5m' } },
    { market: 'US' as const, symbol: 'AAPL', meta: { ticker: 'MSFT', timeframe: '5m' } },
    { market: 'UPBIT' as const, symbol: 'BTC', meta: { market: 'KRW-ETH', unit: '5m' } },
    { market: 'BITGET' as const, symbol: 'BTCUSDT', meta: { symbol: 'ETHUSDT', timeframe: '5m' } },
    { market: 'US' as const, symbol: 'AAPL', meta: { ticker: 'AAPL', timeframe: '1D' } },
    { market: 'US' as const, symbol: 'AAPL', meta: { ticker: 'AAPL', timeframe: '5m', ok: false } },
    { market: 'US' as const, symbol: 'AAPL', meta: { ticker: 'AAPL', timeframe: '5m', ok: 'false' } },
  ];
  for (const item of cases) {
    const requests: string[] = [];
    await expect(fetchUnifiedChartData({
      market: item.market, symbol: item.symbol, timeframe: '5m',
      fetcher: async input => {
        requests.push(String(input));
        return new Response(JSON.stringify({ candles: preflightBars, ...item.meta }), { status: 200 });
      },
    })).rejects.toMatchObject({ kind: 'malformed-response', retryable: false });
    expect(requests).toHaveLength(1);
  }
});

test('canonical response tags preserve valid stock, Bitget and Upbit 1H/60m aliases', async () => {
  const cases = [
    { market: 'KR' as const, symbol: '005930', tf: '5m' as const, meta: { ticker: '005930', timeframe: '5m' } },
    { market: 'US' as const, symbol: 'AAPL', tf: '5m' as const, meta: { ticker: 'AAPL', timeframe: '5m' } },
    { market: 'UPBIT' as const, symbol: 'BTC', tf: '1H' as const, meta: { market: 'KRW-BTC', unit: '60m' } },
    { market: 'BITGET' as const, symbol: 'BTCUSDT', tf: '5m' as const, meta: { symbol: 'BTCUSDT', timeframe: '5m', exchange: 'BITGET' } },
  ];
  for (const item of cases) {
    const candles = item.tf === '1H'
      ? [preflightBars[0], { ...preflightBars[1], time: '2026-10-10T01:00:00Z' }]
      : preflightBars;
    const result = await fetchUnifiedChartData({
      market: item.market, symbol: item.symbol, timeframe: item.tf,
      fetcher: async () => new Response(JSON.stringify({ ok: true, candles, ...item.meta }), { status: 200 }),
    });
    expect(result.normalization.candles).toHaveLength(2);
    expect(result.symbol).toBe(item.symbol);
  }
});

test('a failed primary cannot be laundered into success by an empty HTTP 200 alternate', async () => {
  const calls: string[] = [];
  await expect(fetchUnifiedChartData({
    market: 'KR', symbol: '005930', timeframe: '5m', timeoutMs: 5_000,
    fetcher: async input => {
      const url = String(input); calls.push(url);
      if (url.includes('/candles?')) return new Response(JSON.stringify({ ok: false, error: 'UPSTREAM_503' }), { status: 503 });
      return new Response(JSON.stringify({}), { status: 200 });
    },
  })).rejects.toMatchObject({ kind: 'server', status: 503 });
  expect(calls).toEqual([
    '/api/stocks/005930/candles?tf=5m',
    '/api/stocks/005930/chart?tf=5m',
    '/api/stocks/005930/chart?tf=5m',
  ]);
});

test('a legitimate completed empty provider response without a primary error remains visibly insufficient', async () => {
  const result = await fetchUnifiedChartData({
    market: 'US', symbol: 'AAPL', timeframe: '5m', timeoutMs: 5_000,
    fetcher: async () => new Response(JSON.stringify({ ok: true, candles: [] }), { status: 200 }),
  });
  expect(result.normalization.candles).toHaveLength(0);
});
