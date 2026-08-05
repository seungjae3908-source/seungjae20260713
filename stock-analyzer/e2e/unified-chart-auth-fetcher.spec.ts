import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  configureUnifiedChartFetch,
  fetchUnifiedChartData,
} from '../src/lib/unified-chart-data';

const originalFetch = globalThis.fetch;

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

function candles() {
  return Array.from({ length: 3 }, (_, index) => ({
    time: 1_775_000_000 + index * 300,
    open: 80_000 + index,
    high: 80_004 + index,
    low: 79_997 + index,
    close: 80_002 + index,
    volume: 1_000 + index,
    isClosed: true,
  }));
}

test.afterEach(() => {
  configureUnifiedChartFetch(null);
  globalThis.fetch = originalFetch;
});

test('browser runtime wires the authenticated fetcher into unified chart requests', async () => {
  const mainSource = fs.readFileSync(
    path.join(analyzerDirectory(), 'src/main.tsx'),
    'utf8',
  );
  expect(mainSource).toContain("import { authorizedFetch } from '@/lib/auth-fetch';");
  expect(mainSource).toContain('configureUnifiedChartFetch(authorizedFetch);');

  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    throw new Error('unauthenticated global fetch must not be used');
  };

  const observed: Array<{
    url: string;
    authorization: string | null;
    cacheControl: string | null;
  }> = [];

  configureUnifiedChartFetch(async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', 'Bearer regression-session-token');
    observed.push({
      url: String(input),
      authorization: headers.get('Authorization'),
      cacheControl: headers.get('Cache-Control'),
    });
    return new Response(JSON.stringify({
      provider: 'authenticated-chart-fixture',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      candles: candles(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const result = await fetchUnifiedChartData({
    market: 'KR',
    symbol: '005930',
    timeframe: '5m',
  });

  expect(result.provider).toBe('authenticated-chart-fixture');
  expect(observed).toEqual([{
    url: '/api/stocks/005930/chart?tf=5m',
    authorization: 'Bearer regression-session-token',
    cacheControl: 'no-cache, no-store, max-age=0',
  }]);
  expect(globalFetchCalls).toBe(0);
});
