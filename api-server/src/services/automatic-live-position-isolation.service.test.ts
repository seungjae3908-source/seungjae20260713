import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAutomaticLivePositions } from './automatic-live-position-isolation.service';
import { completeTradingHistory } from './trade-history-completeness.service';
import type { TradingPlan, TradingOrder } from './trade-automation.types';

const at = '2026-10-12T00:00:00Z';
function plan(id: string, automatic = true): TradingPlan {
  return { id, userId: 'history-owner', accountMode: 'live', exchange: 'upbit',
    executionMode: automatic ? 'automatic' : 'manual', signalReasons: [], reduceOnly: false,
    idempotencyKey: id, strategyId: 'history-test', signalId: id, symbol: id, market: 'KRW',
    side: 'buy', orderType: 'limit', estimatedKrw: 10_000, stopPrice: 90, targetPrices: [105],
    splitRatios: [100], state: 'FILLED', approvedAt: null, approvalExpiresAt: null,
    createdAt: at, updatedAt: at, marketSnapshot: { currentPrice: 100, openPositionCount: 0 } as TradingPlan['marketSnapshot'] };
}
function order(id: string, parent: TradingPlan, quantity = 1): TradingOrder {
  return { id, userId: parent.userId, planId: parent.id, exchange: parent.exchange,
    clientOrderId: id, state: 'FILLED', filledQuantity: quantity, exchangeOrderId: id,
    requestedQuantity: quantity, averageFillPrice: 100, retryCount: 0, lastErrorCode: null,
    createdAt: at, updatedAt: at };
}

test('large complete histories keep exact AUTO remaining quantities without repeated full scans', () => {
  // Assert traversal work rather than a machine-dependent timeout. A restored
  // quadratic implementation performs millions of these property reads.
  const count = 2_000;
  let planIdReads = 0;
  let orderPlanIdReads = 0;
  const plans: TradingPlan[] = [];
  const orders: TradingOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = plan(`entry-${index}`);
    const exit: TradingPlan = { ...entry, id: `exit-${index}`, reduceOnly: true, side: 'sell',
      signalReasons: [`AUTO_EXIT_ENTRY_PLAN:${entry.id}`] };
    for (const row of [entry, exit]) {
      plans.push(new Proxy(row, { get(target, key, receiver) {
        if (key === 'id') planIdReads += 1;
        return Reflect.get(target, key, receiver);
      } }));
    }
    for (const row of [order(`open-${index}`, entry, 10), order(`close-${index}`, exit, 4)]) {
      orders.push(new Proxy(row, { get(target, key, receiver) {
        if (key === 'planId') orderPlanIdReads += 1;
        return Reflect.get(target, key, receiver);
      } }));
    }
  }
  const manual = plan('protected-manual', false);
  plans.push(manual);
  orders.push(order('manual-fill', manual, 999));
  const owned = canonicalAutomaticLivePositions(completeTradingHistory(plans), completeTradingHistory(orders));
  assert.equal(owned.length, count);
  assert.ok(owned.every((position, index) => position.plan.id === `entry-${index}` && position.remainingQuantity === 6));
  assert.ok(!owned.some((position) => position.plan.id === manual.id));
  assert.ok(planIdReads < plans.length * 10, `plan traversal exceeded linear bound: ${planIdReads}`);
  assert.ok(orderPlanIdReads < orders.length * 10, `order traversal exceeded linear bound: ${orderPlanIdReads}`);
});

test('indexed ownership still rejects incomplete and duplicate canonical identities', () => {
  const entry = plan('entry');
  const fill = order('fill', entry);
  assert.throws(() => canonicalAutomaticLivePositions(Array.from({ length: 200 }, (_, i) => plan(`p-${i}`)), []),
    /OWNERSHIP_HISTORY_INCOMPLETE/);
  assert.throws(() => canonicalAutomaticLivePositions([entry, { ...entry, accountMode: 'paper' }], [fill]),
    /OWNERSHIP_AMBIGUOUS/);
  assert.throws(() => canonicalAutomaticLivePositions([entry, plan('another')], [fill, { ...fill, planId: 'another' }]),
    /OWNERSHIP_AMBIGUOUS/);
});

test('indexed exit graph rejects multi-parent, foreign-owner and over-close fills before reducing ownership', () => {
  const entry = plan('entry');
  const fill = order('fill', entry, 10);
  const exit: TradingPlan = { ...entry, id: 'exit', reduceOnly: true, side: 'sell',
    signalReasons: ['AUTO_EXIT_ENTRY_PLAN:entry'] };
  for (const altered of [
    { ...exit, signalReasons: [...exit.signalReasons, 'AUTO_EXIT_ENTRY_PLAN:another'] },
    { ...exit, userId: 'foreign-owner' },
  ]) {
    assert.throws(() => canonicalAutomaticLivePositions([entry, altered], [fill, order('close', altered, 4)]),
      /EXIT_DIRECTION_INVALID|EXIT_PARENT_MISMATCH/);
  }
  assert.throws(() => canonicalAutomaticLivePositions([entry, exit], [fill, order('close', exit, 11)]),
    /EXIT_QUANTITY_DRIFT/);
  assert.deepEqual(canonicalAutomaticLivePositions([entry, exit], [fill, order('close', exit, 10)]), []);
});
