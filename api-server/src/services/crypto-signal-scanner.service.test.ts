import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCryptoSignalScannerService,
  type CryptoCandle,
  type CryptoScannerProviders,
  type CryptoTicker,
  type CryptoUniverse,
} from './crypto-signal-scanner.service';
import {
  evaluateCryptoWilliamsDailyCandles,
  type CryptoWilliamsDailyCandle,
} from './crypto-williams-atr-scanner-overlay.service';

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

function williamsLongDailyCandles(): CryptoWilliamsDailyCandle[] {
  const start = Date.UTC(2026, 6, 1);
  return Array.from({ length: 17 }, (_, index) => {
    if (index === 16) {
      return {
        time: start + index * 24 * 60 * 60_000,
        open: 120,
        high: 126,
        low: 119,
        close: 125,
      };
    }
    const close = 100 + index;
    return {
      time: start + index * 24 * 60 * 60_000,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
    };
  });
}

function williamsShortDailyCandles(): CryptoWilliamsDailyCandle[] {
  const start = Date.UTC(2026, 6, 1);
  return Array.from({ length: 17 }, (_, index) => {
    if (index === 16) {
      return {
        time: start + index * 24 * 60 * 60_000,
        open: 110,
        high: 111,
        low: 106,
        close: 107,
      };
    }
    const close = 130 - index;
    return {
      time: start + index * 24 * 60 * 60_000,
      open: close + 1,
      high: close + 2,
      low: close - 2,
      close,
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

test('Williams spot overlay uses completed KST09 sessions and produces LONG with ATR stop', () => {
  const evaluation = evaluateCryptoWilliamsDailyCandles({
    market: 'spot',
    candles: williamsLongDailyCandles(),
    currentPrice: 125,
  });
  assert.equal(evaluation.status, 'ENTRY');
  assert.equal(evaluation.direction, 'LONG');
  assert.equal(evaluation.previousHigh, 117);
  assert.equal(evaluation.previousLow, 113);
  assert.equal(evaluation.sessionOpen, 120);
  assert.equal(evaluation.longTarget, 122);
  assert.ok((evaluation.stopPrice ?? 0) < 125);
});

test('Williams current-session high/low cannot leak into MA5, ATR14 or prior range', () => {
  const baseline = williamsLongDailyCandles();
  const first = evaluateCryptoWilliamsDailyCandles({ market: 'spot', candles: baseline, currentPrice: 125 });
  const mutated = baseline.map((row, index) => index === baseline.length - 1
    ? { ...row, high: 1_000_000, low: 0.01, close: 125 }
    : row);
  const second = evaluateCryptoWilliamsDailyCandles({ market: 'spot', candles: mutated, currentPrice: 125 });
  assert.equal(second.previousHigh, first.previousHigh);
  assert.equal(second.previousLow, first.previousLow);
  assert.equal(second.movingAverage, first.movingAverage);
  assert.equal(second.atr, first.atr);
  assert.equal(second.longTarget, first.longTarget);
});

test('Williams futures permits SHORT while spot keeps SHORT disabled', () => {
  const rows = williamsShortDailyCandles();
  const futures = evaluateCryptoWilliamsDailyCandles({ market: 'futures', candles: rows, currentPrice: 107 });
  assert.equal(futures.status, 'ENTRY');
  assert.equal(futures.direction, 'SHORT');
  assert.ok((futures.stopPrice ?? 0) > 107);

  const spot = evaluateCryptoWilliamsDailyCandles({ market: 'spot', candles: rows, currentPrice: 107 });
  assert.equal(spot.status, 'NO_ENTRY');
  assert.equal(spot.direction, null);
  assert.ok(spot.reasons.includes('spot_short_disabled'));
});