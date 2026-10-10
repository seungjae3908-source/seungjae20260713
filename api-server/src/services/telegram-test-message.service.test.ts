import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTelegramActivationApproved,
  sendPersonalTelegramTestMessage,
} from './telegram-test-message.service';

const activeConnection = {
  userId: 'member-1',
  telegramChatId: 'test-chat-id',
  telegramUserId: 'test-user-id',
  status: 'ACTIVE' as const,
  connectedAt: '2026-09-03T00:00:00.000Z',
  revokedAt: null,
  updatedAt: '2026-09-03T00:00:00.000Z',
};

test('Telegram activation is disabled by default and requires exact lowercase true', () => {
  assert.equal(isTelegramActivationApproved({}), false);
  assert.equal(isTelegramActivationApproved({ LIVE_TELEGRAM_ACTIVATION_APPROVED: 'false' }), false);
  assert.equal(isTelegramActivationApproved({ LIVE_TELEGRAM_ACTIVATION_APPROVED: 'TRUE' }), false);
  assert.equal(isTelegramActivationApproved({ LIVE_TELEGRAM_ACTIVATION_APPROVED: 'true' }), true);
});

test('personal Telegram test fails closed before storage or sender access without activation', async () => {
  let repositoryCalls = 0;
  let senderCalls = 0;

  const result = await sendPersonalTelegramTestMessage('member-1', {
    activationApproved: () => false,
    connectionRepository: {
      async getTelegramConnection() {
        repositoryCalls += 1;
        return activeConnection;
      },
      async revokeTelegramConnection() {
        repositoryCalls += 1;
      },
    },
    sender: async () => {
      senderCalls += 1;
      return { ok: true, attempts: 1 };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    httpStatus: 503,
    error: 'TELEGRAM_ACTIVATION_REQUIRED',
    attempts: 0,
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
  });
  assert.equal(repositoryCalls, 0);
  assert.equal(senderCalls, 0);
});

test('personal Telegram test uses only the injected sender after explicit activation', async () => {
  let repositoryCalls = 0;
  let senderCalls = 0;

  const result = await sendPersonalTelegramTestMessage('member-1', {
    activationApproved: () => true,
    connectionRepository: {
      async getTelegramConnection(userId) {
        repositoryCalls += 1;
        assert.equal(userId, 'member-1');
        return activeConnection;
      },
      async revokeTelegramConnection() {
        repositoryCalls += 1;
      },
    },
    sender: async (input) => {
      senderCalls += 1;
      assert.equal(input.destinationChatId, 'test-chat-id');
      assert.equal(input.type, 'intelligence_report');
      return { ok: true, attempts: 1 };
    },
    now: () => new Date('2026-09-03T01:02:03.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.attempts, 1);
  assert.equal(repositoryCalls, 1);
  assert.equal(senderCalls, 1);
});

test('personal Telegram test revokes a stale connection immediately on Telegram 403', async () => {
  let revokedAt: string | null = null;
  const result = await sendPersonalTelegramTestMessage('member-1', {
    activationApproved: () => true,
    connectionRepository: {
      async getTelegramConnection() {
        return activeConnection;
      },
      async revokeTelegramConnection(userId, timestamp) {
        assert.equal(userId, 'member-1');
        revokedAt = timestamp;
      },
    },
    sender: async () => ({
      ok: false,
      attempts: 1,
      skipped: 'DELIVERY_FAILED',
      errorCode: 'TELEGRAM_HTTP_403',
    }),
    now: () => new Date('2026-09-03T01:02:03.000Z'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'TELEGRAM_HTTP_403');
  assert.equal(revokedAt, '2026-09-03T01:02:03.000Z');
});
