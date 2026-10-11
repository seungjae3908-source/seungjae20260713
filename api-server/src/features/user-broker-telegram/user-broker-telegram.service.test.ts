import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryUserBrokerTelegramRepository,
  TELEGRAM_NOTIFICATION_PREFERENCES_MARKER,
  enabledTypesWithTelegramPreferences,
  notificationPreferencesFromEnabledTypes,
} from './user-broker-telegram.repository';
import {
  UserBrokerTelegramService,
  executionEventFromTradingOrder,
  hashTelegramLinkToken,
  manualPortfolioEvent,
  maskBrokerAccount,
  personalTelegramEventAllowed,
  renderUserExecutionTelegramMessage,
} from './user-broker-telegram.service';
import type {
  PortfolioSyncSink,
  TelegramTransport,
  UserExecutionEvent,
} from './user-broker-telegram.types';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../../services/trade-automation.types';
import { TelegramDeliveryWorker, telegramDeliveryTickConfirmed, userTelegramDeliveryWorkerHealthy, verifiedRecentTelegramDeliveryReceipt } from './user-broker-telegram.worker';

class FakeTelegramTransport implements TelegramTransport {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  fail = false;
  errorCode = 'FAKE_OUTAGE';
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return this.fail ? { ok: false, errorCode: this.errorCode } : { ok: true };
  }
}

class FakePortfolioSink implements PortfolioSyncSink {
  readonly events: UserExecutionEvent[] = [];
  async accept(event: UserExecutionEvent) {
    if (this.events.some((row) => row.sourceEventId === event.sourceEventId && row.userId === event.userId)) return;
    this.events.push(structuredClone(event));
  }
}

const APPROVED_ASSOCIATE = Object.freeze({
  status: 'approved', membership_level: 'associate', is_active: true, role: 'associate',
  membership_expires_at: null, permissions_updated_at: '2026-08-01T00:00:00.000Z',
});

