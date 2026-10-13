import { test, expect } from '@playwright/test';
import { buildUnifiedChartHistoryUrl, fetchUnifiedChartHistoryPage } from '../src/lib/unified-chart-data';
import { retainLogicalViewportOnHistoryPrepend } from '../src/lib/chart-history-viewport';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

test('historical cursor queries are market- and symbol-bound and exclusive', () => {
  const beforeTime = 1_780_000_000;
  const spot = buildUnifiedChartHistoryUrl({ market: 'UPBIT', symbol: 'BTC', timeframe: '5m', beforeTime });
  const futures = buildUnifiedChartHistoryUrl({ market: 'BITGET', symbol: 'BTCUSDT', timeframe: '5m', beforeTime });
  const kr = buildUnifiedChartHistoryUrl({ market: 'KR', symbol: '005930', timeframe: '1D', beforeTime });
  expect(spot).toContain('/api/crypto/spot/candles?');
  expect(decodeURIComponent(spot)).toContain(new Date(beforeTime * 1000).toISOString());
  expect(futures).toContain('before=1780000000000');
  expect(kr).toContain('/api/stocks/005930/history-candles?');
  const stockHistoryRoute = source('../../api-server/src/routes/stocks.ts');
  expect(stockHistoryRoute).toContain('getYahooHistoricalCandles(`${ticker}.KQ`, timeframe, before)');
  expect(() => buildUnifiedChartHistoryUrl({ market: 'KR', symbol: '', timeframe: '1D', beforeTime })).toThrow();
});

test('older candles normalize, reject overlap and never synthesize missing bars', async () => {
  const beforeTime = Math.floor(Date.now() / 1000) - 60;
  const candles = [beforeTime - 600, beforeTime - 300, beforeTime, beforeTime + 300].map((time) => ({
    time, open: 100, high: 105, low: 95, close: 101, volume: 3,
  }));
  const result = await fetchUnifiedChartHistoryPage({
    market: 'UPBIT', symbol: 'BTC', timeframe: '5m', beforeTime,
    fetcher: async () => new Response(JSON.stringify({ ok: true, candles }), { status: 200 }),
  });
  expect(result.map((row) => row.time)).toEqual([beforeTime - 600, beforeTime - 300]);
  await expect(fetchUnifiedChartHistoryPage({
    market: 'UPBIT', symbol: 'BTC', timeframe: '5m', beforeTime,
    fetcher: async () => new Response(JSON.stringify({ ok: true, candles: 'invalid' }), { status: 200 }),
  })).rejects.toThrow('과거 캔들 응답');
});


test('provider overlap-only or invalid historical rows are errors, not false end-of-history', async () => {
  const beforeTime = Math.floor(Date.now() / 1000) - 60;
  const validRow = (time: number) => ({ time, open: 100, high: 105, low: 95, close: 101, volume: 3 });
  const fetchRows = (candles: unknown[]) => fetchUnifiedChartHistoryPage({
    market: 'US' as const, symbol: 'AAPL', timeframe: '5m' as const, beforeTime,
    fetcher: async () => new Response(JSON.stringify({ ok: true, candles }), { status: 200 }),
  });
  await expect(fetchRows([validRow(beforeTime), validRow(beforeTime + 300)]))
    .rejects.toMatchObject({ kind: 'malformed-response', retryable: true });
  await expect(fetchRows([{ ...validRow(beforeTime - 300), high: 90 }]))
    .rejects.toMatchObject({ kind: 'malformed-response', retryable: true });
  // A genuinely empty provider page remains the only valid exhaustion signal.
  await expect(fetchRows([])).resolves.toEqual([]);
});

test('runtime integrates historical pages and AI analyses accepted live candles', () => {
  const chart = source('../src/components/unified-analysis-chart.tsx');
  const scanner = source('../src/pages/signal-scanner.tsx');
  expect(chart).toContain('fetchUnifiedChartHistoryPage');
  expect(chart).toContain('setLiveCandle(reconciled.latestCandle)');
  expect(chart).toContain('data: effectiveChartData,');
  expect(chart).toContain('data-testid="chart-history-load-previous"');
  expect(chart).toContain('onRequestOlderCandles={loadPreviousCandles}');
  expect(chart).toContain("historyStatus === 'capped'");
  const canvas = source('../src/components/pattern-aware-unified-chart-canvas.tsx');
  expect(canvas).toContain('onWheelCapture');
  expect(canvas).toContain('onPointerDownCapture');
  expect(canvas).toContain('gestureToOldestRef.current && canLoadOlderRef.current');
  expect(canvas).toContain('gestureToOldestRef.current = false');
  expect(scanner).toContain('displayedRequestKey.current === requestKey ? storedData : null');
  expect(scanner).toContain('const batchSize = stockView ? 12 : 10');
});

test('history prepend keeps the same real candle dates on screen', () => {
  const prior = { from: 18, to: 110 };
  expect(retainLogicalViewportOnHistoryPrepend(prior, 500, [100, 200, 300, 400, 500, 600, 700]))
    .toEqual({ from: 22, to: 114 });
  // A REST refresh changing the newest candle does not move the user's viewport.
  expect(retainLogicalViewportOnHistoryPrepend(prior, 500, [500, 600, 700, 800]))
    .toEqual(prior);
  expect(retainLogicalViewportOnHistoryPrepend(prior, null, [100, 500])).toEqual(prior);
  const canvas = source('../src/components/pattern-aware-unified-chart-canvas.tsx');
  expect(canvas).toContain('retainLogicalViewportOnHistoryPrepend(');
  expect(canvas).toContain('previouslyRenderedOldestTimeRef.current = candles[0]?.time ?? null;');
});
