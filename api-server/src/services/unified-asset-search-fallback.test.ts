import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnifiedAssetId, type UnifiedAssetDocument } from '../lib/search-normalization';
import {
  replaceUnifiedAssetSearchSnapshotForTests,
  resetUnifiedAssetSearchStateForTests,
  searchUnifiedAssets,
  type UnifiedAssetSearchSnapshot,
} from './unified-asset-search.service';

function document(input: Omit<UnifiedAssetDocument, 'id' | 'active' | 'dataAsOf'> & { dataAsOf: string }): UnifiedAssetDocument {
  const value: UnifiedAssetDocument = { ...input, id: '', active: true };
  value.id = createUnifiedAssetId(value);
  return value;
}

test('serves partial results from the last-good snapshot when one provider is stale', async () => {
  const builtAt = new Date().toISOString();
  const snapshot: UnifiedAssetSearchSnapshot = {
    version: 1,
    builtAt,
    providers: [
      { provider: 'krx', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'finnhub', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'upbit', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'bitget', status: 'stale', count: 1, dataAsOf: builtAt, message: '마지막 정상 인덱스 사용' },
    ],
    documents: [
      document({ assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/KRW'], baseSymbol: 'BTC', quoteCurrency: 'KRW', provider: 'UPBIT', dataAsOf: builtAt }),
      document({ assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/USDT'], baseSymbol: 'BTC', quoteCurrency: 'USDT', provider: 'BITGET', dataAsOf: builtAt }),
    ],
  };

  replaceUnifiedAssetSearchSnapshotForTests(snapshot);
  try {
    const response = await searchUnifiedAssets({ q: 'BTC', limit: 10 });
    assert.equal(response.count, 2);
    assert.equal(response.partial, true);
    assert.equal(response.stale, true);
    assert.deepEqual(new Set(response.results.map((item) => item.market)), new Set(['spot', 'futures']));
    assert.equal(response.providers.find((item) => item.provider === 'bitget')?.status, 'stale');
  } finally {
    resetUnifiedAssetSearchStateForTests();
  }
});
