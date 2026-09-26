import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INVALID_LEGACY_STOCK_SEARCH_RESPONSE,
  isLegacyStockSearchResponsePath,
  requireLegacyStockSearchResponse,
} from './legacy-stock-search-response';

const nowMs = Date.parse('2026-09-10T03:30:00.000Z');
const now = new Date(nowMs).toISOString();

const samsung = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  assetType: 'stock',
  aliases: ['Samsung Electronics'],
} as const;

const apple = {
  ticker: 'AAPL',
  name: 'Apple',
  market: 'US',
  currency: 'USD',
  assetType: 'stock',
  aliases: ['애플'],
} as const;

test('legacy stock search accepts canonical evidence and genuine empty success', () => {
  const parsed = requireLegacyStockSearchResponse(
    'https://app.local/api/search?q=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90',
    { q: '삼성전자', results: [samsung], count: 1, updatedAt: now },
    nowMs,
  );
  assert.equal(parsed.results[0]?.ticker, '005930');

  const empty = requireLegacyStockSearchResponse(
    'https://app.local/api/search?q=NO_MATCH',
    { q: 'NO_MATCH', results: [], count: 0, updatedAt: now },
    nowMs,
  );
  assert.deepEqual(empty.results, []);
});

test('legacy stock search rejects malformed HTTP 200 instead of laundering it into empty results', () => {
  assert.throws(
    () => requireLegacyStockSearchResponse('https://app.local/api/search?q=AAPL', {}, nowMs),
    (error: unknown) => error instanceof Error && error.message === INVALID_LEGACY_STOCK_SEARCH_RESPONSE,
  );
  assert.throws(
    () => requireLegacyStockSearchResponse(
      'https://app.local/api/search?q=AAPL',
      { q: 'AAPL', results: [apple], count: 0, updatedAt: now },
      nowMs,
    ),
    /INVALID_LEGACY_STOCK_SEARCH_RESPONSE/,
  );
});

test('legacy stock search binds response query identity to the request', () => {
  assert.throws(
    () => requireLegacyStockSearchResponse(
      'https://app.local/api/search?q=AAPL',
      { q: 'MSFT', results: [apple], count: 1, updatedAt: now },
      nowMs,
    ),
    /INVALID_LEGACY_STOCK_SEARCH_RESPONSE/,
  );
});

test('legacy stock search rejects stale and future success evidence', () => {
  assert.throws(
    () => requireLegacyStockSearchResponse(
      'https://app.local/api/search?q=AAPL',
      { q: 'AAPL', results: [apple], count: 1, updatedAt: new Date(nowMs - 120_001).toISOString() },
      nowMs,
    ),
    /INVALID_LEGACY_STOCK_SEARCH_RESPONSE/,
  );
  assert.throws(
    () => requireLegacyStockSearchResponse(
      'https://app.local/api/search?q=AAPL',
      { q: 'AAPL', results: [apple], count: 1, updatedAt: new Date(nowMs + 5_001).toISOString() },
      nowMs,
    ),
    /INVALID_LEGACY_STOCK_SEARCH_RESPONSE/,
  );
});

test('legacy stock search rejects malformed row identity and market/currency drift', () => {
  for (const row of [
    { ...apple, ticker: '' },
    { ...apple, ticker: ' aapl ' },
    { ...apple, name: '' },
    { ...apple, market: 'KR' },
    { ...apple, aliases: [1] },
  ]) {
    assert.throws(
      () => requireLegacyStockSearchResponse(
        'https://app.local/api/search?q=AAPL',
        { q: 'AAPL', results: [row], count: 1, updatedAt: now },
        nowMs,
      ),
      /INVALID_LEGACY_STOCK_SEARCH_RESPONSE/,
    );
  }
});

test('legacy search matcher is bounded to GET /api/search only', () => {
  assert.equal(isLegacyStockSearchResponsePath('/api/search', 'GET'), true);
  assert.equal(isLegacyStockSearchResponsePath('/api/search/suggest', 'GET'), false);
  assert.equal(isLegacyStockSearchResponsePath('/api/search', 'POST'), false);
  assert.equal(isLegacyStockSearchResponsePath('/api/quotes', 'GET'), false);
});
