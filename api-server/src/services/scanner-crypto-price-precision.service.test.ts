import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCryptoSignalScannerService,
  type CryptoCandle,
  type CryptoScannerProviders,
  type CryptoTicker,
  type CryptoUniverse,
} from './crypto-signal-scanner.service';
import { createCryptoPricePrecisionService } from './scanner-crypto-price-precision.service';

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

function universe(rows: CryptoTicker[], source: CryptoUniverse['source']): CryptoUniverse {
  return { rows, source, providerErrorCount: 0 };
}

function providers(market: 'spot' | 'futures'): CryptoScannerProviders {
  const rows = market === 'spot'
    ? [ticker('BTC'), ticker('ETH')]
    : [ticker('BTCUSDT'), ticker('ETHUSDT')];
  return {
    getUniverse: async () => universe(rows, market === 'spot' ? 'upbit-public' : 'bitget-public'),
    getCandles: async () => candles(),
    getSpread: async (_market, row) => ({ bid: row.bid, ask: row.ask }),
    now: Date.now,
  };
}

async function scan(market: 'spot' | 'futures') {
  return await createCryptoSignalScannerService(providers(market)).scan({
    memberId: 'precision-test-member',
    market,
    timeframe: '15m',
    condition: 'trend',
    cursor: 0,
    batchSize: 10,
    minimumScore: 0,
    maximumRiskScore: 100,
  });
}

function isTickAligned(value: number, tick: number) {
  const units = value / tick;
  return Math.abs(units - Math.round(units)) < 1e-7;
}

test('Upbit precision aligns every emitted crypto price plan to public tick_size metadata', async () => {
  const raw = await scan('spot');
  assert.ok(raw.cards.length >= 2);
  const urls: string[] = [];
  const service = createCryptoPricePrecisionService(async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify([
      { market: 'KRW-BTC', tick_size: 0.1 },
      { market: 'KRW-ETH', tick_size: 0.1 },
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const aligned = await service.align('spot', raw);
  assert.deepEqual(urls, ['https://api.upbit.com/v1/orderbook/instruments?markets=KRW-BTC%2CKRW-ETH']);
  assert.equal(aligned.orderSubmitted, false);
  assert.equal(aligned.exchangeRequestSent, false);
  assert.equal(aligned.execution.providerErrorCount, raw.execution.providerErrorCount);
  assert.ok(aligned.cards.every((card) => card.dataSources.includes('upbit-public-orderbook-instruments')));
  for (const card of aligned.cards) {
    assert.ok(card.pricePlan.entryZone);
    assert.ok(card.pricePlan.stopLoss != null);
    assert.ok(card.pricePlan.invalidation != null);
    assert.ok(card.pricePlan.targets.length > 0);
    assert.ok(card.pricePlan.riskReward != null);
    const values = [
      card.pricePlan.entryZone.from,
      card.pricePlan.entryZone.to,
      card.pricePlan.stopLoss,
      card.pricePlan.invalidation,
      ...card.pricePlan.targets,
    ];
    assert.ok(values.every((value) => isTickAligned(value, 0.1)));
  }
});

test('Bitget precision derives price tick from public contract pricePlace and priceEndStep', async () => {
  const raw = await scan('futures');
  const urls: string[] = [];
  const service = createCryptoPricePrecisionService(async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      code: '00000',
      data: [
        { symbol: 'BTCUSDT', pricePlace: '2', priceEndStep: '5' },
        { symbol: 'ETHUSDT', pricePlace: '2', priceEndStep: '5' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const aligned = await service.align('futures', raw);
  assert.deepEqual(urls, ['https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES']);
  assert.ok(aligned.cards.every((card) => card.dataSources.includes('bitget-public-contracts')));
  for (const card of aligned.cards) {
    assert.ok(card.pricePlan.entryZone);
    const values = [
      card.pricePlan.entryZone.from,
      card.pricePlan.entryZone.to,
      card.pricePlan.stopLoss,
      card.pricePlan.invalidation,
      ...card.pricePlan.targets,
    ].filter((value): value is number => value != null);
    assert.ok(values.length > 0);
    assert.ok(values.every((value) => isTickAligned(value, 0.05)));
  }
});

test('precision provider failure fails closed by clearing price plans and strong-signal eligibility', async () => {
  const raw = await scan('spot');
  const service = createCryptoPricePrecisionService(async () => new Response('provider unavailable', { status: 503 }));
  const aligned = await service.align('spot', raw);

  assert.equal(aligned.execution.providerErrorCount, raw.execution.providerErrorCount + 1);
  assert.equal(aligned.execution.partial, true);
  assert.equal(aligned.dataState, 'partial');
  assert.equal(aligned.alerts.length, 0);
  assert.equal(aligned.orderSubmitted, false);
  assert.equal(aligned.exchangeRequestSent, false);
  for (const card of aligned.cards) {
    assert.equal(card.pricePlan.entryZone, null);
    assert.equal(card.pricePlan.stopLoss, null);
    assert.equal(card.pricePlan.invalidation, null);
    assert.deepEqual(card.pricePlan.targets, []);
    assert.equal(card.pricePlan.riskReward, null);
    assert.equal(card.strongSignalEligible, false);
    assert.ok(card.warnings.includes('시장 가격 단위 데이터 부족'));
  }
});
