import test from 'node:test';
import assert from 'node:assert/strict';
import type { TradingOrderEvent, TradingPlan } from './trade-automation.types';
import { materializeSplitOrders, type SplitTradingOrder } from './trade-split-order-materializer.service';
import type { CreateSplitOrdersInput, SplitOrderRepository } from './trade-split-order.repository';
import { TradeSplitOrderExecutionService } from './trade-split-order-execution.service';

function plan(): TradingPlan {
  const now = '2026-08-05T10:00:00.000Z';
  return {
    id: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222',
    idempotencyKey: 'split-plan', state: 'SUBMITTED', version: 7, approvalExpiresAt: null, approvedAt: now,
    createdAt: now, updatedAt: now, exchange: 'upbit', accountMode: 'mock', strategyId: 'split-v1', signalId: 'signal-1',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'limit', quantity: 1, quoteAmount: 100_000,
    limitPrice: 100_000, estimatedKrw: 100_000, stopPrice: 95_000, targetPrices: [110_000], splitRatios: [50, 30, 20],
    signalReasons: ['trend'], marketSnapshot: { observedAt: now, dataDelayMs: 0, oneMinuteMovePercent: 0,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 1_000_000, dailyPnlPercent: 0, assetExposurePercent: 0, openPositionCount: 0,
      dailyOrderCount: 0, consecutiveLosses: 0 },
  };
}

class MemoryRepository implements SplitOrderRepository {
  orders: SplitTradingOrder[] = [];
  createCalls = 0;
  activateCalls = 0;
  async listOrdersByPlan() { return structuredClone(this.orders); }
  async createSplitOrdersAtomic(input: CreateSplitOrdersInput) {
    this.createCalls += 1;
    this.orders = structuredClone(input.orders);
    return structuredClone(this.orders);
  }
  async activateNextChildAtomic(order: SplitTradingOrder, _event: TradingOrderEvent) {
    this.activateCalls += 1;
    const activated = { ...order, state: 'SUBMITTED' as const, version: Number(order.version ?? 0) + 1 };
    this.orders = this.orders.map((candidate) => candidate.id === order.id ? activated : candidate);
    return structuredClone(activated);
  }
}

test('creates child batch once and exposes only first child provider payload', async () => {
  const repository = new MemoryRepository();
  const service = new TradeSplitOrderExecutionService(repository);
  const first = await service.ensureChildren(plan());
  const replay = await service.ensureChildren(plan());
  assert.equal(repository.createCalls, 1);
  assert.equal(first.executable?.legSequenceNo, 1);
  assert.equal(first.providerPayload?.requestedQuantity, 0.5);
  assert.equal(first.providerPayload?.requestedQuoteAmount, 50_000);
  assert.equal(replay.executable?.id, first.executable?.id);
});

test('activates exactly the next child only after persisted fill', async () => {
  const repository = new MemoryRepository();
  repository.orders = materializeSplitOrders(plan());
  repository.orders[0] = { ...repository.orders[0]!, state: 'FILLED', filledQuantity: 0.5 };
  const service = new TradeSplitOrderExecutionService(repository);
  const result = await service.activateAfterFill(repository.orders[0]!);
  assert.equal(repository.activateCalls, 1);
  assert.equal(result.executable?.legSequenceNo, 2);
  assert.equal(result.providerPayload?.requestedQuantity, 0.3);
  assert.equal(result.orders[2]?.state, 'PLANNED');
});

test('recovery is lookup-only and never recreates or activates children', async () => {
  const repository = new MemoryRepository();
  repository.orders = materializeSplitOrders(plan());
  const service = new TradeSplitOrderExecutionService(repository);
  const result = await service.recoverLookupOnly(plan().userId, plan().id, 7);
  assert.equal(repository.createCalls, 0);
  assert.equal(repository.activateCalls, 0);
  assert.equal(result.executable?.legSequenceNo, 1);
});

test('fails closed when more than one child is active', async () => {
  const repository = new MemoryRepository();
  repository.orders = materializeSplitOrders(plan()).map((order, index) => index < 2 ? { ...order, state: 'SUBMITTED' } : order);
  const service = new TradeSplitOrderExecutionService(repository);
  await assert.rejects(() => service.recoverLookupOnly(plan().userId, plan().id, 7), /TRADE_SPLIT_MULTIPLE_ACTIVE_CHILDREN/);
});
