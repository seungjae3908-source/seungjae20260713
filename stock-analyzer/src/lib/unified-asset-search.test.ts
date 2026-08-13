import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prioritizeUnifiedAssetSuggestions } from './unified-asset-search-priority';
import {
  deriveUnifiedSearchOutcome,
  unifiedAssetDetailPath,
  type UnifiedAssetSuggestion,
  type UnifiedAssetSuggestResponse,
} from './unified-asset-search';

const now = '2026-08-04T07:00:00.000Z';

function suggestion(input: Partial<UnifiedAssetSuggestion> & Pick<UnifiedAssetSuggestion, 'id' | 'market' | 'productCode' | 'displayName' | 'matchType'>): UnifiedAssetSuggestion {
  return {
    id: input.id,
    assetType: input.market === 'KR' || input.market === 'US' ? 'stock' : 'coin',
    market: input.market,
    instrumentType: input.market === 'KR' || input.market === 'US' ? 'stock' : input.market,
    exchange: input.exchange ?? (input.market === 'KR' ? 'KOSPI' : input.market === 'US' ? 'NASDAQ' : input.market === 'spot' ? 'UPBIT' : 'BITGET'),
    ticker: input.ticker,
    symbol: input.symbol,
    productCode: input.productCode,
    koreanName: input.koreanName ?? input.displayName,
    englishName: input.englishName ?? '',
    displayName: input.displayName,
    baseSymbol: input.baseSymbol ?? input.ticker ?? input.symbol ?? input.productCode,
    quoteCurrency: input.quoteCurrency ?? (input.market === 'KR' || input.market === 'spot' ? 'KRW' : input.market === 'US' ? 'USD' : 'USDT'),
    matchType: input.matchType,
    active: input.active ?? true,
    provider: input.provider ?? 'fixture',
    dataAsOf: input.dataAsOf ?? now,
  };
}

function detailParams(item: UnifiedAssetSuggestion, backPath?: string) {
  const value = unifiedAssetDetailPath(item, backPath);
  const [pathname, query = ''] = value.split('?');
  return { pathname, params: new URLSearchParams(query) };
}

function searchResponse(overrides: Partial<UnifiedAssetSuggestResponse> = {}): UnifiedAssetSuggestResponse {
  return {
    ok: true, state: 'EMPTY', q: 'none', asset: 'all', market: null,
    results: [], count: 0, dataAsOf: now, stale: false, partial: false,
    providers: [], hiddenMatches: [],
    ...overrides,
  };
}

test('search distinguishes no match, provider unavailable, and data unavailable', () => {
  assert.equal(deriveUnifiedSearchOutcome(searchResponse()), 'NO_MATCH');
  assert.equal(deriveUnifiedSearchOutcome(searchResponse({ state: 'DEGRADED', partial: true })), 'PROVIDER_UNAVAILABLE');
  assert.equal(deriveUnifiedSearchOutcome(searchResponse({ providers: [{ provider: 'upbit', status: 'error', count: 0, dataAsOf: null }] })), 'PROVIDER_UNAVAILABLE');
  assert.equal(deriveUnifiedSearchOutcome(searchResponse({ ok: false, state: 'ERROR' })), 'DATA_UNAVAILABLE');
  assert.equal(deriveUnifiedSearchOutcome(searchResponse({ state: 'FULL', results: [suggestion({ id: 'kr', market: 'KR', productCode: '005930', ticker: '005930', displayName: '삼성전자', matchType: 'code_exact' })], count: 1 })), 'RESULTS_AVAILABLE');
});

test('never lets preference priority cross strict match categories', () => {
  const exact = suggestion({ id: 'exact', market: 'US', productCode: 'TSLA', ticker: 'TSLA', displayName: 'Tesla', matchType: 'code_exact' });
  const watchlistedAlias = suggestion({ id: 'alias', market: 'US', productCode: 'TLSA', ticker: 'TLSA', displayName: 'Tesla Alias', matchType: 'alias' });
  const result = prioritizeUnifiedAssetSuggestions([watchlistedAlias, exact], {
    watchlist: [{ ticker: 'TLSA', market: 'US' }],
  });
  assert.deepEqual(result.map((item) => item.id), ['exact', 'alias']);
});

test('prioritizes watchlist and then recent items inside the same match category', () => {
  const normal = suggestion({ id: 'normal', market: 'KR', productCode: '000001', ticker: '000001', displayName: '삼성 보통', matchType: 'name_prefix' });
  const recent = suggestion({ id: 'recent', market: 'KR', productCode: '000002', ticker: '000002', displayName: '삼성 최근', matchType: 'name_prefix' });
  const watchlisted = suggestion({ id: 'watchlisted', market: 'KR', productCode: '000003', ticker: '000003', displayName: '삼성 관심', matchType: 'name_prefix' });
  const result = prioritizeUnifiedAssetSuggestions([normal, recent, watchlisted], {
    recentIds: ['recent'],
    watchlist: [{ ticker: '000003', market: 'KOSPI' }],
  });
  assert.deepEqual(result.map((item) => item.id), ['watchlisted', 'recent', 'normal']);
});

