import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMBER_INVESTMENT_SAFETY,
  defaultAutomationPolicy,
  type AccountSnapshot,
  type AutomationPolicy,
  type BrokerExchangeConnection,
  type OrderIntent,
  type RiskMetrics,
} from './member-investment.contract';
import { InMemoryCredentialVaultRepository, MemberCredentialVault } from './member-credential-vault.service';
import { evaluateMemberInvestmentRisk } from './member-investment-risk-gate.service';
import { PreviewOnlyExecutionProviderAdapter } from './member-investment.provider';
import { InMemoryMemberInvestmentRepository } from './member-investment.repository';
import { MemberInvestmentService } from './member-investment.service';
import { MemberInvestmentTelegramService } from './member-investment-telegram.service';

const NOW = new Date('2026-08-27T00:00:00.000Z');
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const CONNECTION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const POLICY_ID = 'bbbbbbbb-1111-4111-8111-111111111111';

function connection(overrides: Partial<BrokerExchangeConnection> = {}): BrokerExchangeConnection {
  return {
    id: CONNECTION_ID, userId: USER_A, provider: 'bitget', providerType: 'CRYPTO_EXCHANGE', accountScope: 'test-fixture',
    connectionStatus: 'CONNECTED', permissions: ['read'], readOnlyCapable: true, tradeCapable: false,
    credentialReference: 'opaque-reference', credentialVersion: 1, lastVerifiedAt: NOW.toISOString(), lastSyncAt: NOW.toISOString(),
    lastErrorCode: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides,
  };
}

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id: 'snapshot-a', userId: USER_A, connectionId: CONNECTION_ID, provider: 'bitget', accountType: 'futures', currency: 'USDT',
    totalEquity: 10_000, cashBalance: 8_000, availableBalance: 7_000, unrealizedPnl: 10, realizedPnl: 0,
    dailyLoss: 0, drawdown: 0, dataAsOf: NOW.toISOString(), collectedAt: NOW.toISOString(), freshnessStatus: 'FRESH',
    providerStatus: 'HEALTHY', provenance: 'fixture:no-network', snapshotVersion: 1, ...overrides,
  };
}

function policy(overrides: Partial<AutomationPolicy> = {}): AutomationPolicy {
  return {
    ...defaultAutomationPolicy({ id: POLICY_ID, userId: USER_A, connectionId: CONNECTION_ID, market: 'CRYPTO_FUTURES', strategyId: 'trend', strategyVersion: 'v1', now: NOW }),
    enabled: true, executionMode: 'PREVIEW', allowedSymbols: ['BTCUSDT'], maxPositionValue: 1_000, maxPositionPct: 20,
    maxDailyLoss: 500, maxDrawdown: 20, maxOrdersPerDay: 10, maxConcurrentPositions: 3, cooldownSeconds: 30,
    leverageMin: 1, leverageMax: 5, minLiquidationBufferPct: 15, killSwitch: false, ...overrides,
  };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: 'intent-a', userId: USER_A, connectionId: CONNECTION_ID, sourceSignalId: 'signal-a', sourceSignalGeneratedAt: NOW.toISOString(),
    strategyId: 'trend', market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', side: 'LONG', positionSide: 'LONG', orderType: 'LIMIT',
    requestedQuantity: 0.01, requestedPrice: 50_000, stopLoss: 49_000, takeProfit: 52_000, leverage: 2,
    status: 'CREATED', riskDecision: 'PENDING', riskReasons: [], idempotencyKey: 'key-a', createdAt: NOW.toISOString(),
    expiresAt: '2026-08-27T00:01:00.000Z', ...overrides,
  };
}

function metrics(overrides: Partial<RiskMetrics> = {}): RiskMetrics {
  return {
    dailyLoss: 0, drawdown: 0, ordersToday: 0, concurrentPositions: 0, currentPositionValue: 0,
    lastIntentAt: null, duplicateIntent: false, liquidationDistancePct: 40, ...overrides,
  };
}

