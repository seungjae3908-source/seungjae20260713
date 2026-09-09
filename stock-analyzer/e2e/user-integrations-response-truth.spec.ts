import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INVALID_USER_INTEGRATIONS_RESPONSE,
  requireUserIntegrationsResponse,
} from '../src/lib/user-integrations-response';

const USER_ID = 'user-a';
const NOW = Date.parse('2026-09-10T00:00:00.000Z');

const lifecyclePath = fileURLToPath(new URL('../src/lib/user-integrations-request-lifecycle.ts', import.meta.url));
const responsePath = fileURLToPath(new URL('../src/lib/user-integrations-response.ts', import.meta.url));
const panelPath = fileURLToPath(new URL('../src/components/user-broker-telegram-panel.tsx', import.meta.url));
const backendPath = fileURLToPath(new URL('../../api-server/src/routes/user-broker-telegram.ts', import.meta.url));

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
    alertPolicySource: 'STORED',
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

test('user integrations validates canonical HTTP 200 truth before the UI can normalize safe-looking defaults', async () => {
  const [lifecycle, response, panel, backend] = await Promise.all([
    readFile(lifecyclePath, 'utf8'),
    readFile(responsePath, 'utf8'),
    readFile(panelPath, 'utf8'),
    readFile(backendPath, 'utf8'),
  ]);

  expect(panel).toContain("setState(normalizeIntegrationState(result.value));");
  expect(panel).toContain("{state.telegram.connected ? '연결됨' : '연결 안 됨'}");

  expect(lifecycle).toContain("import { requireUserIntegrationsResponse } from '@/lib/user-integrations-response';");
  const validationIndex = lifecycle.indexOf('.then((value) => this.validate ? this.validate(value, identity) : value);');
  const transportSuccessIndex = lifecycle.indexOf(
    "(value): UserIntegrationsTerminal<T> => ({ status: 'success', identity, requestKey, generation, value })",
    validationIndex,
  );
  expect(validationIndex).toBeGreaterThanOrEqual(0);
  expect(transportSuccessIndex).toBeGreaterThan(validationIndex);
  expect(lifecycle).toContain('(value, identity) => requireUserIntegrationsResponse(value, identity),');

  expect(response).toContain("root.ok !== true");
  expect(response).toContain("telegram.status !== 'ACTIVE' || telegram.connectedAt === null");
  expect(response).toContain("policy.userId !== expectedUserId");
  expect(response).toContain("root.privateApiRequests !== 0");
  expect(response).toContain('const expectedLinkingReady = runtime.deliveryReady === true');
  expect(response).toContain('runtime.linkingReady !== expectedLinkingReady');
  expect(response).toContain("runtime.orderAuthority !== 'NONE'");
  expect(response).toContain('root.partial !== expectedPartial');

  expect(backend).toContain('ok: true,');
  expect(backend).toContain('telegramRuntime: telegramRuntimeState(),');
  expect(backend).toContain('linkingReady: deliveryReady && webhookConfigured && botUsernameConfigured,');
  expect(backend).toContain("prioritySemantics: 'DELIVERY_URGENCY_ONLY'");
  expect(backend).toContain('privateApiRequests: 0,');
  expect(backend).toContain('ordersSubmitted: 0,');
  expect(backend).toContain('ordersCancelled: 0,');
});

test('accepts only the canonical fail-closed disconnected success contract', () => {
  const value = canonical();
  expect(requireUserIntegrationsResponse(value, USER_ID, NOW)).toBe(value);

  rejects({});
  rejects({ ok: true });
  rejects({ ok: true, telegram: { connected: true } });
});

test('requires Telegram connection state and timestamp to agree', () => {
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

test('rejects cross-user alert-policy identity and malformed policy evidence', () => {
  rejects(canonical(), 'user-b');
  rejects(canonical({ alertPolicy: { userId: USER_ID, enabled: true } }));
  rejects(canonical({ alertPolicySource: 'PERSISTED' }));
  rejects(canonical({
    alertPolicy: {
      ...(canonical().alertPolicy as Record<string, unknown>),
      quietHours: { enabled: true, start: '24:00', end: '07:00', timeZone: 'Asia/Seoul', criticalBypass: true },
    },
  }));
});

test('binds canonical broker evidence to the authenticated user', () => {
  const connection = {
    userId: USER_ID,
    exchange: 'upbit',
    accountMode: 'paper',
    configured: true,
    lastVerifiedAt: null,
    lastErrorCode: null,
    updatedAt: '2026-09-10T00:00:00.000Z',
    credentialsExposed: false,
  };
  expect(requireUserIntegrationsResponse(canonical({ brokerConnections: [connection] }), USER_ID, NOW))
    .toBeTruthy();
  rejects(canonical({ brokerConnections: [{ ...connection, userId: 'user-b' }] }));
});

test('locks zero trading authority and explicit runtime safety facts', () => {
  rejects(canonical({ privateApiRequests: 1 }));
  rejects(canonical({ ordersSubmitted: 1 }));
  rejects(canonical({
    telegramRuntime: {
      ...(canonical().telegramRuntime as Record<string, unknown>),
      realOrderAllowed: true,
    },
  }));
});

test('requires linking readiness to match its canonical prerequisites', () => {
  rejects(canonical({
    telegramRuntime: {
      ...(canonical().telegramRuntime as Record<string, unknown>),
      linkingReady: true,
    },
  }));
  expect(requireUserIntegrationsResponse(canonical({
    telegramRuntime: {
      ...(canonical().telegramRuntime as Record<string, unknown>),
      deliveryReady: true,
      webhookConfigured: true,
      botUsernameConfigured: true,
      linkingReady: true,
    },
  }), USER_ID, NOW)).toBeTruthy();
});

test('rejects partial and availability contradictions', () => {
  rejects(canonical({ partial: true }));
  rejects(canonical({ telegramStorageAvailable: false, telegramStorageErrorCode: null, partial: true }));
  expect(requireUserIntegrationsResponse(canonical({
    telegramStorageAvailable: false,
    telegramStorageErrorCode: 'USER_BROKER_TELEGRAM_STORAGE_UNAVAILABLE',
    partial: true,
  }), USER_ID, NOW)).toBeTruthy();
});

test('rejects policy values outside the producer validity bounds', () => {
  rejects(canonical({
    alertPolicy: {
      ...(canonical().alertPolicy as Record<string, unknown>),
      sameSymbolRepeatLimit: 101,
    },
  }));
  rejects(canonical({
    alertPolicy: {
      ...(canonical().alertPolicy as Record<string, unknown>),
      deliveryMode: 'BATCHED',
    },
  }));
});
