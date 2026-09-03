import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScannerSignalLifecycle,
  clearScannerSignalLifecycleForTests,
  getScannerLifecycleSnapshot,
  getScannerSignalLifecycleSnapshot,
  scannerLifecycleStateForRiskBridge,
  setScannerExternalLifecycleState,
} from './scanner-signal-lifecycle.service';
import type { ScannerSignalCard, ScannerSignalState } from './scanner-signal.types';

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
    signalState: 'CANDIDATE',
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

test('scanner lifecycle reaches approval pending once and never submits an order', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const expected = ['CANDIDATE', 'CONFIRMED', 'ARMED', 'ENTRY_ZONE', 'APPROVAL_PENDING'] as const;
  let approvalAlert = '';
  for (let index = 0; index < expected.length; index += 1) {
    const result = applyScannerSignalLifecycle('member-1', [card()], now + index * 1_000);
    assert.equal(result.cards[0].signalState, expected[index]);
    if (expected[index] === 'APPROVAL_PENDING') {
      assert.equal(result.alerts.length, 1);
      assert.equal(result.alerts[0].state, 'APPROVAL_PENDING');
      assert.equal(result.alerts[0].orderSubmitted, false);
      assert.equal(result.alerts[0].exchangeRequestSent, false);
      approvalAlert = result.alerts[0].idempotencyKey;
    } else {
      assert.equal(result.alerts.length, 0);
    }
  }

  const repeated = applyScannerSignalLifecycle('member-1', [card()], now + 6_000);
  assert.equal(repeated.cards[0].signalState, 'APPROVAL_PENDING');
  assert.equal(repeated.alerts.length, 0);
  assert.ok(approvalAlert);
  assert.equal(getScannerSignalLifecycleSnapshot('member-1', repeated.cards[0].signalId)?.state, 'READY_FOR_APPROVAL');
});

test('DATA_UNTRUSTED invalidates before ARMED, ENTRY_ZONE or approval can continue', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  let current = card();
  for (let index = 0; index < 3; index += 1) {
    current = applyScannerSignalLifecycle('member-untrusted', [current], now + index * 1_000).cards[0];
  }
  assert.equal(current.signalState, 'ARMED');

  const invalidated = applyScannerSignalLifecycle('member-untrusted', [card({
    signalId: current.signalId,
    dataState: 'untrusted',
    dataQuality: {
      state: 'DATA_UNTRUSTED',
      score: 40,
      strongSignalAllowed: false,
      issues: [{ code: 'STALE_TIMESTAMP', severity: 'blocking', message: 'stale' }],
    },
    strongSignalEligible: false,
  })], now + 4_000);
  assert.equal(invalidated.cards[0].signalState, 'INVALIDATED');
  assert.equal(invalidated.alerts.length, 0);
  assert.equal(getScannerSignalLifecycleSnapshot('member-untrusted', invalidated.cards[0].signalId)?.state, 'INVALIDATED');
});

test('untrusted or weakened signal invalidates and re-entry starts a new cycle', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  applyScannerSignalLifecycle('member-1', [card()], now);
  const invalidated = applyScannerSignalLifecycle(
    'member-1',
    [card({ strongSignalEligible: false, dataState: 'untrusted' })],
    now + 1_000,
  );
  assert.equal(invalidated.cards[0].signalState, 'INVALIDATED');

  const reentry = applyScannerSignalLifecycle('member-1', [card()], now + 2_000);
  assert.match(reentry.cards[0].signalId, /:cycle:2$/);
  assert.equal(reentry.cards[0].signalState, 'CANDIDATE');
});

test('scalping and swing keep independent lifecycle identity', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const scalping = applyScannerSignalLifecycle('member-strategy', [card({ strategyMode: 'scalping' })], now).cards[0];
  const swing = applyScannerSignalLifecycle('member-strategy', [card({ strategyMode: 'swing' })], now + 1_000).cards[0];
  assert.match(scalping.signalId, /:strategy:scalping$/);
  assert.match(swing.signalId, /:strategy:swing$/);
  assert.notEqual(scalping.signalId, swing.signalId);
  assert.equal(scalping.signalState, 'CANDIDATE');
  assert.equal(swing.signalState, 'CANDIDATE');
});

