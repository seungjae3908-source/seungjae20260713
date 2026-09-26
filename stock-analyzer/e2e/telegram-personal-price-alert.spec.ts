import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import {
  applyTelegramAlertPolicyPatch,
  defaultTelegramAlertPolicy,
} from '../../api-server/src/services/telegram-alert-policy.service';
import { deliverPersonalTelegramAlert } from '../../api-server/src/services/personal-telegram-alert.service';

function repositoryRoot() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? path.resolve(process.cwd(), '..')
    : process.cwd();
}

function activeConnection(userId = 'user-a') {
  return {
    userId,
    telegramChatId: 'chat-user-a',
    telegramUserId: 'telegram-user-a',
    status: 'ACTIVE' as const,
    connectedAt: '2026-08-22T00:00:00.000Z',
    revokedAt: null,
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

function priceEvent(userId = 'user-a') {
  return {
    userId,
    eventId: 'price-alert:alert-1:above:70000',
    market: 'KR' as const,
    signalType: 'PRICE_TARGET' as const,
    priority: 'IMPORTANT' as const,
    symbol: '005930',
    occurredAt: '2026-08-22T08:00:00.000Z',
  };
}

const priceAlert = {
  type: 'price_alert' as const,
  symbol: '005930',
  market: 'KR',
  currentPrice: 71_000,
  targetPrice: 70_000,
  dedupeKey: 'price-alert:alert-1:above:70000',
};

const NOW = new Date('2026-08-22T08:00:00.000Z');

test('personal price alert is fail-closed OFF until the user explicitly enables policy', async () => {
  let sends = 0;
  const result = await deliverPersonalTelegramAlert({
    userId: 'user-a',
    event: priceEvent(),
    alert: priceAlert,
    now: NOW,
  }, {
    connectionRepository: {
      async getTelegramConnection() { return activeConnection(); },
    },
    policyRepository: {
      async getPolicy() {
        return { policy: defaultTelegramAlertPolicy('user-a'), source: 'DEFAULT_MISSING' as const };
      },
    },
    sender: async () => {
      sends += 1;
      return { ok: true, attempts: 1 };
    },
  });

  expect(result.status).toBe('POLICY');
  if (result.status === 'POLICY') expect(result.policy.decision.reason).toBe('DISABLED');
  expect(sends).toBe(0);
});

test('enabled personal price alert sends only to the linked user Telegram chat', async () => {
  const destinations: Array<string | undefined> = [];
  const policy = applyTelegramAlertPolicyPatch(defaultTelegramAlertPolicy('user-a'), {
    enabled: true,
    markets: ['KR'],
    signalTypes: ['PRICE_TARGET'],
    priorities: ['IMPORTANT'],
    cooldownMs: 0,
    sameEventDedupeMs: 0,
    sameSymbolWindowMs: 0,
    sameSymbolRepeatLimit: 0,
  });

  const result = await deliverPersonalTelegramAlert({
    userId: 'user-a',
    event: priceEvent(),
    alert: priceAlert,
    now: NOW,
  }, {
    connectionRepository: {
      async getTelegramConnection() { return activeConnection(); },
    },
    policyRepository: {
      async getPolicy() { return { policy, source: 'STORED' as const }; },
    },
    sender: async (input) => {
      destinations.push(input.destinationChatId);
      return { ok: true, attempts: 1 };
    },
  });

  expect(result.status).toBe('POLICY');
  if (result.status === 'POLICY') expect(result.policy.transport?.ok).toBe(true);
  expect(destinations).toEqual(['chat-user-a']);
});

test('owner mismatch, disconnected Telegram, or storage failure never reaches transport', async () => {
  let sends = 0;
  const sender = async () => {
    sends += 1;
    return { ok: true as const, attempts: 1 };
  };

  const ownerMismatch = await deliverPersonalTelegramAlert({
    userId: 'user-a',
    event: priceEvent('user-b'),
    alert: priceAlert,
    now: NOW,
  }, { sender });
  expect(ownerMismatch).toEqual({ status: 'SKIPPED', reason: 'INVALID_USER', policy: null });

  const disconnected = await deliverPersonalTelegramAlert({
    userId: 'user-a',
    event: priceEvent(),
    alert: priceAlert,
    now: NOW,
  }, {
    connectionRepository: { async getTelegramConnection() { return null; } },
    policyRepository: {
      async getPolicy() { return { policy: defaultTelegramAlertPolicy('user-a'), source: 'DEFAULT_MISSING' as const }; },
    },
    sender,
  });
  expect(disconnected).toEqual({ status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null });

  const storageFailure = await deliverPersonalTelegramAlert({
    userId: 'user-a',
    event: priceEvent(),
    alert: priceAlert,
    now: NOW,
  }, {
    connectionRepository: { async getTelegramConnection() { throw new Error('storage unavailable'); } },
    policyRepository: {
      async getPolicy() { return { policy: defaultTelegramAlertPolicy('user-a'), source: 'DEFAULT_MISSING' as const }; },
    },
    sender,
  });
  expect(storageFailure).toEqual({ status: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE', policy: null });
  expect(sends).toBe(0);
});

test('price monitor cannot bypass the personal Telegram policy gateway or fall back to default public chat', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot(), 'api-server/src/services/notification.service.ts'),
    'utf8',
  );
  expect(source).toContain("import { deliverPersonalTelegramAlert } from './personal-telegram-alert.service'");
  expect(source).toContain('await deliverPersonalPriceTargetTelegram(alert, currentPrice, target, now)');
  expect(source).not.toContain("import { sendTelegramAlert } from './telegram-notification.service'");
  expect(source).not.toContain('void sendTelegramAlert({');
});
