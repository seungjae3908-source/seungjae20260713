import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { KiwoomRankingRow } from '../providers/kiwoom';
import type { KiwoomFallbackRankingRow } from '../services/kiwoom-ranking-fallback.service';
import { createKiwoomRankingsSafeRouter } from './kiwoom-rankings-safe';

const primaryRow: KiwoomRankingRow = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  price: 80_000,
  changePercent: 1.2,
  volume: 10_000,
  tradingValue: 800_000_000,
  rank: 1,
  sourceRank: 1,
  assetType: 'STOCK',
  isEtp: false,
  isLeveraged: false,
  isInverse: false,
  isDerivative: false,
  riskLevel: 'NORMAL',
  recommendationEligible: true,
  dataQualityWarnings: [],
  reason: '키움증권 거래량 상위 종목입니다.',
  provider: 'kiwoom',
  raw: {},
};

const fallbackRow: KiwoomFallbackRankingRow = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  assetType: 'STOCK',
  price: 80_000,
  changeAmount: 900,
  changePercent: 1.2,
  volume: 10_000,
  tradingValue: 800_000_000,
  updatedAt: '2026-08-05T03:00:00.000Z',
  rating: {
    rating: 'BUY',
    confidence: 0.7,
    score: 72,
  },
  rank: 1,
  sourceRank: 1,
  provider: 'live-market-providers',
  fallbackUsed: true,
  fallbackReason:
    '키움 랭킹 공급자를 사용할 수 없어 실제 대체 시장데이터 공급자의 결과를 표시합니다.',
  reason:
    '키움 랭킹 공급자를 사용할 수 없어 실제 대체 시장데이터 공급자의 결과를 표시합니다.',
  dataQualityWarnings: [
    '키움 원본 랭킹이 아니며 공급자별 지연 시간은 다를 수 있습니다.',
  ],
};

async function requestJson(
  router: ReturnType<typeof createKiwoomRankingsSafeRouter>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/api/kiwoom', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/kiwoom/rankings?market=KR&type=volume&limit=30&assetFilter=stocks&excludeHighRisk=true`,
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('unconfigured Kiwoom skips the primary request and returns explicit live fallback rows', async () => {
  let primaryCalls = 0;
  const response = await requestJson(
    createKiwoomRankingsSafeRouter({
      isConfigured: () => false,
      getPrimaryRows: async () => {
        primaryCalls += 1;
        return [primaryRow];
      },
      getFallbackRows: async () => [fallbackRow],
    }),
  );

  assert.equal(primaryCalls, 0);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.status, 'partial');
  assert.equal(response.body.fallbackUsed, true);
  assert.equal(response.body.fallbackProvider, 'live-market-providers');
  assert.equal(response.body.providerErrorCode, 'KIWOOM_NOT_CONFIGURED');
  assert.deepEqual(response.body.missingData, ['kiwoom_rankings']);
  assert.equal((response.body.rows as KiwoomFallbackRankingRow[])[0]?.provider, 'live-market-providers');
});

test('configured Kiwoom preserves the primary ready response without fallback', async () => {
  let fallbackCalls = 0;
  const response = await requestJson(
    createKiwoomRankingsSafeRouter({
      isConfigured: () => true,
      getPrimaryRows: async () => [primaryRow],
      getFallbackRows: async () => {
        fallbackCalls += 1;
        return [fallbackRow];
      },
    }),
  );

  assert.equal(fallbackCalls, 0);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'ready');
  assert.equal(response.body.fallbackUsed, false);
  assert.equal((response.body.rows as KiwoomRankingRow[])[0]?.provider, 'kiwoom');
});

test('provider and fallback failures remain a real HTTP 502', async () => {
  const response = await requestJson(
    createKiwoomRankingsSafeRouter({
      isConfigured: () => true,
      getPrimaryRows: async () => {
        throw new Error('PRIMARY_DOWN');
      },
      getFallbackRows: async () => {
        throw new Error('FALLBACK_DOWN');
      },
    }),
  );

  assert.equal(response.status, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.status, 'provider_error');
  assert.equal(response.body.error, 'RANKING_PROVIDERS_UNAVAILABLE');
  assert.equal(response.body.fallbackUsed, false);
  assert.deepEqual(response.body.rows, []);
});