test('order-owned states are synchronized externally and scanner does not advance them', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  let current = card();
  for (let index = 0; index < 5; index += 1) {
    current = applyScannerSignalLifecycle('member-3', [current], now + index * 1_000).cards[0];
  }
  assert.equal(current.signalState, 'APPROVAL_PENDING');
  assert.equal(getScannerLifecycleSnapshot('member-3', current.signalId)?.state, 'APPROVAL_PENDING');
  assert.equal(getScannerSignalLifecycleSnapshot('member-3', current.signalId)?.state, 'READY_FOR_APPROVAL');
  assert.equal(setScannerExternalLifecycleState('member-3', current.signalId, 'APPROVED', now + 6_000), true);
  const afterApproval = applyScannerSignalLifecycle('member-3', [card({ signalId: current.signalId })], now + 7_000);
  assert.equal(afterApproval.cards[0].signalState, 'APPROVED');
  assert.equal(afterApproval.alerts.length, 0);
  assert.equal(afterApproval.cards[0].strongSignalEligible, true);
  assert.equal(getScannerLifecycleSnapshot('member-3', current.signalId)?.state, 'APPROVED');
  assert.equal(getScannerSignalLifecycleSnapshot('member-3', current.signalId)?.state, 'approved');
});

test('risk bridge maps every known state explicitly and unknown future states fail closed', () => {
  const expected = new Map<ScannerSignalState, string>([
    ['CANDIDATE', 'DETECTED'],
    ['CONFIRMED', 'WATCHING'],
    ['ARMED', 'WATCHING'],
    ['ENTRY_ZONE', 'WATCHING'],
    ['APPROVAL_PENDING', 'READY_FOR_APPROVAL'],
    ['APPROVED', 'approved'],
    ['EXECUTING', 'approved'],
    ['PARTIALLY_FILLED', 'approved'],
    ['FILLED', 'approved'],
    ['MANAGING', 'approved'],
    ['CLOSED', 'INVALIDATED'],
    ['INVALIDATED', 'INVALIDATED'],
    ['EXPIRED', 'EXPIRED'],
    ['REJECTED', 'INVALIDATED'],
    ['CANCELLED', 'INVALIDATED'],
    ['DETECTED', 'DETECTED'],
    ['WATCHING', 'WATCHING'],
    ['READY_FOR_APPROVAL', 'READY_FOR_APPROVAL'],
    ['WEAKENED', 'WEAKENED'],
  ]);
  for (const [state, legacy] of expected) {
    assert.equal(scannerLifecycleStateForRiskBridge(state), legacy, state);
  }
  assert.equal(scannerLifecycleStateForRiskBridge('FUTURE_SCANNER_STATE'), 'INVALIDATED');
  assert.notEqual(scannerLifecycleStateForRiskBridge('APPROVAL_PENDING'), 'approved');
});

test('external bridge rejects unknown state at runtime', () => {
  clearScannerSignalLifecycleForTests();
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  const current = applyScannerSignalLifecycle('member-external', [card()], now).cards[0];
  assert.equal(setScannerExternalLifecycleState(
    'member-external',
    current.signalId,
    'FUTURE_SCANNER_STATE' as never,
    now + 1_000,
  ), false);
  assert.equal(getScannerLifecycleSnapshot('member-external', current.signalId)?.state, 'CANDIDATE');
});

test('expired signal never produces an approval alert', () => {
  clearScannerSignalLifecycleForTests();
  const result = applyScannerSignalLifecycle(
    'member-2',
    [card({ expiresAt: '2026-08-04T00:00:00.000Z' })],
    Date.parse('2026-08-05T00:00:00.000Z'),
  );
  assert.equal(result.cards[0].signalState, 'EXPIRED');
  assert.equal(result.alerts.length, 0);
  assert.equal(getScannerSignalLifecycleSnapshot('member-2', result.cards[0].signalId)?.state, 'EXPIRED');
});
