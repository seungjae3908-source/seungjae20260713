import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplitOrderRepository, type SplitOrderDatabasePort } from './trade-split-order.repository';
import { materializeSplitOrders, splitOrderLeg } from './trade-split-order-materializer.service';
import type { TradingOrderEvent, TradingPlan } from './trade-automation.types';

const userId = '22222222-2222-2222-2222-222222222222';
const planId = '11111111-1111-1111-1111-111111111111';

function plan(): TradingPlan {
  const now = '2026-08-05T09:00:00.000Z';
  return {
    id: planId,
    userId,
    idempotencyKey: 'split-plan',
    state: 'SUBMITTED',
    version: 4,
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
    splitRatios: [50, 30, 20],
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
  };
}

function events() {
  return materializeSplitOrders(plan()).map<TradingOrderEvent>((order) => ({
    id: `${order.id.slice(0, -1)}${order.legSequenceNo}`,
    userId,
    orderId: order.id,
    fromState: null,
    toState: order.state,
    reason: 'SPLIT_CHILD_CREATED',
    metadata: { legSequenceNo: order.legSequenceNo },
    createdAt: order.createdAt,
  }));
}

class FakeDatabase implements SplitOrderDatabasePort {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  listData: unknown = [];
  rpcData: unknown = null;
  rpcError: unknown = null;

  async rpc(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return { data: this.rpcData, error: this.rpcError };
  }

  async listOrderPayloads(requestUserId: string, requestPlanId: string, approvedPlanVersion?: number) {
    this.calls.push({ name: 'listOrderPayloads', args: { requestUserId, requestPlanId, approvedPlanVersion } });
    return { data: this.listData, error: null };
  }
}

test('creates the complete child set through the atomic RPC with exact parent version fencing', async () => {
  const database = new FakeDatabase();
  const orders = materializeSplitOrders(plan());
  const legs = orders.map(splitOrderLeg);
  const childEvents = events();
  database.rpcData = [...orders].reverse();
  const repository = createSplitOrderRepository(database, userId);

  const created = await repository.createSplitOrdersAtomic({
    userId,
    planId,
    expectedPlanState: 'SUBMITTED',
    expectedPlanVersion: 4,
    legs,
    orders,
    events: childEvents,
  });

  assert.deepEqual(created?.map((order) => order.legSequenceNo), [1, 2, 3]);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0]?.name, 'create_trade_split_orders_atomic');
  assert.deepEqual(database.calls[0]?.args, {
    p_user_id: userId,
    p_plan_id: planId,
    p_expected_plan_state: 'SUBMITTED',
    p_expected_plan_version: 4,
    p_leg_payloads: legs,
    p_order_payloads: orders,
    p_event_payloads: childEvents,
  });
});

test('lists child payloads in sequence order and rejects cross-user access', async () => {
  const database = new FakeDatabase();
  const orders = materializeSplitOrders(plan());
  database.listData = orders.slice().reverse().map((payload) => ({ payload }));
  const repository = createSplitOrderRepository(database, userId);

  const listed = await repository.listOrdersByPlan(userId, planId, 4);
  assert.deepEqual(listed.map((order) => order.legSequenceNo), [1, 2, 3]);
  await assert.rejects(
    repository.listOrdersByPlan('33333333-3333-3333-3333-333333333333', planId),
    /USER_SCOPE_MISMATCH/,
  );
});

test('activates only a planned child and preserves CAS arguments', async () => {
  const database = new FakeDatabase();
  const order = materializeSplitOrders(plan())[1]!;
  const event: TradingOrderEvent = {
    id: '44444444-4444-4444-4444-444444444444',
    userId,
    orderId: order.id,
    fromState: 'PLANNED',
    toState: 'SUBMITTED',
    reason: 'PREVIOUS_CHILD_FILLED',
    metadata: {},
    createdAt: order.createdAt,
  };
  database.rpcData = { ...order, state: 'SUBMITTED', version: 1 };
  const repository = createSplitOrderRepository(database, userId);

  const activated = await repository.activateNextChildAtomic(order, event);
  assert.equal(activated?.state, 'SUBMITTED');
  assert.equal(database.calls[0]?.name, 'activate_next_trade_split_child_atomic');
  assert.equal(database.calls[0]?.args.p_expected_version, 0);
});

test('fails closed on malformed sequence sets and database errors', async () => {
  const database = new FakeDatabase();
  const orders = materializeSplitOrders(plan());
  database.listData = [orders[0], { ...orders[1], legSequenceNo: 1 }, orders[2]];
  const repository = createSplitOrderRepository(database, userId);
  await assert.rejects(repository.listOrdersByPlan(userId, planId), /TRADE_SPLIT_CHILD_SEQUENCE_INVALID/);

  database.rpcError = { code: 'XX000' };
  await assert.rejects(repository.createSplitOrdersAtomic({
    userId,
    planId,
    expectedPlanState: 'SUBMITTED',
    expectedPlanVersion: 4,
    legs: orders.map(splitOrderLeg),
    orders,
    events: events(),
  }), /TRADE_SPLIT_ORDER_STORAGE_UNAVAILABLE/);
});
