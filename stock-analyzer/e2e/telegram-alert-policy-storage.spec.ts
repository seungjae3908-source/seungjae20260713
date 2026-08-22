import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import {
  TELEGRAM_ALERT_POLICY_MARKER,
  enabledTypesWithTelegramAlertPolicy,
  telegramAlertPolicyFromEnabledTypes,
} from '../../api-server/src/features/user-broker-telegram/telegram-alert-policy.repository';
import {
  applyTelegramAlertPolicyPatch,
  defaultTelegramAlertPolicy,
} from '../../api-server/src/services/telegram-alert-policy.service';

function repositoryRoot() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? path.resolve(process.cwd(), '..')
    : process.cwd();
}

test('Telegram alert policy round-trips inside enabled_types without deleting execution preferences', () => {
  const existing = [
    'legacy-user-setting',
    'telegram_preferences_v1',
    'ORDER_FILLED',
  ];
  const policy = applyTelegramAlertPolicyPatch(defaultTelegramAlertPolicy('user-a'), {
    enabled: true,
    markets: ['KR', 'CRYPTO_FUTURES'],
    signalTypes: ['BUY', 'LONG', 'SHORT', 'NO_TRADE', 'STRATEGY_HEALTH'],
    priorities: ['CRITICAL', 'IMPORTANT'],
    quietHours: {
      enabled: true,
      start: '23:00',
      end: '06:30',
      timeZone: 'Asia/Seoul',
      criticalBypass: true,
    },
    cooldownMs: 120_000,
    sameEventDedupeMs: 3_600_000,
    sameSymbolWindowMs: 1_800_000,
    sameSymbolRepeatLimit: 2,
  });

  const stored = enabledTypesWithTelegramAlertPolicy(existing, policy);
  expect(stored).toContain('legacy-user-setting');
  expect(stored).toContain('telegram_preferences_v1');
  expect(stored).toContain('ORDER_FILLED');
  expect(stored.filter((item) => item.startsWith(TELEGRAM_ALERT_POLICY_MARKER))).toHaveLength(1);

  const restored = telegramAlertPolicyFromEnabledTypes('user-a', stored);
  expect(restored.source).toBe('STORED');
  expect(restored.policy.userId).toBe('user-a');
  expect(restored.policy.enabled).toBe(true);
  expect(restored.policy.markets).toEqual(['KR', 'CRYPTO_FUTURES']);
  expect(restored.policy.priorities).toEqual(['CRITICAL', 'IMPORTANT']);
  expect(restored.policy.quietHours).toEqual({
    enabled: true,
    start: '23:00',
    end: '06:30',
    timeZone: 'Asia/Seoul',
    criticalBypass: true,
  });
});

test('missing, malformed, or duplicate stored policy fails closed to master OFF', () => {
  const missing = telegramAlertPolicyFromEnabledTypes('user-a', ['ORDER_FILLED']);
  expect(missing.source).toBe('DEFAULT_MISSING');
  expect(missing.policy.enabled).toBe(false);

  const malformed = telegramAlertPolicyFromEnabledTypes('user-a', [
    `${TELEGRAM_ALERT_POLICY_MARKER}not-valid-base64-json`,
  ]);
  expect(malformed.source).toBe('DEFAULT_INVALID');
  expect(malformed.policy.enabled).toBe(false);

  const validMarker = enabledTypesWithTelegramAlertPolicy(
    [],
    applyTelegramAlertPolicyPatch(defaultTelegramAlertPolicy('user-a'), { enabled: true }),
  ).find((item) => item.startsWith(TELEGRAM_ALERT_POLICY_MARKER));
  expect(validMarker).toBeTruthy();
  const duplicated = telegramAlertPolicyFromEnabledTypes('user-a', [validMarker!, validMarker!]);
  expect(duplicated.source).toBe('DEFAULT_INVALID');
  expect(duplicated.policy.enabled).toBe(false);
});

test('policy persistence never stores user identity inside the encoded policy payload', () => {
  const stored = enabledTypesWithTelegramAlertPolicy(
    [],
    applyTelegramAlertPolicyPatch(defaultTelegramAlertPolicy('sensitive-user-id'), { enabled: true }),
  );
  const marker = stored.find((item) => item.startsWith(TELEGRAM_ALERT_POLICY_MARKER));
  expect(marker).toBeTruthy();
  const decoded = Buffer.from(marker!.slice(TELEGRAM_ALERT_POLICY_MARKER.length), 'base64url').toString('utf8');
  expect(decoded).not.toContain('sensitive-user-id');
  expect(decoded).not.toContain('userId');
});

test('user integrations route exposes read/write policy APIs with zero trading authority', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot(), 'api-server/src/routes/user-broker-telegram.ts'),
    'utf8',
  );

  expect(source).toContain("userBrokerTelegramRouter.get('/telegram-policy'");
  expect(source).toContain("userBrokerTelegramRouter.patch('/telegram-policy'");
  expect(source).toContain("prioritySemantics: 'DELIVERY_URGENCY_ONLY'");
  expect(source).toContain('privateApiRequests: 0');
  expect(source).toContain('ordersSubmitted: 0');
  expect(source).toContain('ordersCancelled: 0');
  expect(source).toContain("code === 'TELEGRAM_ALERT_POLICY_INVALID' ? 400 : 503");
  expect(source).not.toContain('sendTelegramAlert(');
});
