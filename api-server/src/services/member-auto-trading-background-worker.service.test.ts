import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { DEFAULT_TRADING_POLICY, type ExchangeConnection, type TradingPlan, type TradingPolicy } from './trade-automation.types';
import type { CanonicalAccountSnapshot } from '../features/account-readonly/account-readonly.contract';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import type { PaperJournalRepository } from './paper-journal.types';
import {
  MemberAutoTradingBackgroundWorker,
  liveBackgroundEnabled,
  marketMapping,
  resolveMemberStockBroker,
  readMemberAutoTradingBackgroundRuntimeHealth,
  startMemberAutoTradingBackgroundWorker,
  selectRotatingHandoffEntries,
  formulaAiReviewReasonsForLive,
  assertCanonicalLiveProviderPositions,
  memberTelegramProofMatchesCurrentBinding,
  liveAllFourConnectionVerificationReady,
  type MemberAutoTradingBackgroundSource,
} from './member-auto-trading-background-worker.service';
import { liveEntryArmPresent } from './member-auto-trading-live-arm.service';

const USER = '11111111-1111-1111-1111-111111111111';

function policy(): TradingPolicy {
  return normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    marketEnabled: {
      domestic_stock: false,
      us_stock: false,
      crypto_spot: true,
      crypto_futures: false,
    },
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
    totalCapitalKrw: 1_000_000,
    maxOrderKrw: 100_000,
    maxInstrumentKrw: 300_000,
    maxAssetPercent: 30,
    maxAssetClassKrw: {
      domestic_stock: 1_000_000,
      us_stock: 1_000_000,
      crypto_spot: 500_000,
      crypto_futures: 500_000,
    },
  });
}

function allFourPolicy(): TradingPolicy {
  return normalizeTradingPolicy({
    ...policy(),
    pilotStage: 'validated',
    marketEnabled: {
      domestic_stock: true,
      us_stock: true,
      crypto_spot: true,
      crypto_futures: true,
    },
    stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: false },
  });
}

test('all-four live readiness requires fresh verified Toss, Kiwoom, Upbit, and Bitget connections', () => {
  const nowMs = Date.now();
  const readyPolicy = normalizeTradingPolicy({
    ...allFourPolicy(),
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true, toss: true },
  });
  const connection = (exchange: ExchangeConnection['exchange'], overrides: Partial<ExchangeConnection> = {}): ExchangeConnection => ({
    userId: USER,
    exchange,
    accountMode: 'live',
    configured: true,
    encryptedCredentials: 'encrypted',
    lastVerifiedAt: new Date(nowMs - 60_000).toISOString(),
    lastErrorCode: null,
    updatedAt: new Date(nowMs - 60_000).toISOString(),
    ...overrides,
  });
  const all = [
    connection('toss'),
    connection('kiwoom'),
    connection('upbit'),
    connection('bitget'),
  ];
  assert.equal(liveAllFourConnectionVerificationReady(readyPolicy, all, nowMs), true);
  assert.equal(liveAllFourConnectionVerificationReady(readyPolicy, all.filter((row) => row.exchange !== 'toss'), nowMs), false);
  assert.equal(liveAllFourConnectionVerificationReady(readyPolicy, [
    connection('toss'),
    connection('kiwoom'),
    connection('upbit'),
    connection('bitget', { lastVerifiedAt: new Date(nowMs - 31 * 24 * 60 * 60_000).toISOString() }),
  ], nowMs), false);
  assert.equal(liveAllFourConnectionVerificationReady(readyPolicy, [
    connection('toss'),
    connection('kiwoom'),
    connection('upbit'),
    connection('bitget', { lastErrorCode: 'AUTH_REVOKED' }),
  ], nowMs), false);
});

function handoff(nowMs: number, missingRecentMove = false) {
  const dataTimestamp = new Date(nowMs - (missingRecentMove ? 120_000 : 20_000)).toISOString();
  return {
    schemaVersion: 'member-auto-trading-paper-handoff-v1',
    status: 'READY',
    cycleId: 'cycle-worker-1',
    evaluatedAtMs: nowMs,
    entryCount: 1,
    blockers: [],
    handoffDigest: 'd'.repeat(64),
    safety: {
      executionAuthority: 'NONE',
      publicDataOnly: true,
      simulatedOnly: true,
      liveTrading: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
    },
    entries: [{
      handoffId: 'paper-auto-handoff:sha256:' + 'e'.repeat(64),
      cycleId: 'cycle-worker-1',
      evaluatedAtMs: nowMs,
      identity: {
        signalId: 'signal-worker-1',
        candidateId: 'paper-candidate-v1:' + 'f'.repeat(64),
        market: 'CRYPTO_SPOT',
        symbol: 'BTC',
        timeframe: '15m',
        horizon: 4,
        direction: 'BUY',
        regime: 'TREND',
        strategyId: 'trend-breakout-v1',
        strategyVersion: '1.0.0',
        parameterHash: 'params-v1',
        researchCodeSha: 'a'.repeat(40),
        costPolicyVersion: 'cost-v1',
        executionAuthority: 'NONE',
      },
      signal: {
        signalId: 'signal-worker-1',
        market: 'CRYPTO_SPOT',
        symbol: 'BTC',
        timestampMs: nowMs - 20_000,
        expiresAtMs: nowMs + 60_000,
        ttlMs: 80_000,
        style: 'SCALPING',
        timeframe: '15m',
        horizon: 4,
        direction: 'BUY',
        regime: 'TREND',
        strategyIdentity: {
          candidateId: 'paper-candidate-v1:' + 'f'.repeat(64),
          strategyId: 'trend-breakout-v1',
          strategyVersion: '1.0.0',
          parameterHash: 'params-v1',
          researchCodeSha: 'a'.repeat(40),
        },
        learningSnapshot: {
          immutable: true,
          executionAuthority: 'NONE',
          dataTimestamp,
          referencePrice: 100_000,
          entryPrice: 100_000,
          stopLoss: 95_000,
          target1: 110_000,
          target2: 120_000,
        },
      },
      profitEvidence: {
        status: 'READY',
        expectedNetEdge: 0.02,
        expectedNetReturn: 0.01,
        riskRewardRatio: 2,
        sampleSize: 80,
        costPolicyId: 'cost-v1',
        executionAuthority: 'NONE',
      },
      riskEvidence: {
        status: 'APPROVED',
        source: 'TRADING_RISK_ENGINE',
        evaluatedAtMs: nowMs - 1_000,
        simulatedOnly: true,
        allowed: true,
        blockCodes: [],
        recommendedQuantity: 0.1,
        actualRiskPercent: 0.4,
        riskReward1: 1.8,
        riskReward2: 2.4,
        policyIdentity: null,
        executionAuthority: 'NONE',
      },
      execution: {
        marketAdapterIdentity: { id: 'upbit-paper-v1', version: '1' },
        costPolicy: {
          version: 'cost-v1',
          commissionRate: 0.0005,
          taxRate: 0,
          spreadRate: 0.001,
          slippageRate: 0.0005,
          latencyRate: 0.0001,
          liquidityImpactRate: 0.0002,
          partialFillImpactRate: 0,
          fundingRate: 0,
        },
        executionPolicy: {
          version: 'execution-v1',
          fillModel: 'TOP_OF_BOOK',
          sameBarPolicy: 'STOP_FIRST',
          allowPartialFill: false,
          maxParticipationRate: 0.1,
        },
        dataEvidence: {
          provider: 'upbit',
          provenance: 'canonical-public-market-v1',
          publicOnly: true,
          dataQuality: 'READY',
          asOfMs: nowMs - 1_000,
          maxAgeMs: 30_000,
          tickSize: 100,
          marketStatus: 'TRADABLE',
          minOrderNotional: 5_000,
        },
      },
      simulatedOrder: { type: 'MARKET', quantity: 0.1, direction: 'BUY' },
      publicQuote: {
        bid: 100_000,
        ask: 100_100,
        last: 100_050,
        asOfMs: nowMs - 1_000,
        maxAgeMs: 30_000,
      },
      safety: {
        executionAuthority: 'NONE',
        simulatedOnly: true,
        liveOrderAllowed: false,
        privateTradingApiAllowed: false,
        orderSubmitted: false,
        exchangeRequestSent: false,
      },
    }],
  } as const;
}

