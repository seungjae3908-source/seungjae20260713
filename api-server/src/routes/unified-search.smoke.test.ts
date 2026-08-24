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
import { deriveUnifiedSearchState } from '../services/unified-search-state';
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

test('unified search state separates full, partial, degraded and empty success states', () => {
  assert.equal(deriveUnifiedSearchState({ resultCount: 3, partial: false, stale: false }), 'FULL');
  assert.equal(deriveUnifiedSearchState({ resultCount: 3, partial: true, stale: false }), 'PARTIAL');
  assert.equal(deriveUnifiedSearchState({ resultCount: 1, partial: true, stale: true }), 'PARTIAL');
  assert.equal(deriveUnifiedSearchState({ resultCount: 0, partial: true, stale: false }), 'DEGRADED');
  assert.equal(deriveUnifiedSearchState({ resultCount: 1, partial: false, stale: true }), 'DEGRADED');
  assert.equal(deriveUnifiedSearchState({ resultCount: 0, partial: false, stale: false }), 'EMPTY');
});

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
      assert.equal(body.state, 'PARTIAL');
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
    assert.equal(filteredBody.state, 'PARTIAL');

    const missing = await fetch(`${base}/api/search/suggest?q=${encodeURIComponent('없는자산')}`);
    assert.equal(missing.status, 200);
    const missingBody = await missing.json() as Record<string, any>;
    assert.equal(missingBody.results.length, 0);
    assert.equal(missingBody.state, 'DEGRADED');

    const blank = await fetch(`${base}/api/search/suggest?q=`);
    assert.equal(blank.status, 400);
    const blankBody = await blank.json() as Record<string, unknown>;
    assert.equal(blankBody.state, 'ERROR');
    assert.equal(blankBody.error, 'SEARCH_QUERY_REQUIRED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetUnifiedAssetSearchStateForTests();
  }
});

test('KR search degrades to static identity metadata without asserting live eligibility', async () => {
  const degradedKrSnapshot: UnifiedAssetSearchSnapshot = {
    version: 1,
    builtAt,
    providers: [
      { provider: 'krx', status: 'error', count: 0, dataAsOf: null, message: 'fixture unavailable' },
      { provider: 'finnhub', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'upbit', status: 'ok', count: 0, dataAsOf: builtAt },
      { provider: 'bitget', status: 'ok', count: 0, dataAsOf: builtAt },
    ],
    documents: [
      doc({ assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'AAPL', productCode: 'AAPL', koreanName: '', englishName: 'Apple', displayName: 'Apple', aliases: ['apple'], baseSymbol: 'AAPL', quoteCurrency: 'USD' }),
    ],
  };

  replaceUnifiedAssetSearchSnapshotForTests(degradedKrSnapshot);
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

    const known = await fetch(`${base}/api/search/suggest?q=005930&asset=stock&market=KR`);
    assert.equal(known.status, 200);
    const knownBody = await known.json() as Record<string, any>;
    assert.equal(knownBody.ok, true);
    assert.equal(knownBody.state, 'PARTIAL');
    assert.equal(knownBody.partial, true);
    assert.equal(knownBody.stale, true);
    assert.equal(knownBody.results[0]?.ticker, '005930');
    assert.equal(knownBody.results[0]?.provider, 'STATIC_KR_CATALOG');
    assert.equal(knownBody.results[0]?.active, false);
    assert.equal(knownBody.providers[0]?.provider, 'krx');
    assert.equal(knownBody.providers[0]?.status, 'stale');

    const unknown = await fetch(`${base}/api/search/suggest?q=999999&asset=stock&market=KR`);
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json() as Record<string, any>;
    assert.equal(unknownBody.results.length, 0);
    assert.equal(unknownBody.state, 'DEGRADED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetUnifiedAssetSearchStateForTests();
  }
});

test('US search degrades to static identity metadata without asserting live eligibility', async () => {
  const degradedUsSnapshot: UnifiedAssetSearchSnapshot = {
    version: 1,
    builtAt,
    providers: [
      { provider: 'krx', status: 'ok', count: 1, dataAsOf: builtAt },
      { provider: 'finnhub', status: 'error', count: 0, dataAsOf: null, message: 'fixture refresh in progress' },
      { provider: 'upbit', status: 'ok', count: 0, dataAsOf: builtAt },
      { provider: 'bitget', status: 'ok', count: 0, dataAsOf: builtAt },
    ],
    documents: [
      doc({ assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', aliases: ['삼성', 'samsung'], baseSymbol: '005930', quoteCurrency: 'KRW' }),
    ],
  };

  replaceUnifiedAssetSearchSnapshotForTests(degradedUsSnapshot);
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

    const known = await fetch(`${base}/api/search/suggest?q=AAPL&asset=stock&market=US`);
    assert.equal(known.status, 200);
    const knownBody = await known.json() as Record<string, any>;
    assert.equal(knownBody.ok, true);
    assert.equal(knownBody.state, 'PARTIAL');
    assert.equal(knownBody.partial, true);
    assert.equal(knownBody.stale, true);
    assert.equal(knownBody.results[0]?.ticker, 'AAPL');
    assert.equal(knownBody.results[0]?.provider, 'STATIC_US_CATALOG');
    assert.equal(knownBody.results[0]?.active, false);
    assert.equal(knownBody.results[0]?.matchType, 'code_exact');
    assert.equal(knownBody.providers[0]?.provider, 'finnhub');
    assert.equal(knownBody.providers[0]?.status, 'stale');
    assert.equal(knownBody.dataAsOf, null);

    const unknown = await fetch(`${base}/api/search/suggest?q=NOTINCATALOG&asset=stock&market=US`);
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json() as Record<string, any>;
    assert.equal(unknownBody.results.length, 0);
    assert.equal(unknownBody.state, 'DEGRADED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetUnifiedAssetSearchStateForTests();
  }
});
