import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { UnifiedAssetSuggestResponse, UnifiedAssetSuggestion } from '../src/lib/unified-asset-search';
import {
  ALL_UNIFIED_SEARCH_MARKETS,
  allowedUnifiedSearchMarkets,
  filterUnifiedSearchResponseByMarkets,
  isUnifiedSearchMarketAllowed,
} from '../src/lib/unified-search-capability';

const pageSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/unified-asset-search.tsx'),
  'utf8',
);
const componentSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/unified-asset-search.tsx'),
  'utf8',
);

function suggestion(market: 'spot' | 'futures'): UnifiedAssetSuggestion {
  const futures = market === 'futures';
  return {
    id: `${market}:BTC`,
    assetType: 'coin',
    market,
    instrumentType: market,
    exchange: futures ? 'BITGET' : 'UPBIT',
    symbol: futures ? 'BTCUSDT' : 'BTC',
    productCode: futures ? 'BTCUSDT' : 'KRW-BTC',
    koreanName: '비트코인',
    englishName: 'Bitcoin',
    displayName: '비트코인',
    baseSymbol: 'BTC',
    quoteCurrency: futures ? 'USDT' : 'KRW',
    matchType: 'exact',
    active: true,
    provider: futures ? 'BITGET' : 'UPBIT',
    dataAsOf: futures ? '2026-08-14T08:59:00.000Z' : '2026-08-14T09:00:00.000Z',
  };
}

test('associate-style unified search allows public stocks and spot but excludes futures', () => {
  const markets = allowedUnifiedSearchMarkets({
    canAccessSpot: true,
    canAccessFutures: false,
  });

  expect(markets).toEqual(['KR', 'US', 'spot']);
  expect(isUnifiedSearchMarketAllowed('spot', markets)).toBe(true);
  expect(isUnifiedSearchMarketAllowed('futures', markets)).toBe(false);
});

test('regular-style unified search includes futures only when capability is present', () => {
  const markets = allowedUnifiedSearchMarkets({
    canAccessSpot: true,
    canAccessFutures: true,
  });

  expect(markets).toEqual(['KR', 'US', 'spot', 'futures']);
  expect(markets).toEqual([...ALL_UNIFIED_SEARCH_MARKETS]);
});

test('filtered search drops inaccessible futures rows and their provider failure state', () => {
  const response: UnifiedAssetSuggestResponse = {
    ok: true,
    state: 'PARTIAL',
    q: 'btc',
    asset: 'coin',
    market: null,
    results: [suggestion('spot'), suggestion('futures')],
    count: 2,
    dataAsOf: '2026-08-14T08:59:00.000Z',
    stale: false,
    partial: true,
    providers: [
      { provider: 'upbit', status: 'ok', count: 1, dataAsOf: '2026-08-14T09:00:00.000Z' },
      { provider: 'bitget', status: 'error', count: 0, dataAsOf: null, message: 'BITGET_DOWN' },
    ],
    hiddenMatches: [
      { market: 'spot', count: 1 },
      { market: 'futures', count: 1 },
    ],
  };

  const filtered = filterUnifiedSearchResponseByMarkets(response, ['KR', 'US', 'spot']);

  expect(filtered.results.map((item) => item.market)).toEqual(['spot']);
  expect(filtered.providers.map((item) => item.provider)).toEqual(['upbit']);
  expect(filtered.hiddenMatches).toEqual([{ market: 'spot', count: 1 }]);
  expect(filtered.count).toBe(1);
  expect(filtered.partial).toBe(false);
  expect(filtered.stale).toBe(false);
  expect(filtered.state).toBe('FULL');
  expect(filtered.dataAsOf).toBe('2026-08-14T09:00:00.000Z');
});

test('shared search component applies capability policy to results and recent rows', () => {
  expect(componentSource).toContain('allowedUnifiedSearchMarkets({');
  expect(componentSource).toContain('filterUnifiedSearchResponseByMarkets(next, effectiveAllowedMarkets)');
  expect(componentSource).toContain('recent.filter((item) =>');
  expect(componentSource).toContain('allowedMarketSet.has(item.market)');
  expect(componentSource).toContain('unified-search-skeleton');
  expect(componentSource).toContain('unified-search-refreshing');
  expect(componentSource).toContain('unified-search-last-good');
  expect(componentSource).not.toContain('setResponse(null);\n      setActiveIndex(-1);');
});

test('unified search page hides unavailable market controls and keeps broad phase11 coverage explicit', () => {
  expect(pageSource).toContain("location.startsWith('/__phase11-unified-search-e2e')");
  expect(pageSource).toContain('ALL_UNIFIED_SEARCH_MARKETS');
  expect(pageSource).toContain("canAccessSpot: auth.permissions.canAccessSpot");
  expect(pageSource).toContain("canAccessFutures: auth.permissions.canAccessFutures");
  expect(pageSource).toContain('visibleMarketFilters');
  expect(pageSource).toContain('allowedMarkets={allowedMarkets}');
  expect(pageSource).toContain("if (next && !isUnifiedSearchMarketAllowed(next, allowedMarkets)) return;");
  expect(pageSource).toContain("if (!isUnifiedSearchMarketAllowed(item.market, allowedMarkets)) return;");
});
