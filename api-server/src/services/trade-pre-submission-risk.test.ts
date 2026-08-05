import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import {
  TradePreSubmissionRiskError,
  TradePreSubmissionRiskService,
} from './trade-pre-submission-risk.service';
import type {
  TradingMarketSnapshot,
  TradingOrder,
  TradingPlan,
} from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function snapshot(now: Date): TradingMarketSnapshot {
  return {
    observedAt: now.toISOString(),
    riskObservedAt: now.toISOString(),
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
    currentPrice: 100_000,
    plannedPrice: 100_000,
    marketStatus: 'OPEN',
    providerTimeOffsetMs: 0,
    source: 'upbit-private-account+public-market',
    availableLiquidityKrw: 1_000_000,
    estimatedSlippagePercent: 0.1,
    estimatedFeePercent: 0.05,
    signalState: 'entry_ready',
    signalObservedAt: now.toISOString(),
  };
}

function plan(now: Date, version = 1): TradingPlan {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    userId: USER_ID,
    idempotencyKey: 'risk-test',
    state: 'SUBMITTED',
    version,
    approvalExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    approvedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'breakout-v1',
    signalId: 'signal-1',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: 1,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [100],
    signalReasons: ['trend'],
    marketSnapshot: snapshot(now),
  };
}

function order(now: Date): TradingOrder {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    userId: USER_ID,
    planId: '22222222-2222-2222-2222-222222222222',
    exchange: 'upbit',
    clientOrderId: 'risk-order',
    exchangeOrderId: null,
    state: 'SUBMITTED',
    version: 0,
    requestedQuantity: 1,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    approvedPlanVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

async function setup(now: Date, planVersion = 1) {
  const repository = new InMemoryTradingRepository();
  const currentPlan = plan(now, planVersion);
  const currentOrder = order(now);
  await repository.savePlan(currentPlan);
  await repository.saveOrder(currentOrder);
  return { repository, currentPlan, currentOrder, service: new TradePreSubmissionRiskService(repository) };
}

test('fresh approval, risk evidence, signal, liquidity, cost, and limits pass together', async () => {
  const now = new Date();
  const { currentPlan, currentOrder, service } = await setup(now);
  const result = await service.evaluate({
    userId: USER_ID,
    expectedPlan: currentPlan,
    order: currentOrder,
    snapshot: snapshot(now),
    serverLiveEnabled: true,
    now,
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockCodes, []);
  assert.equal(result.priceDriftPercent, 0);
});

test('stale risk evidence, approval price drift, and broken signal fail closed together', async () => {
  const now = new Date();
  const { currentPlan, currentOrder, service } = await setup(now);
  const blocked = {
    ...snapshot(now),
    riskObservedAt: new Date(now.getTime() - 60_000).toISOString(),
    currentPrice: 103_000,
    signalState: 'condition_broken' as const,
  };
  await assert.rejects(
    () => service.evaluate({
      userId: USER_ID,
      expectedPlan: currentPlan,
      order: currentOrder,
      snapshot: blocked,
      serverLiveEnabled: true,
      now,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TradePreSubmissionRiskError);
      assert.ok(error.result.blockCodes.includes('RISK_EVIDENCE_STALE'));
      assert.ok(error.result.blockCodes.includes('APPROVAL_PRICE_DRIFT_EXCEEDED'));
      assert.ok(error.result.blockCodes.includes('SIGNAL_CONDITION_BROKEN'));
      return true;
    },
  );
});

test('changed plan version invalidates the approval captured by the order', async () => {
  const now = new Date();
  const { currentPlan, currentOrder, service } = await setup(now, 2);
  await assert.rejects(
    () => service.evaluate({
      userId: USER_ID,
      expectedPlan: currentPlan,
      order: currentOrder,
      snapshot: snapshot(now),
      serverLiveEnabled: true,
      now,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TradePreSubmissionRiskError);
      assert.ok(error.result.blockCodes.includes('APPROVAL_VERSION_CHANGED'));
      return true;
    },
  );
});
