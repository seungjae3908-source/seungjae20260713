import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from '../../services/trade-automation.repository';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../../services/trade-automation.types';
import { InMemoryUserBrokerTelegramRepository } from './user-broker-telegram.repository';
import { UserBrokerTelegramService, executionEventFromTradingOrder } from './user-broker-telegram.service';
import { TradeExecutionEventBridgeService, parseExecutionSyncOrderId } from './trade-execution-event-bridge.service';
import type { PortfolioSyncSink, TelegramTransport, UserExecutionEvent } from './user-broker-telegram.types';

class FakeTransport implements TelegramTransport {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

class CapturingPortfolioSink implements PortfolioSyncSink {
  readonly events: UserExecutionEvent[] = [];
  async accept(event: UserExecutionEvent) {
    // The production CanonicalPortfolioSyncSink persists by sourceEventId:
    // retries after an interrupted outbox stage must not duplicate journal rows.
    if (this.events.some((row) =>
      row.userId === event.userId && row.sourceEventId === event.sourceEventId)) return;
    this.events.push(structuredClone(event));
  }
}

function planFixture(): TradingPlan {
  return {
    id: 'plan-bridge-1', userId: 'user-a', idempotencyKey: 'bridge-idem-1', state: 'SUBMITTED', version: 1,
    exchange: 'upbit', accountMode: 'paper', strategyId: 'scalping', signalId: 'signal-bridge-1', symbol: 'BTC', market: 'spot', side: 'buy',
    orderType: 'limit', quantity: 0.01, quoteAmount: null, limitPrice: 100_000_000, estimatedKrw: 1_000_000,
    stopPrice: 98_000_000, targetPrices: [103_000_000], splitRatios: [1], signalReasons: ['bridge-test'],
    marketSnapshot: {
      observedAt: '2026-08-12T00:00:00.000Z', dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0,
      orderbookGapPercent: 0, halted: false, availableBalance: 2_000_000, accountValueKrw: 2_000_000,
      dailyPnlPercent: 0, assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
    },
    approvalExpiresAt: null, approvedAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function orderFixture(plan: TradingPlan): TradingOrder {
  return {
    id: 'order-bridge-1', userId: plan.userId, planId: plan.id, exchange: plan.exchange,
    clientOrderId: 'client-bridge-1', exchangeOrderId: 'paper-client-bridge-1', state: 'FILLED',
    requestedQuantity: 0.01, filledQuantity: 0.01, averageFillPrice: 100_000_000, retryCount: 0,
    lastErrorCode: null, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:02.000Z',
  };
}

function eventFixture(order: TradingOrder, id: string, fromState: TradingOrderEvent['fromState'], toState: TradingOrderEvent['toState'], createdAt: string): TradingOrderEvent {
  return { id, userId: order.userId, orderId: order.id, fromState, toState, reason: `BRIDGE_${toState}`, metadata: {}, createdAt };
}

async function linkedService() {
  const integrationRepository = new InMemoryUserBrokerTelegramRepository();
  integrationRepository.setMemberProfile('user-a', {
    status: 'approved', membership_level: 'associate', is_active: true, role: 'associate',
  });
  integrationRepository.setMemberProfile('user-b', {
    status: 'approved', membership_level: 'associate', is_active: true, role: 'associate',
  });
  const transport = new FakeTransport();
  const portfolio = new CapturingPortfolioSink();
  const service = new UserBrokerTelegramService(integrationRepository, transport, portfolio, 'bridge_ci_bot');
  const now = new Date('2026-08-12T00:00:00.000Z');
  const link = await service.createTelegramLink('user-a', now);
  const token = new URL(link.deepLink!).searchParams.get('start');
  assert.ok(token);
  await service.bindTelegramStart({ token, telegramChatId: 'chat-a', telegramUserId: 'telegram-user-a', now });
  return { integrationRepository, transport, portfolio, service };
}

test('bridge maps canonical historical transitions once without broker requests or order mutations', async () => {
  const trading = new InMemoryTradingRepository();
  const plan = planFixture();
  const order = orderFixture(plan);
  await trading.savePlan(plan);
  await trading.saveOrder(order);
  await trading.appendEvent(eventFixture(order, 'evt-accepted', 'SUBMITTED', 'ACCEPTED', '2026-08-12T00:00:01.000Z'));
  await trading.appendEvent(eventFixture(order, 'evt-filled', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z'));

  const { integrationRepository, portfolio, service } = await linkedService();
  const bridge = new TradeExecutionEventBridgeService(trading, service);

  const first = await bridge.syncUser('user-a', 'associate');
  assert.deepEqual(first, {
    scanned: 2, mapped: 2, inserted: 2, deliveryQueued: 2, missingReferences: 0,
    privateApiRequests: 0, ordersSubmitted: 0, ordersCancelled: 0,
  });
  assert.deepEqual(portfolio.events.map((event) => event.type), ['ORDER_SUBMITTED', 'ORDER_FILLED']);
  assert.equal((await trading.getOrder('user-a', order.id))?.state, 'FILLED');

  const second = await bridge.syncUser('user-a', 'associate');
  assert.equal(second.inserted, 0);
  assert.equal(second.deliveryQueued, 0);
  assert.equal(portfolio.events.length, 2);
  assert.equal((await integrationRepository.listDeliveries('user-a')).length, 2);
});

test('missing bridge membership fails closed for delivery queueing', async () => {
  const trading = new InMemoryTradingRepository();
  const plan = planFixture();
  const order = orderFixture(plan);
  await trading.savePlan(plan);
  await trading.saveOrder(order);
  await trading.appendEvent(eventFixture(order, 'evt-filled-default', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z'));
  const { integrationRepository, service } = await linkedService();
  const result = await new TradeExecutionEventBridgeService(trading, service).syncUser('user-a');
  assert.equal(result.inserted, 1);
  assert.equal(result.deliveryQueued, 0);
  assert.equal((await integrationRepository.listDeliveries('user-a')).length, 0);
});

test('bridge remains user-scoped and cannot expose another user events', async () => {
  const trading = new InMemoryTradingRepository();
  const plan = planFixture();
  const order = orderFixture(plan);
  await trading.savePlan(plan);
  await trading.saveOrder(order);
  await trading.appendEvent(eventFixture(order, 'evt-filled', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z'));

  const { portfolio, service } = await linkedService();
  const bridge = new TradeExecutionEventBridgeService(trading, service);
  const result = await bridge.syncUser('user-b');
  assert.deepEqual(result, {
    scanned: 0, mapped: 0, inserted: 0, deliveryQueued: 0, missingReferences: 0,
    privateApiRequests: 0, ordersSubmitted: 0, ordersCancelled: 0,
  });
  assert.equal(portfolio.events.length, 0);
});


test('canonical background automatic plans retain AUTO_POLICY classification through event bridge', async () => {
  const trading = new InMemoryTradingRepository();
  const plan = { ...planFixture(), executionMode: 'automatic' as const };
  const order = orderFixture(plan);
  await trading.savePlan(plan);
  await trading.saveOrder(order);
  await trading.appendEvent(eventFixture(order, 'auto-filled', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z'));
  const { integrationRepository, service, portfolio } = await linkedService();
  const bridge = new TradeExecutionEventBridgeService(trading, service);
  const first = await bridge.syncUser('user-a', 'associate');
  assert.equal(first.inserted, 1);
  const item = portfolio.events[0];
  assert.ok(item);
  assert.equal(item.executionMethod, 'AUTO_POLICY');
  assert.equal(item.metadata.approvalSource, 'AUTO_POLICY');
  const stored = await integrationRepository.getExecutionEvent('user-a', item.id);
  assert.equal(stored?.executionMethod, 'AUTO_POLICY');
  const repeated = await bridge.syncUser('user-a', 'associate');
  assert.equal(repeated.inserted, 0);
});


test('execution scope accepts one canonical UUID and rejects broad or ambiguous selectors', () => {
  const id = 'A00AA000-B000-4000-8000-000000000001';
  assert.equal(parseExecutionSyncOrderId({}), null);
  assert.equal(parseExecutionSyncOrderId(undefined), null);
  assert.equal(parseExecutionSyncOrderId({ orderId: id }), id.toLowerCase());
  assert.throws(() => parseExecutionSyncOrderId({ orderId: 'not-a-uuid' }), /EXECUTION_SYNC_ORDER_ID_INVALID/);
  assert.throws(() => parseExecutionSyncOrderId({ orderId: 123 }), /EXECUTION_SYNC_ORDER_ID_INVALID/);
  assert.throws(() => parseExecutionSyncOrderId({ orderId: id, userId: 'another-user' }), /EXECUTION_SYNC_REQUEST_INVALID/);
  assert.throws(() => parseExecutionSyncOrderId({ userId: 'another-user' }), /EXECUTION_SYNC_REQUEST_INVALID/);
  assert.throws(() => parseExecutionSyncOrderId([]), /EXECUTION_SYNC_REQUEST_INVALID/);
});

test('owned Paper order sync skips unrelated historical method conflict without changing source lineage', async () => {
  const trading = new InMemoryTradingRepository();
  const historicalPlan = { ...planFixture(), executionMode: 'automatic' as const };
  const historicalOrder = orderFixture(historicalPlan);
  const historicalTransition = eventFixture(
    historicalOrder, 'historic-conflict-event', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z',
  );
  await trading.savePlan(historicalPlan);
  await trading.saveOrder(historicalOrder);
  await trading.appendEvent(historicalTransition);

  const newPlan: TradingPlan = {
    ...historicalPlan, id: 'plan-bridge-fresh',
    idempotencyKey: 'idem-fresh', signalId: 'signal-fresh',
  };
  const newOrder: TradingOrder = {
    ...historicalOrder, id: 'order-bridge-fresh', planId: newPlan.id,
    clientOrderId: 'fresh-client', exchangeOrderId: 'fresh-paper',
  };
  const freshTransition = eventFixture(
    newOrder, 'fresh-paper-filled', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:03.000Z',
  );
  await trading.savePlan(newPlan);
  await trading.saveOrder(newOrder);
  await trading.appendEvent(freshTransition);
  const { integrationRepository, service, portfolio } = await linkedService();

  const historicalUserApproved = executionEventFromTradingOrder(
    historicalTransition, historicalOrder, historicalPlan,
    { executionMethod: 'USER_APPROVED' },
  );
  assert.ok(historicalUserApproved);
  await service.recordEvent(historicalUserApproved, new Date('2026-08-12T00:00:04.000Z'), 'associate');

  const bridge = new TradeExecutionEventBridgeService(trading, service);
  await assert.rejects(() => bridge.syncUser('user-a', 'associate'), /EXECUTION_SOURCE_EVENT_LINEAGE_CONFLICT/);
  assert.equal((await integrationRepository.getExecutionEventBySource('user-a', historicalTransition.id))
    ?.executionMethod, 'USER_APPROVED');

  const scoped = await bridge.syncUser('user-a', 'associate', { orderId: newOrder.id });
  assert.deepEqual(scoped, {
    scanned: 1, mapped: 1, inserted: 1, deliveryQueued: 1,
    missingReferences: 0, scopedToOrder: true,
    privateApiRequests: 0, ordersSubmitted: 0, ordersCancelled: 0,
  });
  assert.equal((await integrationRepository.getExecutionEventBySource('user-a', historicalTransition.id))
    ?.executionMethod, 'USER_APPROVED');
  assert.equal((await integrationRepository.getExecutionEventBySource('user-a', freshTransition.id))
    ?.executionMethod, 'AUTO_POLICY');
  assert.equal(portfolio.events.some((x) => x.sourceEventId === freshTransition.id), true);

  const repeated = await bridge.syncUser('user-a', 'associate', { orderId: newOrder.id });
  assert.equal(repeated.inserted, 0);
  assert.equal(repeated.deliveryQueued, 0);
  await assert.rejects(
    () => bridge.syncUser('user-a', 'associate', { orderId: historicalOrder.id }),
    /EXECUTION_SOURCE_EVENT_LINEAGE_CONFLICT/,
  );
  await assert.rejects(
    () => bridge.syncUser('user-b', 'associate', { orderId: newOrder.id }),
    /EXECUTION_SYNC_TARGET_NOT_FOUND/,
  );
  await assert.rejects(
    () => bridge.syncUser('user-a', 'associate', { orderId: 'missing-order' }),
    /EXECUTION_SYNC_TARGET_NOT_FOUND/,
  );
});

test('targeted sync denies live order even when owned and otherwise valid', async () => {
  const trading = new InMemoryTradingRepository();
  const plan: TradingPlan = { ...planFixture(), accountMode: 'live' };
  const order = orderFixture(plan);
  await trading.savePlan(plan);
  await trading.saveOrder(order);
  await trading.appendEvent(eventFixture(order, 'live-event', 'ACCEPTED', 'FILLED', '2026-08-12T00:00:02.000Z'));
  const { service, integrationRepository } = await linkedService();
  const bridge = new TradeExecutionEventBridgeService(trading, service);
  await assert.rejects(
    () => bridge.syncUser('user-a', 'associate', { orderId: order.id }),
    /EXECUTION_SYNC_TARGET_LIVE_FORBIDDEN/,
  );
  assert.equal(await integrationRepository.getExecutionEventBySource('user-a', 'live-event'), null);
});
