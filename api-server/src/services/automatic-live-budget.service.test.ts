import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { projectAutomaticLiveBudget, automaticLiveBudgetRequired } from './automatic-live-budget.service';
import { DEFAULT_TRADING_POLICY, type TradingOrder, type TradingPlan, type TradingPolicy } from './trade-automation.types';

const userId = '11111111-1111-1111-1111-111111111111';
function policy(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  return { ...structuredClone(DEFAULT_TRADING_POLICY), mode: 'automatic', automaticEnabled: true,
    enabledStrategies: ['formula-test'], totalCapitalKrw: 400_000, maxOrderKrw: 100_000,
    maxInstrumentKrw: 100_000, maxAssetPercent: 100, maxOpenPositions: 8,
    totalDailyLossLimitPercent: 2,
    marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    exchangeEnabled: { toss: true, kiwoom: true, upbit: true, bitget: true },
    maxAssetClassKrw: { domestic_stock: 100_000, us_stock: 100_000, crypto_spot: 100_000, crypto_futures: 100_000 },
    ...overrides } as TradingPolicy;
}
function plan(id: string, overrides: Partial<TradingPlan> = {}): TradingPlan {
  return { id, userId, version: 0, state: 'SUBMITTED', idempotencyKey: id,
    executionMode: 'automatic', accountMode: 'live', exchange: 'upbit', market: 'KRW',
    symbol: id, strategyId: 'formula-test', signalId: `signal-${id}`, signalReasons: [],
    side: 'buy', reduceOnly: false, orderType: 'limit', quantity: 1,
    estimatedKrw: 70_000, stopPrice: 99, limitPrice: 100, targetPrices: [105],
    splitRatios: [100], approvedAt: null, approvalExpiresAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    marketSnapshot: { currentPrice: 100, openPositionCount: 0 } as TradingPlan['marketSnapshot'], ...overrides };
}
function order(parent: TradingPlan, overrides: Partial<TradingOrder> = {}): TradingOrder {
  return { id: `order-${parent.id}`, planId: parent.id, userId: parent.userId,
    exchange: parent.exchange, state: 'SUBMITTED', version: 0, clientOrderId: `client-${parent.id}`,
    exchangeOrderId: null, requestedQuantity: 1, remainingQuantity: 1, filledQuantity: 0,
    averageFillPrice: null, retryCount: 0, lastErrorCode: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}
async function setup(overrides: Partial<TradingPolicy> = {}) {
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(userId, policy(overrides));
  return repository;
}
async function seed(repository: InMemoryTradingRepository, parent: TradingPlan) {
  const child = order(parent);
  await repository.savePlan(parent); await repository.saveOrder(child);
  return child;
}

test('distinct simultaneous AUTO signals cannot oversubscribe one market; no financial transport exists', async () => {
  const repo = await setup();
  const first = await seed(repo, plan('BTC')); const second = await seed(repo, plan('ETH'));
  const results = await Promise.allSettled([
    repo.claimAutomaticLiveEntry(first, 0, 'claim-first'), repo.claimAutomaticLiveEntry(second, 0, 'claim-second'),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled' && row.value != null).length, 1);
  assert.match((results.find((row) => row.status === 'rejected') as PromiseRejectedResult).reason.message,
    /BUDGET_MARKET_EXCEEDED/);
  assert.equal((await repo.listOrders(userId)).filter((row) => row.executionClaimId).length, 1);
  assert.ok((await repo.listOrders(userId)).every((row) => !row.submissionStartedAt));
});

test('cross-market aggregate capital and same-instrument duplication are independently blocked', async () => {
  const repo = await setup({ totalCapitalKrw: 100_000 });
  const first = await seed(repo, plan('BTC')); const us = await seed(repo, plan('AAPL', { exchange: 'kiwoom', market: 'US' }));
  assert.ok(await repo.claimAutomaticLiveEntry(first, 0, 'claim-first'));
  await assert.rejects(repo.claimAutomaticLiveEntry(us, 0, 'claim-us'), /BUDGET_TOTAL_EXCEEDED/);
  const duplicate = await seed(repo, plan('BTC-duplicate', { symbol: 'BTC', estimatedKrw: 10_000 }));
  await assert.rejects(repo.claimAutomaticLiveEntry(duplicate, 0, 'claim-duplicate'), /DUPLICATE_INSTRUMENT/);
});

test('unknown submission, elapsed lease and partial fills keep the whole reservation until terminal proof', async () => {
  const repo = await setup(); const first = await seed(repo, plan('BTC'));
  const claimed = (await repo.claimAutomaticLiveEntry(first, 0, 'claim-first'))!;
  await repo.saveOrder({ ...claimed, state: 'RECOVERY_REQUIRED', submissionStartedAt: '2026-01-01T00:00:00Z' });
  const second = await seed(repo, plan('ETH', { estimatedKrw: 40_000 }));
  await assert.rejects(repo.claimAutomaticLiveEntry(second, 0, 'claim-second'), /BUDGET_MARKET_EXCEEDED/);
  await repo.saveOrder({ ...claimed, state: 'PARTIALLY_FILLED', filledQuantity: 0.1, remainingQuantity: 0.9 });
  await assert.rejects(repo.claimAutomaticLiveEntry(second, 0, 'claim-second'), /BUDGET_MARKET_EXCEEDED/);
  await repo.saveOrder({ ...claimed, state: 'CANCELED', filledQuantity: 0, lastReconciledAt: null });
  await assert.rejects(repo.claimAutomaticLiveEntry(second, 0, 'claim-second'), /BUDGET_MARKET_EXCEEDED/);
  await repo.saveOrder({ ...claimed, state: 'CANCELED', filledQuantity: 0, lastReconciledAt: new Date().toISOString() });
  assert.ok(await repo.claimAutomaticLiveEntry(second, 0, 'claim-second'));
});

test('local pre-submit rejection releases its hold but an ambiguous provider rejection does not', async () => {
  for (const attempted of [false, true]) {
    const repo = await setup(); const first = await seed(repo, plan('BTC'));
    const claimed = (await repo.claimAutomaticLiveEntry(first, 0, 'claim-first'))!;
    await repo.saveOrder({ ...claimed, state: 'REJECTED', submissionStartedAt: attempted ? new Date().toISOString() : null });
    const second = await seed(repo, plan('ETH'));
    if (attempted) await assert.rejects(repo.claimAutomaticLiveEntry(second, 0, 'claim-second'), /BUDGET_MARKET_EXCEEDED/);
    else assert.ok(await repo.claimAutomaticLiveEntry(second, 0, 'claim-second'));
  }
});

test('confirmed full canonical exit releases principal; a wrong-direction or partial exit cannot', async () => {
  for (const mode of ['full', 'partial', 'wrong-side']) {
    const repo = await setup(); const parent = plan('BTC'); const first = await seed(repo, parent);
    const claimed = (await repo.claimAutomaticLiveEntry(first, 0, 'claim-first'))!;
    await repo.saveOrder({ ...claimed, state: 'FILLED', filledQuantity: 1, remainingQuantity: 0, averageFillPrice: 100 });
    const exit = plan('exit', { symbol: parent.symbol, reduceOnly: true,
      side: mode === 'wrong-side' ? 'buy' : 'sell', signalReasons: [`AUTO_EXIT_ENTRY_PLAN:${parent.id}`] });
    await repo.savePlan(exit);
    await repo.saveOrder(order(exit, { state: 'FILLED', filledQuantity: mode === 'partial' ? 0.5 : 1, averageFillPrice: 101 }));
    const second = await seed(repo, plan('ETH'));
    if (mode === 'full') assert.ok(await repo.claimAutomaticLiveEntry(second, 0, 'claim-second'));
    else await assert.rejects(repo.claimAutomaticLiveEntry(second, 0, 'claim-second'),
      mode === 'wrong-side' ? /EXIT_DIRECTION_INVALID/ : /BUDGET_MARKET_EXCEEDED/);
  }
});

test('already-open legacy AUTO fills are charged without adopting manual or Paper holdings', async () => {
  const repo = await setup(); const existing = plan('legacy');
  await repo.savePlan(existing); await repo.saveOrder(order(existing, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 100 }));
  const manual = plan('manual', { executionMode: 'manual', estimatedKrw: 5_000_000 });
  await repo.savePlan(manual); await repo.saveOrder(order(manual, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 100 }));
  const paper = plan('paper', { accountMode: 'paper', estimatedKrw: 5_000_000 });
  await repo.savePlan(paper); await repo.saveOrder(order(paper, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 100 }));
  const next = await seed(repo, plan('next', { estimatedKrw: 40_000 }));
  await assert.rejects(repo.claimAutomaticLiveEntry(next, 0, 'claim-next'), /BUDGET_MARKET_EXCEEDED/);
});

