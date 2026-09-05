import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedAssetId, type UnifiedAssetDocument } from '../lib/search-normalization';
import { clearUsUniverseCacheForTests, getUsUniverse } from '../providers/us-universe';
import {
  replaceUnifiedAssetSearchSnapshotForTests,
  resetUnifiedAssetSearchStateForTests,
  searchUnifiedAssets,
  type UnifiedAssetSearchSnapshot,
} from './unified-asset-search.service';
import {
  buildSpotSearchFallback,
  SPOT_SEARCH_SOFT_DEADLINE_MS,
} from './unified-spot-search-fallback';

function document(input: Omit<UnifiedAssetDocument, 'id' | 'active' | 'dataAsOf'> & { dataAsOf: string }): UnifiedAssetDocument {
  const value: UnifiedAssetDocument = { ...input, id: '', active: true };
  value.id = createUnifiedAssetId(value);
  return value;
}

test('serves partial results from the last-good snapshot and reports its actual basis time', async () => {
  const builtAt = new Date().toISOString();
  const staleDataAsOf = '2026-08-03T03:00:00.000Z';
  const snapshot: UnifiedAssetSearchSnapshot = {
    version: 1,
    builtAt,
    providers: [
      { provider: 'krx', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'finnhub', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'upbit', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'bitget', status: 'stale', count: 1, dataAsOf: staleDataAsOf, message: '마지막 정상 인덱스 사용' },
    ],
    documents: [
      document({ assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/KRW'], baseSymbol: 'BTC', quoteCurrency: 'KRW', provider: 'UPBIT', dataAsOf: builtAt }),
      document({ assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/USDT'], baseSymbol: 'BTC', quoteCurrency: 'USDT', provider: 'BITGET', dataAsOf: staleDataAsOf }),
    ],
  };

  replaceUnifiedAssetSearchSnapshotForTests(snapshot);
  try {
    const response = await searchUnifiedAssets({ q: 'BTC', limit: 10 });
    assert.equal(response.count, 2);
    assert.equal(response.partial, true);
    assert.equal(response.stale, true);
    assert.equal(response.dataAsOf, staleDataAsOf);
    assert.deepEqual(new Set(response.results.map((item) => item.market)), new Set(['spot', 'futures']));
    assert.equal(response.providers.find((item) => item.provider === 'bitget')?.status, 'stale');
  } finally {
    resetUnifiedAssetSearchStateForTests();
  }
});

test('keeps a provider error explicit when no last-good rows exist', async () => {
  const builtAt = new Date().toISOString();
  const snapshot: UnifiedAssetSearchSnapshot = {
    version: 1,
    builtAt,
    providers: [
      { provider: 'krx', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'finnhub', status: 'error', count: 0, dataAsOf: null, message: 'FINNHUB_UNAVAILABLE' },
      { provider: 'upbit', status: 'error', count: 0, dataAsOf: null, message: 'UPBIT_UNAVAILABLE' },
      { provider: 'bitget', status: 'error', count: 0, dataAsOf: null, message: 'BITGET_UNAVAILABLE' },
    ],
    documents: [
      document({ assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', aliases: ['삼성'], baseSymbol: '005930', quoteCurrency: 'KRW', provider: 'KRX', dataAsOf: builtAt }),
    ],
  };

  replaceUnifiedAssetSearchSnapshotForTests(snapshot);
  try {
    const response = await searchUnifiedAssets({ q: '삼성', limit: 10 });
    assert.equal(response.count, 1);
    assert.equal(response.partial, true);
    assert.equal(response.providers.find((item) => item.provider === 'finnhub')?.status, 'error');
    assert.equal(response.providers.find((item) => item.provider === 'finnhub')?.message, 'FINNHUB_UNAVAILABLE');
  } finally {
    resetUnifiedAssetSearchStateForTests();
  }
});

test('uses the repository US catalog when Finnhub credentials are absent', async () => {
  const keys = ['FINNHUB_API_KEY', 'VITE_FINNHUB_API_KEY', 'FINNHUB_KEY'] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  clearUsUniverseCacheForTests();
  try {
    const rows = await getUsUniverse();
    const aapl = rows.find((row) => row.ticker === 'AAPL');
    const nvda = rows.find((row) => row.ticker === 'NVDA');
    assert.ok(rows.length > 0);
    assert.equal(aapl?.name, 'Apple');
    assert.equal(nvda?.name, 'NVIDIA');
    assert.equal(aapl?.source, 'static-catalog');
    assert.equal(nvda?.source, 'static-catalog');
  } finally {
    clearUsUniverseCacheForTests();
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('spot metadata fallback finds BTC without pretending live Upbit availability', () => {
  const response = buildSpotSearchFallback('BTC', 10, '2026-08-19T11:55:00.000Z');
  assert.ok(response);
  assert.equal(response.count, 1);
  assert.equal(response.partial, true);
  assert.equal(response.stale, true);
  assert.equal(response.dataAsOf, null);
  assert.equal(response.results[0]?.productCode, 'KRW-BTC');
  assert.equal(response.results[0]?.market, 'spot');
  assert.equal(response.results[0]?.provider, 'SEARCH_ALIAS_CATALOG');
  assert.equal(response.results[0]?.active, false);
  assert.equal(response.providers[0]?.provider, 'upbit');
  assert.equal(response.providers[0]?.status, 'stale');
  assert.equal(response.providers[0]?.dataAsOf, null);
  assert.match(response.providers[0]?.message ?? '', /상장·가격·주문 가능 상태는 확인되지 않았습니다/);
  assert.equal('price' in (response.results[0] ?? {}), false);
  assert.equal('orderable' in (response.results[0] ?? {}), false);
});

test('spot metadata fallback stays bounded and does not invent unknown assets', () => {
  assert.equal(SPOT_SEARCH_SOFT_DEADLINE_MS <= 5_000, true);
  assert.equal(buildSpotSearchFallback('THIS_ASSET_DOES_NOT_EXIST', 10), null);
});