test('credential vault returns only an opaque reference and keeps plaintext out of stored/application output', async () => {
  const previous = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
  try {
    const repository = new InMemoryCredentialVaultRepository();
    const vault = new MemberCredentialVault(repository, () => NOW);
    const secret = 'NEVER_RETURN_THIS_SECRET';
    const result = await vault.store(USER_A, 'bitget', { apiKey: 'TEST_KEY', secret });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.credentialsReturned, false);
    assert.deepEqual(await vault.resolveForServer(USER_A, result.credentialReference, 1), { apiKey: 'TEST_KEY', secret });
    await assert.rejects(() => vault.resolveForServer(USER_B, result.credentialReference, 1), /CREDENTIAL_REFERENCE_UNAVAILABLE/);
    await vault.revoke(USER_A, result.credentialReference);
    await assert.rejects(() => vault.resolveForServer(USER_A, result.credentialReference, 1), /CREDENTIAL_REFERENCE_UNAVAILABLE/);
  } finally {
    if (previous == null) delete process.env.TRADING_CREDENTIAL_MASTER_KEY; else process.env.TRADING_CREDENTIAL_MASTER_KEY = previous;
  }
});

test('execution gateway supports preview only and hard-disables every real mutation', async () => {
  const gateway = new PreviewOnlyExecutionProviderAdapter(() => NOW);
  const preview = await gateway.previewOrder(intent(), 'bitget');
  assert.equal(preview.status, 'PREVIEW_ONLY');
  assert.deepEqual(preview.safety, MEMBER_INVESTMENT_SAFETY);
  await assert.rejects(() => gateway.placeOrder(intent()), /REAL_ORDER_EXECUTION_DISABLED/);
  await assert.rejects(() => gateway.cancelOrder('order-a'), /REAL_ORDER_EXECUTION_DISABLED/);
  await assert.rejects(() => gateway.amendOrder('order-a'), /REAL_ORDER_EXECUTION_DISABLED/);
  await assert.rejects(() => gateway.transfer('USDT', 1), /REAL_ORDER_EXECUTION_DISABLED/);
  await assert.rejects(() => gateway.withdraw('USDT', 1), /REAL_ORDER_EXECUTION_DISABLED/);
});

test('unavailable and partial account evidence remains explicit and never becomes fabricated zero data', async () => {
  const repository = new InMemoryMemberInvestmentRepository();
  repository.seed({
    connections: [connection({ connectionStatus: 'DEGRADED' })],
    snapshots: [snapshot({ totalEquity: null, cashBalance: null, availableBalance: null, freshnessStatus: 'UNAVAILABLE', providerStatus: 'UNAVAILABLE' })],
    futuresPositions: [{
      id: 'partial-short', userId: USER_A, connectionId: CONNECTION_ID, exchange: 'bitget', symbol: 'ETHUSDT', side: 'SHORT',
      marginMode: 'ISOLATED', leverage: null, quantity: null, entryPrice: null, markPrice: null, liquidationPrice: null,
      liquidationDistancePct: null, unrealizedPnl: null, maintenanceMargin: null, dataAsOf: NOW.toISOString(), collectedAt: NOW.toISOString(),
      freshnessStatus: 'PARTIAL', provenance: 'fixture:no-network',
    }],
  });
  const overview = await repository.getOverview(USER_A);
  assert.equal(overview.snapshots[0].freshnessStatus, 'UNAVAILABLE');
  assert.equal(overview.snapshots[0].totalEquity, null);
  assert.equal(overview.futuresPositions[0].freshnessStatus, 'PARTIAL');
  assert.equal(overview.futuresPositions[0].quantity, null);
});

test('risk gate accepts separate futures LONG/SHORT previews and rejects short directions for stocks and spot', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    const result = evaluateMemberInvestmentRisk({ authenticatedUserId: USER_A, intent: intent({ side, positionSide: side }), connection: connection(), snapshot: snapshot(), policy: policy(), metrics: metrics(), now: NOW });
    assert.equal(result.allowed, true, side);
    assert.equal(result.decision, 'PREVIEW_ONLY');
  }
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT'] as const) {
    const result = evaluateMemberInvestmentRisk({
      authenticatedUserId: USER_A, intent: intent({ market, side: 'SHORT', positionSide: 'SHORT', leverage: null }),
      connection: connection(), snapshot: snapshot(), policy: policy({ market }), metrics: metrics(), now: NOW,
    });
    assert.equal(result.allowed, false, market);
    assert.ok(result.reasons.includes('MARKET_DIRECTION_NOT_ALLOWED'));
  }
});