function paperRepository(nowMs: number): PaperJournalRepository {
  return {
    async listSnapshot() {
      return [{
        kind: 'account',
        id: 'paper-account',
        version: 1,
        updatedAt: new Date(nowMs).toISOString(),
        deletedAt: null,
        payload: {
          id: 'paper-account',
          equity: 1_000_000,
          cashBalance: 1_000_000,
          availableMargin: 1_000_000,
        },
      }];
    },
  } as unknown as PaperJournalRepository;
}

function source(
  repository: InMemoryTradingRepository,
  nowMs: number,
  options: {
    missingRecentMove?: boolean;
    tier?: 'pending' | 'associate' | 'admin';
    expired?: boolean;
    handoffMissing?: boolean;
    markPrice?: number;
    syncCalls?: { count: number };
    syncFailure?: boolean;
    syncMissingReferences?: number;
  } = {},
): MemberAutoTradingBackgroundSource {
  return {
    async readHandoff() {
      return options.handoffMissing ? null : handoff(nowMs, options.missingRecentMove) as never;
    },
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: policy(),
        profile: {
          membership_level: options.tier ?? 'associate',
          role: options.tier === 'admin' ? 'admin' : 'user',
          status: options.tier === 'pending' ? 'pending' : 'approved',
          is_active: true,
          membership_expires_at: options.expired ? new Date(nowMs - 1_000).toISOString() : null,
        },
      }];
    },
    tradingRepositoryFor() { return repository; },
    paperJournalRepositoryFor() { return paperRepository(nowMs); },
    async resolveFx() {
      return {
        market: 'CRYPTO_SPOT',
        krwPerQuoteCurrency: 1,
        source: 'NATIVE_KRW',
        observedAt: new Date(nowMs).toISOString(),
        stale: false,
      };
    },
    telegramDeliveryHealthy() { return true; },
    async readLiveAccountSnapshot() {
      throw new Error('LIVE_ACCOUNT_READ_MUST_NOT_RUN_WHEN_DISABLED');
    },
    async readMarketMark() {
      return {
        market: 'CRYPTO_SPOT',
        symbol: 'BTC',
        price: options.markPrice ?? 100_050,
        observedAt: new Date(nowMs).toISOString(),
        source: 'test-public-mark',
      };
    },
    ...(options.syncCalls ? {
      async syncExecutionEvents() {
        options.syncCalls!.count += 1;
        if (options.syncFailure) throw new Error('TEST_EXECUTION_SYNC_FAILED');
        return {
          inserted: 1,
          deliveryQueued: 1,
          missingReferences: options.syncMissingReferences ?? 0,
        };
      },
    } : {}),
  };
}

function sidecarPaperOnly() {
  return new Response(JSON.stringify({
    ok: true,
    serviceSha: 'worker-sidecar-test',
    result: {
      safety: {
        executionAuthority: 'NONE',
        privateTradingApiAllowed: false,
        realOrderAllowed: false,
        orderSubmissionAllowed: false,
      },
      scanner: {
        mode: 'SOFT_INTELLIGENCE_LAYER',
        adjustment: 0,
        intelligenceScore: 50,
        bullishScore: 50,
        bearishScore: 50,
        hardBlockReason: null,
        candidateDeletionAllowed: false,
      },
      autoTrading: {
        mode: 'PAPER_ONLY',
        orderAllowed: false,
        evidenceReady: false,
        parentEligibilityReady: false,
        hardBlockReason: null,
      },
      warnings: [],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetchMock<T>(run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sidecarPaperOnly();
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('member stock broker routing is user-selectable for stocks and fixed away from crypto', () => {
  const selected = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    stockBrokerByMarket: { domestic_stock: 'toss', us_stock: 'kiwoom' },
  });
  assert.equal(resolveMemberStockBroker(selected, 'KR_STOCK'), 'toss');
  assert.equal(resolveMemberStockBroker(selected, 'US_STOCK'), 'kiwoom');
  assert.equal(resolveMemberStockBroker(selected, 'CRYPTO_SPOT'), null);
  assert.equal(resolveMemberStockBroker(selected, 'CRYPTO_FUTURES'), null);

  const legacy = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, stockBrokerByMarket: undefined });
  assert.equal(resolveMemberStockBroker(legacy, 'KR_STOCK'), 'kiwoom');
  assert.equal(resolveMemberStockBroker(legacy, 'US_STOCK'), 'kiwoom');
});

test('stock automatic routing allows domestic Toss/Kiwoom but forces US Kiwoom', () => {
  const base = policy();
  const toss = normalizeTradingPolicy({
    ...base,
    stockBrokerByMarket: { domestic_stock: 'toss', us_stock: 'toss' },
    exchangeEnabled: { ...base.exchangeEnabled, toss: true, kiwoom: false },
  });
  assert.deepEqual(marketMapping('KR_STOCK', toss), {
    exchange: 'toss', assetClass: 'domestic_stock', planMarket: 'KR', stockBroker: 'toss',
  });
  assert.deepEqual(marketMapping('US_STOCK', toss), {
    exchange: 'kiwoom', assetClass: 'us_stock', planMarket: 'US', stockBroker: 'kiwoom',
  });
  const kiwoom = normalizeTradingPolicy({
    ...base,
    stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
    exchangeEnabled: { ...base.exchangeEnabled, toss: false, kiwoom: true },
  });
  assert.equal(marketMapping('KR_STOCK', kiwoom).exchange, 'kiwoom');
  assert.equal(marketMapping('US_STOCK', kiwoom).exchange, 'kiwoom');
});

test('Bitget futures worker preserves every validated 4x-7x policy and evidence into the plan', async () => {
  for (const expectedLeverage of [4, 5, 6, 7] as const) {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const futuresPolicy = normalizeTradingPolicy({
    ...policy(),
    marketEnabled: {
      domestic_stock: false,
      us_stock: false,
      crypto_spot: false,
      crypto_futures: true,
    },
    exchangeEnabled: { bitget: true, upbit: false, kiwoom: false, toss: false },
    bitgetLeverage: expectedLeverage,
  });
  await repository.savePolicy(USER, futuresPolicy);

  const futuresHandoff = JSON.parse(JSON.stringify(handoff(nowMs))) as any;
  const entry = futuresHandoff.entries[0];
  entry.identity.market = 'CRYPTO_FUTURES';
  entry.identity.symbol = 'BTCUSDT';
  entry.identity.direction = 'LONG';
  entry.signal.market = 'CRYPTO_FUTURES';
  entry.signal.symbol = 'BTCUSDT';
  entry.signal.direction = 'LONG';
  entry.execution.marketAdapterIdentity = { id: 'bitget-paper-v1', version: '1' };
  entry.execution.dataEvidence = {
    ...entry.execution.dataEvidence,
    provider: 'bitget',
    leverage: expectedLeverage,
    marginMode: 'isolated',
    marketStatus: 'TRADABLE',
    tickSize: 0.1,
    minOrderNotional: 5,
  };
  entry.signal.learningSnapshot.referencePrice = 100;
  entry.signal.learningSnapshot.entryPrice = 100;
  entry.signal.learningSnapshot.stopLoss = 95;
  entry.signal.learningSnapshot.target1 = 110;
  entry.signal.learningSnapshot.target2 = 120;
  entry.publicQuote = {
    bid: 100,
    ask: 100.1,
    last: 100.05,
    asOfMs: nowMs - 1_000,
    maxAgeMs: 30_000,
  };

  const base = source(repository, nowMs);
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readHandoff() { return futuresHandoff as never; },
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: futuresPolicy,
        profile: { membership_level: 'regular', role: 'full', status: 'approved', is_active: true },
      }];
    },
    async resolveFx() {
      return {
        market: 'CRYPTO_FUTURES',
        krwPerQuoteCurrency: 1_400,
        source: 'UPBIT:KRW-USDT',
        observedAt: new Date(nowMs).toISOString(),
        stale: false,
      };
    },
  });

  const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(result.failures, 0);
  assert.equal(result.createdPlans, 1);
  const plans = await repository.listPlans(USER);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.exchange, 'bitget');
  assert.equal(plans[0]?.leverage, expectedLeverage);
  assert.equal(plans[0]?.marginMode, 'isolated');
  }
});

