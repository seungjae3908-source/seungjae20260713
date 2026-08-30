import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import express from 'express';
import { MarketDataService } from './market-data.service';
import { MarketListingService } from './market-listing.service';
import marketRouter from '../routes/market';

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
