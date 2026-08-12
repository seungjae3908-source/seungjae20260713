import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTossPreSubmissionSnapshot } from './toss-pre-submission-snapshot.service';
import type { TradingOrder, TradingPlan, TradingRiskDecision } from './trade-automation.types';

const NOW = new Date('2026-03-25T10:00:10+09:00');
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678';

function plan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  return {
    id: 'plan-toss-1',
    userId: '11111111-1111-1111-1111-111111111111',
    idempotencyKey: 'toss-plan-key',
    exchange: 'toss',
    accountMode: 'live',
    strategyId: 'breakout',
    signalId: 'signal-toss-1',
    symbol: '005930',
    market: 'KR',
    side: 'buy',
    orderType: 'limit',
    quantity: 2,
    quoteAmount: null,
    limitPrice: 72_100,
    estimatedKrw: 144_200,
    stopPrice: 70_000,
    targetPrices: [75_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['test'],
    marketSnapshot: {
      observedAt: NOW.toISOString(),
      riskObservedAt: NOW.toISOString(),
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 5_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      currentPrice: 72_000,
      marketStatus: 'OPEN',
      source: 'TOSS',
      availableLiquidityKrw: 5_000_000,
      estimatedSlippagePercent: 0.1,
      estimatedFeePercent: 0.015,
      signalState: 'entry_ready',
      signalObservedAt: NOW.toISOString(),
    },
    state: 'SUBMITTED',
    version: 1,
    approvalExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    approvedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function order(overrides: Partial<TradingOrder> = {}): TradingOrder {
  return {
    id: 'internal-order-1',
    userId: '11111111-1111-1111-1111-111111111111',
    planId: 'plan-toss-1',
    exchange: 'toss',
    clientOrderId: 'client-order-1',
    exchangeOrderId: null,
    state: 'SUBMITTED',
    version: 0,
    requestedQuantity: 2,
    remainingQuantity: 2,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const allowedRisk: TradingRiskDecision = { allowed: true, blockCodes: [], warnings: [] };

function payloads(overrides: Record<string, unknown> = {}) {
  return {
    accounts: { result: [{ accountSeq: 17 }] },
    prices: { result: [{ symbol: '005930', timestamp: '2026-03-25T10:00:05+09:00', lastPrice: '72000', currency: 'KRW' }] },
    orderbook: { result: {
      timestamp: '2026-03-25T10:00:06+09:00', currency: 'KRW',
      asks: [{ price: '72100', volume: '1000' }], bids: [{ price: '72000', volume: '1200' }],
    } },
    buyingPower: { result: { currency: 'KRW', cashBuyingPower: '1000000' } },
    sellableQuantity: { result: { sellableQuantity: '50' } },
    commissions: { result: [{ marketCountry: 'KR', commissionRate: '0.015', startDate: '2026-01-01', endDate: null }] },
    marketCalendar: { result: { today: { date: '2026-03-25', integrated: {
      preMarket: { startTime: '2026-03-25T08:00:00+09:00', endTime: '2026-03-25T09:00:00+09:00' },
      regularMarket: { startTime: '2026-03-25T09:00:00+09:00', endTime: '2026-03-25T15:30:00+09:00' },
      afterMarket: { startTime: '2026-03-25T15:30:00+09:00', endTime: '2026-03-25T20:00:00+09:00' },
    } } } },
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    selectedAccountSeq: '17',
    plan: plan(),
    order: order(),
    market: 'KR' as const,
    currency: 'KRW' as const,
    riskDecision: allowedRisk,
    riskDecisionId: 'risk-1',
    strategyVersion: 'breakout@1.2.0',
    releaseSha: RELEASE_SHA,
    payloads: payloads(),
    now: NOW,
    ...overrides,
  };
}

test('Toss pre-submission evidence is immutable, complete, and never exposes raw account id', () => {
  const snapshot = buildTossPreSubmissionSnapshot(input());
  assert.equal(snapshot.provider, 'TOSS');
  assert.equal(snapshot.marketStatus, 'OPEN');
  assert.equal(snapshot.currentPrice, 72_000);
  assert.equal(snapshot.expectedExecutionPrice, 72_100);
  assert.equal(snapshot.availableBuyingPower, 1_000_000);
  assert.equal(snapshot.sellableQuantity, 50);
  assert.equal(snapshot.estimatedCommissionPercent, 0.015);
  assert.equal(snapshot.internalOrderId, 'internal-order-1');
  assert.equal(snapshot.clientOrderId, 'client-order-1');
  assert.equal(snapshot.releaseSha, RELEASE_SHA);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(JSON.stringify(snapshot).includes('"accountAlias":"17"'), false);
  assert.equal(snapshot.accountAlias.includes('*'), true);
});

test('Toss pre-submission rejects implicit or mismatched account selection', () => {
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ selectedAccountSeq: '' })), /TOSS_ACCOUNT_SELECTION_REQUIRED/);
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ selectedAccountSeq: '99' })), /TOSS_SELECTED_ACCOUNT_NOT_FOUND/);
});

test('Toss pre-submission rejects stale quotes and closed market', () => {
  const stale = payloads({
    prices: { result: [{ symbol: '005930', timestamp: '2026-03-25T09:58:00+09:00', lastPrice: '72000', currency: 'KRW' }] },
  });
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ payloads: stale })), /TOSS_MARKET_DATA_STALE/);
  const closed = payloads({ marketCalendar: { result: { today: { date: '2026-03-25', integrated: null } } } });
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ payloads: closed })), /TOSS_MARKET_NOT_OPEN/);
});

test('Toss pre-submission rejects buying-power and sellable-quantity deficits', () => {
  const insufficientBuy = payloads({ buyingPower: { result: { currency: 'KRW', cashBuyingPower: '1000' } } });
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ payloads: insufficientBuy })), /TOSS_INSUFFICIENT_BUYING_POWER/);

  const sellPlan = plan({ side: 'sell', quantity: 10, quoteAmount: null });
  const insufficientSell = payloads({ sellableQuantity: { result: { sellableQuantity: '5' } } });
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ plan: sellPlan, payloads: insufficientSell })), /TOSS_INSUFFICIENT_SELLABLE_QUANTITY/);
});

test('Toss pre-submission refuses a rejected risk decision and invalid release identity', () => {
  assert.throws(() => buildTossPreSubmissionSnapshot(input({
    riskDecision: { allowed: false, blockCodes: ['DAILY_LOSS_LIMIT'], warnings: [] },
  })), /TOSS_RISK_DECISION_NOT_ALLOWED/);
  assert.throws(() => buildTossPreSubmissionSnapshot(input({ releaseSha: 'main' })), /TOSS_RELEASE_SHA_INVALID/);
});