test('background worker is default OFF without explicit activation flag', () => {
  const previous = process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
  delete process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
  try {
    assert.equal(startMemberAutoTradingBackgroundWorker(), null);
    const health = readMemberAutoTradingBackgroundRuntimeHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.lastTickAt, null);
    assert.equal(health.liveTrackedPositions, 0);
    assert.equal(health.liveAllFourPolicyReadyMembers, 0);
    assert.equal(health.startupWarmupObserved, false);
    assert.equal(health.firstWarmupTickLiveOrders, null);
    assert.equal(health.firstWarmupTickLiveExitOrders, null);
  } finally {
    if (previous == null) delete process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
    else process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED = previous;
  }
});

test('expired associate is excluded from automatic trading before any plan or order work', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const worker = new MemberAutoTradingBackgroundWorker(source(repository, nowMs, { expired: true }));

  const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(result.createdPlans, 0);
  assert.equal(result.filledOrders, 0);
  assert.equal(result.liveOrders, 0);
  assert.equal(result.privateTradingRequests, 0);
  assert.equal((await repository.listOrders(USER)).length, 0);
});

test('associate automatic policy creates exactly one Paper FILLED order through canonical services', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const worker = new MemberAutoTradingBackgroundWorker(source(repository, nowMs));

  const first = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(first.liveOrders, 0);
  assert.equal(first.privateTradingRequests, 0);
  assert.equal(first.createdPlans, 1);
  assert.equal(first.filledOrders, 1);
  assert.equal(first.positionLifecycles, 1);
  assert.equal(first.lifecycleIdempotent, 0);
  assert.equal(first.failures, 0);

  const orders = await repository.listOrders(USER);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].state, 'FILLED');
  const plan = await repository.getPlan(USER, orders[0].planId);
  assert.equal(plan?.accountMode, 'paper');
  assert.equal(plan?.exchange, 'upbit');
  assert.equal(plan?.market, 'KRW');
  assert.equal(plan?.signalId, 'signal-worker-1');
  assert.equal(orders[0].exchangeOrderId?.startsWith('paper-'), true);
  const lifecycleEvents = (await repository.listEvents(USER))
    .filter((event) => event.reason === 'PAPER_POSITION_LIFECYCLE_OPENED');
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0]?.toState, 'FILLED');
  assert.equal((lifecycleEvents[0]?.metadata?.safety as any).executionAuthority, 'NONE');
  assert.equal((lifecycleEvents[0]?.metadata?.safety as any).economicSampleCredit, 0);

  const second = await withFetchMock(() => worker.runOnce(new Date(nowMs + 1_000)));
  assert.equal((await repository.listOrders(USER)).length, 1);
  assert.equal(second.createdPlans, 0);
  assert.ok(second.duplicates >= 1);
  assert.equal(second.positionLifecycles, 0);
  assert.equal(second.lifecycleIdempotent, 1);
  assert.equal((await repository.listEvents(USER))
    .filter((event) => event.reason === 'PAPER_POSITION_LIFECYCLE_OPENED').length, 1);
  assert.equal(second.liveOrders, 0);
});

test('same-tick automatic entries refresh canonical exposure before evaluating the next signal', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const bounded = normalizeTradingPolicy({ ...policy(), maxOpenPositions: 1, maxDailyOrders: 100 });
  await repository.savePolicy(USER, bounded);

  const two = JSON.parse(JSON.stringify(handoff(nowMs))) as any;
  const second = JSON.parse(JSON.stringify(two.entries[0]));
  second.handoffId = 'paper-auto-handoff:sha256:' + '9'.repeat(64);
  second.identity.signalId = 'signal-worker-2';
  second.identity.candidateId = 'paper-candidate-v1:' + '8'.repeat(64);
  second.identity.symbol = 'ETH';
  second.signal.signalId = 'signal-worker-2';
  second.signal.symbol = 'ETH';
  second.signal.strategyIdentity.candidateId = second.identity.candidateId;
  second.signal.learningSnapshot.referencePrice = 50_000;
  second.signal.learningSnapshot.entryPrice = 50_000;
  second.signal.learningSnapshot.stopLoss = 47_500;
  second.signal.learningSnapshot.target1 = 55_000;
  second.signal.learningSnapshot.target2 = 60_000;
  second.publicQuote = { bid: 50_000, ask: 50_050, last: 50_025, asOfMs: nowMs - 1_000, maxAgeMs: 30_000 };
  two.entries.push(second);
  two.entryCount = 2;

  const base = source(repository, nowMs);
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readHandoff() { return two as never; },
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: bounded,
        profile: { membership_level: 'associate', role: 'user', status: 'approved', is_active: true },
      }];
    },
  });

  const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(result.createdPlans, 1);
  assert.equal(result.filledOrders, 1);
  assert.ok(result.runtimeRefreshes >= 1);
  assert.ok(result.blocked >= 1);
  assert.equal((await repository.listOrders(USER)).length, 1);
});

test('background worker automatically projects canonical execution events without requiring the manual sync endpoint', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const syncCalls = { count: 0 };
  const worker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs, { handoffMissing: true, syncCalls }),
  );

  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(syncCalls.count, 1);
  assert.equal(result.executionEventsInserted, 1);
  assert.equal(result.notificationDeliveriesQueued, 1);
  assert.equal(result.executionSyncMissingReferences, 0);
  assert.equal(result.executionSyncFailures, 0);
  assert.equal(result.handoffReady, false);
  assert.equal(result.newEntriesFailClosed, true);
  assert.equal(result.privateTradingRequests, 0);
});

test('execution projection missing references fail-close new entries before canonical order mutation', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const syncCalls = { count: 0 };
  const worker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs, { syncCalls, syncMissingReferences: 1 }),
  );

  const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(syncCalls.count, 1);
  assert.equal(result.executionSyncMissingReferences, 1);
  assert.equal(result.executionSyncFailures, 0);
  assert.equal(result.executionSyncBlocks, 1);
  assert.equal(result.newEntriesFailClosed, true);
  assert.equal(result.createdPlans, 0);
  assert.equal(result.filledOrders, 0);
  assert.equal(result.blocked, 1);
  assert.equal((await repository.listOrders(USER)).length, 0);
});

test('execution event fan-out failure fail-closes new entries before canonical order mutation', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const syncCalls = { count: 0 };
  const worker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs, { syncCalls, syncFailure: true }),
  );

  const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(syncCalls.count, 1);
  assert.equal(result.executionSyncFailures, 1);
  assert.equal(result.executionSyncBlocks, 1);
  assert.equal(result.newEntriesFailClosed, true);
  assert.equal(result.failures, 0);
  assert.equal(result.createdPlans, 0);
  assert.equal(result.filledOrders, 0);
  assert.equal(result.blocked, 1);
  assert.equal((await repository.listOrders(USER)).length, 0);
});

test('execution projection failure is isolated from canonical trading state', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const base = source(repository, nowMs, { handoffMissing: true });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async syncExecutionEvents() {
      throw new Error('EXECUTION_EVENT_PROJECTION_UNAVAILABLE');
    },
  });

  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(result.executionSyncFailures, 1);
  assert.equal(result.failures, 0);
  assert.equal(result.createdPlans, 0);
  assert.equal(result.filledOrders, 0);
  assert.equal(result.privateTradingRequests, 0);
});

