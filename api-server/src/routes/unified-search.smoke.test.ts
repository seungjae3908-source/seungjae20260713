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

function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise<{ server: ReturnType<typeof app.listen>; base: string }>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
    server.once('error', reject);
  });
}

async function close(server: ReturnType<express.Express['listen']>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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
  const { server, base } = await listen(app);
  try {
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
    await close(server);
    resetUnifiedAssetSearchStateForTests();
  }
});

test('unified search falls back to curated KR metadata when the live KRX index is unavailable', async () => {
  const degraded: UnifiedAssetSearchSnapshot = {
    ...snapshot,
    providers: snapshot.providers.map((provider) => provider.provider === 'krx'
      ? { provider: 'krx' as const, status: 'error' as const, count: 0, dataAsOf: null, message: 'fixture KRX unavailable' }
      : provider),
    documents: snapshot.documents.filter((document) => document.market !== 'KR'),
  };
  replaceUnifiedAssetSearchSnapshotForTests(degraded);
  const app = express();
  app.use('/api', unifiedSearchRouter);
  const { server, base } = await listen(app);
  try {
    for (const ticker of ['005930', '000660', '035420', '051910', '068270']) {
      const response = await fetch(`${base}/api/search/suggest?q=${ticker}&asset=stock&market=KR`);
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, any>;
      assert.equal(body.ok, true);
      assert.equal(body.state, 'PARTIAL');
      assert.equal(body.results[0]?.productCode, ticker);
      assert.equal(body.results[0]?.market, 'KR');
      assert.equal(body.results[0]?.provider, 'STATIC_KR_CATALOG');
      assert.equal(body.results[0]?.active, false);
      assert.equal(body.dataAsOf, null);
      assert.equal(body.partial, true);
      assert.equal(body.stale, true);
      assert.equal(body.providers[0]?.provider, 'krx');
      assert.equal(body.providers[0]?.status, 'stale');
      assert.match(String(body.providers[0]?.message ?? ''), /정적 KR 종목 메타데이터/);
    }
  } finally {
    await close(server);
    resetUnifiedAssetSearchStateForTests();
  }
});