function fixture() {
  const repository = new InMemoryUserBrokerTelegramRepository();
  for (const userId of ['user-a', 'user-b', 'associate-user']) repository.setMemberProfile(userId, APPROVED_ASSOCIATE);
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

test('member revoked after token issuance cannot bind Telegram', async () => {
  const { service, repository } = fixture();
  const now = new Date('2026-08-12T00:00:00.000Z');
  const created = await service.createTelegramLink('user-a', now);
  const token = new URL(created.deepLink!).searchParams.get('start')!;
  repository.setMemberProfile('user-a', {
    status: 'suspended', membership_level: 'associate', is_active: false, role: 'associate',
  });
  await assert.rejects(
    service.bindTelegramStart({ token, telegramChatId: 'chat-a', telegramUserId: 'tg-a', now }),
    /TELEGRAM_MEMBER_INELIGIBLE/,
  );
  assert.equal(await repository.getTelegramConnection('user-a'), null);
});

test('expired and schema-incomplete members cannot bind a Telegram link', async () => {
  for (const profile of [
    { ...APPROVED_ASSOCIATE, membership_expires_at: '2025-01-01T00:00:00.000Z' },
    { ...APPROVED_ASSOCIATE, permissions_updated_at: null },
    { ...APPROVED_ASSOCIATE, membership_level: null, role: 'associate' },
  ]) {
    const { service, repository } = fixture();
    const now = new Date('2026-08-12T00:00:00.000Z');
    const created = await service.createTelegramLink('user-a', now);
    const token = new URL(created.deepLink!).searchParams.get('start')!;
    repository.setMemberProfile('user-a', profile);
    await assert.rejects(
      service.bindTelegramStart({ token, telegramChatId: 'chat-a', telegramUserId: 'tg-a', now }),
      /TELEGRAM_MEMBER_INELIGIBLE/,
    );
    assert.equal(await repository.getTelegramConnection('user-a'), null);
  }
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

test('personal Telegram delivery is bounded by the server-resolved membership market scope', async () => {
  assert.equal(personalTelegramEventAllowed('associate', { market: 'KR' }), true);
  assert.equal(personalTelegramEventAllowed('associate', { market: 'crypto_spot' }), true);
  assert.equal(personalTelegramEventAllowed('associate', { market: 'crypto_futures' }), false);
  assert.equal(personalTelegramEventAllowed('regular', { market: 'crypto_futures' }), true);
  assert.equal(personalTelegramEventAllowed('pending', { market: 'KR' }), false);

  const { service, repository } = fixture();
  await link(service, 'associate-user', 'associate-chat');
  const futures = manualPortfolioEvent({
    id: 'associate-futures', userId: 'associate-user', symbol: 'BTCUSDT', market: 'crypto_futures', quantity: 1, price: 100,
  });
  assert.deepEqual(
    await service.recordEvent(futures, new Date('2026-08-12T00:02:00.000Z'), 'associate'),
    { inserted: true, deliveryQueued: false, skipped: 'MEMBERSHIP_SCOPE' },
  );
  assert.equal((await repository.listDeliveries('associate-user')).length, 0);
});

test('missing membership scope fails closed before Telegram queueing', async () => {
  const { service, repository } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'missing-membership', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000,
  });
  assert.deepEqual(await service.recordEvent(event), {
    inserted: true,
    deliveryQueued: false,
    skipped: 'MEMBERSHIP_SCOPE',
  });
  assert.equal((await repository.listDeliveries('user-a')).length, 0);
});

test('user A manual event queues only Telegram A and does not re-sync canonical portfolio', async () => {
  const { service, repository, transport, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  await link(service, 'user-b', 'chat-b', 'tg-b', new Date('2026-08-12T00:01:00.000Z'));
  const event = manualPortfolioEvent({
    id: 'manual-a', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 10, price: 72000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:02:00.000Z'), 'associate');
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

test('owner AUTO_POLICY events mirror only to the dedicated auto-trading room', async () => {
  const repository = new InMemoryUserBrokerTelegramRepository();
  repository.setMemberProfile('user-a', APPROVED_ASSOCIATE);
  repository.setMemberProfile('user-b', APPROVED_ASSOCIATE);
  const transport = new FakeTelegramTransport();
  const portfolio = new FakePortfolioSink();
  const service = new UserBrokerTelegramService(
    repository,
    transport,
    portfolio,
    'ci_test_bot',
    undefined,
    'user-a',
    'owner-auto-room',
  );

  await link(service, 'user-a', 'chat-a');
  await link(service, 'user-b', 'chat-b', 'tg-b', new Date('2026-08-12T00:01:00.000Z'));

  const ownerEvent: UserExecutionEvent = {
    ...manualPortfolioEvent({
      id: 'owner-auto',
      userId: 'user-a',
      symbol: '005930',
      market: 'KR',
      side: 'buy',
      quantity: 1,
      price: 72000,
    }),
    type: 'ORDER_FILLED',
    source: 'PAPER_EXECUTION',
    executionMethod: 'AUTO_POLICY',
  };
  const otherEvent: UserExecutionEvent = {
    ...manualPortfolioEvent({
      id: 'other-auto',
      userId: 'user-b',
      symbol: 'AAPL',
      market: 'US',
      side: 'buy',
      quantity: 1,
      price: 220,
    }),
    type: 'ORDER_FILLED',
    source: 'PAPER_EXECUTION',
    executionMethod: 'AUTO_POLICY',
  };

  const ownerQueued = await service.recordEvent(ownerEvent, new Date('2026-08-12T00:02:00.000Z'), 'associate');
  const otherQueued = await service.recordEvent(otherEvent, new Date('2026-08-12T00:02:01.000Z'), 'associate');
  await service.processDelivery('user-a', ownerQueued.deliveryId!, new Date('2026-08-12T00:03:00.000Z'));
  await service.processDelivery('user-b', otherQueued.deliveryId!, new Date('2026-08-12T00:03:01.000Z'));

  assert.deepEqual(transport.sent.map((item) => item.chatId), [
    'chat-a',
    'owner-auto-room',
    'chat-b',
  ]);
  assert.match(transport.sent[1].text, /🤖 자동매매 · 매수 신호/);
});

test('owner AUTO mirror skips a colliding holdings room while personal receipt succeeds', async () => {
  const originalHoldings = process.env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID;
  try {
    process.env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID = 'owner-auto-room';
    const repository = new InMemoryUserBrokerTelegramRepository();
    repository.setMemberProfile('user-a', APPROVED_ASSOCIATE);
    const transport = new FakeTelegramTransport();
    const service = new UserBrokerTelegramService(
      repository, transport, new FakePortfolioSink(), 'ci_test_bot',
      undefined, 'user-a', 'owner-auto-room',
    );
    await link(service, 'user-a', 'chat-a');
    const event: UserExecutionEvent = {
      ...manualPortfolioEvent({
        id: 'owner-auto-collision',
        userId: 'user-a',
        symbol: '005930',
        market: 'KR',
        side: 'buy',
        quantity: 1,
        price: 72000,
      }),
      type: 'ORDER_FILLED',
      source: 'PAPER_EXECUTION',
      executionMethod: 'AUTO_POLICY',
    };
    const queued = await service.recordEvent(event, new Date('2026-08-12T00:02:00.000Z'), 'associate');
    assert.ok(queued.deliveryId);
    const sent = await service.processDelivery('user-a', queued.deliveryId!, new Date('2026-08-12T00:03:00.000Z'));
    assert.equal(sent.state, 'SENT');
    assert.deepEqual(transport.sent.map(item => item.chatId), ['chat-a']);
  } finally {
    if (originalHoldings == null) delete process.env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID;
    else process.env.TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID = originalHoldings;
  }
});

test('member revoked after queueing is dead-lettered before Telegram transport', async () => {
  const { service, repository, transport } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'revoke-membership-after-queue', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:02:00.000Z'), 'associate');
  repository.setMemberProfile('user-a', {
    status: 'suspended', membership_level: 'associate', is_active: false, role: 'associate',
  });
  const result = await service.processDelivery('user-a', queued.deliveryId!, new Date('2026-08-12T00:03:00.000Z'));
  assert.equal(result.state, 'DEAD_LETTER');
  assert.equal(transport.sent.length, 0);
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.lastErrorCode, 'TELEGRAM_MEMBER_INELIGIBLE');
});

test('membership expiration after queueing prevents Telegram send and dead-letters the delivery', async () => {
  const { service, repository, transport } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'expired-after-queue', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:02:00.000Z'), 'associate');
  assert.equal(queued.deliveryQueued, true);
  repository.setMemberProfile('user-a', {
    ...APPROVED_ASSOCIATE, membership_expires_at: '2025-01-01T00:00:00.000Z',
  });
  const result = await service.processDelivery('user-a', queued.deliveryId!, new Date('2026-08-12T00:03:00.000Z'));
  assert.equal(result.state, 'DEAD_LETTER');
  assert.equal(transport.sent.length, 0);
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.lastErrorCode, 'TELEGRAM_MEMBER_INELIGIBLE');
});

test('duplicate execution event is ignored by source-event id and does not duplicate Telegram delivery', async () => {
  const { service, repository, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'same-source', userId: 'user-a', symbol: 'AAPL', market: 'US', quantity: 1, price: 220,
  });
  assert.equal((await service.recordEvent(event, new Date(), 'associate')).inserted, true);
  assert.equal((await service.recordEvent({ ...event, id: 'another-id' }, new Date(), 'associate')).inserted, false);
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
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:00:00.000Z'), 'associate');
  const deliveryId = queued.deliveryId!;
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:00:01.000Z'))).state, 'RETRY_SCHEDULED');
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:01:00.000Z'))).state, 'RETRY_SCHEDULED');
  assert.equal((await service.processDelivery('user-a', deliveryId, new Date('2026-08-12T00:03:00.000Z'))).state, 'DEAD_LETTER');
  const delivery = await repository.getDelivery('user-a', deliveryId);
  assert.equal(delivery?.attempts, 3);
  assert.equal(transport.sent.length, 3);
});

test('Telegram 403 is permanent, dead-letters once, and revokes the stale personal connection', async () => {
  const { service, repository, transport } = fixture();
  transport.fail = true;
  transport.errorCode = 'TELEGRAM_HTTP_403';
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'forbidden-source', userId: 'user-a', symbol: 'BTC', market: 'spot', quantity: 0.01, price: 100000000,
  });
  const queued = await service.recordEvent(event, new Date('2026-08-12T00:01:00.000Z'), 'associate');
  const result = await service.processDelivery('user-a', queued.deliveryId!, new Date('2026-08-12T00:02:00.000Z'));

  assert.equal(result.state, 'DEAD_LETTER');
  assert.equal(transport.sent.length, 1);
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.attempts, 1);
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.lastErrorCode, 'TELEGRAM_HTTP_403');
  assert.equal((await repository.getTelegramConnection('user-a'))?.status, 'REVOKED');
});

