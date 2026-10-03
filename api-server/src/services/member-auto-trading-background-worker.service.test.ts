import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { DEFAULT_TRADING_POLICY, type TradingPolicy } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import type { PaperJournalRepository } from './paper-journal.types';
import {
  MemberAutoTradingBackgroundWorker,
  liveBackgroundEnabled,
  marketMapping,
  resolveMemberStockBroker,
  startMemberAutoTradingBackgroundWorker,
  type MemberAutoTradingBackgroundSource,
} from './member-auto-trading-background-worker.service';

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
    tier?: 'pending' | 'associate';
    handoffMissing?: boolean;
    markPrice?: number;
    syncCalls?: { count: number };
    syncFailure?: boolean;
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
          role: 'user',
          status: options.tier === 'pending' ? 'pending' : 'approved',
          is_active: true,
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
        return { inserted: 1, deliveryQueued: 1, missingReferences: 0 };
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

test('stock automatic routing uses the selected Toss or Kiwoom provider as the canonical exchange', () => {
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
    exchange: 'toss', assetClass: 'us_stock', planMarket: 'US', stockBroker: 'toss',
  });
  const kiwoom = normalizeTradingPolicy({
    ...base,
    stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
    exchangeEnabled: { ...base.exchangeEnabled, toss: false, kiwoom: true },
  });
  assert.equal(marketMapping('KR_STOCK', kiwoom).exchange, 'kiwoom');
  assert.equal(marketMapping('US_STOCK', kiwoom).exchange, 'kiwoom');
});

test('background worker is default OFF without explicit activation flag', () => {
  const previous = process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
  delete process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
  try {
    assert.equal(startMemberAutoTradingBackgroundWorker(), null);
  } finally {
    if (previous == null) delete process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED;
    else process.env.MEMBER_AUTO_TRADING_BACKGROUND_ENABLED = previous;
  }
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
  assert.equal(result.privateTradingRequests, 0);
});

test('execution event fan-out failure is non-fatal to canonical trading state and is observable', async () => {
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
  assert.equal(result.failures, 0);
  assert.equal(result.createdPlans, 1);
  assert.equal(result.filledOrders, 1);
  assert.equal((await repository.listOrders(USER))[0]?.state, 'FILLED');
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