test('missing <=60s reference move evidence blocks before plan creation', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const worker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs, { missingRecentMove: true }),
  );
  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(result.blocked, 1);
  assert.equal(result.createdPlans, 0);
  assert.equal((await repository.listPlans(USER)).length, 0);
  assert.equal((await repository.listOrders(USER)).length, 0);
});

test('pending member cannot receive background automatic Paper work', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const worker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs, { tier: 'pending' }),
  );
  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(result.evaluated, 0);
  assert.equal(result.skipped, 1);
  assert.equal((await repository.listPlans(USER)).length, 0);
});

test('market OFF policy skips candidate without creating a plan', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const off = normalizeTradingPolicy({
    ...policy(),
    marketEnabled: {
      domestic_stock: false,
      us_stock: false,
      crypto_spot: false,
      crypto_futures: false,
    },
  });
  await repository.savePolicy(USER, off);
  const base = source(repository, nowMs);
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: off,
        profile: { membership_level: 'associate', role: 'user', status: 'approved', is_active: true },
      }];
    },
  });
  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(result.skipped, 1);
  assert.equal(result.createdPlans, 0);
  assert.equal((await repository.listPlans(USER)).length, 0);
});


test('live background lane requires every explicit live authority flag', () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'true';
    assert.equal(liveBackgroundEnabled(), true);
    process.env.PRIVATE_TRADING_API_ALLOWED = 'false';
    assert.equal(liveBackgroundEnabled(), false);
    process.env.PRIVATE_TRADING_API_ALLOWED = 'true';
    process.env.REAL_ORDER_ENABLED = 'false';
    assert.equal(liveBackgroundEnabled(), false);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('first live-enabled worker tick is a read/sync warmup and cannot create a live entry', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const syncCalls = { count: 0 };
  let liveReads = 0;
  const base = source(repository, nowMs, { syncCalls, tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: readyPolicy,
        profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      }];
    },
    async readLiveAccountSnapshot() {
      liveReads += 1;
      throw new Error('FIRST_TICK_LIVE_READ_FORBIDDEN');
    },
  });
  try {
    for (const key of keys) process.env[key] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.liveEntriesArmed, false);
    assert.equal(result.liveEntriesSuppressedByWarmupOrArm, 1);
    assert.equal(result.liveEntryWarmupComplete, true);
    assert.equal(result.liveOrders, 0);
    assert.equal(result.liveExitOrders, 0);
    assert.equal(liveReads, 0);
    assert.ok(syncCalls.count >= 2);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('live warmup survives an empty intermediate member batch and drops only after a full empty rotation cycle', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const readyMember = {
    userId: USER,
    policy: readyPolicy,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
  } as const;
  let members: readonly any[] = [readyMember];
  let cycleComplete = true;
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() { return members as never; },
    memberBatchCycleCompleted() { return cycleComplete; },
  });

  try {
    for (const key of keys) process.env[key] = 'true';

    const first = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(first.liveReadinessCycleComplete, true);
    assert.equal(first.liveCycleOrderEligible, true);
    assert.equal(first.liveCyclePolicyReady, true);
    assert.equal(first.liveEntryWarmupComplete, true);

    members = [];
    cycleComplete = false;
    const middle = await withFetchMock(() => worker.runOnce(new Date(nowMs + 30_000)));
    assert.equal(middle.liveReadinessCycleComplete, false);
    assert.equal(middle.liveEntryWarmupComplete, true);
    assert.equal(middle.newEntriesFailClosed, false);

    cycleComplete = true;
    const end = await withFetchMock(() => worker.runOnce(new Date(nowMs + 60_000)));
    assert.equal(end.liveReadinessCycleComplete, true);
    assert.equal(end.liveCycleOrderEligible, false);
    assert.equal(end.liveCyclePolicyReady, false);
    assert.equal(end.liveEntryWarmupComplete, false);
    assert.equal(end.newEntriesFailClosed, true);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('completed rotation revalidates the all-four readiness witness before live warmup can pass', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const readyMember = {
    userId: USER,
    policy: readyPolicy,
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
  } as const;
  let members: readonly any[] = [readyMember];
  let cycleComplete = false;
  let witnessReady = true;
  let revalidationCalls = 0;
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() { return members as never; },
    memberBatchCycleCompleted() { return cycleComplete; },
    async revalidateLiveAllFourReadiness(userId) {
      revalidationCalls += 1;
      assert.equal(userId, USER);
      return witnessReady;
    },
  });

  try {
    for (const key of keys) process.env[key] = 'true';

    const partial = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(partial.liveReadinessCycleComplete, false);
    assert.equal(partial.liveCycleAllFourPolicyReady, true);
    assert.equal(partial.liveEntryWarmupComplete, false);
    assert.equal(revalidationCalls, 0);

    members = [];
    cycleComplete = true;
    witnessReady = false;
    const completed = await withFetchMock(() => worker.runOnce(new Date(nowMs + 30_000)));
    assert.equal(revalidationCalls, 1);
    assert.equal(completed.liveReadinessCycleComplete, true);
    assert.equal(completed.liveCycleOrderEligible, false);
    assert.equal(completed.liveCyclePolicyReady, false);
    assert.equal(completed.liveCycleAllFourPolicyReady, false);
    assert.equal(completed.liveEntryWarmupComplete, false);
    assert.equal(completed.newEntriesFailClosed, true);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('worker failure clears partial rotation readiness before the recovery cycle', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const readyMember = {
    userId: USER,
    policy: policy(),
    profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
  } as const;
  let members: readonly any[] = [readyMember];
  let cycleComplete = false;
  let failHandoff = false;
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readHandoff() {
      if (failHandoff) throw new Error('ROTATION_TEST_HANDOFF_FAILURE');
      return base.readHandoff(nowMs);
    },
    async listEligibleMembers() { return members as never; },
    memberBatchCycleCompleted() { return cycleComplete; },
  });

  try {
    for (const key of keys) process.env[key] = 'true';

    const partial = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(partial.liveReadinessCycleComplete, false);
    assert.equal(partial.liveCycleOrderEligible, true);
    assert.equal(partial.liveEntryWarmupComplete, false);

    failHandoff = true;
    const quarantined = await withFetchMock(() => worker.runOnce(new Date(nowMs + 30_000)));
    assert.equal(quarantined.handoffStatus, 'BLOCKED_DATA');
    assert.equal(quarantined.newEntriesFailClosed, true);
    assert.equal(quarantined.liveEntryWarmupComplete, false);
    assert.equal(quarantined.failures, 1);

    failHandoff = false;
    members = [];
    cycleComplete = true;
    const recovered = await withFetchMock(() => worker.runOnce(new Date(nowMs + 60_000)));
    assert.equal(recovered.liveReadinessCycleComplete, true);
    assert.equal(recovered.liveCycleOrderEligible, false);
    assert.equal(recovered.liveCyclePolicyReady, false);
    assert.equal(recovered.liveEntryWarmupComplete, false);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('live activation warmup stays fail-closed when no member can place real orders', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const worker = new MemberAutoTradingBackgroundWorker(source(repository, nowMs, { tier: 'associate' }));

  try {
    for (const key of keys) process.env[key] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.handoffReady, true);
    assert.equal(result.liveOrderEligibleMembers, 0);
    assert.equal(result.livePolicyReadyMembers, 0);
    assert.equal(result.liveEntryWarmupComplete, false);
    assert.equal(result.newEntriesFailClosed, true);
    assert.equal(result.liveOrders, 0);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('partial-market automatic policy cannot complete live warmup even with order capability', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const partialPolicy = policy();
  await repository.savePolicy(USER, partialPolicy);
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: partialPolicy,
        profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      }];
    },
  });

  try {
    for (const key of keys) process.env[key] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.liveOrderEligibleMembers, 1);
    assert.equal(result.livePolicyReadyMembers, 1);
    assert.equal(result.liveAllFourPolicyReadyMembers, 0);
    assert.equal(result.liveCycleAllFourPolicyReady, false);
    assert.equal(result.liveEntryWarmupComplete, false);
    assert.equal(result.newEntriesFailClosed, true);
    assert.equal(result.liveOrders, 0);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('all-four activation readiness requires one order-capable futures member with all four markets enabled', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: readyPolicy,
        profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      }];
    },
  });

  try {
    for (const key of keys) process.env[key] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.liveOrderEligibleMembers, 1);
    assert.equal(result.livePolicyReadyMembers, 1);
    assert.equal(result.liveAllFourPolicyReadyMembers, 1);
    assert.equal(result.liveEntryWarmupComplete, true);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('first live warmup suppresses automatic exits for existing live positions before exact-SHA arm', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  await repository.savePlan({
    exchange: 'upbit',
    accountMode: 'live',
    strategyId: 'trend-breakout-v1',
    signalId: 'live-signal-existing',
    symbol: 'BTC',
    market: 'UPBIT',
    side: 'buy',
    orderType: 'market',
    quantity: 0.1,
    quoteAmount: null,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [1],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'],
    marketSnapshot: {
      observedAt: new Date(nowMs - 1_000).toISOString(),
      dataDelayMs: 1_000,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.05,
      orderbookGapPercent: 0,
      halted: false,
      availableBalance: 900_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      openPositionCount: 1,
      dailyOrderCount: 1,
      consecutiveLosses: 0,
      currentPrice: 100_000,
      signalState: 'approved',
    },
    entryPrice: 100_000,
    executionMode: 'automatic',
    id: 'live-plan-existing',
    userId: USER,
    idempotencyKey: 'live-plan-existing-key',
    state: 'FILLED',
    version: 1,
    approvalExpiresAt: null,
    approvedAt: new Date(nowMs - 10_000).toISOString(),
    createdAt: new Date(nowMs - 10_000).toISOString(),
    updatedAt: new Date(nowMs - 5_000).toISOString(),
  } as any);
  await repository.saveOrder({
    id: 'live-order-existing',
    userId: USER,
    planId: 'live-plan-existing',
    exchange: 'upbit',
    clientOrderId: 'live-order-existing-client',
    exchangeOrderId: 'live-order-existing-provider',
    state: 'FILLED',
    version: 1,
    requestedQuantity: 0.1,
    remainingQuantity: 0,
    filledQuantity: 0.1,
    averageFillPrice: 100_000,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: new Date(nowMs - 10_000).toISOString(),
    updatedAt: new Date(nowMs - 5_000).toISOString(),
  } as any);

  let liveReads = 0;
  const base = source(repository, nowMs, { tier: 'admin', markPrice: 90_000 });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readLiveAccountSnapshot() {
      liveReads += 1;
      throw new Error('WARMUP_LIVE_EXIT_PRIVATE_READ_FORBIDDEN');
    },
  });

  try {
    for (const key of keys) process.env[key] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.liveEntriesArmed, false);
    assert.equal(result.liveExitOrders, 0);
    assert.equal(result.liveTrackedPositions, 1);
    assert.equal(result.liveExitsSuppressedByWarmupOrArm, 1);
    assert.equal(result.privateTradingRequests, 0);
    assert.equal(liveReads, 0);

    // A broken/missing Paper account can no longer suppress visibility of
    // this independently persisted Live position. Entries stay fail-closed.
    const missingPaper = new MemberAutoTradingBackgroundWorker({
      ...base,
      paperJournalRepositoryFor() {
        return {
          async listSnapshot() { return []; },
        } as unknown as PaperJournalRepository;
      },
      async readLiveAccountSnapshot() {
        liveReads += 1;
        throw new Error('NO_PRIVATE_EXIT_DURING_WARMUP');
      },
    });
    const quarantined = await withFetchMock(() => missingPaper.runOnce(new Date(nowMs)));
    assert.equal(quarantined.liveTrackedPositions, 1);
    assert.equal(quarantined.liveExitOrders, 0);
    assert.equal(quarantined.newEntriesFailClosed, true);
    assert.equal(quarantined.createdPlans, 0);
    assert.equal(quarantined.failures, 1);
    assert.equal(liveReads, 0);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('zero-mutation activation rehearsal transitions warmup to exact-SHA arm with no provider request or live order', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
    'DEPLOY_SHA',
    'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const syncCalls = { count: 0 };
  const root = await mkdtemp(join(tmpdir(), 'auto-trading-activation-rehearsal-'));
  const armPath = join(root, 'live-entry-arm.json');
  const targetSha = 'b'.repeat(40);
  const empty = JSON.parse(JSON.stringify(handoff(nowMs))) as any;
  empty.entries = [];
  empty.entryCount = 0;
  const base = source(repository, nowMs, { syncCalls, tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER,
        policy: readyPolicy,
        profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      }];
    },
    async readHandoff() { return empty as never; },
    async readLiveAccountSnapshot() {
      throw new Error('ZERO_MUTATION_REHEARSAL_LIVE_ACCOUNT_READ_FORBIDDEN');
    },
  });

  try {
    for (const key of keys.slice(0, 6)) process.env[key] = 'true';
    process.env.DEPLOY_SHA = targetSha;
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = armPath;

    const warmup = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(warmup.handoffReady, true);
    assert.equal(warmup.liveEntryArmPresent, false);
    assert.equal(warmup.liveEntriesArmed, false);
    assert.equal(warmup.liveEntryWarmupComplete, true);
    assert.equal(warmup.liveOrders, 0);
    assert.equal(warmup.liveExitOrders, 0);
    assert.equal(warmup.liveTrackedPositions, 0);
    assert.equal(warmup.privateTradingRequests, 0);
    assert.equal(warmup.executionSyncFailures, 0);
    assert.equal(warmup.executionSyncMissingReferences, 0);
    assert.equal(warmup.liveOrderEligibleMembers, 1);
    assert.equal(warmup.livePolicyReadyMembers, 1);
    assert.equal(warmup.liveAllFourPolicyReadyMembers, 1);
    assert.equal(warmup.globalEmergencyStopActive, false);

    await writeFile(armPath, JSON.stringify({
      schemaVersion: 'member-auto-trading-live-entry-arm-v1',
      targetSha,
      armed: true,
      armedAt: new Date(nowMs + 500).toISOString(),
      activateNotBeforeAt: new Date(nowMs + 1_500).toISOString(),
    }) + '\n', { mode: 0o600, flag: 'wx' });

    const quarantined = await withFetchMock(() => worker.runOnce(new Date(nowMs + 1_000)));
    assert.equal(quarantined.handoffReady, true);
    assert.equal(quarantined.liveEntryArmPresent, false);
    assert.equal(quarantined.liveEntriesArmed, false);
    assert.equal(quarantined.liveOrders, 0);
    assert.equal(quarantined.liveExitOrders, 0);
    assert.equal(quarantined.privateTradingRequests, 0);

    const armed = await withFetchMock(() => worker.runOnce(new Date(nowMs + 2_000)));
    assert.equal(armed.handoffReady, true);
    assert.equal(armed.liveEntryArmPresent, true);
    assert.equal(armed.liveEntriesArmed, true);
    assert.equal(armed.liveEntryWarmupComplete, true);
    assert.equal(armed.liveOrders, 0);
    assert.equal(armed.liveExitOrders, 0);
    assert.equal(armed.liveTrackedPositions, 0);
    assert.equal(armed.privateTradingRequests, 0);
    assert.equal(armed.executionSyncFailures, 0);
    assert.equal(armed.executionSyncMissingReferences, 0);
    assert.equal((await repository.listOrders(USER)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Paper-only worker never touches live account reader when live lane is disabled', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED',
    'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED',
    'LIVE_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  let liveReads = 0;
  const base = source(repository, nowMs);
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    readLiveAccountSnapshot: async () => {
      liveReads += 1;
      throw new Error('LIVE_READ_MUST_NOT_RUN');
    },
  });
  try {
    for (const key of keys) delete process.env[key];
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(liveReads, 0);
    assert.equal(result.liveOrders, 0);
    assert.equal(result.privateTradingRequests, 0);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('automatic Paper exit closes a tracked position even when the next handoff is missing', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const firstWorker = new MemberAutoTradingBackgroundWorker(source(repository, nowMs, { markPrice: 100_050 }));
  const first = await withFetchMock(() => firstWorker.runOnce(new Date(nowMs)));
  assert.equal(first.filledOrders, 1);
  assert.equal(first.paperExitOrders, 0);

  const secondWorker = new MemberAutoTradingBackgroundWorker(
    source(repository, nowMs + 5_000, { handoffMissing: true, markPrice: 90_000 }),
  );
  const second = await withFetchMock(() => secondWorker.runOnce(new Date(nowMs + 5_000)));
  assert.equal(second.handoffStatus, 'MISSING');
  assert.equal(second.paperExitOrders, 1);
  assert.equal(second.liveExitOrders, 0);
  const plans = await repository.listPlans(USER);
  const exitPlan = plans.find((plan) => plan.reduceOnly === true);
  assert.ok(exitPlan);
  assert.ok(exitPlan.signalReasons.includes('AUTO_EXIT_REASON:STOP_LOSS'));
  const orders = await repository.listOrders(USER);
  const exitOrder = orders.find((order) => order.planId === exitPlan!.id);
  assert.equal(exitOrder?.state, 'FILLED');
  assert.equal(exitOrder?.filledQuantity, 0.1);
});


test('Telegram outage blocks armed live entry while preserving independent exit warmup', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING', 'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED', 'DEPLOY_SHA', 'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, readyPolicy);
  const root = await mkdtemp(join(tmpdir(), 'auto-telegram-gate-'));
  const armPath = join(root, 'arm.json');
  const targetSha = 'c'.repeat(40);
  let telegramReady = true;
  let liveReads = 0;
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    telegramDeliveryHealthy() { return telegramReady; },
    async listEligibleMembers() {
      return [{
        userId: USER, policy: readyPolicy,
        profile: { membership_level: 'admin', role: 'admin', status: 'approved', is_active: true },
      }];
    },
    async readLiveAccountSnapshot() {
      liveReads += 1;
      throw new Error('TELEGRAM_OUTAGE_MUST_NOT_READ_PRIVATE_PROVIDER');
    },
  });
  try {
    for (const key of keys.slice(0, 6)) process.env[key] = 'true';
    process.env.DEPLOY_SHA = targetSha;
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = armPath;
    const warmup = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(warmup.liveEntryWarmupComplete, true);
    assert.equal(warmup.liveEntriesArmed, false);
    await writeFile(armPath, JSON.stringify({
      schemaVersion: 'member-auto-trading-live-entry-arm-v1',
      armed: true, targetSha,
      armedAt: new Date(nowMs + 100).toISOString(),
      activateNotBeforeAt: new Date(nowMs + 200).toISOString(),
    }) + '\n', { mode: 0o600, flag: 'wx' });
    telegramReady = false;
    const blocked = await withFetchMock(() => worker.runOnce(new Date(nowMs + 2_000)));
    assert.equal(blocked.liveEntryArmPresent, true);
    assert.equal(blocked.liveEntryWarmupComplete, true);
    assert.equal(blocked.liveEntriesArmed, false);
    assert.equal(blocked.newEntriesFailClosed, true);
    assert.equal(blocked.liveEntriesSuppressedByTelegram, 1);
    assert.equal(blocked.liveOrders, 0);
    assert.equal(liveReads, 0);
    assert.equal((await repository.listPlans(USER)).filter((plan) => plan.accountMode === 'live').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of keys) {
      const value = saved[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('fair automatic handoff rotation visits more than 40 sorted signals without permanent starvation', () => {
  const all = Array.from({ length: 91 }, (_, index) => index);
  let offset = 0;
  const visited: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = selectRotatingHandoffEntries(all, offset, 40);
    visited.push(...result.entries);
    offset = result.nextOffset;
  }
  assert.deepEqual(visited.slice(0, 91), all);
  assert.equal(offset, 40);
  assert.deepEqual(selectRotatingHandoffEntries([], 50, 40), { entries: [], nextOffset: 0 });
});

test('exact SHA entry arm is invalid after revocation even if an earlier check succeeded', async () => {
  const keys = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING', 'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED', 'DEPLOY_SHA', 'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'auto-arm-revocation-'));
  const armPath = join(root, 'arm.json');
  try {
    for (const key of keys.slice(0, 6)) process.env[key] = 'true';
    process.env.DEPLOY_SHA = 'c'.repeat(40);
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = armPath;
    await writeFile(armPath, JSON.stringify({
      schemaVersion: 'member-auto-trading-live-entry-arm-v1',
      armed: true,
      targetSha: 'c'.repeat(40),
      armedAt: new Date(nowMs - 2_000).toISOString(),
      activateNotBeforeAt: new Date(nowMs - 1_000).toISOString(),
    }), { mode: 0o600 });
    assert.equal(await liveEntryArmPresent(nowMs), true);
    await rm(armPath);
    assert.equal(await liveEntryArmPresent(nowMs), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of keys) {
      const value = previous[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a broken handoff is fail-closed for entries without terminating the member worker tick', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  let selectedMembers = 0;
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readHandoff() { throw new Error('BROKEN_HANDOFF_DIGEST'); },
    async listEligibleMembers() {
      selectedMembers += 1;
      return base.listEligibleMembers();
    },
  });
  const result = await worker.runOnce(new Date(nowMs));
  assert.equal(result.handoffStatus, 'BLOCKED_DATA');
  assert.equal(result.handoffReady, false);
  assert.equal(result.newEntriesFailClosed, true);
  assert.equal(result.failures, 1);
  assert.equal(result.createdPlans, 0);
  assert.equal(result.liveOrders, 0);
  assert.equal(selectedMembers, 1);
});


test('formula+AI pilot cannot synthesize a PASS review from an ordinary Paper handoff', () => {
  const nowMs = Date.now();
  const entry = handoff(nowMs).entries[0] as any;
  assert.throws(() => formulaAiReviewReasonsForLive(entry, nowMs), /BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED/);
  const immutable = {
    schemaVersion: 'canonical-signal-ai-review-v1',
    source: 'CANONICAL_SIGNAL_AI_REVIEW',
    signalId: entry.identity.signalId,
    strategyId: entry.identity.strategyId,
    market: entry.identity.market,
    direction: entry.identity.direction,
    researchCodeSha: entry.identity.researchCodeSha,
    decision: 'PASS',
    liveEligibility: 'PASS_ONLY_ELIGIBLE',
    evidenceDigest: 'f'.repeat(64),
    reviewedAtMs: nowMs - 2_000,
    expiresAtMs: nowMs + 60_000,
  };
  const canonical = (v: any): string => Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
      : JSON.stringify(v);
  entry.aiReviewEvidence = {
    ...immutable,
    reviewDigest: createHash('sha256').update(canonical(immutable)).digest('hex'),
  };
  const reasons = formulaAiReviewReasonsForLive(entry, nowMs);
  assert.ok(reasons.includes('AI_REVIEW_DECISION:PASS'));
  assert.ok(reasons.includes('AI_REVIEW_LIVE_ELIGIBLE:PASS_ONLY_ELIGIBLE'));
  assert.ok(reasons.includes('STRATEGY_RULE_PACK:' + entry.identity.strategyId));
  assert.ok(reasons.includes('AI_REVIEW_EVIDENCE:' + 'f'.repeat(64)));
  assert.throws(() => formulaAiReviewReasonsForLive(entry, nowMs + 60_001), /BACKGROUND_FORMULA_AI_REVIEW_PROOF_REQUIRED/);
});


test('missing Paper account never produces a new entry or a false live warmup', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const base = source(repository, nowMs, { tier: 'admin' });
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    paperJournalRepositoryFor() {
      return { async listSnapshot() { return []; } } as unknown as PaperJournalRepository;
    },
  });
  const r = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
  assert.equal(r.newEntriesFailClosed, true);
  assert.equal(r.createdPlans, 0);
  assert.equal(r.livePlans, 0);
  assert.equal(r.failures, 1);
});