test('historical Telegram 403 after the latest link is exposed and blocks new delivery fan-out', async () => {
  const { service, repository } = fixture();
  await link(service, 'user-a', 'chat-a');
  await repository.enqueueDelivery({
    id: 'historical-forbidden', userId: 'user-a', eventId: null, dedupeKey: 'historical-forbidden',
    state: 'DEAD_LETTER', attempts: 3, nextRetryAt: null, lastErrorCode: 'TELEGRAM_HTTP_403',
    createdAt: '2026-08-12T00:01:00.000Z', updatedAt: '2026-08-12T00:02:00.000Z',
    kind: 'EXECUTION_EVENT', payload: null,
  });

  const state = await service.getState('user-a');
  assert.deepEqual(state.telegram, {
    connected: false,
    status: 'RECOVERY_REQUIRED',
    connectedAt: '2026-08-12T00:00:00.000Z',
    recoveryRequired: true,
    recoveryErrorCode: 'TELEGRAM_HTTP_403',
    recoveryFailedAt: '2026-08-12T00:02:00.000Z',
  });

  const event = manualPortfolioEvent({
    id: 'blocked-after-forbidden', userId: 'user-a', symbol: 'BTC', market: 'spot', quantity: 0.01, price: 100000000,
  });
  const recorded = await service.recordEvent(event, new Date('2026-08-12T00:03:00.000Z'), 'associate');
  assert.equal(recorded.deliveryQueued, false);
  assert.equal(recorded.skipped, 'TELEGRAM_CONNECTION_RECOVERY_REQUIRED');
  assert.equal((await repository.listDeliveries('user-a')).length, 1);
});