test('risk gate is exhaustive and fail-closed for stale data, kill switch, losses, cooldown, duplicates and invalid price', () => {
  const result = evaluateMemberInvestmentRisk({
    authenticatedUserId: USER_A, intent: intent({ requestedPrice: Number.NaN }), connection: connection(),
    snapshot: snapshot({ freshnessStatus: 'STALE', providerStatus: 'DEGRADED', dataAsOf: '2026-08-26T00:00:00.000Z' }),
    policy: policy({ killSwitch: true }),
    metrics: metrics({ dailyLoss: 500, drawdown: 20, ordersToday: 10, concurrentPositions: 3, lastIntentAt: NOW.toISOString(), duplicateIntent: true, liquidationDistancePct: 1 }), now: NOW,
  });
  assert.equal(result.allowed, false);
  for (const reason of ['ACCOUNT_DATA_STALE', 'PROVIDER_DEGRADED', 'KILL_SWITCH_ACTIVE', 'PRICE_INVALID', 'DAILY_LOSS_LIMIT_EXCEEDED', 'COOLDOWN_ACTIVE', 'DUPLICATE_ORDER_INTENT', 'LIQUIDATION_BUFFER_INSUFFICIENT']) {
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test('automation modes SHADOW/PAPER/PREVIEW persist while LIVE is rejected server-side', async () => {
  const repository = new InMemoryMemberInvestmentRepository();
  repository.seed({ connections: [connection()] });
  const service = new MemberInvestmentService(repository, new PreviewOnlyExecutionProviderAdapter(() => NOW), { notifyIntent: async () => undefined as never }, () => NOW);
  for (const executionMode of ['SHADOW', 'PAPER', 'PREVIEW'] as const) {
    const saved = await service.savePolicy(USER_A, { ...policy({ id: `policy-${executionMode}` }), executionMode });
    assert.equal(saved.policy.executionMode, executionMode);
  }
  await assert.rejects(() => service.savePolicy(USER_A, { ...policy({ id: 'policy-live' }), executionMode: 'LIVE' }), /LIVE_ACTIVATION_NOT_APPROVED/);
});

test('valid intent reaches PREVIEW_READY exactly once and Telegram payload has navigation only', async () => {
  const repository = new InMemoryMemberInvestmentRepository();
  repository.seed({ connections: [connection()], snapshots: [snapshot()], policies: [policy()] });
  repository.seedRiskMetrics(USER_A, CONNECTION_ID, 'BTCUSDT', metrics());
  const dispatched: Array<{ userId: string; event: unknown; alert: Record<string, unknown> }> = [];
  const telegram = new MemberInvestmentTelegramService(async (input) => {
    dispatched.push(input as unknown as typeof dispatched[number]);
    return { status: 'SKIPPED', reason: 'TELEGRAM_DISCONNECTED', policy: null };
  }, 'https://example.test');
  const service = new MemberInvestmentService(repository, new PreviewOnlyExecutionProviderAdapter(() => NOW), telegram, () => NOW);
  const request = {
    connectionId: CONNECTION_ID, policyId: POLICY_ID, sourceSignalId: 'signal-a', sourceSignalGeneratedAt: NOW.toISOString(),
    strategyId: 'trend', market: 'CRYPTO_FUTURES' as const, symbol: 'btcusdt', side: 'LONG' as const, positionSide: 'LONG' as const,
    orderType: 'LIMIT' as const, requestedQuantity: 0.01, requestedPrice: 50_000, stopLoss: 49_000, takeProfit: 52_000,
    leverage: 2, expiresAt: '2026-08-27T00:01:00.000Z', idempotencyKey: 'unique-key',
  };
  const first = await service.createIntentPreview(USER_A, request);
  assert.equal(first.intent.status, 'PREVIEW_READY');
  assert.equal(first.preview?.status, 'PREVIEW_ONLY');
  assert.equal(repository.previews.length, 1);
  assert.equal(dispatched.length, 1);
  const telegramPayload = JSON.stringify(dispatched[0]);
  assert.doesNotMatch(telegramPayload, /chat.?id|credential|secret|api.?key/i);
  assert.doesNotMatch(telegramPayload, /callback_data|buy_now|sell_now/i);
  assert.match(telegramPayload, /상세보기/);
  const duplicate = await service.createIntentPreview(USER_A, request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(repository.previews.length, 1);
});
