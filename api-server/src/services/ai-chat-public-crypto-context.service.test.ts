import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicCryptoAiContextFromRoom,
  loadPublicCryptoAiContext,
  PublicCryptoAiContextError,
} from './ai-chat-public-crypto-context.service';
import type {
  MarketInformationAssetRow,
  MarketInformationMeta,
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';

const now = '2026-08-10T07:00:00.000Z';

function asset(symbol: string, overrides: Partial<MarketInformationAssetRow> = {}): MarketInformationAssetRow {
  return {
    symbol,
    name: symbol,
    exchange: symbol.includes('USDT') ? 'BITGET' : 'UPBIT',
    currency: symbol.includes('USDT') ? 'USDT' : 'KRW',
    price: 100,
    changePercent: 1.2,
    high24h: 105,
    low24h: 95,
    volume24h: 1_000,
    tradingValue24h: 100_000,
    marketCap: null,
    warning: false,
    tradingStatus: 'ACTIVE',
    fundingRatePercent: null,
    nextFundingAt: null,
    openInterest: null,
    rangeVolatility24hPercent: 10.5,
    providerUpdatedAt: now,
    ...overrides,
  };
}

function response(room: MarketInformationRoomId, rows: MarketInformationAssetRow[]): MarketInformationResponse {
  const market: MarketInformationResponse['market'] = room === 'coins-spot' ? 'spot' : 'futures';
  const assetType: MarketInformationResponse['assetType'] = room === 'coins-spot' ? 'coin-spot' : 'coin-futures';
  const currency: MarketInformationResponse['currency'] = room === 'coins-spot' ? 'KRW' : 'USDT';
  const meta: MarketInformationMeta = {
    provider: room === 'coins-spot' ? 'Upbit' : 'Bitget',
    source: room === 'coins-spot' ? 'Upbit 공식 공개 Quotation API' : 'Bitget 공식 공개 USDT-FUTURES market API',
    market,
    assetType,
    currency,
    providerUpdatedAt: now,
    observedAt: now,
    fetchedAt: now,
    marketTimeZone: room === 'coins-spot' ? 'Asia/Seoul' : 'UTC',
    marketStatus: '24H',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
  return {
    ok: true,
    room,
    market,
    assetType,
    currency,
    fetchedAt: now,
    partial: false,
    sections: {
      indices: { status: 'unsupported', data: [], meta, message: null },
      rankings: { status: 'ready', data: rows, meta, message: null },
      sectors: { status: 'unsupported', data: [], meta, message: null },
      news: { status: 'unavailable', data: [], meta, message: null },
      disclosures: { status: 'unsupported', data: [], meta, message: null },
      derivatives: {
        status: room === 'coins-futures' ? 'ready' : 'unsupported',
        data: {
          referenceSymbol: 'BTCUSDT',
          longRatio: 0.52,
          shortRatio: 0.48,
          longShortRatio: 1.0833,
          ratioObservedAt: now,
          liquidations: [
            { symbol: 'BTCUSDT', side: 'long', price: 99, amount: 10, occurredAt: now },
            { symbol: 'ETHUSDT', side: 'short', price: 49, amount: 20, occurredAt: now },
          ],
        },
        meta,
        message: null,
      },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

test('Upbit AI context uses only the selected KRW spot asset and declares missing technical/news data', () => {
  const result = buildPublicCryptoAiContextFromRoom('UPBIT', 'KRW-BTC', response('coins-spot', [asset('BTC')]));
  assert.equal(result.symbol, 'BTC');
  assert.equal(result.quote?.exchange, 'UPBIT');
  assert.equal(result.quote?.price, 100);
  assert.equal(result.derivatives, null);
  assert.equal(result.disclosure.status, 'partial');
  assert.ok(result.disclosure.missing.includes('OHLCV·기술지표'));
  assert.ok(result.disclosure.missing.includes('검증된 코인 뉴스'));
});

test('Bitget AI context includes public funding OI and symbol-matched derivatives only', () => {
  const result = buildPublicCryptoAiContextFromRoom('BITGET', 'BTCUSDT', response('coins-futures', [
    asset('BTCUSDT', { fundingRatePercent: 0.01, openInterest: 12345 }),
  ]));
  assert.equal(result.quote?.exchange, 'BITGET');
  assert.equal(result.derivatives?.fundingRatePercent, 0.01);
  assert.equal(result.derivatives?.openInterest, 12345);
  assert.equal(result.derivatives?.longShortRatio, 1.0833);
  assert.deepEqual(result.derivatives?.liquidations.map((item) => item.side), ['long']);
});

test('Bitget BTC long-short ratio is never mixed into another futures symbol', () => {
  const result = buildPublicCryptoAiContextFromRoom('BITGET', 'ETHUSDT', response('coins-futures', [
    asset('ETHUSDT', { fundingRatePercent: -0.005, openInterest: 222 }),
  ]));
  assert.equal(result.derivatives?.longShortRatio, null);
  assert.equal(result.derivatives?.longRatio, null);
  assert.equal(result.derivatives?.shortRatio, null);
  assert.ok(result.disclosure.missing.includes('선택 종목 long/short ratio'));
  assert.deepEqual(result.derivatives?.liquidations.map((item) => item.side), ['short']);
});

test('AI crypto context fails closed if a room reports any private/account/order request', () => {
  const safe = response('coins-spot', [asset('BTC')]);
  const unsafe = {
    ...safe,
    requestPolicy: { ...safe.requestPolicy, privateExchangeRequests: 1 },
  } as unknown as MarketInformationResponse;
  assert.throws(
    () => buildPublicCryptoAiContextFromRoom('UPBIT', 'BTC', unsafe),
    (cause: unknown) => cause instanceof PublicCryptoAiContextError && cause.code === 'AI_CRYPTO_PRIVATE_BOUNDARY_VIOLATION',
  );
});

test('AI crypto context selects the correct public room and forwards AbortSignal', async () => {
  const controller = new AbortController();
  let observedRoom: MarketInformationRoomId | null = null;
  let observedSignal: AbortSignal | undefined;
  const result = await loadPublicCryptoAiContext('BITGET', 'BTCUSDT', controller.signal, async (room, signal) => {
    observedRoom = room;
    observedSignal = signal;
    return response('coins-futures', [asset('BTCUSDT')]);
  });
  assert.equal(observedRoom, 'coins-futures');
  assert.equal(observedSignal, controller.signal);
  assert.equal(result.symbol, 'BTCUSDT');
});