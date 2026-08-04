import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../sample/types';
import type { ScanCard } from './signal.service';
import type { ScannerUniverseEntry } from './scanner-universe.service';
import { applyStockSignalPolicy } from './scanner-signal-policy.service';

const candles = (): Candle[] => Array.from({ length: 40 }, (_, index) => ({
  time: Date.now() - (40 - index) * 86_400_000,
  open: 100 + index * 0.2,
  high: 102 + index * 0.2,
  low: 99 + index * 0.2,
  close: 101 + index * 0.2,
  volume: 100_000 + index * 1_000,
}));

const universe: ScannerUniverseEntry = {
  ticker: '005930',
  name: '삼성전자',
  market: 'KR',
  currency: 'KRW',
  assetType: 'STOCK',
  exchange: 'KRX',
  listingStatus: 'LISTED',
};

function factor(score: number | null, status: 'ok' | 'unavailable' = 'ok') {
  return { score, status, reasons: status === 'ok' ? ['실데이터 확인'] : ['데이터 없음'] };
}

function card(overrides: Partial<ScanCard> = {}): ScanCard {
  return {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    assetType: 'STOCK',
    price: 108,
    changePercent: 1.2,
    score: 100,
    confidence: 95,
    matched: ['거래량 증가'],
    missing: [],
    breakoutProbability: 80,
    expectedPeriod: '단기',
    entry: [],
    stop: [],
    matchCount: 1,
    selectedCount: 1,
    riskLevel: 'LOW',
    riskScore: 20,
    liquidity: 10_000_000_000,
    marketCap: 500_000_000_000,
    dataState: 'ok',
    analyzedAt: new Date().toISOString(),
    scoreBreakdown: {
      trend: factor(100),
      volume: factor(100),
      liquidity: factor(100),
      technical: factor(100),
      news: factor(100),
      financial: factor(100),
      market: factor(100),
      risk: factor(100),
    },
    ...overrides,
  };
}

test('missing risk and context data cannot be promoted to a strong signal', () => {
  const input = card({
    riskLevel: 'UNAVAILABLE',
    riskScore: null,
    scoreBreakdown: {
      trend: factor(100),
      volume: factor(100),
      liquidity: factor(100),
      technical: factor(100),
      news: factor(null, 'unavailable'),
      financial: factor(null, 'unavailable'),
      market: factor(null, 'unavailable'),
      risk: factor(null, 'unavailable'),
    },
  });
  const result = applyStockSignalPolicy({
    memberId: 'member-1',
    card: input,
    universeEntry: universe,
    candles: candles(),
    selected: ['거래량 증가', '뉴스 호재'],
    timeframe: '1D',
  });
  assert.ok(result.score <= 64);
  assert.ok(result.dataCompleteness < 80);
  assert.equal(result.strongSignalEligible, false);
  assert.equal(result.riskScore, null);
  assert.ok(result.unverified.includes('뉴스 호재'));
  assert.ok(result.warnings.includes('위험 데이터 없음'));
});

test('complete verified evidence remains eligible without fabricated factors', () => {
  const result = applyStockSignalPolicy({
    memberId: 'member-1',
    card: card(),
    universeEntry: universe,
    candles: candles(),
    selected: ['거래량 증가'],
    timeframe: '1D',
  });
  assert.equal(result.score, 100);
  assert.equal(result.dataCompleteness, 100);
  assert.equal(result.strongSignalEligible, true);
  assert.deepEqual(result.matched, ['거래량 증가']);
  assert.deepEqual(result.unverified, []);
  assert.ok((result.pricePlan.riskReward ?? 0) >= 1.5);
});
