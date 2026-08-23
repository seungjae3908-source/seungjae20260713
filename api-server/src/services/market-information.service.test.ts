import assert from 'node:assert/strict';
import test from 'node:test';
import './four-market-auto-readiness.test';
import {
  dedupeMarketNews,
  fetchPublicMarketJson,
  MarketInformationError,
  normalizeBitgetDerivatives,
  normalizeBitgetTickers,
  normalizeUpbitMarkets,
  normalizeUpbitTickers,
  validatePublicMarketUrl,
  type MarketInformationNewsRow,
} from './market-information.service';

const jsonResponse = (body: unknown, status = 200, extraHeaders?: HeadersInit) => {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
};

const noSleep = async () => undefined;

test('public market URL guard permits only quotation endpoints and blocks private paths', () => {
  assert.equal(validatePublicMarketUrl('https://api.upbit.com/v1/ticker?markets=KRW-BTC').pathname, '/v1/ticker');
  assert.equal(validatePublicMarketUrl('https://api.bitget.com/api/v3/market/liquidations?category=USDT-FUTURES').pathname, '/api/v3/market/liquidations');
  assert.throws(
    () => validatePublicMarketUrl('https://api.upbit.com/v1/accounts'),
    (error: unknown) => error instanceof MarketInformationError && error.code === 'PUBLIC_MARKET_URL_BLOCKED',
  );
  assert.throws(
    () => validatePublicMarketUrl('https://api.bitget.com/api/v2/mix/account/accounts'),
    (error: unknown) => error instanceof MarketInformationError && error.code === 'PUBLIC_MARKET_URL_BLOCKED',
  );
});

test('public JSON client rejects primitive, empty object, empty body, and invalid JSON payloads', async () => {
  const cases: Array<{ response: () => Response; code: string }> = [
    { response: () => new Response('1', { status: 200 }), code: 'UPSTREAM_PRIMITIVE_PAYLOAD' },
    { response: () => jsonResponse({}), code: 'UPSTREAM_EMPTY_OBJECT' },
    { response: () => new Response('', { status: 200 }), code: 'UPSTREAM_EMPTY_BODY' },
    { response: () => new Response('{', { status: 200 }), code: 'UPSTREAM_INVALID_JSON' },
  ];
  for (const item of cases) {
    await assert.rejects(
      fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
        provider: 'test',
        fetchImpl: async () => item.response(),
        sleepImpl: noSleep,
      }),
      (error: unknown) => error instanceof MarketInformationError && error.code === item.code,
    );
  }
});

test('public JSON client retries only retryable GET failures once and respects 429 contract', async () => {
  let calls = 0;
  const payload = await fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
    provider: 'test',
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'rate' }, 429, { 'retry-after': '0' })
        : jsonResponse([{ market: 'KRW-BTC' }]);
    },
    sleepImpl: noSleep,
  });
  assert.equal(calls, 2);
  assert.ok(Array.isArray(payload));

  let forbiddenCalls = 0;
  await assert.rejects(
    fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
      provider: 'test',
      fetchImpl: async () => {
        forbiddenCalls += 1;
        return jsonResponse({ error: 'forbidden' }, 403);
      },
      sleepImpl: noSleep,
    }),
    (error: unknown) => error instanceof MarketInformationError
      && error.code === 'UPSTREAM_HTTP_403'
      && !error.retryable,
  );
  assert.equal(forbiddenCalls, 1);
});

test('public JSON client retries 500, 502, 503, and 504 once', async () => {
  for (const status of [500, 502, 503, 504]) {
    let calls = 0;
    await assert.rejects(
      fetchPublicMarketJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', {
        provider: 'test',
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({ error: status }, status);
        },
        sleepImpl: noSleep,
      }),
      (error: unknown) => error instanceof MarketInformationError && error.code === `UPSTREAM_HTTP_${status}`,
    );
    assert.equal(calls, 2);
  }
});

test('public JSON client distinguishes timeout, network TypeError, and caller AbortError', async () => {
  const never = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(
    fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
      provider: 'test',
      timeoutMs: 5,
      fetchImpl: never,
      sleepImpl: noSleep,
    }),
    (error: unknown) => error instanceof MarketInformationError && error.code === 'UPSTREAM_TIMEOUT',
  );

  await assert.rejects(
    fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
      provider: 'test',
      fetchImpl: async () => { throw new TypeError('DNS lookup failed'); },
      sleepImpl: noSleep,
    }),
    (error: unknown) => error instanceof MarketInformationError && error.code === 'UPSTREAM_NETWORK_ERROR',
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchPublicMarketJson('https://api.upbit.com/v1/ticker?markets=KRW-BTC', {
      provider: 'test',
      signal: controller.signal,
      fetchImpl: async () => jsonResponse([]),
      sleepImpl: noSleep,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
});

