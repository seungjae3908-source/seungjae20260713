import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKET_INFORMATION_ROUTES,
  MarketInformationContractError,
  marketInformationDetailPath,
  marketInformationRoute,
  parseMarketInformationResponse,
  parseMarketInformationText,
  type MarketInformationResponse,
  type MarketInformationRoute,
} from './market-information';

const NOW = '2026-08-05T00:00:00.000Z';

function fixture(route: MarketInformationRoute): MarketInformationResponse {
  const assetType = route.id === 'coins-spot'
    ? 'coin-spot' as const
    : route.id === 'coins-futures'
      ? 'coin-futures' as const
      : 'stock' as const;
  const meta = {
    provider: 'fixture',
    source: 'public fixture',
    market: route.market,
    assetType,
    currency: route.currency,
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: route.market === 'KR' ? 'Asia/Seoul' : route.market === 'US' ? 'America/New_York' : route.market === 'spot' ? 'Asia/Seoul' : 'UTC',
    marketStatus: route.asset === 'coin' ? '24H' as const : 'CLOSED' as const,
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
  return {
    ok: true,
    room: route.id,
    market: route.market,
    assetType,
    currency: route.currency,
    fetchedAt: NOW,
    partial: false,
    sections: {
      indices: { status: 'ready', data: [{ key: 'INDEX', label: '지수', value: 0, changePercent: null }], meta, message: null },
      rankings: {
        status: 'ready',
        data: [{
          symbol: route.asset === 'stock' ? 'TEST' : 'BTC',
          name: '테스트',
          exchange: route.exchange,
          currency: route.currency,
          price: 0,
          changePercent: 0,
          high24h: null,
          low24h: null,
          volume24h: 0,
          tradingValue24h: 0,
          marketCap: null,
          warning: false,
          tradingStatus: null,
          fundingRatePercent: null,
          nextFundingAt: null,
          openInterest: null,
          rangeVolatility24hPercent: null,
          providerUpdatedAt: NOW,
        }],
        meta,
        message: null,
      },
      sectors: { status: 'empty', data: [], meta, message: null },
      news: { status: 'empty', data: [], meta, message: null },
      disclosures: { status: 'empty', data: [], meta, message: null },
      derivatives: {
        status: 'unsupported',
        data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] },
        meta,
        message: '미지원',
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

test('market information parser accepts null and real zero without coercion', () => {
  const route = MARKET_INFORMATION_ROUTES[0];
  const parsed = parseMarketInformationResponse(fixture(route), route);
  const row = parsed.sections.rankings.data[0];
  assert.equal(row.price, 0);
  assert.equal(row.changePercent, 0);
  assert.equal(row.volume24h, 0);
  assert.equal(row.marketCap, null);
  assert.equal(parsed.sections.indices.data[0].changePercent, null);
});

test('market information parser rejects empty body, invalid JSON, primitive, and empty object', () => {
  const route = MARKET_INFORMATION_ROUTES[0];
  assert.throws(
    () => parseMarketInformationText('', route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'EMPTY_RESPONSE_BODY',
  );
  assert.throws(
    () => parseMarketInformationText('{', route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'INVALID_RESPONSE_JSON',
  );
  assert.throws(
    () => parseMarketInformationResponse(1, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'EMPTY_RESPONSE_OBJECT',
  );
  assert.throws(
    () => parseMarketInformationResponse({}, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'EMPTY_RESPONSE_OBJECT',
  );
});

test('market information parser rejects wrong room, currency, timestamps, and missing fields', () => {
  const route = MARKET_INFORMATION_ROUTES[0];
  const wrongRoom = fixture(route);
  wrongRoom.room = 'stocks-us';
  assert.throws(
    () => parseMarketInformationResponse(wrongRoom, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'ROOM_CONTRACT_MISMATCH',
  );

  const wrongCurrency = fixture(route);
  wrongCurrency.sections.rankings.data[0].currency = 'USD';
  assert.throws(
    () => parseMarketInformationResponse(wrongCurrency, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'ASSET_CURRENCY_MISMATCH',
  );

  const invalidTime = fixture(route);
  invalidTime.sections.rankings.meta.fetchedAt = 'not-a-time';
  assert.throws(
    () => parseMarketInformationResponse(invalidTime, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'INVALID_TIMESTAMP',
  );

  const missingSections = fixture(route) as unknown as Record<string, unknown>;
  delete missingSections.sections;
  assert.throws(
    () => parseMarketInformationResponse(missingSections, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'INVALID_RESPONSE_META',
  );
});

test('market information parser fails closed when private or order counts are nonzero', () => {
  const route = MARKET_INFORMATION_ROUTES[3];
  const payload = fixture(route);
  payload.requestPolicy.privateExchangeRequests = 1 as 0;
  assert.throws(
    () => parseMarketInformationResponse(payload, route),
    (error: unknown) => error instanceof MarketInformationContractError && error.code === 'OUTBOUND_POLICY_VIOLATION',
  );
});

test('market information route and detail adapters preserve existing navigation contracts', () => {
  const kr = marketInformationRoute('/stocks/kr?tab=volume');
  const futures = marketInformationRoute('/coins/futures');
  assert.ok(kr);
  assert.ok(futures);
  assert.equal(kr.id, 'stocks-kr');
  assert.equal(futures.id, 'coins-futures');
  assert.equal(marketInformationRoute('/unknown'), null);
  assert.equal(marketInformationDetailPath(kr, '005930'), '/stock-info?asset=stock&market=KR&ticker=005930');
  assert.equal(marketInformationDetailPath(futures, 'btcusdt'), '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT');
});
