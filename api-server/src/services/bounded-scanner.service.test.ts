import test from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '../data/catalog';
import type { SignalContext } from '../sample/accumulation';
import type { Candle, Quote } from '../sample/types';
import {
  ScanProviderUnavailableError,
  ScanRequestAbortedError,
  createBoundedScannerService,
  type BoundedScannerDependencies,
} from './bounded-scanner.service';

const item = (index: number): CatalogEntry => ({
  ticker: `T${String(index).padStart(3, '0')}`,
  name: `Test ${index}`,
  market: 'KR',
  currency: 'KRW',
});

const candleRows = (): Candle[] => Array.from({ length: 80 }, (_, index) => {
  const close = 100 + index * 0.4;
  return {
    time: Date.now() - (80 - index) * 86_400_000,
    open: close - 0.2,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10_000 + index * 100,
  };
});

const quoteRow = (): Quote => ({
  price: 132,
  changeAmount: 1,
  changePercent: 0.8,
  volume: 20_000,
  marketCap: 10_000_000_000,
  week52High: 140,
  week52Low: 80,
});

const signalContext = (per = 5): SignalContext => ({
  financialSource: 'live',
  financials: { per, pbr: 0.8, roe: 12 },
  negativeEvents: [],
  positiveEvents: [],
  riskDataAvailable: true,
  newsScore: 0,
  newsPositive: 0,
  newsNegative: 0,
  currency: 'KRW',
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deps(
  catalog: CatalogEntry[],
  overrides: Partial<BoundedScannerDependencies> = {},
): BoundedScannerDependencies {
  return {
    catalog,
    getCandles: async () => candleRows(),
    getQuote: async () => quoteRow(),
    getContext: async () => signalContext(),
    now: Date.now,
    ...overrides,
  };
}

test('normal scan completes with bounded concurrency', async () => {
  const service = createBoundedScannerService(deps([item(1), item(2), item(3)]));
  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 500,
    itemTimeoutMs: 200,
    concurrency: 2,
  });
  assert.equal(result.partial, false);
  assert.equal(result.completedCount, 3);
  assert.equal(result.cards.length, 3);
  assert.ok(result.maxConcurrency <= 2);
});

test('zero matches is a complete empty result', async () => {
  const service = createBoundedScannerService(deps(
    [item(1), item(2)],
    { getContext: async () => signalContext(30) },
  ));
  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 500,
    itemTimeoutMs: 200,
    concurrency: 2,
  });
  assert.equal(result.partial, false);
  assert.equal(result.dataState, 'complete');
  assert.deepEqual(result.cards, []);
});

test('some item timeouts return explicit partial data', async () => {
  const service = createBoundedScannerService(deps([item(1), item(2), item(3)], {
    getCandles: async (ticker) => {
      if (ticker === 'T001') return candleRows();
      await wait(120);
      return candleRows();
    },
  }));
  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 150,
    itemTimeoutMs: 35,
    concurrency: 2,
  });
  assert.equal(result.partial, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.completedCount, 1);
  assert.equal(result.timeoutCount, 2);
  assert.equal(result.cards.length, 1);
});

test('complete provider failure remains strict', async () => {
  const service = createBoundedScannerService(deps([item(1), item(2)], {
    getCandles: async () => {
      throw new Error('provider unavailable');
    },
  }));
  await assert.rejects(
    service.scan('KR', ['PER 낮음'], {}, {
      deadlineMs: 300,
      itemTimeoutMs: 100,
      concurrency: 2,
    }),
    ScanProviderUnavailableError,
  );
});

test('deadline prevents the full catalog from starting', async () => {
  const started: string[] = [];
  let active = 0;
  let maximum = 0;
  const catalog = Array.from({ length: 40 }, (_, index) => item(index));
  const service = createBoundedScannerService(deps(catalog, {
    getCandles: async (ticker) => {
      started.push(ticker);
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await wait(28);
        return candleRows();
      } finally {
        active -= 1;
      }
    },
  }));
  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 90,
    itemTimeoutMs: 45,
    concurrency: 3,
  });
  assert.equal(result.partial, true);
  assert.ok(result.scanned < catalog.length);
  assert.equal(started.length, result.scanned);
  assert.ok(maximum <= 3);
});

test('matched cards reuse one candles and context lookup per symbol', async () => {
  const candleCalls = new Map<string, number>();
  const contextCalls = new Map<string, number>();
  const catalog = [item(1), item(2), item(3)];
  const service = createBoundedScannerService(deps(catalog, {
    getCandles: async (ticker) => {
      candleCalls.set(ticker, (candleCalls.get(ticker) ?? 0) + 1);
      return candleRows();
    },
    getContext: async (entry) => {
      contextCalls.set(entry.ticker, (contextCalls.get(entry.ticker) ?? 0) + 1);
      return signalContext();
    },
  }));
  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 500,
    itemTimeoutMs: 200,
    concurrency: 2,
  });
  assert.equal(result.completedCount, 3);
  for (const entry of catalog) {
    assert.equal(candleCalls.get(entry.ticker), 1);
    assert.equal(contextCalls.get(entry.ticker), 1);
  }
});

test('request abort rejects instead of producing a late success', async () => {
  const controller = new AbortController();
  const service = createBoundedScannerService(deps([item(1), item(2)], {
    getCandles: async () => {
      await wait(80);
      return candleRows();
    },
  }));
  const pending = service.scan('KR', ['PER 낮음'], {}, {
    signal: controller.signal,
    deadlineMs: 500,
    itemTimeoutMs: 300,
    concurrency: 2,
  });
  setTimeout(() => controller.abort(new ScanRequestAbortedError()), 10);
  await assert.rejects(pending, ScanRequestAbortedError);
});
