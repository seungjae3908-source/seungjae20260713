import { expect, test } from '@playwright/test';

import {
  deliverTelegramAlertWithPolicy,
  evaluateTelegramAlertPolicy,
  type TelegramAlertPolicy,
  type TelegramPolicyDeliveryHistory,
  type TelegramPolicyEvent,
} from '../../api-server/src/services/telegram-alert-policy.service';

function policy(overrides: Partial<TelegramAlertPolicy> = {}): TelegramAlertPolicy {
  return {
    userId: 'user-a',
    enabled: true,
    markets: ['KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'],
    signalTypes: [
      'BUY', 'LONG', 'SHORT', 'NO_TRADE', 'STRATEGY_HEALTH',
      'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR',
    ],
    priorities: ['CRITICAL', 'IMPORTANT', 'INFO'],
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      timeZone: 'Asia/Seoul',
      criticalBypass: false,
    },
    cooldownMs: 60_000,
    sameEventDedupeMs: 5 * 60_000,
    sameSymbolWindowMs: 60 * 60_000,
    sameSymbolRepeatLimit: 3,
    deliveryMode: 'IMMEDIATE',
    digest: { enabled: false, windowMs: 15 * 60_000 },
    ...overrides,
  };
}

function event(overrides: Partial<TelegramPolicyEvent> = {}): TelegramPolicyEvent {
  return {
    userId: 'user-a',
    eventId: 'event-1',
    market: 'KR',
    signalType: 'BUY',
    priority: 'IMPORTANT',
    symbol: '005930',
    occurredAt: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

function history(overrides: Partial<TelegramPolicyDeliveryHistory> = {}): TelegramPolicyDeliveryHistory {
  return {
    userId: 'user-a',
    eventId: 'old-event',
    market: 'KR',
    signalType: 'BUY',
    priority: 'IMPORTANT',
    symbol: '005930',
    deliveredAt: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date('2026-08-22T08:10:00.000Z');

test('per-user Telegram policy filters owner, master switch, market, signal and priority independently', () => {
  expect(evaluateTelegramAlertPolicy(policy({ enabled: false }), event(), [], NOW).reason).toBe('DISABLED');
  expect(evaluateTelegramAlertPolicy(policy(), event({ userId: 'other-user' }), [], NOW).reason).toBe('OWNER_MISMATCH');
  expect(evaluateTelegramAlertPolicy(policy({ markets: ['US'] }), event(), [], NOW).reason).toBe('MARKET_FILTERED');
  expect(evaluateTelegramAlertPolicy(policy({ signalTypes: ['LONG'] }), event(), [], NOW).reason).toBe('SIGNAL_FILTERED');
  expect(evaluateTelegramAlertPolicy(policy({ priorities: ['CRITICAL'] }), event(), [], NOW).reason).toBe('PRIORITY_FILTERED');

  const allowed = evaluateTelegramAlertPolicy(policy(), event(), [], NOW);
  expect(allowed.action).toBe('IMMEDIATE');
  expect(allowed.prioritySemantics).toBe('DELIVERY_URGENCY_ONLY');
  expect(allowed.safety).toEqual({
    investmentDecisionChanged: false,
    strategyStateChanged: false,
    orderAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
  });
});

test('quiet hours use explicit IANA timezone and CRITICAL does not bypass unless explicitly allowed', () => {
  const quietPolicy = policy({
    quietHours: {
      enabled: true,
      start: '22:00',
      end: '07:00',
      timeZone: 'Asia/Seoul',
      criticalBypass: false,
    },
  });
  const duringQuiet = new Date('2026-08-22T14:30:00.000Z'); // 23:30 KST
  expect(evaluateTelegramAlertPolicy(quietPolicy, event(), [], duringQuiet).reason).toBe('QUIET_HOURS');
  expect(evaluateTelegramAlertPolicy(quietPolicy, event({ priority: 'CRITICAL' }), [], duringQuiet).reason).toBe('QUIET_HOURS');

  const bypass = policy({
    quietHours: { ...quietPolicy.quietHours, criticalBypass: true },
  });
  expect(evaluateTelegramAlertPolicy(bypass, event({ priority: 'CRITICAL' }), [], duringQuiet).action).toBe('IMMEDIATE');
});

test('same-event dedupe, subject cooldown and same-symbol repeat limit are separate gates', () => {
  const now = new Date('2026-08-22T08:10:00.000Z');

  const duplicate = evaluateTelegramAlertPolicy(
    policy({ cooldownMs: 0 }),
    event(),
    [history({ eventId: 'event-1', deliveredAt: '2026-08-22T08:09:00.000Z' })],
    now,
  );
  expect(duplicate.reason).toBe('SAME_EVENT_DUPLICATE');

  const cooldown = evaluateTelegramAlertPolicy(
    policy({ sameEventDedupeMs: 0, cooldownMs: 2 * 60_000 }),
    event(),
    [history({ eventId: 'different', deliveredAt: '2026-08-22T08:09:00.000Z' })],
    now,
  );
  expect(cooldown.reason).toBe('COOLDOWN');

  const repeated = evaluateTelegramAlertPolicy(
    policy({ sameEventDedupeMs: 0, cooldownMs: 0, sameSymbolRepeatLimit: 2 }),
    event(),
    [
      history({ eventId: 'old-1', signalType: 'LONG', market: 'CRYPTO_FUTURES', deliveredAt: '2026-08-22T07:30:00.000Z' }),
      history({ eventId: 'old-2', signalType: 'RESEARCH', market: undefined, deliveredAt: '2026-08-22T07:40:00.000Z' }),
    ],
    now,
  );
  expect(repeated.reason).toBe('SAME_SYMBOL_REPEAT_LIMIT');
});

test('batched mode returns a digest intent without contacting Telegram', async () => {
  let sends = 0;
  const batchedPolicy = policy({
    deliveryMode: 'BATCHED',
    digest: { enabled: true, windowMs: 30 * 60_000 },
  });
  const result = await deliverTelegramAlertWithPolicy({
    policy: batchedPolicy,
    event: event({ signalType: 'RESEARCH', market: undefined }),
    alert: { type: 'intelligence_report', symbol: '005930' },
    now: NOW,
    sender: async () => {
      sends += 1;
      return { ok: true, attempts: 1 };
    },
  });
  expect(result.decision.action).toBe('BATCHED');
  expect(result.decision.digestWindowMs).toBe(30 * 60_000);
  expect(result.transport).toBeNull();
  expect(sends).toBe(0);
});

test('Telegram transport failure is fail-open for investment state and has no order authority', async () => {
  const result = await deliverTelegramAlertWithPolicy({
    policy: policy(),
    event: event(),
    alert: { type: 'strong_buy', symbol: '005930', market: 'KR' },
    now: NOW,
    sender: async () => {
      throw new Error('telegram unavailable');
    },
  });

  expect(result.decision.action).toBe('IMMEDIATE');
  expect(result.transport).toEqual({
    ok: false,
    attempts: 0,
    skipped: 'DELIVERY_FAILED',
  });
  expect(result.safety.investmentDecisionChanged).toBe(false);
  expect(result.safety.strategyStateChanged).toBe(false);
  expect(result.safety.orderAuthority).toBe('NONE');
  expect(result.safety.privateTradingApiAllowed).toBe(false);
  expect(result.safety.realOrderAllowed).toBe(false);
});

test('invalid timezone or invalid batched digest fails closed instead of guessing', () => {
  expect(evaluateTelegramAlertPolicy(
    policy({ quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Not/AZone', criticalBypass: false } }),
    event(),
    [],
    NOW,
  ).reason).toBe('INVALID_POLICY');

  expect(evaluateTelegramAlertPolicy(
    policy({ deliveryMode: 'BATCHED', digest: { enabled: false, windowMs: 0 } }),
    event(),
    [],
    NOW,
  ).reason).toBe('INVALID_POLICY');
});