test('revoked Telegram connection cannot receive a queued event', async () => {
  const { service, repository, transport } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = manualPortfolioEvent({
    id: 'revoke-source', userId: 'user-a', symbol: '005930', market: 'KR', quantity: 1, price: 72000,
  });
  const queued = await service.recordEvent(event, new Date(), 'associate');
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

test('Telegram preference projection preserves unified app notification types', () => {
  const legacy = notificationPreferencesFromEnabledTypes(['news_positive', 'system']);
  assert.equal(legacy.ORDER_FILLED, true);
  assert.equal(legacy.POSITION_CLOSED, true);

  const enabledTypes = enabledTypesWithTelegramPreferences(
    ['news_positive', 'system', 'ORDER_REJECTED', TELEGRAM_NOTIFICATION_PREFERENCES_MARKER],
    { ...legacy, ORDER_FILLED: false, POSITION_CLOSED: false },
  );
  assert.deepEqual(enabledTypes.slice(0, 3), [
    'news_positive',
    'system',
    TELEGRAM_NOTIFICATION_PREFERENCES_MARKER,
  ]);
  const stored = notificationPreferencesFromEnabledTypes(enabledTypes);
  assert.equal(stored.ORDER_FILLED, false);
  assert.equal(stored.POSITION_CLOSED, false);
  assert.equal(stored.ORDER_REJECTED, true);
});

test('canonical trading order event maps to user execution event with owner checks and masked account', () => {
  const plan = {
    id: 'plan-1', userId: 'user-a', idempotencyKey: 'idem-1', state: 'SUBMITTED', version: 1,
    exchange: 'kiwoom', accountMode: 'paper', strategyId: 'scalping', signalId: 'sig-1', symbol: '005930', market: 'KR', side: 'buy',
    orderType: 'limit', quantity: 10, quoteAmount: null, limitPrice: 72000, estimatedKrw: 720000,
    entryPrice: 71500, entryZoneLow: 71000, entryZoneHigh: 72000, estimatedSlippagePercent: 0.2,
    stopPrice: 70000, targetPrices: [75000, 78000], splitRatios: [1], signalReasons: ['거래량 증가', '돌파 확인'],
    marketSnapshot: { observedAt: '2026-08-12T00:00:00Z', dataDelayMs: 0, oneMinuteMovePercent: 0, spreadPercent: 0,
      orderbookGapPercent: 0, halted: false, availableBalance: 1000000, accountValueKrw: 1000000, dailyPnlPercent: 0,
      assetExposurePercent: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0 },
    approvalExpiresAt: null, approvedAt: '2026-08-12T00:00:00Z', createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
  } satisfies TradingPlan;
  const order = {
    id: 'order-1', userId: 'user-a', planId: plan.id, exchange: 'kiwoom', clientOrderId: 'client-1', exchangeOrderId: null,
    state: 'FILLED', requestedQuantity: 10, filledQuantity: 10, averageFillPrice: 72000,
    feeAmount: 1200, feeCurrency: 'KRW', retryCount: 0, lastErrorCode: null,
    createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:01Z',
  } satisfies TradingOrder;
  const transition = {
    id: 'transition-1', userId: 'user-a', orderId: order.id, fromState: 'ACCEPTED', toState: 'FILLED', reason: 'FILLED', metadata: {},
    createdAt: '2026-08-12T00:00:01Z',
  } satisfies TradingOrderEvent;
  const event = executionEventFromTradingOrder(transition, order, plan, {
    accountNumber: '1234567890',
    executionMethod: 'AUTO_POLICY',
  });
  assert.equal(event?.type, 'ORDER_FILLED');
  assert.equal(event?.source, 'PAPER_EXECUTION');
  assert.equal(event?.maskedAccount, '****7890');
  assert.deepEqual(event?.metadata.signalReasons, ['거래량 증가', '돌파 확인']);
  assert.equal(event?.metadata.feeAmount, 1200);
  assert.equal(event?.metadata.estimatedSlippagePercent, 0.2);
  assert.equal(event?.metadata.actualSlippagePercent, 0.6993);
  const message = renderUserExecutionTelegramMessage(event!);
  assert.match(message, /🤖 자동매매 · 매수 신호/);
  assert.match(message, /자동매매 판단 근거/);
  assert.match(message, /판단: 매수/);
  assert.match(message, /상태: 체결 완료/);
  assert.match(message, /전략: 단타/);
  assert.match(message, /거래량 증가/);
  assert.match(message, /익절 계획: TP1 75,000 \(\+4\.90%\) · TP2 78,000 \(\+9\.09%\)/);
  assert.match(message, /손절\/무효: 70,000 \(-2\.10%\)/);
  assert.match(message, /수수료: 1,200 KRW/);
  assert.match(message, /실제 슬리피지: 0\.6993%/);
  assert.match(message, /시각:/);
  assert.equal(message.includes('ORDER_FILLED'), false);
  assert.equal(maskBrokerAccount('12'), '****12');
  assert.throws(() => executionEventFromTradingOrder({ ...transition, userId: 'user-b' }, order, plan), /EXECUTION_OWNER_MISMATCH/);
});


test('Telegram runtime health rejects failed, stale and future worker ticks', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const ready = { enabled: true, lastTickAt: new Date(now - 30_000).toISOString(), tickOk: true, deliveryConfirmed: true, lastConfirmedDeliveryAt: new Date(now - 45_000).toISOString(), errorCode: null };
  assert.equal(userTelegramDeliveryWorkerHealthy(ready, now), true);
  assert.equal(userTelegramDeliveryWorkerHealthy({ ...ready, lastTickAt: new Date(now - 400_000).toISOString() }, now), false);
  assert.equal(userTelegramDeliveryWorkerHealthy({ ...ready, lastTickAt: new Date(now + 10_000).toISOString() }, now), false);
  assert.equal(userTelegramDeliveryWorkerHealthy({ ...ready, tickOk: false }, now), false);
  assert.equal(userTelegramDeliveryWorkerHealthy({ ...ready, enabled: false }, now), false);
  assert.equal(userTelegramDeliveryWorkerHealthy({ ...ready, errorCode: 'TELEGRAM_UNAVAILABLE' }, now), false);
});

test('Telegram delivery failure stays unhealthy through idle ticks until confirmed success', () => {
  const failed = { sent: 0, retryScheduled: 1, deadLetter: 0 };
  const idle = { sent: 0, retryScheduled: 0, deadLetter: 0 };
  const sent = { sent: 1, retryScheduled: 0, deadLetter: 0 };
  assert.equal(telegramDeliveryTickConfirmed(true, failed), false);
  assert.equal(telegramDeliveryTickConfirmed(false, idle), false);
  assert.equal(telegramDeliveryTickConfirmed(false, sent), true);
  assert.equal(telegramDeliveryTickConfirmed(true, { sent: 1, retryScheduled: 0, deadLetter: 1 }), false);
});

test('overlapping Telegram delivery tick cannot overwrite the in-flight health', async () => {
  let complete!: (result: { processed: boolean; state: 'SENT' }) => void;
  const pending = new Promise<{ processed: boolean; state: 'SENT' }>((resolve) => { complete = resolve; });
  const worker = new TelegramDeliveryWorker(
    { async listDue() { return [{ userId: 'user-a', id: 'delivery-a' }]; } },
    { async processDelivery() { return pending; } } as unknown as UserBrokerTelegramService,
    1,
  );
  const first = worker.runOnce();
  const overlap = await worker.runOnce();
  assert.equal(overlap.overlapSkipped, true);
  complete({ processed: true, state: 'SENT' });
  const done = await first;
  assert.equal(done.overlapSkipped, false);
  assert.equal(done.sent, 1);
});


test('idle initial Telegram tick is not actual member delivery proof', () => {
  const idle = { sent: 0, retryScheduled: 0, deadLetter: 0 };
  assert.equal(telegramDeliveryTickConfirmed(false, idle), false);
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  assert.equal(userTelegramDeliveryWorkerHealthy({
    enabled: true, tickOk: true, lastTickAt: new Date(now).toISOString(),
    deliveryConfirmed: false, lastConfirmedDeliveryAt: null, errorCode: null,
  }, now), false);
});


test('recent durable SENT receipt restores Telegram health only when no newer failed delivery exists', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const row = { state: 'SENT', updated_at: new Date(now - 40_000).toISOString() };
  assert.equal(verifiedRecentTelegramDeliveryReceipt(row, now), row.updated_at);
  assert.equal(verifiedRecentTelegramDeliveryReceipt({ ...row, state: 'RETRY_SCHEDULED' }, now), null);
  assert.equal(verifiedRecentTelegramDeliveryReceipt({ ...row, state: 'DEAD_LETTER' }, now), null);
  assert.equal(verifiedRecentTelegramDeliveryReceipt({ ...row, updated_at: new Date(now - 25 * 60 * 60_000).toISOString() }, now), null);
  assert.equal(verifiedRecentTelegramDeliveryReceipt({ ...row, updated_at: new Date(now + 10_000).toISOString() }, now), null);
  assert.equal(verifiedRecentTelegramDeliveryReceipt(null, now), null);
});


