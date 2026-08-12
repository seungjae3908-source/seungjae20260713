import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryUserBrokerTelegramRepository } from './user-broker-telegram.repository';
import {
  UserBrokerTelegramService,
  executionEventFromTradingOrder,
  hashTelegramLinkToken,
  manualPortfolioEvent,
  maskBrokerAccount,
} from './user-broker-telegram.service';
import type {
  PortfolioSyncSink,
  TelegramTransport,
  UserExecutionEvent,
} from './user-broker-telegram.types';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../../services/trade-automation.types';

class FakeTelegramTransport implements TelegramTransport {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  fail = false;
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return this.fail ? { ok: false, errorCode: 'FAKE_OUTAGE' } : { ok: true };
  }
}

class FakePortfolioSink implements PortfolioSyncSink {
  readonly events: UserExecutionEvent[] = [];
  async accept(event: UserExecutionEvent) { this.events.push(structuredClone(event)); }
}

function fixture() {
  const repository = new InMemoryUserBrokerTelegramRepository();
  const transport = new FakeTelegramTransport();
  const portfolio = new FakePortfolioSink();
  const service = new UserBrokerTelegramService(repository, transport, portfolio, 'ci_test_bot');
  return { repository, transport, portfolio, service };
}

async function link(
  service: UserBrokerTelegramService,
  userId: string,
  chatId: string,
  telegramUserId = `tg-${userId}`,
  now = new Date('2026-08-12T00:00:00.000Z'),
) {
  const created = await service.createTelegramLink(userId, now);
  assert.ok(created.deepLink);
  const token = new URL(created.deepLink).searchParams.get('start');
  assert.ok(token);
  return service.bindTelegramStart({ token, telegramChatId: chatId, telegramUserId, now });
}

test('Telegram link token is user-bound, one-time and stored/consumed by hash', async () => {
  const { service } = fixture();
  const now = new Date('2026-08-12T00:00:00.000Z');
  const created = await service.createTelegramLink('user-a', now);
  const token = new URL(created.deepLink!).searchParams.get('start')!;
  assert.equal(token.length > 20, true);
  assert.equal(hashTelegramLinkToken(token).includes(token), false);
  assert.deepEqual(await service.bindTelegramStart({
    token, telegramChatId: 'chat-a', telegramUserId: 'tg-a', now,
  }), { userId: 'user-a', connected: true });
  await assert.rejects(
    service.bindTelegramStart({ token, telegramChatId: 'chat-b', telegramUserId: 'tg-b', now }),
    /TELEGRAM_LINK_EXPIRED_OR_USED/,
  );
});

test('expired Telegram link cannot be consumed', async () => {
  const { service } = fixture();
  const created = await service.createTelegramLink('user-a', new Date('2026-08-12T00:00:00.000Z'));
  const token = new URL(created.deepLink!).searchParams.get('start')!;
  await assert.rejects(service.bindTelegramStart({
    token,
    telegramChatId: 'chat-a',
    telegramUserId: 'tg-a',
    now: new Date('2026-08-12T00:11:00.000Z'),
  }), /TELEGRAM_LINK_EXPIRED_OR_USED/);
});

test('a Telegram chat cannot be rebound to another app user', async () => {
  const { service } = fixture();
  await link(service, 'user-a', 'shared-chat');
  const created = await service.createTelegramLink('user-b', new Date('2026-08-12T00:01:00.000Z'));
  const token = new URL(created.deepLink!).searchParams.get('start')!;
  await assert.rejects(service.bindTelegramStart({
    token,
    telegramChatId: 'shared-chat',
    telegramUserId: 'tg-b',
    now: new Date('2026-08-12T00:01:00.000Z'),
  }), /TELEGRAM_CHAT_ALREADY_LINKED/);
});

