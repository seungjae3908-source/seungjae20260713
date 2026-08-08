import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canReadScannerGrade,
  filterScannerResponseForTier,
  parseScannerGradeQuery,
} from './scanner-access-control.service';
import type { ScannerResponse, ScannerSignalCard, ScannerSignalGrade } from './scanner-signal.types';

function card(signalId: string, symbol: string, grade: ScannerSignalGrade): ScannerSignalCard {
  return {
    signalId,
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol,
    name: symbol,
    currency: 'KRW',
    assetType: 'stock',
    listingStatus: 'LISTED',
    price: 100,
    changePercent: 1,
    direction: 'LONG',
    signalState: 'APPROVAL_PENDING',
    score: 80,
    confidence: 80,
    dataCompleteness: 100,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 100,
    volume: 100,
    tradingValue: 10_000,
    spreadPercent: 0.1,
    volatilityPercent: 1,
    matched: ['trend'],
    notMatched: [],
    unverified: [],
    evidence: [],
    pricePlan: { entryZone: { from: 99, to: 101 }, invalidation: 95, stopLoss: 96, targets: [105], riskReward: 2 },
    dataState: 'complete',
    dataSources: ['fixture'],
    observedAt: '2026-08-09T00:00:00.000Z',
    expiresAt: '2026-08-09T00:05:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    strategyMode: 'scalping',
    signalGrade: grade,
  };
}

function response(): ScannerResponse {
  return {
    ok: true,
    requestId: 'request-1',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '5m',
    cards: [card('s-1', 'SECRET-S', 'S'), card('a-1', 'VISIBLE-A', 'A'), card('d-1', 'VISIBLE-D', 'D')],
    alerts: [
      { idempotencyKey: 's-alert', signalId: 's-1', assetClass: 'stock', market: 'KR', symbol: 'SECRET-S', direction: 'LONG', state: 'APPROVAL_PENDING', entryZone: { from: 99, to: 101 }, stopLoss: 96, targets: [105], expiresAt: '2026-08-09T00:05:00.000Z', evidence: ['secret'], orderSubmitted: false, exchangeRequestSent: false },
      { idempotencyKey: 'a-alert', signalId: 'a-1', assetClass: 'stock', market: 'KR', symbol: 'VISIBLE-A', direction: 'LONG', state: 'APPROVAL_PENDING', entryZone: { from: 99, to: 101 }, stopLoss: 96, targets: [105], expiresAt: '2026-08-09T00:05:00.000Z', evidence: ['public'], orderSubmitted: false, exchangeRequestSent: false },
    ],
    failures: [
      { symbol: 'SECRET-S', reason: 'provider_error', message: 'hidden' },
      { symbol: 'OTHER', reason: 'provider_error', message: 'visible' },
    ],
    execution: { requestedCount: 3, startedCount: 3, completedCount: 3, excludedCount: 0, providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false, cancelled: false, duplicate: false, elapsedMs: 10, deadlineMs: 1000, itemTimeoutMs: 100, maxConcurrency: 2 },
    universe: { totalCount: 100, cursor: 0, nextCursor: 24, source: 'fixture', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
    dataState: 'complete',
    message: 'ok',
    generatedAt: '2026-08-09T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

test('associate and regular receive A-D while S payload and S alert are removed', () => {
  for (const tier of ['associate', 'regular'] as const) {
    const filtered = filterScannerResponseForTier(response(), tier);
    assert.deepEqual(filtered.cards.map((item) => item.signalGrade), ['A', 'D']);
    assert.deepEqual(filtered.cards.map((item) => item.symbol), ['VISIBLE-A', 'VISIBLE-D']);
    assert.deepEqual(filtered.alerts.map((item) => item.symbol), ['VISIBLE-A']);
    assert.equal(filtered.failures.some((item) => item.symbol === 'SECRET-S'), false);
  }
});

test('admin receives S and may explicitly request only S', () => {
  const all = filterScannerResponseForTier(response(), 'admin');
  assert.deepEqual(all.cards.map((item) => item.signalGrade), ['S', 'A', 'D']);
  const onlyS = filterScannerResponseForTier(response(), 'admin', 'S');
  assert.deepEqual(onlyS.cards.map((item) => item.symbol), ['SECRET-S']);
  assert.deepEqual(onlyS.alerts.map((item) => item.symbol), ['SECRET-S']);
});

test('grade parser and policy fail closed for S on non-admin roles', () => {
  assert.equal(parseScannerGradeQuery(undefined), undefined);
  assert.equal(parseScannerGradeQuery('s'), 'S');
  assert.equal(parseScannerGradeQuery('A'), 'A');
  assert.equal(parseScannerGradeQuery('unknown'), null);
  assert.equal(canReadScannerGrade('associate', 'S'), false);
  assert.equal(canReadScannerGrade('regular', 'S'), false);
  assert.equal(canReadScannerGrade('admin', 'S'), true);
  assert.equal(canReadScannerGrade('associate', 'D'), true);
});
