import test from 'node:test';
import assert from 'node:assert/strict';
import './trade-split-order.repository.test';
import './trade-split-order-execution.test';
import {
  aggregateSplitOrderState,
  assertNextSplitOrderReady,
  materializeSplitOrders,
  type SplitTradingOrder,
} from './trade-split-order-materializer.service';
import type { TradingPlan } from './trade-automation.types';

function plan(): TradingPlan {
  const now = '2026-08-05T09:00:00.000Z';
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
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

function withState(order: SplitTradingOrder, state: SplitTradingOrder['state'], filledQuantity = order.filledQuantity) {
  return { ...order, state, filledQuantity };
}

test('materializes deterministic child payloads with only the first child submitted', () => {
  const first = materializeSplitOrders(plan());
  const replay = materializeSplitOrders(plan());
  assert.deepEqual(first, replay);
  assert.deepEqual(first.map((order) => order.state), ['SUBMITTED', 'PLANNED', 'PLANNED']);
  assert.deepEqual(first.map((order) => order.requestedQuantity), [0.5, 0.3, 0.2]);
  assert.deepEqual(first.map((order) => order.requestedQuoteAmount), [50_000, 30_000, 20_000]);
  assert.deepEqual(first.map((order) => order.legSequenceNo), [1, 2, 3]);
  assert.equal(first[1]?.previousChildOrderId, first[0]?.id);
  assert.equal(first[2]?.previousChildOrderId, first[1]?.id);
  assert.ok(first.every((order) => order.parentPlanVersion === 4));
  assert.equal(new Set(first.map((order) => order.clientOrderId)).size, 3);
});

test('blocks the next child until the immediate previous child is filled', () => {
  const orders = materializeSplitOrders(plan());
  assert.throws(() => assertNextSplitOrderReady(orders[1]!, orders), /TRADE_SPLIT_PREVIOUS_CHILD_NOT_FILLED/);

  const ready = [withState(orders[0]!, 'FILLED', 0.5), orders[1]!, orders[2]!];
  assert.doesNotThrow(() => assertNextSplitOrderReady(ready[1]!, ready));
  assert.throws(() => assertNextSplitOrderReady(ready[2]!, ready), /TRADE_SPLIT_PREVIOUS_CHILD_NOT_FILLED/);
});

test('aggregates partial success and recovery without hiding a failed child', () => {
  const orders = materializeSplitOrders(plan());
  assert.equal(aggregateSplitOrderState(orders), 'SUBMITTED');
  assert.equal(aggregateSplitOrderState([
    withState(orders[0]!, 'FILLED', 0.5),
    withState(orders[1]!, 'PARTIALLY_FILLED', 0.1),
    orders[2]!,
  ]), 'PARTIALLY_FILLED');
  assert.equal(aggregateSplitOrderState([
    withState(orders[0]!, 'FILLED', 0.5),
    withState(orders[1]!, 'RECOVERY_REQUIRED'),
    orders[2]!,
  ]), 'RECOVERY_REQUIRED');
  assert.equal(aggregateSplitOrderState(orders.map((order) => withState(order, 'FILLED', Number(order.requestedQuantity)))), 'FILLED');
  assert.equal(aggregateSplitOrderState(orders.map((order, index) => withState(order, index === 1 ? 'REJECTED' : 'CANCELED'))), 'REJECTED');
});

test('rejects duplicate sequence numbers in parent aggregation', () => {
  const orders = materializeSplitOrders(plan());
  assert.throws(
    () => aggregateSplitOrderState([orders[0]!, { ...orders[1]!, legSequenceNo: 1 }]),
    /TRADE_SPLIT_CHILD_SEQUENCE_DUPLICATE/,
  );
});