test('user A manual event queues only Telegram A and does not re-sync canonical portfolio', async () => {
  const { service, repository, transport, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  await link(service, 'user-b', 'chat-b', 'tg-b', new Date('2026-08-12T00:01:00.000Z'));
  const event = manualPortfolioEvent({
    id: 'manual-a', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 10, price: 72000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:02:00.000Z'));
  assert.equal(queued.deliveryQueued, true);
  assert.equal(portfolio.events.length, 0);
  const deliveriesA = await repository.listDeliveries('user-a');
  const deliveriesB = await repository.listDeliveries('user-b');
  assert.equal(deliveriesA.length, 1);
  assert.equal(deliveriesB.length, 0);
  await service.processDelivery('user-a', deliveriesA[0].id, new Date('2026-08-12T00:03:00.000Z'));
  assert.deepEqual(transport.sent.map((item) => item.chatId), ['chat-a']);
  assert.match(transport.sent[0].text, /등록방식: 수동등록/);
});

test('duplicate execution event is ignored by source-event id and does not duplicate Telegram delivery', async () => {
  const { service, repository, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'same-source', userId: 'user-a', symbol: 'AAPL', market: 'US', quantity: 1, price: 220,
  });
  assert.equal((await service.recordEvent(event)).inserted, true);
  assert.equal((await service.recordEvent({ ...event, id: 'another-id' })).inserted, false);
  assert.equal((await repository.listDeliveries('user-a')).length, 1);
  assert.equal(portfolio.events.length, 0);
});

test('Telegram delivery retries are bounded and end in dead letter without changing the execution event', async () => {
  const { service, repository, transport } = fixture();
  transport.fail = true;
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'retry-source', userId: 'user-a', symbol: 'BTC', market: 'spot', quantity: 0.01, price: 100000000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:00:00.000Z'));
  const deliveryId = queued.deliveryId!;
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:00:01.000Z'))).state, 'RETRY_SCHEDULED');
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:01:00.000Z'))).state, 'RETRY_SCHEDULED');
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:03:00.000Z'))).state, 'DEAD_LETTER');
  const delivery = await repository.getDelivery('user-a', deliveryId);
  assert.equal(delivery?.attempts, 3);
  assert.equal(transport.sent.length, 3);
});

test('revoked Telegram connection cannot receive a queued event', async () => {
  const { service, repository, transport } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'revoke-source', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000,
  });
  const queued = await service.recordEvent(event);
  await service.revokeTelegram('user-a');
  const result = await service.processDelivery('user-a', queued.deliveryId!);
  assert.equal(result.state, 'DEAD_LETTER');
  assert.equal(transport.sent.length, 0);
  assert.equal((await repository.getTelegramConnection('user-a'))?.status, 'REVOKED');
});

test('notification preferences can disable a type without affecting event/portfolio sync', async () => {
  const { service, repository, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  await service.savePreferences('user-a', { ORDER_FILLED: false });
  const event: UserExecutionEvent = {
    ...manualPortfolioEvent({ id: 'filled-source', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000 }),
    type: 'ORDER_FILLED', source: 'PAPER_EXECUTION', executionMethod: 'USER_APPROVED',
  };
  const result = await service.recordEvent(event);
  assert.deepEqual(result, { inserted: true, deliveryQueued: false });
  assert.equal((await repository.listDeliveries('user-a')).length, 0);
  assert.equal(portfolio.events.length, 1);
});

test('canonical trading order event maps to user execution event with owner checks and masked account', () => {
  const plan = {
    id: 'plan-1', userId: 'user-a', idempotencyKey: 'idem-1', state: 'SUBMITTED', version: 1,
    exchange: 'kiwoom', accountMode: 'paper', strategyId: 'scalping', signalId: 'sig-1', symbol: '005930', market: 'KR', side: 'buy',
    orderType: 'limit', quantity: 10, quoteAmount: null, limitPrice: 72000, estimatedKrw: 720000,
    stopPrice: 70000, targetPrices: [75000], splitRatios: [1], signalReasons: ['test'],
    marketSnapshot: { observedAt: '2026-08-12T00:00:00Z', dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0,
      orderbookGapPercent: 0, halted: false, availableBalance: 1000000, accountValueKrw: 1000000, dailyPnlPercent: 0,
      assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0 },
    approvalExpiresAt: null, approvedAt: '2026-08-12T00:00:00Z', createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
  } satisfies TradingPlan;
  const order = {
    id: 'order-1', userId: 'user-a', planId: plan.id, exchange: 'kiwoom', clientOrderId: 'client-1', exchangeOrderId: null,
    state: 'FILLED', requestedQuantity: 10, filledQuantity: 10, averageFillPrice: 72000, retryCount: 0, lastErrorCode: null,
    createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:01Z',
  } satisfies TradingOrder;
  const transition = {
    id: 'transition-1', userId: 'user-a', orderId: order.id, fromState: 'ACCEPTED', toState: 'FILLED', reason: 'FILLED', metadata: {},
    createdAt: '2026-08-12T00:00:01Z',
  } satisfies TradingOrderEvent;
  const event = executionEventFromTradingOrder(transition, order, plan, { accountNumber: '1234567890' });
  assert.equal(event?.type, 'ORDER_FILLED');
  assert.equal(event?.source, 'PAPER_EXECUTION');
  assert.equal(event?.maskedAccount, '****7890');
  assert.equal(maskBrokerAccount('12'), '****12');
  assert.throws(() => executionEventFromTradingOrder({ ...transition, userId: 'user-b' }, order, plan), /EXECUTION_OWNER_MISMATCH/);
});
