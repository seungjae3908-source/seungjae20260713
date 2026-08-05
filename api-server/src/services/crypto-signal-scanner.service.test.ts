import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCryptoSignalScannerService,
  type CryptoCandle,
  type CryptoScannerProviders,
  type CryptoTicker,
  type CryptoUniverse,
} from './crypto-signal-scanner.service';

const now = () => Date.now();

function ticker(symbol: string): CryptoTicker {
  return {
    symbol,
    name: symbol,
    price: 120,
    changePercent: 4,
    volume: 2_000_000,
    tradingValue: 20_000_000_000,
    bid: 119.9,
    ask: 120.1,
    fundingRate: 0.0001,
    openInterest: 5_000_000,
    timestamp: Date.now(),
    warning: false,
  };
}

function candles(count = 40): CryptoCandle[] {
  const current = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      time: current - (count - index) * 60_000,
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
      volume: index === count - 1 ? 300_000 : 100_000,
      quoteVolume: 10_000_000,
    };
  });
}

function universe(rows: CryptoTicker[], source: CryptoUniverse['source'] = 'upbit-public'): CryptoUniverse {
  return { rows, source, providerErrorCount: 0 };
}

function request(market: 'spot' | 'futures' = 'spot') {
  return {
    memberId: 'member-1',
    market,
    timeframe: '15m' as const,
    condition: 'trend' as const,
    cursor: 0,
    batchSize: 10,
    minimumScore: 0,
    maximumRiskScore: 100,
  };
}

function providers(overrides: Partial<CryptoScannerProviders> = {}): CryptoScannerProviders {
  return {
    getUniverse: async (market) => universe(
      [ticker('BTC'), ticker('ETH')],
      market === 'spot' ? 'upbit-public' : 'bitget-public',
    ),
    getCandles: async () => candles(),
    getSpread: async (_market, row) => ({ bid: row.bid, ask: row.ask }),
    now,
    ...overrides,
  };
}

test('Upbit spot scanner uses public data and never emits SHORT or order flags', async () => {
  const service = createCryptoSignalScannerService(providers());
  const result = await service.scan(request('spot'));
  assert.equal(result.assetClass, 'coin_spot');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.execution.providerErrorCount, 0);
  assert.ok(result.cards.length > 0);
  assert.ok(result.cards.every((card) => card.direction !== 'SHORT'));
  assert.ok(result.cards.every((card) => card.warnings.includes('현물 Scanner에는 숏·레버리지를 적용하지 않습니다.')));
});

test('one slow crypto symbol is reported as timeout and partial instead of disappearing', async () => {
  const service = createCryptoSignalScannerService(providers({
    getCandles: async (_market, symbol, _timeframe, signal) => {
      if (symbol !== 'ETH') return candles();
      return await new Promise<CryptoCandle[]>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  }));
  const result = await service.scan(request('spot'));
  assert.equal(result.execution.partial, true);
  assert.equal(result.execution.timeoutCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].symbol, 'ETH');
  assert.equal(result.failures[0].reason, 'timeout');
  assert.ok(result.cards.some((card) => card.symbol === 'BTC'));
});

test('provider outage returns last-good result as stale without READY alert', async () => {
  let failUniverse = false;
  const service = createCryptoSignalScannerService(providers({
    getUniverse: async () => {
      if (failUniverse) throw new Error('provider down');
      return universe([ticker('BTC')]);
    },
  }));
  const first = await service.scan(request('spot'));
  assert.equal(first.dataState, 'complete');
  failUniverse = true;
  const fallback = await service.scan(request('spot'));
  assert.equal(fallback.dataState, 'stale');
  assert.equal(fallback.universe.stale, true);
  assert.equal(fallback.alerts.length, 0);
  assert.ok(fallback.cards.every((card) => card.score <= 49 && !card.strongSignalEligible));
  assert.equal(fallback.failures[0].reason, 'provider_error');
});

test('caller abort stops the crypto scanner instead of returning a late success', async () => {
  const controller = new AbortController();
  const service = createCryptoSignalScannerService(providers({
    getCandles: async (_market, _symbol, _timeframe, signal) => await new Promise<CryptoCandle[]>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  }));
  const pending = service.scan({ ...request('futures'), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 20);
  await assert.rejects(pending, /test abort/);
});
