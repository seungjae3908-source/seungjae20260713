import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScannerSignalLifecycle,
  clearScannerSignalLifecycleForTests,
} from './scanner-signal-lifecycle.service';
import type { ScannerSignalCard } from './scanner-signal.types';

function card(overrides: Partial<ScannerSignalCard> = {}): ScannerSignalCard {
  const observedAt = new Date('2026-08-05T00:00:00.000Z').toISOString();
  return {
    signalId: 'signal:base',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol: '005930',
    name: '삼성전자',
    currency: 'KRW',
    assetType: 'STOCK',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'DETECTED',
    score: 85,
    confidence: 82,
    dataCompleteness: 90,
    riskScore: 25,
    riskLevel: 'LOW',
    liquidity: 1_000_000_000,
    volume: 100_000,
    tradingValue: 10_000_000,
    spreadPercent: null,
    volatilityPercent: 2,
    matched: ['거래량 증가'],
    notMatched: [],
    unverified: [],
    evidence: [{
      key: '거래량 증가',
      label: '거래량 증가',
      status: 'matched',
      source: 'market-candles-volume',
      observedAt,
      reasons: ['실데이터 확인'],
    }],
    pricePlan: {
      entryZone: { from: 98, to: 100 },
      invalidation: 95,
      stopLoss: 95,
      targets: [108, 112],
      riskReward: 1.6,
    },
    dataState: 'complete',
    dataSources: ['market-quote', 'market-candles'],
    observedAt,
    expiresAt: new Date('2026-08-06T00:00:00.000Z').toISOString(),
    strongSignalEligible: true,
    warnings: [],
    ...overrides,
  };
}

test('READY alert is emitted once and a weakened re-entry starts a new cycle', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const first = applyScannerSignalLifecycle('member-1', [card()], now);
  assert.equal(first.cards[0].signalState, 'DETECTED');
  assert.equal(first.cards[0].marketClass, 'KR_STOCK');
  assert.equal(first.cards[0].action, 'BUY');
  assert.equal(first.cards[0].executionIntent, 'OPEN_OR_ADD');
  assert.equal(first.alerts.length, 0);

  const second = applyScannerSignalLifecycle('member-1', [card()], now + 1_000);
  assert.equal(second.cards[0].signalState, 'WATCHING');
  assert.equal(second.alerts.length, 0);

  const third = applyScannerSignalLifecycle('member-1', [card()], now + 2_000);
  assert.equal(third.cards[0].signalState, 'READY_FOR_APPROVAL');
  assert.equal(third.alerts.length, 1);
  assert.equal(third.alerts[0].action, 'BUY');
  assert.equal(third.alerts[0].executionIntent, 'OPEN_OR_ADD');
  assert.equal(third.alerts[0].marketClass, 'KR_STOCK');
  assert.match(third.alerts[0].performanceKey, /^KR_STOCK\|/);
  assert.equal(third.alerts[0].orderSubmitted, false);
  assert.equal(third.alerts[0].exchangeRequestSent, false);

  const fourth = applyScannerSignalLifecycle('member-1', [card()], now + 3_000);
  assert.equal(fourth.cards[0].signalState, 'READY_FOR_APPROVAL');
  assert.equal(fourth.alerts.length, 0);

  const weakened = applyScannerSignalLifecycle(
    'member-1',
    [card({ strongSignalEligible: false })],
    now + 4_000,
  );
  assert.equal(weakened.cards[0].signalState, 'WEAKENED');

  const reentry1 = applyScannerSignalLifecycle('member-1', [card()], now + 5_000);
  const reentry2 = applyScannerSignalLifecycle('member-1', [card()], now + 6_000);
  const reentry3 = applyScannerSignalLifecycle('member-1', [card()], now + 7_000);
  assert.match(reentry1.cards[0].signalId, /:cycle:2$/);
  assert.equal(reentry1.cards[0].signalState, 'DETECTED');
  assert.equal(reentry2.cards[0].signalState, 'WATCHING');
  assert.equal(reentry3.cards[0].signalState, 'READY_FOR_APPROVAL');
  assert.equal(reentry3.alerts.length, 1);
  assert.notEqual(reentry3.alerts[0].idempotencyKey, third.alerts[0].idempotencyKey);
});

test('market-specific approval gate blocks a raw US signal below the US threshold', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const weakUsCard = card({
    signalId: 'signal:us',
    market: 'US',
    exchange: 'NASDAQ',
    symbol: 'AAPL',
    currency: 'USD',
    score: 76,
    confidence: 76,
    strongSignalEligible: true,
  });
  const result = applyScannerSignalLifecycle('member-us', [weakUsCard], now);
  assert.equal(result.cards[0].marketClass, 'US_STOCK');
  assert.equal(result.cards[0].marketApprovalEligible, false);
  assert.equal(result.cards[0].signalState, 'DETECTED');
  assert.match(result.cards[0].warnings.join(' '), /점수 78 미만/);
  assert.equal(result.alerts.length, 0);
});

test('spot SELL alert stays reduce-only through the lifecycle', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const spotSell = card({
    signalId: 'signal:spot-sell',
    assetClass: 'coin_spot',
    market: 'UPBIT_KRW',
    exchange: 'UPBIT',
    symbol: 'BTC',
    name: '비트코인',
    currency: 'KRW',
    assetType: 'CRYPTO_SPOT',
    direction: 'NEUTRAL',
    changePercent: -3,
    score: 82,
    confidence: 80,
    dataCompleteness: 92,
    riskScore: 20,
    liquidity: 50_000_000_000,
    spreadPercent: 0.08,
    strongSignalEligible: false,
    evidence: [
      { key: 'volume', label: '거래량', status: 'matched', source: 'test', observedAt: '2026-08-05T00:00:00.000Z', reasons: ['거래량'] },
      { key: 'liquidity', label: '유동성', status: 'matched', source: 'test', observedAt: '2026-08-05T00:00:00.000Z', reasons: ['유동성'] },
      { key: 'spread', label: '스프레드', status: 'matched', source: 'test', observedAt: '2026-08-05T00:00:00.000Z', reasons: ['스프레드'] },
      { key: 'risk', label: '위험', status: 'matched', source: 'test', observedAt: '2026-08-05T00:00:00.000Z', reasons: ['위험'] },
    ],
  });
  applyScannerSignalLifecycle('member-spot', [spotSell], now);
  applyScannerSignalLifecycle('member-spot', [spotSell], now + 1_000);
  const ready = applyScannerSignalLifecycle('member-spot', [spotSell], now + 2_000);
  assert.equal(ready.cards[0].action, 'SELL');
  assert.equal(ready.cards[0].executionIntent, 'REDUCE_OR_EXIT');
  assert.equal(ready.cards[0].signalState, 'READY_FOR_APPROVAL');
  assert.equal(ready.alerts.length, 1);
  assert.equal(ready.alerts[0].action, 'SELL');
  assert.equal(ready.alerts[0].executionIntent, 'REDUCE_OR_EXIT');
  assert.deepEqual(ready.alerts[0].targets, []);
});

test('expired signal never produces a READY alert', () => {
  clearScannerSignalLifecycleForTests();
  const result = applyScannerSignalLifecycle(
    'member-2',
    [card({ expiresAt: '2026-08-04T00:00:00.000Z' })],
    Date.parse('2026-08-05T00:00:00.000Z'),
  );
  assert.equal(result.cards[0].signalState, 'EXPIRED');
  assert.equal(result.alerts.length, 0);
});
