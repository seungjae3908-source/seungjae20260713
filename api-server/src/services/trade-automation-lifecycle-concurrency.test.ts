import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingExchange,
  type TradingPlan,
  type TradingPlanInput,
} from './trade-automation.types';

const USER = '33333333-3333-3333-3333-333333333333';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class CoordinatedRepository extends InMemoryTradingRepository {
  private blockSubmittedSave = false;
  private blockConnectionRead = false;
  readonly submittedSaveReached = deferred();
  readonly releaseSubmittedSave = deferred();
  readonly connectionReadReached = deferred();
  readonly releaseConnectionRead = deferred();

  blockNextSubmittedPlanSave() { this.blockSubmittedSave = true; }
  blockNextConnectionRead() { this.blockConnectionRead = true; }

  override async compareAndSetPlan(plan: TradingPlan, expectedState: TradingPlan['state']) {
    const result = await super.compareAndSetPlan(plan, expectedState);
    if (this.blockSubmittedSave && result?.state === 'SUBMITTED') {
      this.blockSubmittedSave = false;
      this.submittedSaveReached.resolve();
      await this.releaseSubmittedSave.promise;
    }
    return result;
  }

  override async getConnection(userId: string, exchange: TradingExchange) {
    const connection = await super.getConnection(userId, exchange);
    if (this.blockConnectionRead) {
      this.blockConnectionRead = false;
      this.connectionReadReached.resolve();
      await this.releaseConnectionRead.promise;
    }
    return connection;
  }
}

function paperPlan(signalId: string): TradingPlanInput {
  const now = Date.now();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId,
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 40_000, limitPrice: null, estimatedKrw: 40_000, stopPrice: 98_000,
    targetPrices: [104_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend'],
    signalState: 'confirmed', signalExpiresAt: new Date(now + 300_000).toISOString(),
    entryPrice: 100_000, entryZoneLow: 99_000, entryZoneHigh: 101_000,
    estimatedSlippagePercent: 0.1, averageSpreadPercent: 0.1,
    economics: {
      sampleSize: 80, winProbability: 0.55, averageWinR: 1.5, averageLossR: 1,
      estimatedCostsR: 0.05, profitFactor: 1.4, maxDrawdownPercent: 8,
      marketRegime: 'bull', calibratedAt: new Date(now).toISOString(),
    },
    marketSnapshot: {
      observedAt: new Date(now).toISOString(), dataDelayMs: 100, oneMinuteMovePercent: 0,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 1_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, correlatedExposurePercent: 0,
    },
  };
}

async function configuredRepository(repository = new CoordinatedRepository()) {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  await repository.saveConnection({
    userId: USER, exchange: 'upbit', accountMode: 'paper', configured: true,
    encryptedCredentials: 'paper-test-only', lastVerifiedAt: null, lastErrorCode: null,
    updatedAt: new Date().toISOString(),
  });
  return { repository, policy };
}

test('invalidation queued during approval expires the submitted plan before order creation', async () => {
  const { repository, policy } = await configuredRepository();
  const automation = new TradeAutomationService(repository);
  const created = await automation.createPlan(USER, paperPlan('approve-invalidate-race'), policy, false);
  assert.ok(created.plan);

  repository.blockNextSubmittedPlanSave();
  const approval = automation.approvePlan(USER, created.plan.id);
  await repository.submittedSaveReached.promise;
  const invalidation = automation.invalidatePlan(USER, created.plan.id);
  repository.releaseSubmittedSave.resolve();

  const approved = await approval;
  const invalidated = await invalidation;
  assert.equal(approved.state, 'SUBMITTED');
  assert.equal(invalidated.plan.state, 'EXPIRED');
  assert.equal((await repository.getPlan(USER, approved.id))?.state, 'EXPIRED');
  assert.equal(invalidated.order, null);
  await assert.rejects(() => automation.createOrder(USER, approved), /TRADE_PLAN_NOT_SUBMITTED/);
  assert.equal((await repository.listOrders(USER)).length, 0);
  assert.equal((await repository.listEvents(USER)).length, 0);
});

test('duplicate paper execution is serialized and emits each lifecycle event once', async () => {
  const { repository, policy } = await configuredRepository();
  const automation = new TradeAutomationService(repository);
  const execution = new TradeExecutionService(repository);
  const created = await automation.createPlan(USER, paperPlan('duplicate-execution-race'), policy, false);
  const approved = await automation.approvePlan(USER, created.plan!.id);
  const { order } = await automation.createOrder(USER, approved);

  const nativeFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = (async () => {
    externalRequests += 1;
    throw new Error('external request blocked');
  }) as typeof fetch;
  try {
    const results = await Promise.all([
      execution.execute(USER, approved, order),
      execution.execute(USER, approved, order),
    ]);
    assert.deepEqual(results.map((result) => result.state), ['FILLED', 'FILLED']);
    const reasons = (await repository.listEvents(USER)).map((event) => event.reason);
    for (const reason of ['ORDER_CREATED', 'PAPER_BROKER_ACCEPTED', 'PAPER_BROKER_FILLED']) {
      assert.equal(reasons.filter((value) => value === reason).length, 1, reason);
    }
    assert.equal(externalRequests, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('invalidation waits for an in-flight paper execution and observes the terminal order', async () => {
  const { repository, policy } = await configuredRepository();
  const automation = new TradeAutomationService(repository);
  const execution = new TradeExecutionService(repository);
  const created = await automation.createPlan(USER, paperPlan('execute-invalidate-race'), policy, false);
  const approved = await automation.approvePlan(USER, created.plan!.id);
  const { order } = await automation.createOrder(USER, approved);

  repository.blockNextConnectionRead();
  const executing = execution.execute(USER, approved, order);
  await repository.connectionReadReached.promise;
  const invalidating = automation.invalidatePlan(USER, approved.id);
  repository.releaseConnectionRead.resolve();

  const executed = await executing;
  const invalidated = await invalidating;
  assert.equal(executed.state, 'FILLED');
  assert.equal(invalidated.order?.state, 'FILLED');
  const reasons = (await repository.listEvents(USER)).map((event) => event.reason);
  assert.equal(reasons.filter((value) => value === 'PAPER_BROKER_ACCEPTED').length, 1);
  assert.equal(reasons.filter((value) => value === 'PAPER_BROKER_FILLED').length, 1);
  assert.equal(reasons.includes('SIGNAL_INVALIDATED_CANCEL_UNFILLED_REMAINDER'), false);
});

test('emergency stop is rechecked immediately before paper execution', async () => {
  const { repository, policy } = await configuredRepository();
  const automation = new TradeAutomationService(repository);
  const execution = new TradeExecutionService(repository);
  const created = await automation.createPlan(USER, paperPlan('execution-emergency-stop'), policy, false);
  const approved = await automation.approvePlan(USER, created.plan!.id);
  const { order } = await automation.createOrder(USER, approved);
  await repository.savePolicy(USER, normalizeTradingPolicy({ ...policy, emergencyStopped: true }));

  const nativeFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = (async () => {
    externalRequests += 1;
    throw new Error('external request blocked');
  }) as typeof fetch;
  try {
    const result = await execution.execute(USER, approved, order);
    assert.equal(result.state, 'REJECTED');
    assert.equal(result.lastErrorCode, 'EMERGENCY_STOP_ACTIVE');
    assert.equal(externalRequests, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
