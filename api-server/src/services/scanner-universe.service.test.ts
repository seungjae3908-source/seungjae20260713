import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG } from '../data/catalog';
import { clearUsUniverseCacheForTests, getUsUniverse } from '../providers/us-universe';
import {
  SCANNER_PROVIDER_ROSTER_MINIMUM,
  ScannerUniverseService,
  classifyScannerUniverseSource,
  clearScannerUniverseCacheForTests,
  type ScannerUniverseEntry,
} from './scanner-universe.service';

function providerStock(
  ticker: string,
  market: 'KR' | 'US' = 'US',
  source = market === 'US' ? 'finnhub-symbol-master' : 'krx-symbol-master',
  listingStatus: 'LISTED' | 'UNKNOWN' = 'LISTED',
): ScannerUniverseEntry {
  return {
    ticker, name: ticker, market,
    currency: market === 'US' ? 'USD' : 'KRW',
    exchange: market === 'US' ? 'NASDAQ' : 'KOSPI',
    assetType: 'STOCK', source: source as ScannerUniverseEntry['source'],
    listingStatus,
  };
}

test('six hard-coded symbols never become a whole US or KR provider roster', () => {
  assert.equal(SCANNER_PROVIDER_ROSTER_MINIMUM.US, 1_000);
  assert.equal(SCANNER_PROVIDER_ROSTER_MINIMUM.KR, 500);
  for (const market of ['US', 'KR'] as const) {
    const tiny = Array.from({ length: 6 }, (_, i) =>
      providerStock(market === 'US' ? `T${i}` : String(i).padStart(6,'0'), market));
    const result = classifyScannerUniverseSource(market, tiny);
    assert.equal(result.partial, true);
    assert.equal(result.providerErrorCount, 1);
  }
});

test('dynamic full-size provider roster is eligible for batching but not execution authority', () => {
  for (const market of ['US', 'KR'] as const) {
    const symbols = Array.from({ length: SCANNER_PROVIDER_ROSTER_MINIMUM[market] + 25 }, (_, i) =>
      providerStock(market === 'US' ? `AAA${i}` : String(i).padStart(6,'0'), market));
    const ready = classifyScannerUniverseSource(market, symbols);
    assert.equal(ready.partial, false);
    assert.equal(ready.stale, false);
    assert.equal(ready.providerErrorCount, 0);
    const truncated = classifyScannerUniverseSource(market, symbols.slice(0, 6));
    assert.equal(truncated.partial, true);
  }
});

test('static catalog, stale cache and mixed provider lists stay explicitly partial', () => {
  const inputs = [
    [providerStock('AAPL', 'US', 'curated-fallback', 'UNKNOWN')],
    [providerStock('AAPL', 'US', 'last-good-cache', 'UNKNOWN')],
    [providerStock('AAPL', 'US'), providerStock('MSFT', 'US', 'last-good-cache', 'UNKNOWN')],
  ];
  for (const entries of inputs) {
    const result = classifyScannerUniverseSource('US', entries);
    assert.equal(result.partial, true);
    assert.equal(result.providerErrorCount, 1);
  }
  const lastGood = classifyScannerUniverseSource('US', inputs[1]);
  assert.equal(lastGood.source, 'last-good-cache');
  assert.equal(lastGood.stale, true);
});

test('missing US provider token uses UNKNOWN curated fallback; cursor pagination never disguises it as full universe', async () => {
  const keys = ['FINNHUB_API_KEY', 'VITE_FINNHUB_API_KEY', 'FINNHUB_KEY'] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  try {
    keys.forEach((key) => delete process.env[key]);
    clearUsUniverseCacheForTests();
    clearScannerUniverseCacheForTests();
    const raw = await getUsUniverse();
    assert.ok(raw.length > 0, 'the app should retain a curated lookup fallback');
    assert.ok(raw.every((row) =>
      row.listingStatus === 'UNKNOWN' && row.source === 'static-catalog'));
    const paged: string[] = [];
    let cursor = 0;
    for (let step = 0; step < 100; step++) {
      const batch = await ScannerUniverseService.batch('US', cursor, 10);
      assert.equal(batch.partial, true);
      assert.equal(batch.stale, true);
      assert.equal(batch.source, 'curated-fallback');
      assert.ok(batch.entries.every((row) =>
        row.listingStatus === 'UNKNOWN' && row.source === 'curated-fallback'));
      assert.equal(batch.cursor, cursor);
      paged.push(...batch.entries.map((row) => row.ticker));
      if (batch.nextCursor === null) {
        assert.equal(paged.length, batch.totalCount);
        break;
      }
      assert.ok(batch.nextCursor > cursor);
      cursor = batch.nextCursor;
    }
    assert.equal(paged.length, new Set(paged).size);
    const curated = new Set(CATALOG.filter((row) => row.market === 'US')
      .map((row) => row.ticker.trim().toUpperCase()));
    assert.ok(paged.every((ticker) => curated.has(ticker)));
    assert.ok(paged.length <= curated.size);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    clearUsUniverseCacheForTests();
    clearScannerUniverseCacheForTests();
  }
});
