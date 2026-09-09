import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UnifiedSearchResponseContractError,
  parseUnifiedAssetSuggestResponse,
} from './unified-asset-search-response';

const NOW = Date.parse('2026-09-09T05:50:00.000Z');
const expected = { q: 'AAPL', asset: 'stock' as const, market: 'US' as const };

const stock = {
  id: 'stock:US:AAPL',
  assetType: 'stock',
  market: 'US',
  instrumentType: 'stock',
  exchange: 'NASDAQ',
  ticker: 'AAPL',
  productCode: 'AAPL',
  koreanName: '애플',
  englishName: 'Apple Inc.',
  displayName: 'Apple Inc.',
  baseSymbol: 'AAPL',
  quoteCurrency: 'USD',
  matchType: 'code_exact',
  active: true,
  provider: 'FINNHUB',
  dataAsOf: '2026-09-09T05:49:00.000Z',
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    state: 'FULL',
    q: 'AAPL',
    asset: 'stock',
    market: 'US',
    results: [stock],
    count: 1,
    dataAsOf: '2026-09-09T05:49:00.000Z',
    stale: false,
    partial: false,
    providers: [{ provider: 'finnhub', status: 'ok', count: 1, dataAsOf: '2026-09-09T05:49:00.000Z' }],
    hiddenMatches: [],
    ...overrides,
  };
}

test('unified search accepts canonical fresh success payload', () => {
  const parsed = parseUnifiedAssetSuggestResponse(envelope(), expected, NOW);
  assert.equal(parsed.state, 'FULL');
  assert.equal(parsed.results[0].ticker, 'AAPL');
});

test('unified search preserves canonical empty response without fabricating results', () => {
  const parsed = parseUnifiedAssetSuggestResponse(envelope({
    state: 'EMPTY',
    results: [],
    count: 0,
  }), expected, NOW);
  assert.equal(parsed.state, 'EMPTY');
  assert.deepEqual(parsed.results, []);
});

test('unified search rejects malformed HTTP 200 that would look like no match', () => {
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ state: 'FULL', results: [], count: 0 }), expected, NOW),
    UnifiedSearchResponseContractError,
  );
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ results: undefined }), expected, NOW),
    UnifiedSearchResponseContractError,
  );
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ count: 0 }), expected, NOW),
    /count does not match/,
  );
});

test('unified search rejects request identity and provider truth drift', () => {
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ q: 'MSFT' }), expected, NOW),
    /does not match request/,
  );
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ partial: true, state: 'PARTIAL' }), expected, NOW),
    /partial is inconsistent/,
  );
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ providers: [] }), expected, NOW),
    UnifiedSearchResponseContractError,
  );
});

test('unified search accepts degraded metadata fallback but rejects fake fresh timestamps', () => {
  const fallback = parseUnifiedAssetSuggestResponse(envelope({
    state: 'PARTIAL',
    dataAsOf: null,
    stale: true,
    partial: true,
    providers: [{ provider: 'finnhub', status: 'stale', count: 0, dataAsOf: null, message: 'fallback' }],
  }), expected, NOW);
  assert.equal(fallback.state, 'PARTIAL');
  assert.equal(fallback.dataAsOf, null);

  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ dataAsOf: '2026-09-09T05:51:00.000Z' }), expected, NOW),
    /future/,
  );
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ dataAsOf: '2026-09-08T04:00:00.000Z' }), expected, NOW),
    /stale while stale=false/,
  );
});

test('unified search rejects result identity that violates the requested market', () => {
  const wrongMarket = { ...stock, market: 'KR', exchange: 'KOSPI' };
  assert.throws(
    () => parseUnifiedAssetSuggestResponse(envelope({ results: [wrongMarket] }), expected, NOW),
    /requested market filter/,
  );
});

test('unified search exposes only a user-safe contract error message', () => {
  try {
    parseUnifiedAssetSuggestResponse({}, expected, NOW);
    assert.fail('expected parser to reject malformed payload');
  } catch (error) {
    assert.ok(error instanceof UnifiedSearchResponseContractError);
    assert.equal(error.message, '검색 응답을 검증하지 못했습니다. 다시 시도해 주세요.');
    assert.notEqual(error.detail, error.message);
  }
});
