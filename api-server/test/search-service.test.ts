import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MarketDataService,
  type QuoteRow,
  type SearchResult,
} from '../src/services/market-data.service';
import { SearchService } from '../src/services/search.service';

test('searchQuotes uses last-good when every live quote fails', async () => {
  const originalSearchWithMeta = MarketDataService.searchWithMeta;
  const originalGetQuoteRow = MarketDataService.getQuoteRow;
  const ticker = 'LASTGOOD-TEST';
  const query = `lastgood-${Date.now()}`;
  const symbol: SearchResult = {
    ticker,
    name: 'Last Good Test',
    market: 'US',
    currency: 'USD',
    assetType: 'STOCK',
  };
  const liveRow: QuoteRow = {
    ...symbol,
    price: 100,
    changeAmount: 1,
    changePercent: 1,
    volume: 1_000,
    tradingValue: 100_000,
    updatedAt: new Date().toISOString(),
    rating: {
      rating: 'HOLD',
      confidence: 60,
      score: 50,
    },
  };

  try {
    MarketDataService.searchWithMeta = async () => ({
      results: [symbol],
      partial: false,
      warnings: [],
    });
    MarketDataService.getQuoteRow = async () => liveRow;

    const seeded = await SearchService.searchQuotes(query);
    assert.equal(seeded.source, 'live');
    assert.deepEqual(seeded.results, [liveRow]);

    MarketDataService.getQuoteRow = async () => null;

    const fallback = await SearchService.searchQuotes(query);
    assert.equal(fallback.source, 'last-good');
    assert.deepEqual(fallback.results, [liveRow]);
    assert.equal(fallback.partial, true);
    assert.ok(fallback.warnings.includes('QUOTE_SEARCH_PROVIDER_ERROR'));
  } finally {
    MarketDataService.searchWithMeta = originalSearchWithMeta;
    MarketDataService.getQuoteRow = originalGetQuoteRow;
  }
});
