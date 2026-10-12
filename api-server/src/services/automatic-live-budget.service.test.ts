import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { projectAutomaticLiveBudget, automaticLiveBudgetRequired, assertAutomaticLiveBudgetProjection } from './automatic-live-budget.service';
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
    feeAmount: 0, feeCurrency: 'KRW', taxAmount: 0, taxCurrency: 'KRW',
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
    await repo.saveOrder({ ...claimed, state: 'PARTIALLY_FILLED', filledQuantity: 0.1, remainingQuantity: 0.9, averageFillPrice: 100 });
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

test('actual fill slippage and fees revalue both held and legacy orders before the next entry', async () => {
  for (const reserved of [true, false]) {
    const repo = await setup();
    const parent = plan(`filled-${reserved}`, { limitPrice: 70_000, stopPrice: 69_000,
      marketSnapshot: { currentPrice: 70_000, openPositionCount: 0 } as TradingPlan['marketSnapshot'] });
    const child = await seed(repo, parent);
    const claimed = reserved ? (await repo.claimAutomaticLiveEntry(child, 0, 'first'))! : child;
    await repo.saveOrder({ ...claimed, state: 'FILLED', filledQuantity: 1, remainingQuantity: 0,
      averageFillPrice: 72_000, feeAmount: 100 });
    const next = await seed(repo, plan(`next-${reserved}`, { estimatedKrw: 29_000 }));
    await assert.rejects(repo.claimAutomaticLiveEntry(next, 0, 'second'), /BUDGET_MARKET_EXCEEDED/);
  }
});

test('one repriced held order remains one position and never frees its original reservation on partial close', async () => {
  const repo = await setup({ maxOpenPositions: 2, maxAssetClassKrw: { ...policy().maxAssetClassKrw, crypto_spot: 200_000 } });
  const parent = plan('BTC', { limitPrice: 70_000, stopPrice: 69_000,
    marketSnapshot: { currentPrice: 70_000, openPositionCount: 0 } as TradingPlan['marketSnapshot'] });
  const child = await seed(repo, parent);
  const claimed = (await repo.claimAutomaticLiveEntry(child, 0, 'first'))!;
  await repo.saveOrder({ ...claimed, state: 'FILLED', filledQuantity: 1, remainingQuantity: 0,
    averageFillPrice: 72_000, feeAmount: 100 });
  const next = await seed(repo, plan('ETH', { estimatedKrw: 20_000 }));
  assert.ok(await repo.claimAutomaticLiveEntry(next, 0, 'second'), 'revaluation is not a duplicate position');
  const exit = plan('half-exit', { symbol: 'BTC', reduceOnly: true, side: 'sell', signalReasons: ['AUTO_EXIT_ENTRY_PLAN:BTC'] });
  await repo.savePlan(exit);
  await repo.saveOrder(order(exit, { state: 'FILLED', filledQuantity: 0.5, averageFillPrice: 73_000 }));
  await repo.savePolicy(userId, policy({ maxAssetClassKrw: { ...policy().maxAssetClassKrw, crypto_spot: 85_000 } }));
  await assert.rejects(repo.assertAutomaticLiveEntryBudget(plan('ETH', { estimatedKrw: 20_000 })), /BUDGET_MARKET_EXCEEDED/);
});

test('slippage expands actual stop risk rather than retaining the smaller planned stop distance', async () => {
  const repo = await setup({ maxAssetClassKrw: { ...policy().maxAssetClassKrw, crypto_spot: 200_000 } });
  const parent = plan('BTC', { limitPrice: 70_000, stopPrice: 69_000,
    marketSnapshot: { currentPrice: 70_000, openPositionCount: 0 } as TradingPlan['marketSnapshot'] });
  const child = await seed(repo, parent);
  const claimed = (await repo.claimAutomaticLiveEntry(child, 0, 'first'))!;
  await repo.saveOrder({ ...claimed, state: 'FILLED', filledQuantity: 1, remainingQuantity: 0,
    averageFillPrice: 78_000, feeAmount: 100 });
  const next = await seed(repo, plan('ETH', { estimatedKrw: 10_000 }));
  await assert.rejects(repo.claimAutomaticLiveEntry(next, 0, 'second'), /BUDGET_RISK_EXCEEDED/);
});