test('policy tightening is rechecked after claim and the legacy per-order path cannot bypass AUTO budget', async () => {
  const repo = await setup(); const parent = plan('BTC'); const first = await seed(repo, parent);
  await assert.rejects(repo.claimOrderExecution(first, 0, 'old-claim'), /ATOMIC_BUDGET_CLAIM_REQUIRED/);
  const claimed = (await repo.claimAutomaticLiveEntry(first, 0, 'claim-first'))!;
  await repo.assertAutomaticLiveEntryBudget(parent);
  await repo.savePolicy(userId, policy({ maxAssetClassKrw: { ...policy().maxAssetClassKrw, crypto_spot: 50_000 } }));
  await assert.rejects(repo.assertAutomaticLiveEntryBudget(parent), /BUDGET_MARKET_EXCEEDED/);
  assert.equal(await repo.claimAutomaticLiveEntry(first, 0, 'stale-claim'), null);
  assert.equal(claimed.submissionStartedAt ?? null, null);
  assert.equal(automaticLiveBudgetRequired({ ...parent, reduceOnly: true }), false);
});

test('foreign history, duplicate IDs, missing policy, invalid cap and unknown hold lineage fail closed', async () => {
  const parent = plan('BTC'); const child = order(parent);
  const valid = { policy: policy(), emergencyStopped: false, plans: [parent], orders: [child], holds: [] };
  for (const bad of [
    { ...valid, plans: [{ ...parent, userId: 'foreign' }] },
    { ...valid, orders: [child, child] },
    { ...valid, policy: null },
    { ...valid, policy: policy({ maxOrderKrw: Number.NaN }) },
    { ...valid, holds: [{ orderId: 'missing', market: 'crypto_spot', instrument: 'BTC', strategy: 'x', amountKrw: 1, riskKrw: 0 }] },
  ]) await assert.rejects(projectAutomaticLiveBudget(bad, userId, child.id, (value) => {
    if (!value) throw new Error('POLICY_REQUIRED'); return value;
  }));
});