test('distinguishes the same coin base symbol by spot and futures market', () => {
  const spot = suggestion({ id: 'spot', market: 'spot', productCode: 'KRW-BTC', symbol: 'BTC', baseSymbol: 'BTC', displayName: '비트코인 현물', matchType: 'code_exact' });
  const futures = suggestion({ id: 'futures', market: 'futures', productCode: 'BTCUSDT', symbol: 'BTCUSDT', baseSymbol: 'BTC', displayName: '비트코인 선물', matchType: 'code_exact' });
  const result = prioritizeUnifiedAssetSuggestions([futures, spot], {
    watchlist: [{ ticker: 'BTC', market: 'UPBIT 현물' }],
  });
  assert.deepEqual(result.map((item) => item.id), ['spot', 'futures']);
});

test('keeps the original server order when preferences are equal', () => {
  const first = suggestion({ id: 'first', market: 'US', productCode: 'AAA', ticker: 'AAA', displayName: 'Alpha', matchType: 'name_prefix' });
  const second = suggestion({ id: 'second', market: 'US', productCode: 'AAB', ticker: 'AAB', displayName: 'Alpha Beta', matchType: 'name_prefix' });
  const result = prioritizeUnifiedAssetSuggestions([first, second]);
  assert.deepEqual(result.map((item) => item.id), ['first', 'second']);
});

test('uses the stock-info detail contract for Korean and US stocks', () => {
  for (const item of [
    suggestion({ id: 'kr', market: 'KR', productCode: '005930', ticker: '005930', displayName: '삼성전자', matchType: 'code_exact' }),
    suggestion({ id: 'us', market: 'US', productCode: 'BRK.B', ticker: 'BRK.B', displayName: 'Berkshire Hathaway', matchType: 'code_exact' }),
  ]) {
    const { pathname, params } = detailParams(item, '/stocks');
    assert.equal(pathname, '/stock-info');
    assert.equal(params.get('asset'), 'stock');
    assert.equal(params.get('market'), item.market);
    assert.equal(params.get('ticker'), item.ticker);
    assert.equal(params.get('back'), '/stocks');
  }
});

test('keeps Upbit spot and Bitget futures detail identities separate', () => {
  const spot = suggestion({ id: 'spot-detail', market: 'spot', productCode: 'KRW-BTC', symbol: 'BTC', baseSymbol: 'BTC', displayName: '비트코인 현물', matchType: 'code_exact' });
  const futures = suggestion({ id: 'futures-detail', market: 'futures', productCode: 'BTCUSDT', symbol: 'BTCUSDT', baseSymbol: 'BTC', displayName: '비트코인 선물', matchType: 'code_exact' });
  const spotPath = detailParams(spot);
  const futuresPath = detailParams(futures);

  assert.equal(spotPath.pathname, '/stock-info');
  assert.equal(spotPath.params.get('asset'), 'coin');
  assert.equal(spotPath.params.get('coinMarket'), 'spot');
  assert.equal(spotPath.params.get('symbol'), 'BTC');
  assert.equal(futuresPath.pathname, '/stock-info');
  assert.equal(futuresPath.params.get('asset'), 'coin');
  assert.equal(futuresPath.params.get('coinMarket'), 'futures');
  assert.equal(futuresPath.params.get('symbol'), 'BTCUSDT');
});

test('application routes keep unified search capability-gated and separate from legacy lists', () => {
  const appSource = readFileSync(path.join(process.cwd(), 'stock-analyzer/src/App.tsx'), 'utf8');

  assert.match(appSource, /function UnifiedAssetSearchAccess\(\) \{ return gated\('canAccessBasicInfo', builder\('ASSET_SEARCH', <UnifiedAssetSearchPage \/>\)\); \}/);
  assert.match(appSource, /<Route path="\/stocks" component=\{UnifiedAssetSearchAccess\} \/>/);
  assert.match(appSource, /<Route path="\/search" component=\{UnifiedAssetSearchAccess\} \/>/);
  assert.match(appSource, /<Route path="\/market-rankings" component=\{SearchPage\} \/>/);
  assert.match(appSource, /<Route path="\/market-browser" component=\{StocksPage\} \/>/);
  assert.doesNotMatch(appSource, /<Route path="\/search" component=\{SearchPage\} \/>/);
});

test('keeps Production main global console contract intact', () => {
  const mainSource = readFileSync(path.join(process.cwd(), 'stock-analyzer/src/main.tsx'), 'utf8');

  assert.doesNotMatch(mainSource, /configureRecoverableSearchDiagnostics/);
  assert.doesNotMatch(mainSource, /console\.error\s*=/);
});

