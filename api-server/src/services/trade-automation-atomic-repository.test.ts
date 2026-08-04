import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { TradeAutomationService } from './trade-automation.service';
import {
  DEFAULT_TRADING_POLICY,
  type TradingOrder,
  type TradingPlan,
  type TradingPlanInput,
} from './trade-automation.types';

const USER = '44444444-4444-4444-4444-444444444444';

function input(signalId: string): TradingPlanInput {
  const now = Date.now();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'atomic-v1', signalId,
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 40_000, limitPrice: null, estimatedKrw: 40_000, stopPrice: 98_000,
    targetPrices: [104_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['atomic-contract'],
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

function order(plan: TradingPlan, id = randomUUID()): TradingOrder {
  const now = new Date().toISOString();
  return {
    id, userId: plan.userId, planId: plan.id, exchange: plan.exchange,
    clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
    exchangeOrderId: null, state: 'SUBMITTED', requestedQuantity: plan.quantity ?? null,
    filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
    createdAt: now, updatedAt: now,
  };
}

class AtomicProbeRepository extends InMemoryTradingRepository {
  insertPlanCalls = 0;
  compareAndSetPlanCalls = 0;
  insertOrderCalls = 0;

  override async insertPlan(plan: TradingPlan) {
    this.insertPlanCalls += 1;
    return super.insertPlan(plan);
  }

  override async compareAndSetPlan(plan: TradingPlan, expectedState: TradingPlan['state']) {
    this.compareAndSetPlanCalls += 1;
    return super.compareAndSetPlan(plan, expectedState);
  }

  override async insertOrder(candidate: TradingOrder) {
    this.insertOrderCalls += 1;
    return super.insertOrder(candidate);
  }
}

test('atomic repository returns the existing plan for duplicate idempotency', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await service.createPlan(USER, input('atomic-plan'), policy, false);
  assert.ok(created.plan);

  const duplicateCandidate: TradingPlan = {
    ...created.plan,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const duplicate = await repository.insertPlan(duplicateCandidate);

  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.plan.id, created.plan.id);
  assert.equal((await repository.listPlans(USER)).length, 1);
});

test('plan compare-and-set applies one expected-state transition only', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await service.createPlan(USER, input('atomic-cas'), policy, false);
  assert.ok(created.plan);

  const submitted: TradingPlan = {
    ...created.plan,
    state: 'SUBMITTED',
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const first = await repository.compareAndSetPlan(submitted, 'APPROVAL_PENDING');
  const second = await repository.compareAndSetPlan({ ...submitted, updatedAt: new Date().toISOString() }, 'APPROVAL_PENDING');

  assert.equal(first?.state, 'SUBMITTED');
  assert.equal(second, null);
  assert.equal((await repository.getPlan(USER, submitted.id))?.state, 'SUBMITTED');
});

test('concurrent repository CAS and order inserts produce one winner', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await service.createPlan(USER, input('atomic-race'), policy, false);
  assert.ok(created.plan);

  const firstSubmitted: TradingPlan = {
    ...created.plan,
    state: 'SUBMITTED',
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const secondSubmitted: TradingPlan = {
    ...firstSubmitted,
    approvedAt: new Date(Date.now() + 1).toISOString(),
    updatedAt: new Date(Date.now() + 1).toISOString(),
  };
  const casResults = await Promise.all([
    repository.compareAndSetPlan(firstSubmitted, 'APPROVAL_PENDING'),
    repository.compareAndSetPlan(secondSubmitted, 'APPROVAL_PENDING'),
  ]);
  assert.equal(casResults.filter(Boolean).length, 1);

  const persisted = await repository.getPlan(USER, created.plan.id);
  assert.ok(persisted);
  const orderResults = await Promise.all([
    repository.insertOrder(order(persisted)),
    repository.insertOrder(order(persisted)),
  ]);
  assert.equal(orderResults.filter((result) => result.inserted).length, 1);
  assert.equal(new Set(orderResults.map((result) => result.order.id)).size, 1);
  assert.equal((await repository.listOrders(USER)).length, 1);
});

test('atomic repository returns the existing order for one plan and client order id', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const created = await service.createPlan(USER, input('atomic-order'), policy, false);
  const approved = await service.approvePlan(USER, created.plan!.id);
  const firstOrder = order(approved);
  const secondOrder = order(approved);

  const first = await repository.insertOrder(firstOrder);
  const second = await repository.insertOrder(secondOrder);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.order.id, first.order.id);
  assert.equal((await repository.listOrders(USER)).length, 1);
});

test('trade service uses insert and compare-and-set repository primitives', async () => {
  const repository = new AtomicProbeRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);

  const created = await service.createPlan(USER, input('atomic-service-path'), policy, false);
  const approved = await service.approvePlan(USER, created.plan!.id);
  const createdOrder = await service.createOrder(USER, approved);
  const duplicateOrder = await service.createOrder(USER, approved);

  assert.equal(repository.insertPlanCalls, 1);
  assert.equal(repository.compareAndSetPlanCalls, 1);
  assert.equal(repository.insertOrderCalls, 1);
  assert.equal(createdOrder.duplicate, false);
  assert.equal(duplicateOrder.duplicate, true);
  assert.equal(duplicateOrder.order.id, createdOrder.order.id);
  assert.equal((await repository.listEvents(USER)).filter((event) => event.reason === 'ORDER_CREATED').length, 1);
});