test('an old empty READY Paper handoff cannot certify current live warmup or authorize new entries', async () => {
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  const base = source(repository, nowMs, { tier: 'admin' });
  const stale = { ...handoff(nowMs - 31 * 60_000), entries: [], entryCount: 0 };
  const result = await new MemberAutoTradingBackgroundWorker({
    ...base,
    async readHandoff() { return stale as never; },
  }).runOnce(new Date(nowMs));
  assert.equal(result.handoffStatus, 'BLOCKED_DATA');
  assert.equal(result.handoffReady, false);
  assert.equal(result.newEntriesFailClosed, true);
  assert.equal(result.createdPlans, 0);
  assert.equal(result.liveOrders, 0);
  assert.equal(result.failures, 1);
});


test('read-only Live pre-entry exposure blocks untracked securities but excludes Upbit KRW settlement cash', () => {
  const tracked = { symbol: 'BTCUSDT', side: 'long', exchange: 'bitget' } as TradingPlan;
  const position = (symbol: string, quantity: number | null, side: string | null = 'long') =>
    ({ symbol, quantity, side }) as NonNullable<CanonicalAccountSnapshot['positions']>[number];
  const bitget = (positions: CanonicalAccountSnapshot['positions']) =>
    assertCanonicalLiveProviderPositions({ provider: 'bitget', positions }, [tracked]);
  assert.doesNotThrow(() => bitget([position('BTCUSDT', 1)]));
  assert.throws(() => bitget([position('ETHUSDT', 1)]),
    /BACKGROUND_LIVE_EXTERNAL_POSITION_UNRECONCILED/);
  assert.throws(() => bitget([position('BTCUSDT', 1, 'short')]),
    /BACKGROUND_LIVE_PROVIDER_POSITION_SIDE_MISMATCH/);
  assert.throws(() => bitget(null), /BACKGROUND_LIVE_PROVIDER_POSITIONS_UNAVAILABLE/);
  assert.throws(() => bitget([position('BTCUSDT', null)]),
    /BACKGROUND_LIVE_PROVIDER_POSITION_QUANTITY_UNAVAILABLE/);
  assert.doesNotThrow(() => bitget([]));

  // Upbit includes its KRW cash wallet in positions; that is NOT an open
  // market exposure, but a separately held ETH coin must still block entry.
  assert.doesNotThrow(() => assertCanonicalLiveProviderPositions({
    provider: 'upbit', positions: [position('KRW', 500_000, null)],
  }, []));
  assert.throws(() => assertCanonicalLiveProviderPositions({
    provider: 'upbit', positions: [
      position('KRW', 500_000, null), position('ETH', 0.4, null),
    ],
  }, []), /BACKGROUND_LIVE_EXTERNAL_POSITION_UNRECONCILED/);
});


