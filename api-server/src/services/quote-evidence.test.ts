import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import express from 'express';
import { MarketDataService } from './market-data.service';
import { MarketListingService } from './market-listing.service';
import marketRouter from '../routes/market';
import { quoteTimeEvidence, marketNumber } from '../providers/market-evidence';
import { getQuote as yahooQuote, parseYahooQuote, normalizeYahooCandles } from '../providers/yahoo';
import { getQuote as naverQuote, parseNaverPollQuote } from '../providers/naver';
import { normalizeQuoteRow } from './market-data.base.service';

test('market time evidence rejects missing, malformed, impossible, timezone-free and future timestamps without clock substitution', () => {
  const now = Date.parse('2026-08-30T15:00:00Z');
  for (const value of [null, undefined, '']) {
    const result = quoteTimeEvidence(value, 'iso', now);
    assert.equal(result.updatedAt, null);
    assert.equal(result.freshness.status, 'UNKNOWN');
  }
  for (const value of ['bad', '2026-08-30', '2026-08-30T15:00:00', '2026-02-30T00:00:00Z', '2026-08-30T24:00:00Z', '2026-08-30T00:00:00+15:00', '2026-08-30T15:00:01Z']) {
    const result = quoteTimeEvidence(value, 'iso', now);
    assert.equal(result.updatedAt, null, value);
    assert.equal(result.freshness.status, 'INVALID', value);
  }
  assert.equal(quoteTimeEvidence('2026-08-28T15:30:00+09:00', 'iso', now).updatedAt, '2026-08-28T06:30:00.000Z');
  assert.equal(quoteTimeEvidence('2026-08-28T15:30:00+09:00', 'iso', now).freshness.status, 'STALE');
  assert.equal(quoteTimeEvidence(now / 1000, 'unix-seconds', now).freshness.status, 'FRESH');
  assert.equal(quoteTimeEvidence(now, 'unix-seconds', now).freshness.status, 'INVALID');
  for (const value of [null, undefined, '', ' ', '1,23', '3조 8,198억', false, NaN, Infinity]) assert.equal(marketNumber(value), null);
  assert.equal(marketNumber('0'), 0);
  assert.equal(marketNumber('-9,000'), -9000);
});

function yahooFixture() {
  return { meta: { symbol: 'AAPL', currency: 'USD', regularMarketPrice: 110, regularMarketTime: 1787947201, chartPreviousClose: 70 },
    timestamp: [1787837400, 1787923800], indicators: { quote: [{ open: [98, 101], high: [101, 111], low: [97, 100], close: [100, 110], volume: [50, 0] }] } };
}

