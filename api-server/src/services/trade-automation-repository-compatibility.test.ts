import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import type { ExchangeConnection, TradingOrder, TradingOrderEvent, TradingPlan } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
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

function makeEvent(
  id: string,
  orderId: string,
  fromState: TradingOrderEvent['fromState'],
  toState: TradingOrderEvent['toState'],
  userId = USER_ID,
): TradingOrderEvent {
  return {
    id,
    userId,
    orderId,
    fromState,
    toState,
    reason: 'compatibility regression test',
    metadata: {},
    createdAt: NOW,
  };
}

function makeConnection(userId: string, encryptedCredentials: string): ExchangeConnection {
  return {
    userId,
    exchange: 'upbit',
    accountMode: 'live',
    configured: true,
    encryptedCredentials,
    lastVerifiedAt: NOW,
    lastErrorCode: null,
    updatedAt: NOW,
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

test('exchange connections are strictly isolated by authenticated user identity', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.saveConnection(makeConnection(USER_ID, 'encrypted-user-a'));
  await repository.saveConnection(makeConnection(OTHER_USER_ID, 'encrypted-user-b'));

  const userAConnection = await repository.getConnection(USER_ID, 'upbit');
  const userBConnection = await repository.getConnection(OTHER_USER_ID, 'upbit');

  assert.equal(userAConnection?.userId, USER_ID);
  assert.equal(userAConnection?.encryptedCredentials, 'encrypted-user-a');
  assert.equal(userBConnection?.userId, OTHER_USER_ID);
  assert.equal(userBConnection?.encryptedCredentials, 'encrypted-user-b');
  assert.deepEqual((await repository.getConnections(USER_ID)).map((item) => item.userId), [USER_ID]);
  assert.deepEqual((await repository.getConnections(OTHER_USER_ID)).map((item) => item.userId), [OTHER_USER_ID]);
});

test('plans, orders, events, and idempotency identities cannot cross user boundaries', async () => {
  const repository = new InMemoryTradingRepository();
  const userAPlan = makePlan({ id: 'plan-user-a', state: 'SUBMITTED' });
  const userBPlan = makePlan({
    id: 'plan-user-b',
    userId: OTHER_USER_ID,
    state: 'SUBMITTED',
    idempotencyKey: userAPlan.idempotencyKey,
    signalId: 'compatibility-user-b',
  });

  assert.equal((await repository.insertPlan(userAPlan)).inserted, true);
  assert.equal((await repository.insertPlan(userBPlan)).inserted, true);
  assert.equal(await repository.getPlan(OTHER_USER_ID, userAPlan.id), null);
  assert.equal(await repository.getPlan(USER_ID, userBPlan.id), null);
  assert.equal((await repository.findPlanByIdempotency(USER_ID, userAPlan.idempotencyKey))?.id, userAPlan.id);
  assert.equal((await repository.findPlanByIdempotency(OTHER_USER_ID, userBPlan.idempotencyKey))?.id, userBPlan.id);
  assert.deepEqual((await repository.listPlans(USER_ID)).map((plan) => plan.id), [userAPlan.id]);
  assert.deepEqual((await repository.listPlans(OTHER_USER_ID)).map((plan) => plan.id), [userBPlan.id]);

  const sharedClientOrderId = 'client-shared-across-users';
  const userAOrder = makeOrder({ id: 'order-user-a', planId: userAPlan.id, clientOrderId: sharedClientOrderId });
  const userBOrder = makeOrder({
    id: 'order-user-b',
    userId: OTHER_USER_ID,
    planId: userBPlan.id,
    clientOrderId: sharedClientOrderId,
  });

  assert.equal((await repository.createOrderAtomic(
    userAOrder,
    makeEvent('event-user-a', userAOrder.id, null, 'SUBMITTED', USER_ID),
    'SUBMITTED',
  ))?.inserted, true);
  assert.equal((await repository.createOrderAtomic(
    userBOrder,
    makeEvent('event-user-b', userBOrder.id, null, 'SUBMITTED', OTHER_USER_ID),
    'SUBMITTED',
  ))?.inserted, true);

  assert.equal(await repository.getOrder(OTHER_USER_ID, userAOrder.id), null);
  assert.equal(await repository.getOrder(USER_ID, userBOrder.id), null);
  assert.equal(await repository.findOrderByPlan(OTHER_USER_ID, userAPlan.id), null);
  assert.equal(await repository.findOrderByPlan(USER_ID, userBPlan.id), null);
  assert.deepEqual((await repository.listOrders(USER_ID)).map((order) => order.id), [userAOrder.id]);
  assert.deepEqual((await repository.listOrders(OTHER_USER_ID)).map((order) => order.id), [userBOrder.id]);
  assert.deepEqual((await repository.listEvents(USER_ID)).map((event) => event.id), ['event-user-a']);
  assert.deepEqual((await repository.listEvents(OTHER_USER_ID)).map((event) => event.id), ['event-user-b']);
});