test('member Telegram live admission requires a SENT receipt after this chat binding, never from a former chat', () => {
  const now = Date.parse('2026-10-08T05:30:00.000Z');
  const connection = {
    status: 'ACTIVE' as const,
    telegramChatId: 'telegram-chat-new',
    connectedAt: new Date(now - 60_000).toISOString(),
  };
  const accepted = { state: 'SENT', updated_at: new Date(now - 5_000).toISOString() };
  assert.equal(memberTelegramProofMatchesCurrentBinding(connection, accepted, now), true);
  assert.equal(memberTelegramProofMatchesCurrentBinding(
    connection, { ...accepted, updated_at: new Date(now - 90_000).toISOString() }, now,
  ), false);
  assert.equal(memberTelegramProofMatchesCurrentBinding(connection, { ...accepted, state: 'RETRY_SCHEDULED' }, now), false);
  assert.equal(memberTelegramProofMatchesCurrentBinding({ ...connection, status: 'REVOKED' }, accepted, now), false);
  assert.equal(memberTelegramProofMatchesCurrentBinding({ ...connection, connectedAt: 'unparseable' }, accepted, now), false);
  assert.equal(memberTelegramProofMatchesCurrentBinding(null, accepted, now), false);
});

test('stopped automatic member with a stored Live fill remains visible without reactivating exits or new entries', async () => {
  const env = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
  const now = Date.now();
  const repository = new InMemoryTradingRepository();
  const stopped = normalizeTradingPolicy({
    ...policy(), mode: 'approval', automaticEnabled: false,
    emergencyStopped: true,
  });
  await repository.savePolicy(USER, stopped);
  await repository.savePlan({
    id: 'live-stopped-plan', userId: USER, idempotencyKey: 'live-stopped-entry',
    state: 'FILLED', version: 1, accountMode: 'live', executionMode: 'automatic',
    exchange: 'upbit', strategyId: 'trend-breakout-v1',
    signalId: 'stopped-signal', symbol: 'BTC', market: 'UPBIT',
    side: 'buy', orderType: 'market', quantity: 0.1, quoteAmount: null,
    limitPrice: null, estimatedKrw: 100_000, stopPrice: 95_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null,
    marginMode: null, reduceOnly: false, signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'],
    marketSnapshot: { observedAt: new Date(now).toISOString() },
    approvedAt: new Date(now).toISOString(), approvalExpiresAt: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  } as any);
  await repository.saveOrder({
    id: 'live-stopped-order', userId: USER, planId: 'live-stopped-plan',
    exchange: 'upbit', clientOrderId: 'live-stopped-oid',
    exchangeOrderId: 'live-stopped-exchange-order', state: 'FILLED',
    requestedQuantity: 0.1, filledQuantity: 0.1,
    averageFillPrice: 100_000, retryCount: 0, lastErrorCode: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  } as any);
  const base = source(repository, now, { tier: 'admin', markPrice: 90_000 });
  let providerReads = 0;
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER, policy: stopped,
        profile: { role: 'admin', membership_level: 'admin', status: 'approved', is_active: true },
      }] as never;
    },
    async readLiveAccountSnapshot() {
      providerReads++;
      throw new Error('NO_PROVIDER_REQUEST_AFTER_AUTO_STOP');
    },
  });
  try {
    for (const key of env) process.env[key] = 'true';
    const result = await worker.runOnce(new Date(now));
    assert.equal(result.liveTrackedPositions, 1);
    assert.equal(result.liveExitsSuppressedByPolicy, 1);
    assert.equal(result.newEntriesFailClosed, true);
    assert.equal(result.liveEntryWarmupComplete, false);
    assert.equal(result.createdPlans, 0);
    assert.equal(result.liveOrders, 0);
    assert.equal(result.liveExitOrders, 0);
    assert.equal(providerReads, 0);
  } finally {
    for (const key of env) {
      const oldValue = previous[key];
      if (oldValue == null) delete process.env[key];
      else process.env[key] = oldValue;
    }
  }
});
async function seedRetainedLiveAutoFill(repository: InMemoryTradingRepository, nowMs: number) {
  const timestamp = new Date(nowMs).toISOString();
  await repository.savePlan({
    id: 'retained-live-plan', userId: USER, idempotencyKey: 'retained-live-entry',
    state: 'FILLED', version: 1, accountMode: 'live', executionMode: 'automatic',
    exchange: 'upbit', strategyId: 'trend-breakout-v1',
    signalId: 'retained-live-signal', symbol: 'BTC', market: 'UPBIT',
    side: 'buy', orderType: 'market', quantity: 0.1, quoteAmount: null,
    limitPrice: null, estimatedKrw: 100_000, stopPrice: 95_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null,
    marginMode: null, reduceOnly: false, signalReasons: ['CANONICAL_LIVE_AUTO_HANDOFF'],
    marketSnapshot: { observedAt: timestamp },
    approvedAt: timestamp, approvalExpiresAt: null,
    createdAt: timestamp, updatedAt: timestamp,
  } as any);
  await repository.saveOrder({
    id: 'retained-live-order', userId: USER, planId: 'retained-live-plan',
    exchange: 'upbit', clientOrderId: 'retained-live-oid',
    exchangeOrderId: 'retained-live-exchange-order', state: 'FILLED',
    requestedQuantity: 0.1, filledQuantity: 0.1,
    averageFillPrice: 100_000, retryCount: 0, lastErrorCode: null,
    createdAt: timestamp, updatedAt: timestamp,
  } as any);
}