test('Yahoo keeps actual source time and uses previous daily candle, never 1mo range baseline or synthetic zero change', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ chart: { result: [yahooFixture()] } }), { status: 200 }));
  const result = await yahooQuote({ ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD' });
  assert.equal(result.updatedAt, '2026-08-28T20:00:01.000Z');
  assert.equal(result.changeAmount, 10);
  assert.equal(result.changePercent, 10);
  assert.equal(result.volume, 0);
  assert.equal(result.source, 'yahoo');
  const fixture = yahooFixture();
  assert.throws(() => parseYahooQuote(fixture, 'MSFT'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseYahooQuote(fixture, 'AAPL', 'KRW'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseYahooQuote({ ...fixture, meta: { ...fixture.meta, regularMarketTime: Math.ceil(Date.now() / 1000) + 60 } }, 'AAPL'), /SOURCE_TIME_FUTURE/);
  const missing = { ...fixture, meta: { symbol: 'AAPL', currency: 'USD', regularMarketPrice: 110 } };
  assert.equal(parseYahooQuote(missing, 'AAPL').updatedAt, null);
  assert.equal(parseYahooQuote(missing, 'AAPL').freshness.status, 'UNKNOWN');
  const only = { ...fixture, indicators: { quote: [{ open: [100], high: [111], low: [99], close: [110], volume: [0] }] } };
  assert.throws(() => parseYahooQuote(only, 'AAPL'), /previousClose/);
  assert.throws(() => normalizeYahooCandles({ ...fixture, timestamp: [1787837400, 1787837400] }), /TIME_INVALID/);
  assert.throws(() => normalizeYahooCandles({ ...fixture, timestamp: [Math.ceil(Date.now() / 1000) + 60] }), /FUTURE/);
  assert.throws(() => normalizeYahooCandles({ ...fixture, indicators: { quote: [{ close: [100, 110] }] } }), /candle.open/);
});

function naverFixture() {
  return { itemCode: '005930', symbolCode: '005930', stockName: '삼성전자', currencyType: { code: 'KRW' },
    closePriceRaw: '257000', compareToPreviousClosePriceRaw: '-9000', fluctuationsRatioRaw: '-3.38',
    openPriceRaw: '262500', highPriceRaw: '266000', lowPriceRaw: '256000', accumulatedTradingVolumeRaw: '14698877',
    accumulatedTradingValue: '3조 8,198억', accumulatedTradingValueRaw: '3819820000000', localTradedAt: '2026-08-28T15:30:00+09:00' };
}

test('Naver quote uses regular-session identity, signed change, raw KRW turnover and trade time', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ datas: [naverFixture()], time: '20260831001342' }), { status: 200 }));
  const result = await naverQuote('005930');
  assert.equal(result.updatedAt, '2026-08-28T06:30:00.000Z');
  assert.equal(result.changeAmount, -9000);
  const row = normalizeQuoteRow({ ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW' }, result);
  assert.equal(row.tradingValue, 3819820000000);
  assert.equal(row.tradingValueSource, 'PROVIDER_REPORTED');
  assert.equal(row.updatedAt, result.updatedAt);
  assert.throws(() => parseNaverPollQuote({ ...naverFixture(), itemCode: '000660' }, '005930'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseNaverPollQuote({ ...naverFixture(), accumulatedTradingValueRaw: undefined }, '005930'), /tradingValue/);
  assert.throws(() => parseNaverPollQuote({ ...naverFixture(), closePriceRaw: '' }, '005930'), /price/);
  assert.throws(() => parseNaverPollQuote({ ...naverFixture(), accumulatedTradingVolumeRaw: '-1' }, '005930'), /volume/);
  assert.equal(parseNaverPollQuote({ ...naverFixture(), localTradedAt: undefined }, '005930').freshness.status, 'UNKNOWN');
});

test('quote normalization never substitutes previous close for current price or absent metrics with zero', () => {
  const entry = { ticker: 'AAPL', name: 'Apple', market: 'US' as const, currency: 'USD' as const };
  assert.throws(() => normalizeQuoteRow(entry, { previousClose: 100, volume: 0 }), /quote.price/);
  assert.throws(() => normalizeQuoteRow(entry, { price: 100, volume: 0 }), /quote.changeAmount/);
  assert.throws(() => normalizeQuoteRow(entry, { price: 100, changeAmount: 0, changePercent: 0 }), /quote.volume/);
  const row = normalizeQuoteRow(entry, { price: 100, changeAmount: 0, changePercent: 0, volume: 0 });
  assert.equal(row.updatedAt, null);
  assert.equal(row.freshness?.status, 'UNKNOWN');
  assert.equal(row.previousClose, undefined);
  assert.equal(row.open, undefined);
  assert.equal(row.changePercent, 0);
});

test('live quote and listing boundaries never generate ratings, probabilities or trade levels', async (t) => {
  const quote = { price: 100, changeAmount: 0, changePercent: 0, volume: 0, marketCap: 1000, week52High: 100, week52Low: 50 };
  t.mock.method(MarketDataService, 'getQuote', async () => quote);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture blocks external provider access'); });
  let candleCalls = 0;
  t.mock.method(MarketDataService, 'getCandles', async () => { candleCalls++; return []; });
  const row = await MarketDataService.getQuoteRow('005930');
  assert.equal(row?.price, 100);
  assert.equal(row?.rating, null);
  assert.equal(row?.ratingStatus, 'MISSING_EVIDENCE');
  assert.equal(await MarketDataService.getRating('005930'), null);
  const listing = await MarketListingService.getMarketListings('KRX');
  assert.ok(listing.popular.length > 0);
  for (const item of listing.popular) {
    assert.equal(item.rating, null);
    assert.equal(item.entry, undefined);
    assert.equal(item.take1, undefined);
    assert.equal(item.stop, undefined);
    assert.match(item.reason ?? '', /평가 근거 부족/);
  }
  assert.deepEqual(listing.recommended, []);
  assert.equal(listing.diagnostics.recommendationStatus, 'MISSING_EVIDENCE');
  assert.equal(candleCalls, 0);
});

async function getRoute(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/api', marketRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server address unavailable');
  try {
    return await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject);
      req.end();
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('quote/search/alert provider outages cannot become successful empty market responses', async (t) => {
  t.mock.method(MarketDataService, 'getQuotes', async () => []);
  t.mock.method(MarketDataService, 'search', async () => [{ ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', assetType: 'STOCK' as const }]);
  t.mock.method(MarketListingService, 'getMarketListings', async () => { throw new Error('fixture outage'); });
  for (const path of ['/api/quotes?tickers=AAPL', '/api/search/quotes?q=AAPL', '/api/market/alerts?market=US']) {
    const result = await getRoute(path);
    assert.equal(result.status, 503, path);
    assert.equal(result.body.dataStatus, 'unavailable');
  }
  const emptyRequest = await getRoute('/api/quotes');
  assert.equal(emptyRequest.status, 200);
  assert.equal(emptyRequest.body.dataStatus, 'complete');
});

test('market summary provider outage retains null values and explicit unavailable time evidence', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  const rows = await MarketListingService.getMarketSummary();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.ok, false);
    assert.equal(row.price, null);
    assert.equal(row.changePercent, null);
    assert.equal(row.updatedAt, null);
    assert.equal(row.freshness?.status, 'PROVIDER_UNAVAILABLE');
  }
  const result = await getRoute('/api/market/summary');
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
});
