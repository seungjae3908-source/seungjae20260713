import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const NOW = '2026-08-05T03:00:00.000Z';

function makePlan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  return {
    id: 'plan-compatibility-1',
    userId: USER_ID,
    idempotencyKey: 'signal:compatibility-1',
    state: 'APPROVAL_PENDING',
    version: 0,
    approvalExpiresAt: '2026-08-05T03:10:00.000Z',
    approvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'compatibility-test',
    signalId: 'compatibility-1',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: null,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['compatibility'],
    marketSnapshot: {
      observedAt: NOW,
      dataDelayMs: 100,
      oneMinuteMovePercent: 0.1,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 5_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 5,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    ...overrides,
  };
}

function makeOrder(overrides: Partial<TradingOrder> = {}): TradingOrder {
  return {
    id: 'order-compatibility-1',
    userId: USER_ID,
    planId: 'plan-compatibility-1',
    exchange: 'upbit',
    clientOrderId: 'client-compatibility-1',
    exchangeOrderId: null,
    state: 'SUBMITTED',
    version: 0,
    requestedQuantity: 1,
    remainingQuantity: 1,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEvent(id: string, orderId: string, fromState: TradingOrderEvent['fromState'], toState: TradingOrderEvent['toState']): TradingOrderEvent {
  return {
    id,
    userId: USER_ID,
    orderId,
    fromState,
    toState,
    reason: 'compatibility regression test',
    metadata: {},
    createdAt: NOW,
  };
}

test('in-memory plan storage preserves the public object reference used by approval rechecks', async () => {
  const repository = new InMemoryTradingRepository();
  const plan = makePlan();
  const inserted = await repository.insertPlan(plan);

  assert.equal(inserted.plan, plan);
  plan.marketSnapshot.observedAt = '2026-08-05T01:00:00.000Z';

  const stored = await repository.getPlan(USER_ID, plan.id);
  assert.equal(stored?.marketSnapshot.observedAt, plan.marketSnapshot.observedAt);
});

test('plan CAS updates the stored public reference without weakening version checks', async () => {
  const repository = new InMemoryTradingRepository();
  const plan = makePlan();
  await repository.insertPlan(plan);

  const updated = await repository.compareAndSetPlan({ ...plan, state: 'EXPIRED' }, 'APPROVAL_PENDING', 0);
  assert.equal(updated, plan);
  assert.equal(plan.state, 'EXPIRED');
  assert.equal(plan.version, 1);

  const staleWrite = await repository.compareAndSetPlan({ ...plan, state: 'SUBMITTED' }, 'EXPIRED', 0);
  assert.equal(staleWrite, null);
  assert.equal(plan.state, 'EXPIRED');
  assert.equal(plan.version, 1);
});

test('atomic order transitions update the original order reference used by restart reconciliation', async () => {
  const repository = new InMemoryTradingRepository();
  const plan = makePlan({ state: 'SUBMITTED' });
  const order = makeOrder({ state: 'ACCEPTED' });
  await repository.insertPlan(plan);

  const created = await repository.createOrderAtomic(
    order,
    makeEvent('event-compatibility-1', order.id, null, 'ACCEPTED'),
    'SUBMITTED',
  );
  assert.equal(created?.order, order);

  const transitioned = await repository.transitionOrderAtomic(
    { ...order, state: 'RECOVERY_REQUIRED', updatedAt: '2026-08-05T03:01:00.000Z' },
    'ACCEPTED',
    0,
    makeEvent('event-compatibility-2', order.id, 'ACCEPTED', 'RECOVERY_REQUIRED'),
  );
  assert.equal(transitioned.applied, true);
  assert.equal(transitioned.order, order);
  assert.equal(order.state, 'RECOVERY_REQUIRED');
  assert.equal(order.version, 1);
});

test('reference compatibility keeps plan and order idempotency constraints intact', async () => {
  const repository = new InMemoryTradingRepository();
  const firstPlan = makePlan();
  const duplicatePlan = makePlan({ id: 'plan-compatibility-2' });
  assert.equal((await repository.insertPlan(firstPlan)).inserted, true);
  const duplicatePlanResult = await repository.insertPlan(duplicatePlan);
  assert.equal(duplicatePlanResult.inserted, false);
  assert.equal(duplicatePlanResult.plan, firstPlan);
  assert.equal((await repository.listPlans(USER_ID)).length, 1);

  firstPlan.state = 'SUBMITTED';
  const firstOrder = makeOrder();
  const duplicateOrder = makeOrder({ id: 'order-compatibility-2', clientOrderId: 'client-compatibility-2' });
  assert.equal((await repository.createOrderAtomic(
    firstOrder,
    makeEvent('event-compatibility-3', firstOrder.id, null, 'SUBMITTED'),
    'SUBMITTED',
  ))?.inserted, true);
  const duplicateOrderResult = await repository.createOrderAtomic(
    duplicateOrder,
    makeEvent('event-compatibility-4', duplicateOrder.id, null, 'SUBMITTED'),
    'SUBMITTED',
  );
  assert.equal(duplicateOrderResult?.inserted, false);
  assert.equal(duplicateOrderResult?.order, firstOrder);
  assert.equal((await repository.listOrders(USER_ID)).length, 1);
});
