import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { DEFAULT_TRADING_POLICY, type TradingPolicy } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import type { PaperJournalRepository } from './paper-journal.types';
import {
  MemberAutoTradingBackgroundWorker,
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
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false },
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
  options: { missingRecentMove?: boolean; tier?: 'pending' | 'associate' } = {},
): MemberAutoTradingBackgroundSource {
  return {
    async readHandoff() { return handoff(nowMs, options.missingRecentMove) as never; },
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

  const second = await withFetchMock(() => worker.runOnce(new Date(nowMs + 1_000)));
  assert.equal((await repository.listOrders(USER)).length, 1);
  assert.equal(second.createdPlans, 0);
  assert.ok(second.duplicates >= 1);
  assert.equal(second.liveOrders, 0);
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