test('interrupted canonical event fan-out recovers journal and Telegram using the original persisted event ID', async () => {
  const { service, repository, portfolio } = fixture();
  await link(service, 'user-a', 'chat-a');
  const original = {
    ...manualPortfolioEvent({
      id: 'crash-after-event-insert', userId: 'user-a',
      symbol: 'BTC', market: 'CRYPTO_SPOT', quantity: 0.01, price: 100_000,
    }),
    type: 'ORDER_FILLED' as const,
    source: 'PAPER_EXECUTION' as const,
  };
  let failOnce = true;
  const failingPortfolio: PortfolioSyncSink = {
    async accept(event) {
      if (failOnce) {
        failOnce = false;
        throw new Error('TEST_PORTFOLIO_PROJECTION_CRASH');
      }
      await portfolio.accept(event);
    },
  };
  const recoveryService = new UserBrokerTelegramService(repository, new FakeTelegramTransport(),
    failingPortfolio, 'ci_test_bot');
  await assert.rejects(
    () => recoveryService.recordEvent(original, new Date(), 'associate'),
    /TEST_PORTFOLIO_PROJECTION_CRASH/,
  );
  const persisted = await repository.getExecutionEventBySource('user-a', original.sourceEventId);
  assert.equal(persisted?.id, original.id);
  assert.equal((await repository.listDeliveries('user-a')).length, 0);
  const recovered = await recoveryService.recordEvent({
    ...original, id: 'fresh-uuid-on-retry',
  }, new Date(), 'associate');
  assert.equal(recovered.inserted, false);
  assert.equal(recovered.deliveryQueued, true);
  assert.equal(portfolio.events.length, 1);
  const deliveries = await repository.listDeliveries('user-a');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.eventId, original.id);
  const repeated = await recoveryService.recordEvent({
    ...original, id: 'second-retry-id',
  }, new Date(), 'associate');
  assert.equal(repeated.inserted, false);
  assert.equal(repeated.deliveryQueued, false);
  assert.equal(portfolio.events.length, 1);
  assert.equal((await repository.listDeliveries('user-a')).length, 1);
});

