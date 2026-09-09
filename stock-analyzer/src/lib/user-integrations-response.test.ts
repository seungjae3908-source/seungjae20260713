import { describe, expect, it } from 'vitest';
import {
  INVALID_USER_INTEGRATIONS_RESPONSE,
  requireUserIntegrationsResponse,
} from './user-integrations-response';

const USER_ID = 'user-a';
const NOW = Date.parse('2026-09-10T00:00:00.000Z');

function canonical(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    brokerConnections: [],
    brokerConnectionsAvailable: true,
    brokerConnectionsErrorCode: null,
    brokerMetadataRead: true,
    telegram: {
      connected: false,
      status: 'DISCONNECTED',
      connectedAt: null,
    },
    preferences: {
      ORDER_SUBMITTED: true,
      ORDER_PARTIALLY_FILLED: true,
      ORDER_FILLED: true,
      ORDER_CANCELLED: true,
      ORDER_REJECTED: true,
      POSITION_OPENED: true,
      POSITION_INCREASED: true,
      POSITION_REDUCED: true,
      POSITION_CLOSED: true,
      TAKE_PROFIT_FILLED: true,
      STOP_FILLED: true,
      MANUAL_PORTFOLIO_ENTRY: true,
    },
    deliveries: [],
    telegramStorageAvailable: true,
    telegramStorageErrorCode: null,
    alertPolicy: {
      userId: USER_ID,
      enabled: true,
      markets: ['KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'],
      signalTypes: [
        'BUY', 'LONG', 'SHORT', 'NO_TRADE', 'PRICE_TARGET',
        'STRATEGY_HEALTH', 'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR',
      ],
      priorities: ['CRITICAL', 'IMPORTANT', 'INFO'],
      quietHours: {
        enabled: false,
        start: '22:00',
        end: '07:00',
        timeZone: 'Asia/Seoul',
        criticalBypass: true,
      },
      cooldownMs: 300_000,
      sameEventDedupeMs: 86_400_000,
      sameSymbolWindowMs: 3_600_000,
      sameSymbolRepeatLimit: 3,
      deliveryMode: 'IMMEDIATE',
      digest: { enabled: false, windowMs: 1_800_000 },
    },
    alertPolicySource: 'PERSISTED',
    alertPolicyStorageAvailable: true,
    alertPolicyStorageErrorCode: null,
    telegramRuntime: {
      deliveryReady: false,
      linkingReady: false,
      webhookConfigured: false,
      botUsernameConfigured: false,
      stockRoomReady: false,
      cryptoRoomReady: false,
      richSignalEnabled: false,
      aiExplanationEnabled: false,
      signalFollowupEnabled: false,
      memberHoldingsEnabled: false,
      orderAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
    },
    prioritySemantics: 'DELIVERY_URGENCY_ONLY',
    partial: false,
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
    ...overrides,
  };
}

function rejects(value: unknown, expectedUserId = USER_ID) {
  expect(() => requireUserIntegrationsResponse(value, expectedUserId, NOW))
    .toThrow(INVALID_USER_INTEGRATIONS_RESPONSE);
}

describe('requireUserIntegrationsResponse', () => {
  it('accepts the canonical fail-closed disconnected success contract', () => {
    const value = canonical();
    expect(requireUserIntegrationsResponse(value, USER_ID, NOW)).toBe(value);
  });

  it('rejects malformed HTTP 200 envelopes instead of normalizing them to safe-looking defaults', () => {
    rejects({});
    rejects({ ok: true });
    rejects({ ok: true, telegram: { connected: true } });
  });

  it('requires Telegram connection state and timestamp to agree', () => {
    rejects(canonical({
      telegram: { connected: true, status: 'DISCONNECTED', connectedAt: null },
    }));
    rejects(canonical({
      telegram: { connected: true, status: 'ACTIVE', connectedAt: null },
    }));
    rejects(canonical({
      telegram: { connected: true, status: 'ACTIVE', connectedAt: '2026-09-10T00:00:06.000Z' },
    }));
    expect(requireUserIntegrationsResponse(canonical({
      telegram: { connected: true, status: 'ACTIVE', connectedAt: '2026-09-10T00:00:00.000Z' },
    }), USER_ID, NOW)).toBeTruthy();
  });

  it('rejects cross-user alert-policy identity and malformed policy evidence', () => {
    rejects(canonical(), 'user-b');
    rejects(canonical({ alertPolicy: { userId: USER_ID, enabled: true } }));
  });

  it('locks zero trading authority and explicit runtime safety facts', () => {
    rejects(canonical({ privateApiRequests: 1 }));
    rejects(canonical({ ordersSubmitted: 1 }));
    rejects(canonical({
      telegramRuntime: {
        ...canonical().telegramRuntime as Record<string, unknown>,
        realOrderAllowed: true,
      },
    }));
  });

  it('rejects partial and availability contradictions', () => {
    rejects(canonical({ partial: true }));
    rejects(canonical({ telegramStorageAvailable: false, telegramStorageErrorCode: null, partial: true }));
    expect(requireUserIntegrationsResponse(canonical({
      telegramStorageAvailable: false,
      telegramStorageErrorCode: 'USER_BROKER_TELEGRAM_STORAGE_UNAVAILABLE',
      partial: true,
    }), USER_ID, NOW)).toBeTruthy();
  });
});
