import test from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '../data/catalog';
import { BoundedWorkTimeoutError } from '../lib/bounded-work-pool';
import type { Candle, Quote } from '../sample/types';
import {
  ScanProviderUnavailableError,
  createBoundedScannerService,
  type BoundedScannerDependencies,
} from './bounded-scanner.service';
import { MarketDataService } from './market-data.service';
import { ScannerProviderHealthTracker } from './scanner-provider-health.service';

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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deps(
  catalog: CatalogEntry[],
  overrides: Partial<BoundedScannerDependencies> = {},
): BoundedScannerDependencies {
  return {
    catalog,
    getCandles: async () => candleRows(),
    getQuote: async () => quoteRow(),
    getContext: async () => ({ currency: 'KRW' }),
    now: Date.now,
    ...overrides,
  };
}

test('per-item timeout signal reaches mandatory provider dependencies without becoming a provider rejection', async () => {
  let candleSignal: AbortSignal | undefined;
  let quoteSignal: AbortSignal | undefined;
  const waitForAbort = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    assert.ok(signal, 'mandatory provider dependency must receive the per-item signal');
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const service = createBoundedScannerService(deps([item(1)], {
    getCandles: async (_ticker, _timeframe, signal) => {
      candleSignal = signal;
      return waitForAbort(signal);
    },
    getQuote: async (ticker, signal) => {
      if (ticker === '^KS11') return quoteRow();
      quoteSignal = signal;
      return waitForAbort(signal);
    },
  }));

  await assert.rejects(
    service.scan('KR', ['PER 낮음'], {}, {
      deadlineMs: 120,
      itemTimeoutMs: 30,
      concurrency: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScanProviderUnavailableError);
      assert.match(error.message, /providerErrors=0/u);
      assert.match(error.message, /workerErrors=0/u);
      assert.match(error.message, /timeouts=1/u);
      return true;
    },
  );
  assert.equal(candleSignal?.aborted, true);
  assert.equal(quoteSignal?.aborted, true);
});

test('actual mandatory provider rejection is counted as provider error', async () => {
  const service = createBoundedScannerService(deps([item(1), item(2)], {
    getCandles: async (ticker) => {
      if (ticker === 'T002') throw new Error('provider unavailable');
      return candleRows();
    },
  }));

  const result = await service.scan('KR', ['PER 낮음'], {}, {
    deadlineMs: 500,
    itemTimeoutMs: 200,
    concurrency: 2,
  });
  assert.equal(result.completedCount, 1);
  assert.equal(result.providerErrorCount, 1);
  assert.equal(result.workerErrorCount, 0);
  assert.equal(result.timeoutCount, 0);
  assert.equal(result.partial, true);
});

test('internal scanner worker rejection is not mislabeled as provider failure', async () => {
  const service = createBoundedScannerService(deps([item(1)], {
    getCandles: async () => null as unknown as Candle[],
  }));

  await assert.rejects(
    service.scan('KR', ['PER 낮음'], {}, {
      deadlineMs: 500,
      itemTimeoutMs: 200,
      concurrency: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ScanProviderUnavailableError, false);
      assert.match(error.message, /^SCAN_WORKER_ERROR:/u);
      assert.match(error.message, /providerErrors=0/u);
      assert.match(error.message, /workerErrors=1/u);
      return true;
    },
  );
});

test('provider health remains timeout after logical cancellation even when raw work resolves later', async () => {
  const marketData = MarketDataService as unknown as {
    getQuote: (ticker: string) => Promise<Quote>;
  };
  const originalGetQuote = marketData.getQuote;
  let resolveQuote: ((value: Quote) => void) | undefined;
  marketData.getQuote = async () => new Promise<Quote>((resolve) => {
    resolveQuote = resolve;
  });

  const tracker = new ScannerProviderHealthTracker();
  const controller = new AbortController();
  const pending = tracker.getQuote('KR', '005930', controller.signal);
  const timeoutError = new BoundedWorkTimeoutError(25);

  try {
    controller.abort(timeoutError);
    await assert.rejects(pending, (error: unknown) => error === timeoutError);
    resolveQuote?.(quoteRow());
    await wait(0);

    const health = tracker.snapshot();
    assert.equal(health.some((row) => row.state === 'READY'), false);
    const quoteChain = health.find((row) => row.provider === 'stock-quote-chain');
    assert.equal(quoteChain?.state, 'TIMEOUT');
    assert.equal(quoteChain?.timeout, true);
  } finally {
    marketData.getQuote = originalGetQuote;
  }
});
