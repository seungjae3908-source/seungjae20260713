import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearTossTokenCache,
  getCandles,
  getCurrentPrice,
  getOrderbook,
  getStockInfo,
  getTossAccessToken,
} from './toss';
import type { CatalogEntry } from '../data/catalog';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalEnv = {
  clientId: process.env.TOSS_CLIENT_ID,
  clientSecret: process.env.TOSS_CLIENT_SECRET,
  baseUrl: process.env.TOSS_API_BASE_URL,
};

function setFakeConfig(): void {
  process.env.TOSS_CLIENT_ID = 'ci-client-id-sentinel';
  process.env.TOSS_CLIENT_SECRET = 'ci-secret-sentinel';
  process.env.TOSS_API_BASE_URL = 'https://toss-openapi.test';
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

const samsung = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  aliases: [],
} as CatalogEntry;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  clearTossTokenCache();
  if (originalEnv.clientId == null) delete process.env.TOSS_CLIENT_ID;
  else process.env.TOSS_CLIENT_ID = originalEnv.clientId;
  if (originalEnv.clientSecret == null) delete process.env.TOSS_CLIENT_SECRET;
  else process.env.TOSS_CLIENT_SECRET = originalEnv.clientSecret;
  if (originalEnv.baseUrl == null) delete process.env.TOSS_API_BASE_URL;
  else process.env.TOSS_API_BASE_URL = originalEnv.baseUrl;
});

test('refreshes the Toss token before expiry with a single cached token', async () => {
  setFakeConfig();
  let now = 1_000_000;
  Date.now = () => now;
  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.match(url, /\/oauth2\/token$/);
    tokenCalls += 1;
    return response({
      access_token: `token-${tokenCalls}`,
      token_type: 'Bearer',
      expires_in: 600,
    });
  };

  assert.equal(await getTossAccessToken(), 'token-1');
  assert.equal(await getTossAccessToken(), 'token-1');
  assert.equal(tokenCalls, 1);

  now += 301_000;
  assert.equal(await getTossAccessToken(), 'token-2');
  assert.equal(tokenCalls, 2);
});

test('reissues auth exactly once after a 401 and normalizes current price', async () => {
  setFakeConfig();
  let tokenCalls = 0;
  let priceCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) {
      tokenCalls += 1;
      return response({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
    }
    assert.match(url, /\/api\/v1\/prices\?symbols=005930$/);
    assert.equal(init?.method, 'GET');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('X-Tossinvest-Account'), false);
    priceCalls += 1;
    if (priceCalls === 1) return response({}, { status: 401 });
    return response({
      result: [{
        symbol: '005930',
        timestamp: '2026-08-10T09:30:00+09:00',
        lastPrice: '81200',
        currency: 'KRW',
      }],
    });
  };

  const result = await getCurrentPrice('005930');
  assert.deepEqual(result, {
    ticker: '005930',
    price: 81200,
    currency: 'KRW',
    updatedAt: '2026-08-10T09:30:00+09:00',
    provider: 'toss',
  });
  assert.equal(tokenCalls, 2);
  assert.equal(priceCalls, 2);
});

test('normalizes stock info, candles and orderbook without synthetic timestamps', async () => {
  setFakeConfig();
  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname === '/oauth2/token') {
      return response({ access_token: 'token-safe', expires_in: 3600 });
    }
    if (url.pathname === '/api/v1/stocks') {
      return response({ result: [{
        symbol: '005930',
        name: '삼성전자',
        englishName: 'Samsung Electronics',
        isinCode: 'KR7005930003',
        market: 'KOSPI',
        securityType: 'STOCK',
        isCommonShare: true,
        status: 'ACTIVE',
        currency: 'KRW',
        listDate: '1975-06-11',
        delistDate: null,
        sharesOutstanding: '5919637922',
        leverageFactor: null,
        koreanMarketDetail: {
          krxTradingSuspended: false,
          nxtTradingSuspended: false,
        },
      }] });
    }
    if (url.pathname === '/api/v1/candles') {
      return response({ result: { candles: [
        {
          timestamp: '2026-08-10T09:01:00+09:00',
          openPrice: '81000', highPrice: '81300', lowPrice: '80900', closePrice: '81200',
          volume: '2200', currency: 'KRW',
        },
        {
          timestamp: '2026-08-10T09:00:00+09:00',
          openPrice: '80800', highPrice: '81100', lowPrice: '80700', closePrice: '81000',
          volume: '1800', currency: 'KRW',
        },
      ], nextBefore: null } });
    }
    if (url.pathname === '/api/v1/orderbook') {
      return response({ result: {
        timestamp: null,
        currency: 'KRW',
        asks: [{ price: '81300', volume: '1200' }],
        bids: [{ price: '81200', volume: '900' }],
      } });
    }
    throw new Error(`unexpected test URL: ${url.pathname}`);
  };

  const info = await getStockInfo('005930');
  assert.equal(info.appMarket, 'KR');
  assert.equal(info.sharesOutstanding, 5919637922);
  assert.equal(info.tradingSuspended, false);

  const candles = await getCandles(samsung, '1m', 2);
  assert.deepEqual(candles.map((item) => item.time), [
    '2026-08-10T09:00:00+09:00',
    '2026-08-10T09:01:00+09:00',
  ]);
  assert.deepEqual(candles.map((item) => item.volume), [1800, 2200]);

  const book = await getOrderbook('005930');
  assert.equal(book.updatedAt, null);
  assert.deepEqual(book.asks, [{ price: 81300, volume: 1200 }]);
  assert.deepEqual(book.bids, [{ price: 81200, volume: 900 }]);
  assert.equal(requestedPaths.some((path) => /order|account|asset/i.test(path) && path !== '/api/v1/orderbook'), false);
});

test('retries a rate-limited read with a bounded Retry-After', async () => {
  setFakeConfig();
  let reads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      return response({ access_token: 'token-safe', expires_in: 3600 });
    }
    reads += 1;
    if (reads === 1) {
      return response({}, { status: 429, headers: { 'Retry-After': '0' } });
    }
    return response({ result: [{
      symbol: 'AAPL', timestamp: null, lastPrice: '225.50', currency: 'USD',
    }] });
  };

  const price = await getCurrentPrice('AAPL');
  assert.equal(price.price, 225.5);
  assert.equal(price.updatedAt, null);
  assert.equal(reads, 2);
});

test('never exposes client credentials in provider errors', async () => {
  setFakeConfig();
  globalThis.fetch = async () => response({}, { status: 401 });

  await assert.rejects(
    getTossAccessToken(),
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      assert.equal(text.includes('ci-client-id-sentinel'), false);
      assert.equal(text.includes('ci-secret-sentinel'), false);
      return true;
    },
  );
});