test('Upbit normalizers preserve real zero values, reject missing prices, and deduplicate markets', () => {
  const markets = normalizeUpbitMarkets([
    { market: 'KRW-BTC', korean_name: '비트코인', market_warning: 'NONE' },
    { market: 'KRW-BTC', korean_name: '비트코인', market_warning: 'CAUTION' },
    { market: 'BTC-ETH', korean_name: '이더리움' },
  ]);
  assert.equal(markets.length, 1);
  assert.equal(markets[0].warning, true);

  const names = new Map([['KRW-BTC', { name: '비트코인', warning: true }]]);
  const rows = normalizeUpbitTickers([
    {
      market: 'KRW-BTC',
      trade_price: 100,
      signed_change_rate: 0,
      high_price: 101,
      low_price: 99,
      acc_trade_volume_24h: 0,
      acc_trade_price_24h: 0,
      timestamp: 1_786_000_000_000,
    },
    { market: 'KRW-ETH', trade_price: null },
  ], names, 1_786_000_100_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].changePercent, 0);
  assert.equal(rows[0].volume24h, 0);
  assert.equal(rows[0].tradingValue24h, 0);
  assert.equal(rows[0].marketCap, null);
  assert.equal(rows[0].warning, true);
});

test('Bitget normalizer keeps USDT currency, zero funding, OI, next funding time, and contract status', () => {
  const funding = new Map([['BTCUSDT', { rate: 0, next: '2026-08-05T08:00:00.000Z' }]]);
  const contracts = new Map([['BTCUSDT', 'normal']]);
  const rows = normalizeBitgetTickers({
    code: '00000',
    data: [{
      symbol: 'BTCUSDT',
      lastPr: '70000',
      high24h: '71000',
      low24h: '69000',
      change24h: '0',
      baseVolume: '0',
      usdtVolume: '0',
      fundingRate: '0.1',
      holdingAmount: '0',
      ts: '1786000000000',
    }],
  }, contracts, funding, 1_786_000_100_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, 'USDT');
  assert.equal(rows[0].changePercent, 0);
  assert.equal(rows[0].fundingRatePercent, 0);
  assert.equal(rows[0].openInterest, 0);
  assert.equal(rows[0].nextFundingAt, '2026-08-05T08:00:00.000Z');
  assert.equal(rows[0].tradingStatus, 'normal');
  assert.ok((rows[0].rangeVolatility24hPercent ?? 0) > 0);
});

test('Bitget derivatives normalizer accepts official public long-short and liquidation contracts', () => {
  const result = normalizeBitgetDerivatives(
    { code: '00000', data: [{ longRatio: '0.55', shortRatio: '0.45', longShortRatio: '1.22', ts: '1785800000000' }] },
    { code: '00000', data: { list: [{ symbol: 'BTCUSDT', side: 'buy', price: '70000', amount: '0.5', ts: '1785800000000' }] } },
  );
  assert.equal(result.referenceSymbol, 'BTCUSDT');
  assert.equal(result.longRatio, 0.55);
  assert.equal(result.liquidations.length, 1);
  assert.equal(result.liquidations[0].side, 'long');
});

test('news deduplication rejects empty, duplicate, and future items and sorts newest first', () => {
  const now = Date.parse('2026-08-05T08:00:00.000Z');
  const base: MarketInformationNewsRow = {
    id: '1',
    kind: 'news',
    symbol: 'AAPL',
    title: 'Apple update',
    summary: null,
    provider: 'provider',
    source: 'source',
    url: 'https://example.com/story?utm_source=test',
    publishedAt: '2026-08-05T07:00:00.000Z',
  };
  const rows = dedupeMarketNews([
    base,
    { ...base, id: '2', url: 'https://example.com/story' },
    { ...base, id: '3', title: '', url: 'https://example.com/empty' },
    { ...base, id: '4', title: 'future', url: 'https://example.com/future', publishedAt: '2026-08-05T09:00:00.000Z' },
    { ...base, id: '5', title: 'older', url: 'https://example.com/older', publishedAt: '2026-08-04T07:00:00.000Z' },
  ], now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[0].url, 'https://example.com/story');
});
