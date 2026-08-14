import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ALL_UNIFIED_SEARCH_MARKETS,
  allowedUnifiedSearchMarkets,
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

test('shared search component filters results, recent rows, provider state, and hidden matches', () => {
  expect(componentSource).toContain('allowedUnifiedSearchMarkets({');
  expect(componentSource).toContain('next.results.filter((item) => allowedMarketSet.has(item.market))');
  expect(componentSource).toContain('next.hiddenMatches.filter((item) => allowedMarketSet.has(item.market))');
  expect(componentSource).toContain('recent.filter((item) =>');
  expect(componentSource).toContain('allowedMarketSet.has(item.market)');
  expect(componentSource).toContain('PROVIDER_MARKET');
  expect(componentSource).toContain('allowedMarketSet.has(providerMarket)');
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
