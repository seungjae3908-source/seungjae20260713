import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCryptoFuturesDirectionalScannerService,
  type FuturesDirectionalRuntimeProviders,
  type FuturesDirectionalTicker,
} from './crypto-futures-directional-scanner.service';
import type { FuturesDirectionalCandle } from './crypto-futures-directional-formula.service';

const FIXED_NOW = Date.UTC(2026, 7, 27, 0, 0, 0);

function ticker(symbol: string, price: number, changePercent: number, fundingRate: number): FuturesDirectionalTicker {
  return {
    symbol,
    name: symbol,
    price,
    changePercent,
    volume: 5_000_000,
    tradingValue: 50_000_000_000,
    bid: price * 0.9995,
    ask: price * 1.0005,
    fundingRate,
    openInterest: 10_000_000,
    timestamp: FIXED_NOW - 30_000,
  };
}

function trendCandles(direction: 'up' | 'down', count = 40): FuturesDirectionalCandle[] {
  const step = 15 * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const base = direction === 'up' ? 100 + index * 0.5 : 120 - index;
    return {
      time: FIXED_NOW - (count - index) * step,
      open: direction === 'up' ? base - 0.2 : base + 0.4,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 100_000,
      quoteVolume: 10_000_000,
    };
  });
}

function providers(overrides: Partial<FuturesDirectionalRuntimeProviders> = {}): FuturesDirectionalRuntimeProviders {
  return {
    getUniverse: async () => ({
      source: 'bitget-public',
      providerErrorCount: 0,
      rows: [
        ticker('BTCUSDT', 120, 4, -0.0007),
        ticker('ETHUSDT', 80, -4, 0.0008),
      ],
    }),
    getCandles: async (symbol) => symbol === 'BTCUSDT' ? trendCandles('up') : trendCandles('down'),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function request(view: 'LONG' | 'SHORT' | 'BOTH' = 'BOTH') {
  return {
    memberId: 'member-1',
    view,
    strategyMode: 'scalping' as const,
    timeframe: '15m',
    condition: 'trend' as const,
    cursor: 0,
    batchSize: 10,
    minimumScore: 0,
    maximumRiskScore: 100,
    limit: 10,
  };
}

test('futures directional runtime keeps LONG and SHORT in separate ranked lanes', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers());
  const result = await service.scan(request('BOTH'));

  assert.equal(result.ok, true);
  assert.equal(result.assetClass, 'coin_futures');
  assert.equal(result.requestedView, 'BOTH');
  assert.equal(result.cards.length, 0, 'BOTH never flattens two directions into one mixed ranking');
  assert.ok(result.lanes.long.cards.length > 0);
  assert.ok(result.lanes.short.cards.length > 0);
  assert.ok(result.lanes.long.cards.every((card) => card.direction === 'LONG' && card.action === 'LONG'));
  assert.ok(result.lanes.short.cards.every((card) => card.direction === 'SHORT' && card.action === 'SHORT'));
  assert.equal(result.lanes.long.cards[0].symbol, 'BTCUSDT');
  assert.equal(result.lanes.short.cards[0].symbol, 'ETHUSDT');
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.liveTradingEnabled, false);
});

test('single-direction views expose only the selected lane and never invert the other lane', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers());
  const long = await service.scan(request('LONG'));
  const short = await service.scan(request('SHORT'));

  assert.ok(long.cards.length > 0 && long.cards.every((card) => card.direction === 'LONG'));
  assert.ok(short.cards.length > 0 && short.cards.every((card) => card.direction === 'SHORT'));
  assert.notDeepEqual(
    long.lanes.long.cards.map((card) => [card.symbol, card.score]),
    short.lanes.short.cards.map((card) => [card.symbol, card.score]),
  );
});

test('futures directional runtime fails closed to NO_TRADE when public universe is unavailable', async () => {
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getUniverse: async () => { throw new Error('provider down'); },
  }));
  const result = await service.scan(request('BOTH'));

  assert.equal(result.dataState, 'unavailable');
  assert.equal(result.lanes.long.decision, 'NO_TRADE');
  assert.equal(result.lanes.short.decision, 'NO_TRADE');
  assert.equal(result.cards.length, 0);
  assert.equal(result.failures[0]?.reason, 'provider_error');
  assert.equal(result.orderSubmitted, false);
});

test('futures directional runtime propagates caller abort instead of returning a late success', async () => {
  const controller = new AbortController();
  const service = createCryptoFuturesDirectionalScannerService(providers({
    getCandles: async (_symbol, _timeframe, signal) => await new Promise<FuturesDirectionalCandle[]>((_resolve, reject) => {
      const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  }));
  const pending = service.scan({ ...request('BOTH'), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 10);
  await assert.rejects(pending, /test abort/);
});