test('late Telegram connection cannot retroactively enqueue an originally disconnected source event', async () => {
  const { service, repository } = fixture();
  const original = manualPortfolioEvent({
    id: 'late-telegram-bind', userId: 'user-a', symbol: 'AAPL',
    market: 'US', quantity: 1, price: 100,
    occurredAt: '2026-08-11T23:59:00.000Z',
  });
  assert.deepEqual(await service.recordEvent(original, new Date(), 'associate'),
    { inserted: true, deliveryQueued: false });
  await link(service, 'user-a', 'chat-a');
  const retry = await service.recordEvent({ ...original, id: 'different-event-uuid' }, new Date(), 'associate');
  assert.equal(retry.inserted, false);
  assert.equal(retry.deliveryQueued, false);
  assert.equal((await repository.listDeliveries('user-a')).length, 0);
  assert.equal((await repository.getExecutionEventBySource('user-a', original.sourceEventId))
    ?.metadata.telegramDeliveryIntendedAtInsert, false);
});


test('later preference enable never retroactively makes old canonical events deliverable', async () => {
  const { repository, service } = fixture();
  await link(service, 'user-a', 'chat-a');
  const preferences = await repository.getPreferences('user-a');
  await repository.savePreferences('user-a', { ...preferences, ORDER_FILLED: false }, new Date().toISOString());
  const event = {
    ...manualPortfolioEvent({
      id: 'opted-out-event', userId: 'user-a', symbol: 'BTC',
      market: 'CRYPTO_SPOT', quantity: 0.1, price: 100_000,
    }),
    type: 'ORDER_FILLED' as const,
    source: 'PAPER_EXECUTION' as const,
  };
  assert.equal((await service.recordEvent(event, new Date(), 'associate')).deliveryQueued, false);
  await repository.savePreferences('user-a', { ...preferences, ORDER_FILLED: true }, new Date().toISOString());
  const retried = await service.recordEvent({ ...event, id: 'retry-opted-out' }, new Date(), 'associate');
  assert.equal(retried.inserted, false);
  assert.equal(retried.deliveryQueued, false);
  assert.equal((await repository.listDeliveries('user-a')).length, 0);
});

