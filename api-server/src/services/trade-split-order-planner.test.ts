import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSplitLegTotals,
  buildEntrySplitLegs,
  normalizeSplitRatios,
  TradeSplitOrderPlanError,
} from './trade-split-order-planner.service';
import type { TradingPlan } from './trade-automation.types';

function plan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  const now = '2026-08-05T09:00:00.000Z';
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    idempotencyKey: 'split-plan',
    state: 'SUBMITTED',
    version: 3,
    approvalExpiresAt: '2026-08-05T09:10:00.000Z',
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    exchange: 'upbit',
    accountMode: 'mock',
    strategyId: 'breakout-v1',
    signalId: 'signal-1',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: 100_000,
    limitPrice: 100_000,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [33.33, 33.33, 33.34],
    signalReasons: ['trend'],
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    ...overrides,
  };
}

test('accepts legacy percentage ratios and normalized fractional ratios only', () => {
  assert.deepEqual(normalizeSplitRatios([50, 30, 20]), [0.5, 0.3, 0.2]);
  assert.deepEqual(normalizeSplitRatios([0.5, 0.3, 0.2]), [0.5, 0.3, 0.2]);
  assert.throws(() => normalizeSplitRatios([50, 30]), (error: unknown) => {
    assert.ok(error instanceof TradeSplitOrderPlanError);
    assert.equal(error.code, 'TRADE_SPLIT_RATIO_TOTAL_INVALID');
    return true;
  });
  assert.throws(() => normalizeSplitRatios([100, 0]), /TRADE_SPLIT_RATIO_INVALID/);
});

test('allocates rounded remainder to the final leg without exceeding parent totals', () => {
  const legs = buildEntrySplitLegs(plan());
  assert.deepEqual(legs.map((leg) => leg.plannedQuantity), [0.3333, 0.3333, 0.3334]);
  assert.deepEqual(legs.map((leg) => leg.plannedQuoteAmount), [33_330, 33_330, 33_340]);
  assert.equal(legs.reduce((sum, leg) => sum + Number(leg.plannedQuantity), 0), 1);
  assert.equal(legs.reduce((sum, leg) => sum + Number(leg.plannedQuoteAmount), 0), 100_000);
  assertSplitLegTotals(plan(), legs);
});

test('uses plan version and leg sequence for stable child idempotency', () => {
  const first = buildEntrySplitLegs(plan());
  const replay = buildEntrySplitLegs(plan());
  const nextVersion = buildEntrySplitLegs(plan({ version: 4 }));
  assert.deepEqual(first, replay);
  assert.notEqual(first[0]?.idempotencyKey, nextVersion[0]?.idempotencyKey);
  assert.equal(new Set(first.map((leg) => leg.idempotencyKey)).size, first.length);
  assert.deepEqual(first.map((leg) => leg.sequenceNo), [1, 2, 3]);
});

test('rejects legs rounded below executable minimum and missing parent size', () => {
  assert.throws(
    () => buildEntrySplitLegs(plan({ quantity: 0.00000001, quoteAmount: null, splitRatios: [50, 50] })),
    /TRADE_SPLIT_LEG_BELOW_MINIMUM/,
  );
  assert.throws(
    () => buildEntrySplitLegs(plan({ quantity: null, quoteAmount: null })),
    /TRADE_SPLIT_PARENT_SIZE_REQUIRED/,
  );
});