test('expired automatic member retains read-only Live fill visibility and has zero order authority', async () => {
  const flags = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(flags.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy());
  await seedRetainedLiveAutoFill(repository, nowMs);
  const base = source(repository, nowMs, { expired: true, tier: 'associate' });
  let providerReads = 0;
  let projectionCalls = 0;
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async readLiveAccountSnapshot() {
      providerReads += 1;
      throw new Error('REVOKED_MEMBER_PROVIDER_IO_FORBIDDEN');
    },
    async syncExecutionEvents() {
      projectionCalls += 1;
      throw new Error('REVOKED_MEMBER_PROJECTION_IO_FORBIDDEN');
    },
  });
  try {
    for (const flag of flags) process.env[flag] = 'true';
    const result = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(result.liveTrackedPositions, 1);
    assert.equal(result.liveExitsSuppressedByPolicy, 1);
    assert.equal(result.liveEntryWarmupComplete, false);
    assert.equal(result.newEntriesFailClosed, true);
    assert.equal(result.liveOrders, 0);
    assert.equal(result.liveExitOrders, 0);
    assert.equal(result.createdPlans, 0);
    assert.equal(providerReads, 0);
    assert.equal(projectionCalls, 0);
    assert.equal((await repository.listOrders(USER)).length, 1);
  } finally {
    for (const flag of flags) {
      const value = previous[flag];
      if (value == null) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
});