test('source event replay detects historical incorrect AUTO_POLICY attribution instead of silently sending', async () => {
  const { repository, service } = fixture();
  await link(service, 'user-a', 'chat-a');
  const event = {
    ...manualPortfolioEvent({
      id: 'historical-manual-method', userId: 'user-a', symbol: 'BTC',
      market: 'CRYPTO_SPOT', quantity: 0.1, price: 100_000,
    }),
    type: 'ORDER_FILLED' as const,
    source: 'PAPER_EXECUTION' as const,
    executionMethod: 'USER_APPROVED' as const,
  };
  const first = await service.recordEvent(event, new Date(), 'associate');
  assert.equal(first.inserted, true);
  await assert.rejects(
    () => service.recordEvent({
      ...event, id: 'auto-origin-correction-needs-approval',
      executionMethod: 'AUTO_POLICY',
    }, new Date(), 'associate'),
    /EXECUTION_SOURCE_EVENT_LINEAGE_CONFLICT/,
  );
  assert.equal((await repository.listDeliveries('user-a')).length, 1);
});


test('relink after historical 403 does not replay DEAD_LETTER but permits a new personal delivery', async () => {
  const { service, repository, transport } = fixture();
  const first = new Date('2026-08-12T00:00:00.000Z');
  await link(service, 'user-a', 'chat-old', 'tg-user-a', first);
  transport.fail = true;
  transport.errorCode = 'TELEGRAM_HTTP_403';

  const prior = manualPortfolioEvent({
    id: 'forbidden-before-relink', userId: 'user-a',
    symbol: 'AAPL', market: 'US', quantity: 1, price: 220,
  });
  const queued = await service.recordEvent(prior, new Date('2026-08-12T00:01:00.000Z'), 'associate');
  assert.equal(queued.deliveryQueued, true);
  assert.equal(
    (await service.processDelivery('user-a', queued.deliveryId!, new Date('2026-08-12T00:02:00.000Z'))).state,
    'DEAD_LETTER',
  );
  assert.equal((await repository.getTelegramConnection('user-a'))?.status, 'REVOKED');

  const relinkedAt = new Date('2026-08-13T00:00:00.000Z');
  await link(service, 'user-a', 'chat-new', 'tg-user-a', relinkedAt);
  const recovered = await service.getState('user-a');
  assert.equal(recovered.telegram.connected, true);
  assert.equal(recovered.telegram.status, 'ACTIVE');
  assert.equal(recovered.telegram.recoveryRequired, false);
  assert.equal(recovered.telegram.recoveryErrorCode, null);
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.state, 'DEAD_LETTER');
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.attempts, 1);

  transport.fail = false;
  const next = manualPortfolioEvent({
    id: 'new-after-relink', userId: 'user-a',
    symbol: 'MSFT', market: 'US', quantity: 1, price: 450,
  });
  const pending = await service.recordEvent(next, new Date('2026-08-13T00:01:00.000Z'), 'associate');
  assert.equal(pending.deliveryQueued, true);
  assert.equal(
    (await service.processDelivery('user-a', pending.deliveryId!, new Date('2026-08-13T00:02:00.000Z'))).state,
    'SENT',
  );
  assert.equal((await repository.getDelivery('user-a', queued.deliveryId!))?.state, 'DEAD_LETTER');
  assert.equal((await repository.listDeliveries('user-a')).length, 2);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[1]?.chatId, 'chat-new');
});
