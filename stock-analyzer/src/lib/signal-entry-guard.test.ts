import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEntryGuard, livePricePollMs, rewardRiskFrom } from './signal-entry-guard';

const plan = { direction: 'BUY' as const, entryZone: { from: 98, to: 102 }, stopLoss: 92, targets: [116, 124, 130], budget: 1_000_000 };
const at = (price: number | null, priceAgeMs = 1_000) => evaluateEntryGuard({ ...plan, price, priceAgeMs });

test('in zone: allowed, tranches at or above the price fill now at the current price', () => {
  const r = at(100);
  assert.equal(r.state, 'IN_ZONE');
  assert.equal(r.allowed, true);
  assert.deepEqual(r.tranches.map((t) => [t.planPrice, t.orderPrice, t.fillsNow, t.amount]),
    [[102, 100, true, 300_000], [100, 100, true, 300_000], [98, 98, false, 400_000]]);
  assert.equal(r.rewardRisk, 2);
  assert.ok(r.maxLossAmount != null && r.maxLossAmount > 0);
});

test('owner example: planned ~100, price drops to 95 (above stop) → limit prices auto-adjust to 95', () => {
  const r = at(95);
  assert.equal(r.state, 'BETTER_THAN_ZONE');
  assert.equal(r.allowed, true);
  assert.deepEqual(r.tranches.map((t) => t.orderPrice), [95, 95, 95]);
});

test('price at or below the stop (이탈가) blocks buying', () => {
  for (const price of [92, 80]) {
    const r = at(price);
    assert.equal(r.state, 'INVALIDATED');
    assert.equal(r.allowed, false);
    assert.equal(r.tone, 'block');
  }
});

test('above the zone: wait while reward/risk ≥ 1, block once it falls below 1', () => {
  const wait = at(104); // (116-104)/(104-92) = 1.0
  assert.equal(wait.state, 'ABOVE_ZONE_WAIT');
  assert.equal(wait.allowed, true);
  assert.deepEqual(wait.tranches.map((t) => t.fillsNow), [false, false, false]);
  const chase = at(106); // 10/14 ≈ 0.71
  assert.equal(chase.state, 'CHASE_BLOCKED');
  assert.equal(chase.allowed, false);
  assert.match(chase.message, /1 : 0\.71/u);
});

test('missing or stale price blocks until refreshed', () => {
  assert.equal(at(null).state, 'NO_PRICE');
  assert.equal(at(100, 31_000).state, 'STALE');
  assert.equal(at(100, 31_000).allowed, false);
});

test('short mirrors the rules', () => {
  const s = { direction: 'SHORT' as const, entryZone: { from: 98, to: 102 }, stopLoss: 108, targets: [86], budget: 100 };
  assert.equal(evaluateEntryGuard({ ...s, price: 100, priceAgeMs: 0 }).state, 'IN_ZONE');
  assert.equal(evaluateEntryGuard({ ...s, price: 104, priceAgeMs: 0 }).state, 'BETTER_THAN_ZONE');
  assert.equal(evaluateEntryGuard({ ...s, price: 108, priceAgeMs: 0 }).state, 'INVALIDATED');
  assert.equal(evaluateEntryGuard({ ...s, price: 93, priceAgeMs: 0 }).state, 'CHASE_BLOCKED'); // 7/15
  assert.deepEqual(evaluateEntryGuard({ ...s, price: 100, priceAgeMs: 0 }).tranches.map((t) => t.planPrice), [98, 100, 102]);
});

test('broken plans never allow an order', () => {
  assert.equal(evaluateEntryGuard({ ...plan, stopLoss: 99, price: 100, priceAgeMs: 0 }).state, 'PLAN_INVALID');
  assert.equal(evaluateEntryGuard({ ...plan, targets: [], price: 100, priceAgeMs: 0 }).state, 'PLAN_INVALID');
  assert.equal(rewardRiskFrom(92, 116, 92, false), null);
  assert.equal(livePricePollMs('UPBIT'), 2_000);
  assert.equal(livePricePollMs('KR'), 5_000);
});
