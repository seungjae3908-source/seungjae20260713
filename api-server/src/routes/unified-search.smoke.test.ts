import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import unifiedSearchRouter from './unified-search';
import {
  replaceUnifiedAssetSearchSnapshotForTests,
  resetUnifiedAssetSearchStateForTests,
  type UnifiedAssetSearchSnapshot,
} from '../services/unified-asset-search.service';
import { createUnifiedAssetId, type UnifiedAssetDocument } from '../lib/search-normalization';

const builtAt = new Date().toISOString();

function doc(input: Omit<UnifiedAssetDocument, 'id' | 'active' | 'provider' | 'dataAsOf'>): UnifiedAssetDocument {
  const value: UnifiedAssetDocument = { ...input, id: '', active: true, provider: input.exchange, dataAsOf: builtAt };
  value.id = createUnifiedAssetId(value);
  return value;
}

const snapshot: UnifiedAssetSearchSnapshot = {
  version: 1,
  builtAt,
  providers: [
    { provider: 'krx', status: 'ok', count: 1, dataAsOf: builtAt },
    { provider: 'finnhub', status: 'ok', count: 1, dataAsOf: builtAt },
    { provider: 'upbit', status: 'ok', count: 1, dataAsOf: builtAt },
    { provider: 'bitget', status: 'stale', count: 1, dataAsOf: builtAt, message: 'fixture stale fallback' },
  ],
  documents: [
    doc({ assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', aliases: ['삼성', 'samsung'], baseSymbol: '005930', quoteCurrency: 'KRW' }),
    doc({ assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'TSLA', productCode: 'TSLA', koreanName: '테슬라', englishName: 'Tesla', displayName: '테슬라', aliases: ['tesla'], baseSymbol: 'TSLA', quoteCurrency: 'USD' }),
    doc({ assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/KRW', 'BTC-KRW'], baseSymbol: 'BTC', quoteCurrency: 'KRW' }),
    doc({ assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', aliases: ['BTC/USDT'], baseSymbol: 'BTC', quoteCurrency: 'USDT' }),
  ],
};

test('unified search suggest route supports Korean, English, codes and market separation', async () => {
  replaceUnifiedAssetSearchSnapshotForTests(snapshot);
  const app = express();
  app.use('/api', unifiedSearchRouter);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    for (const [query, expected] of [['삼', '005930'], ['samsung', '005930'], ['테슬라', 'TSLA'], ['TSLA', 'TSLA'], ['BTC/KRW', 'KRW-BTC'], ['BTCUSDT', 'BTCUSDT']] as const) {
      const response = await fetch(`${base}/api/search/suggest?q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, any>;
      assert.equal(body.ok, true);
      assert.equal(body.results[0]?.productCode, expected);
      assert.equal('secret' in body.results[0], false);
      assert.equal('userId' in body.results[0], false);
    }

    const filtered = await fetch(`${base}/api/search/suggest?q=BTC&market=spot`);
    const filteredBody = await filtered.json() as Record<string, any>;
    assert.equal(filteredBody.results.length, 1);
    assert.equal(filteredBody.results[0].market, 'spot');
    assert.deepEqual(filteredBody.hiddenMatches, [{ market: 'futures', count: 1 }]);
    assert.equal(filteredBody.partial, true);

    const blank = await fetch(`${base}/api/search/suggest?q=`);
    assert.equal(blank.status, 400);
    const blankBody = await blank.json() as Record<string, unknown>;
    assert.equal(blankBody.error, 'SEARCH_QUERY_REQUIRED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetUnifiedAssetSearchStateForTests();
  }
});
