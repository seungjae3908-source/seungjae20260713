import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../sample/types';
import type { ScanCard } from './signal.service';
import type { ScannerUniverseEntry } from './scanner-universe.service';
import { applyStockSignalPolicy } from './scanner-signal-policy.service';
import './telegram-investment-intelligence.service.test';
import './scanner-telegram-plan-format.service.test';

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
  source: 'krx-symbol-master',
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
    quoteObservedAt: new Date().toISOString(),
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

test('stock policy preserves provider time and never renews expiry at analysis time', () => {
  const now = Date.now();
  const quoteObservedAt = new Date(now - 120_000).toISOString();
  const result = applyStockSignalPolicy({
    memberId: 'time-test', card: card({ quoteObservedAt, analyzedAt: new Date(now).toISOString() }),
    universeEntry: universe, candles: candles(), selected: ['거래량 증가'], timeframe: '5m', now,
  });
  assert.equal(result.observedAt, quoteObservedAt);
  assert.equal(result.expiresAt, new Date(now - 120_000 + 15 * 60_000).toISOString());
  assert.equal(result.strongSignalEligible, true);
});

test('missing, invalid, future and stale quote time cannot become a fresh strong signal', () => {
  const now = Date.now();
  for (const quoteObservedAt of [undefined, null, '', 'bad-time', '2026-02-30T00:00:00Z', new Date(now + 1_000).toISOString(), new Date(now - 600_000).toISOString()]) {
    const result = applyStockSignalPolicy({
      memberId: 'invalid-time', card: card({ quoteObservedAt, analyzedAt: new Date(now).toISOString() }),
      universeEntry: universe, candles: candles(), selected: ['거래량 증가'], timeframe: '5m', now,
    });
    assert.equal(result.strongSignalEligible, false);
    assert.equal(result.signalState, 'INVALIDATED');
    assert.equal(result.pricePlan.entryZone, null);
    assert.equal(result.pricePlan.riskReward, null);
    assert.deepEqual(result.matched, []);
    assert.equal(result.evidence[0].status, 'unverified');
    if (result.dataState !== 'stale') {
      assert.equal(result.observedAt, null);
      assert.equal(result.expiresAt, null);
    }
  }
});

test('invalid analysis clock does not create a usable price plan from otherwise valid source data', () => {
  const now = Date.now();
  for (const analyzedAt of ['', 'invalid', new Date(now + 1000).toISOString()]) {
    const result = applyStockSignalPolicy({
      memberId: 'invalid-analysis', card: card({ analyzedAt, quoteObservedAt: new Date(now).toISOString() }),
      universeEntry: universe, candles: candles(), selected: ['거래량 증가'], timeframe: '5m', now,
    });
    assert.equal(result.strongSignalEligible, false);
    assert.equal(result.dataState, 'untrusted');
    assert.equal(result.pricePlan.stopLoss, null);
  }
});