test('unknown fees, foreign fee denomination, incomplete fills and absent or stale foreign FX never become zero cost', async () => {
  const parent = plan('filled'); const next = plan('next');
  const valid = order(parent, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 100 });
  for (const bad of [
    { ...valid, feeAmount: null }, { ...valid, feeAmount: 1, feeCurrency: 'BTC' },
    { ...valid, fills: [{ quantity: 0.5, price: 100, feeAmount: 0, feeCurrency: 'KRW' }] },
  ]) {
    await assert.rejects(projectAutomaticLiveBudget({ policy: policy(), emergencyStopped: false,
      plans: [parent, next], orders: [bad as TradingOrder, order(next)], holds: [] }, userId, order(next).id, (value) => value!),
    /FILL_COST_UNVERIFIED/);
  }
  for (const exchange of ['kiwoom', 'bitget'] as const) {
    const foreign = plan('foreign', { exchange, market: exchange === 'kiwoom' ? 'US' : 'USDT-FUTURES',
      side: exchange === 'bitget' ? 'long' : 'buy', leverage: 7 });
    const filled = order(foreign, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 100 });
    for (const settlementFxEvidence of [null, { source: exchange === 'kiwoom' ? 'YAHOO:USDKRW=X' : 'UPBIT:KRW-USDT',
      krwPerQuoteCurrency: 1400, observedAt: '2000-01-01T00:00:00Z' }]) {
      await assert.rejects(projectAutomaticLiveBudget({ policy: policy(), emergencyStopped: false,
        plans: [foreign, next], orders: [{ ...filled, settlementFxEvidence }, order(next)], holds: [] },
      userId, order(next).id, (value) => value!), /FILL_FX_UNVERIFIED/);
    }
  }
});

test('foreign notional uses genuine fill-time FX once, regardless of preserved futures leverage', async () => {
  for (const leverage of [2, 7]) {
    const existing = plan('futures', { exchange: 'bitget', market: 'USDT-FUTURES', side: 'long', leverage,
      limitPrice: 50, stopPrice: 49, marketSnapshot: { currentPrice: 50, openPositionCount: 0 } as TradingPlan['marketSnapshot'] });
    const at = new Date().toISOString();
    const filled = order(existing, { state: 'FILLED', filledQuantity: 1, averageFillPrice: 51, feeAmount: 0.1,
      feeCurrency: 'USDT', updatedAt: at, settlementFxEvidence: { source: 'UPBIT:KRW-USDT', krwPerQuoteCurrency: 1400, observedAt: at } });
    const next = plan('next', { estimatedKrw: 10_000 });
    const projection = await projectAutomaticLiveBudget({ policy: policy(), emergencyStopped: false,
      plans: [existing, next], orders: [filled, order(next)], holds: [] }, userId, order(next).id, (value) => value!);
    assert.equal(projection.baseCharges[0]!.amountKrw, 71_540);
    assert.equal(projection.baseCharges[0]!.riskKrw, 2_940);
  }
});

test('large retained histories and durable holds are projected with bounded linear identity reads', async () => {
  const count = 4_000;
  let identityReads = 0;
  const tracked = <T extends TradingPlan | TradingOrder>(row: T): T => new Proxy(row, {
    get(target, property, receiver) {
      if (property === 'id' || property === 'planId') identityReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const parents: TradingPlan[] = [];
  const children: TradingOrder[] = [];
  const holds = [];
  for (let i = 0; i < count; i += 1) {
    const parent = tracked(plan(`history-${i}`));
    const child = tracked(order(parent, { state: 'REJECTED', submissionStartedAt: null }));
    parents.push(parent); children.push(child);
    holds.push({ orderId: child.id, market: 'crypto_spot', instrument: `upbit:KRW:${parent.symbol.toUpperCase()}`,
      strategy: parent.strategyId, amountKrw: 70_000, riskKrw: 700 });
  }
  const next = tracked(plan('next'));
  const nextOrder = tracked(order(next));
  const nextId = nextOrder.id;
  identityReads = 0;
  const projection = await projectAutomaticLiveBudget({ policy: policy(), emergencyStopped: false,
    plans: [...parents, next], orders: [...children, nextOrder], holds }, userId, nextId, (value) => value!);
  assert.equal(projection.releases.length, count);
  assert.equal(projection.baseCharges.length, 0);
  assert.equal(projection.amountKrw, 70_000);
  assert.ok(identityReads < count * 40, `identity reads must be linear, observed ${identityReads}`);
  let releaseReads = 0;
  const releases = new Proxy(projection.releases, {
    get(target, property, receiver) {
      if (/^\d+$/u.test(String(property))) releaseReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assertAutomaticLiveBudgetProjection({ ...projection, releases }, holds);
  assert.ok(releaseReads <= count * 2, `release membership reads must be linear, observed ${releaseReads}`);
});
