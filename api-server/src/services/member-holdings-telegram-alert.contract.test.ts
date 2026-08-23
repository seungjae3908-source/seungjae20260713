import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpUserTelegramTransport } from '../features/user-broker-telegram/user-broker-telegram.transport';
import {
  buildMemberHoldingTelegramDispatch,
  deliverMemberHoldingTelegramAlert,
} from './member-holdings-telegram-alert.service';
import { defaultTelegramAlertPolicy } from './telegram-alert-policy.service';
import {
  clearTelegramAlertState,
  sendTelegramAlert,
  type TelegramAlertInput,
} from './telegram-notification.service';

function okTelegramResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('public and member Telegram transports always request protected content', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  const payloads: Array<Record<string, unknown> | FormData> = [];
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'ci-protected-bot';
    process.env.TELEGRAM_CHAT_ID = 'default-ci-chat';
    clearTelegramAlertState();
    globalThis.fetch = async (_input, init) => {
      if (init?.body instanceof FormData) payloads.push(init.body);
      else payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okTelegramResponse();
    };

    assert.deepEqual(await sendTelegramAlert({
      type: 'strong_buy',
      symbol: '005930',
      destinationChatId: 'stock-room',
      dedupeKey: 'protected-text',
      duplicateWindowMs: 0,
      cooldownMs: 0,
    }), { ok: true, attempts: 1 });

    assert.deepEqual(await sendTelegramAlert({
      type: 'intelligence_report',
      symbol: 'AAPL',
      destinationChatId: 'stock-room',
      photo: { bytes: new Uint8Array([137, 80, 78, 71]), filename: 'evidence.png' },
      dedupeKey: 'protected-photo',
      duplicateWindowMs: 0,
      cooldownMs: 0,
    }), { ok: true, attempts: 1 });

    const directTransport = new HttpUserTelegramTransport('ci-member-bot');
    assert.deepEqual(await directTransport.send('member-chat', 'member-only'), { ok: true });

    const textPayload = payloads[0] as Record<string, unknown>;
    assert.equal(textPayload.chat_id, 'stock-room');
    assert.equal(textPayload.protect_content, true);

    const photoPayload = payloads[1] as FormData;
    assert.equal(photoPayload.get('chat_id'), 'stock-room');
    assert.equal(photoPayload.get('protect_content'), 'true');

    const memberPayload = payloads[2] as Record<string, unknown>;
    assert.equal(memberPayload.chat_id, 'member-chat');
    assert.equal(memberPayload.protect_content, true);
  } finally {
    globalThis.fetch = originalFetch;
    clearTelegramAlertState();
    if (originalToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
  }
});

test('member holdings messages separate stock and crypto without exposing user identity', () => {
  const stock = buildMemberHoldingTelegramDispatch({
    userId: 'user-a-secret-id',
    eventId: 'stock-event-1',
    assetClass: 'stock',
    market: 'KR',
    symbol: '005930',
    name: '삼성전자',
    occurredAt: '2026-08-23T03:30:00.000Z',
    currentPrice: 82000,
    averageEntryPrice: 78000,
    changePercent: 3.25,
    aiAnalysis: '검증된 입력 범위 안의 분석',
    tradePlan: {
      entryPrices: [81000, 80000, 79000],
      targetPrices: [84000, 86000, 88000],
      stopLoss: 77000,
    },
    news: [{
      kind: 'DISCLOSURE',
      title: '테스트 공시',
      source: 'DART',
      url: 'https://example.com/disclosure',
    }],
  });
  assert.equal(stock.event.market, 'KR');
  assert.equal(stock.event.userId, 'user-a-secret-id');
  assert.match(stock.alert.details ?? '', /📈 보유종목\(주식\)/u);
  assert.match(stock.alert.details ?? '', /1차 81,000/u);
  assert.match(stock.alert.details ?? '', /공시/u);
  assert.equal((stock.alert.details ?? '').includes('user-a-secret-id'), false);
  assert.equal(stock.alert.destinationChatId, undefined);

  const crypto = buildMemberHoldingTelegramDispatch({
    userId: 'user-b-secret-id',
    eventId: 'crypto-event-1',
    assetClass: 'coin_futures',
    market: 'BITGET_FUTURES',
    symbol: 'BTCUSDT',
    occurredAt: '2026-08-23T03:31:00.000Z',
    currentPrice: 65000,
    changePercent: -8.5,
    tradePlan: { targetPrices: [67000, 69000], stopLoss: 63000 },
  });
  assert.equal(crypto.event.market, 'CRYPTO_FUTURES');
  assert.equal(crypto.event.priority, 'CRITICAL');
  assert.match(crypto.alert.details ?? '', /₿ 보유종목\(코인\)/u);
  assert.match(crypto.alert.details ?? '', /AI 분석: N\/A/u);
  assert.equal((crypto.alert.details ?? '').includes('user-b-secret-id'), false);
});

test('member holdings delivery resolves only the linked member chat server-side', async () => {
  const delivered: TelegramAlertInput[] = [];
  const policy = {
    ...defaultTelegramAlertPolicy('user-a'),
    enabled: true,
    cooldownMs: 0,
    sameEventDedupeMs: 0,
    sameSymbolWindowMs: 0,
    sameSymbolRepeatLimit: 100,
  };
  const result = await deliverMemberHoldingTelegramAlert({
    userId: 'user-a',
    eventId: 'member-only-event-20260823',
    assetClass: 'stock',
    market: 'US',
    symbol: 'AAPL',
    occurredAt: '2026-08-23T03:32:00.000Z',
    currentPrice: 225,
    averageEntryPrice: 210,
    news: [{ kind: 'NEWS', title: '테스트 뉴스', source: 'provider' }],
  }, {
    connectionRepository: {
      getTelegramConnection: async (userId) => userId === 'user-a'
        ? {
            userId: 'user-a',
            telegramChatId: 'member-chat-a',
            telegramUserId: 'tg-a',
            status: 'ACTIVE',
            connectedAt: '2026-08-01T00:00:00.000Z',
            revokedAt: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
          }
        : null,
    },
    policyRepository: {
      getPolicy: async () => ({ policy, source: 'STORED' }),
    },
    sender: async (input) => {
      delivered.push(input);
      return { ok: true, attempts: 1 };
    },
  });

  assert.equal(result.status, 'POLICY');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].destinationChatId, 'member-chat-a');
  assert.notEqual(delivered[0].destinationChatId, 'member-chat-b');
  assert.equal((delivered[0].details ?? '').includes('user-a'), false);
});