test('blocked member evidence survives paginated warmup and cannot be erased by a ready later batch', async () => {
  const flags = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
  ] as const;
  const previous = Object.fromEntries(flags.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const readyUser = '22222222-2222-2222-2222-222222222222';
  const readyPolicy = allFourPolicy();
  await repository.savePolicy(USER, policy());
  await repository.savePolicy(readyUser, readyPolicy);
  await seedRetainedLiveAutoFill(repository, nowMs);
  const base = source(repository, nowMs);
  let batch = 0;
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    // Isolate the pagination/warmup regression from unrelated Paper risk
    // evaluations, which can legitimately trip the persistent kill switch.
    async readHandoff() {
      const ready = await base.readHandoff(nowMs);
      return ready ? { ...ready, entries: [], entryCount: 0 } as never : null;
    },
    async listEligibleMembers() {
      batch += 1;
      if (batch === 1) return [{
        userId: USER,
        policy: policy(),
        profile: {
          role: 'user', membership_level: 'associate', status: 'approved',
          is_active: false,
        },
      }] as never;
      return [{
        userId: readyUser,
        policy: readyPolicy,
        profile: {
          role: 'admin', membership_level: 'admin', status: 'approved',
          is_active: true,
        },
      }] as never;
    },
    memberBatchCycleCompleted() { return batch > 1; },
    async readLiveAccountSnapshot() {
      throw new Error('UNARMED_LIVE_IO_FORBIDDEN');
    },
  });
  try {
    for (const flag of flags) process.env[flag] = 'true';
    const first = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(first.liveReadinessCycleComplete, false);
    assert.equal(first.liveTrackedPositions, 1);
    assert.equal(first.liveExitsSuppressedByPolicy, 1);
    assert.equal(first.liveEntryWarmupComplete, false);

    const completed = await withFetchMock(() => worker.runOnce(new Date(nowMs + 15_000)));
    assert.equal(completed.liveReadinessCycleComplete, true);
    assert.equal(completed.liveAllFourPolicyReadyMembers, 1);
    assert.equal(completed.liveCycleAllFourPolicyReady, false);
    assert.equal(completed.liveEntryWarmupComplete, false);
    assert.equal(completed.newEntriesFailClosed, true);
    assert.equal(completed.liveOrders, 0);

    // A wholly new clean rotation may re-establish readiness. A blocked
    // completed cycle must never count as its own clean recovery proof.
    const recovered = await withFetchMock(() => worker.runOnce(new Date(nowMs + 30_000)));
    assert.equal(recovered.liveEntryWarmupComplete, true);
    assert.equal(recovered.liveEntriesArmed, false);
    assert.equal(recovered.liveOrders, 0);
  } finally {
    for (const flag of flags) {
      const value = previous[flag];
      if (value == null) delete process.env[flag];
      else process.env[flag] = value;
    }
  }
});
test('armed Live worker cannot bypass an unfilled Paper mirror to call a private provider', async () => {
  const flags = [
    'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED', 'AUTO_TRADING',
    'LIVE_AUTOMATIC_TRADING_ENABLED', 'LIVE_TRADING',
    'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
    'DEPLOY_SHA', 'MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH',
  ] as const;
  const previous = Object.fromEntries(flags.map((key) => [key, process.env[key]]));
  const nowMs = Date.now();
  const repository = new InMemoryTradingRepository();
  const rule = normalizeTradingPolicy({ ...allFourPolicy(), maxOrderKrw: 5_000 });
  await repository.savePolicy(USER, rule);
  const root = await mkdtemp(join(tmpdir(), 'auto-paper-paired-admission-'));
  const armPath = join(root, 'arm.json');
  const targetSha = 'f'.repeat(40);
  const base = source(repository, nowMs, { tier: 'admin' });
  let providerReads = 0;
  const worker = new MemberAutoTradingBackgroundWorker({
    ...base,
    async listEligibleMembers() {
      return [{
        userId: USER, policy: rule,
        profile: { role: 'admin', membership_level: 'admin', status: 'approved', is_active: true },
      }] as never;
    },
    async readLiveAccountSnapshot() {
      providerReads++;
      throw new Error('LIVE_PROVIDER_READ_NOT_ALLOWED_WITHOUT_FILLED_PAPER');
    },
  });
  try {
    for (const flag of flags.slice(0, 6)) process.env[flag] = 'true';
    process.env.DEPLOY_SHA = targetSha;
    process.env.MEMBER_AUTO_TRADING_LIVE_ENTRY_ARM_PATH = armPath;
    const first = await withFetchMock(() => worker.runOnce(new Date(nowMs)));
    assert.equal(first.liveEntryWarmupComplete, true);
    assert.equal(first.liveOrders, 0);
    assert.equal(first.filledOrders, 0);

    await writeFile(armPath, JSON.stringify({
      schemaVersion: 'member-auto-trading-live-entry-arm-v1',
      armed: true,
      targetSha,
      armedAt: new Date(nowMs + 100).toISOString(),
      activateNotBeforeAt: new Date(nowMs + 200).toISOString(),
    }) + '\n', { mode: 0o600, flag: 'wx' });

    const blocked = await withFetchMock(() => worker.runOnce(new Date(nowMs + 2_000)));
    assert.equal(blocked.liveEntriesArmed, true);
    assert.equal(blocked.filledOrders, 0);
    assert.equal(blocked.liveOrders, 0);
    assert.equal(blocked.newEntriesFailClosed, true);
    assert.equal(providerReads, 0);
    assert.equal((await repository.listPlans(USER)).filter((plan) => plan.accountMode === 'live').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const flag of flags) {
      const old = previous[flag];
      if (old == null) delete process.env[flag];
      else process.env[flag] = old;
    }
  }
});
