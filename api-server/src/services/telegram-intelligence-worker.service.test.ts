import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryTelegramIntelligenceStateStore,
  TelegramIntelligenceWorker,
} from './telegram-intelligence-worker.service';
import type { TelegramAlertInput, TelegramAlertResult } from './telegram-notification.service';

const originalPersonalChatId = process.env.TELEGRAM_PERSONAL_CHAT_ID;

test.afterEach(() => {
  if (originalPersonalChatId == null) delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  else process.env.TELEGRAM_PERSONAL_CHAT_ID = originalPersonalChatId;
});

test('intelligence worker sends due KR close report exactly once without trading authority', async () => {
  delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  const store = new MemoryTelegramIntelligenceStateStore();
  const delivered: TelegramAlertInput[] = [];
  const deliver = async (input: TelegramAlertInput): Promise<TelegramAlertResult> => {
    delivered.push(input);
    return { ok: true, attempts: 1 };
  };
  const worker = new TelegramIntelligenceWorker(store, deliver, (destination) => (
    destination === 'STOCK_ROOM' ? 'stock-room' : destination === 'CRYPTO_ROOM' ? 'crypto-room' : null
  ));
  const now = new Date('2026-08-14T07:00:00.000Z');

  const first = await worker.runOnce(now);
  assert.equal(first.duePlans, 1);
  assert.equal(first.attempted, 2);
  assert.equal(first.delivered, 2);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.privateTradingApiCount, 0);
  assert.equal(first.liveTradingAuthority, false);
  assert.deepEqual(delivered.map((item) => item.type), ['intelligence_report', 'intelligence_report']);
  assert.equal(delivered.every((item) => item.details?.includes('한국장 마감 브리핑')), true);

  const second = await worker.runOnce(now);
  assert.equal(second.attempted, 0);
  assert.equal(second.delivered, 0);
  assert.equal(second.deduped, 2);
  assert.equal(delivered.length, 2);
});

test('same physical chat is collapsed even when stock and crypto audiences share it', async () => {
  delete process.env.TELEGRAM_PERSONAL_CHAT_ID;
  const store = new MemoryTelegramIntelligenceStateStore();
  let calls = 0;
  const worker = new TelegramIntelligenceWorker(
    store,
    async () => {
      calls += 1;
      return { ok: true, attempts: 1 };
    },
    () => 'owner-room',
  );

  const result = await worker.runOnce(new Date('2026-08-14T07:00:00.000Z'));
  assert.equal(result.duePlans, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 1);
  assert.equal(calls, 1);
});
