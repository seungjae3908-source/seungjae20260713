import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from '../../services/trade-automation.repository';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../../services/trade-automation.types';
import { InMemoryUserBrokerTelegramRepository } from './user-broker-telegram.repository';
import { UserBrokerTelegramService } from './user-broker-telegram.service';
import { TradeExecutionEventBridgeService } from './trade-execution-event-bridge.service';
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
    this.events.push(structuredClone(event));
  }
}

function planFixture(): TradingPlan {
  return {
    id: 'plan-bridge-1',
    userId: 'user-a',
    idempotencyKey: 'bridge-idem-1',
    state: 'SUBMITTED',
    version: 1,
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'scalping',
    signalId: 'signal-bridge-1',
    symbol: 'BTC',
    market: 'spot',
    side: 'buy',
    orderType: 'limit',
    quantity: 0.01,
    quoteAmount: null,
    limitPrice: 100_000_000,
    estimatedKrw: 1_000_000,
    stopPrice: 98_000_000,
    targetPrices: [103_000_000],
    splitRatios: [1],
    signalReasons: ['bridge-test'],
    marketSnapshot: {
      observedAt: '2026-08-12T00:00:00.000Z',
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0,
      orderbookGapPercent: 0,
      halted: false,
      availableBalance: 2_000_000,
      accountValueKrw: 2_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    approvalExpiresAt: null,
    approvedAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function orderFixture(plan: TradingPlan): TradingOrder {
  return {
    id: 'order-bridge-1',
    userId: plan.userId,
    planId: plan.id,
    exchange: plan.exchange,
    clientOrderId: 'client-bridge-1',
    exchangeOrderId: 'paper-client-bridge-1',
    state: 'FILLED',
    requestedQuantity: 0.01,
    filledQuantity: 0.01,
    averageFillPrice: 100_000_000,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:02.000Z',
  };
}

function eventFixture(
  order: TradingOrder,
  id: string,
  fromState: TradingOrderEvent['fromState'],
  toState: TradingOrderEvent['toState'],
  createdAt: string,
): TradingOrderEvent {
  return {
    id,
    userId: order.userId,
    orderId: order.id,
    fromState,
    toState,
    reason: `BRIDGE_${toState}`,
    metadata: {},
    createdAt,
  };
}

async function linkedService() {
  const integrationRepository = new InMemoryUserBrokerTelegramRepository();
  const transport = new FakeTransport();
  const portfolio = new CapturingPortfolioSink();
  const service = new UserBrokerTelegramService(integrationRepository, transport, portfolio, 'bridge_ci_bot');
  const now = new Date('2026-08-12T00:00:00.000Z');
  const link = await service.createTelegramLink('user-a', now);
  const token = new URL(link.deepLink!).searchParams.get('start');
  assert.ok(token);
  await service.bindTelegramStart({
    token,
    telegramChatId: 'chat-a',
    telegramUserId: 'telegram-user-a',
    now,
  });
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

  const first = await bridge.syncUser('user-a');
  assert.deepEqual(first, {
    scanned: 2,
    mapped: 2,
    inserted: 2,
    deliveryQueued: 2,
    missingReferences: 0,
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
  });
  assert.deepEqual(portfolio.events.map((event) => event.type), ['ORDER_SUBMITTED', 'ORDER_FILLED']);
  assert.equal((await trading.getOrder('user-a', order.id))?.state, 'FILLED');

  const second = await bridge.syncUser('user-a');
  assert.equal(second.inserted, 0);
  assert.equal(second.deliveryQueued, 0);
  assert.equal(portfolio.events.length, 2);
  assert.equal((await integrationRepository.listDeliveries('user-a')).length, 2);
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
    scanned: 0,
    mapped: 0,
    inserted: 0,
    deliveryQueued: 0,
    missingReferences: 0,
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
  });
  assert.equal(portfolio.events.length, 0);
});
