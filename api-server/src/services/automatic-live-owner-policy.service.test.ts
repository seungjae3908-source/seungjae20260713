import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';
import { approvedAdministratorAutomaticLivePolicy, administratorAutomaticLivePolicyBlockers } from './automatic-live-owner-policy.service';
test('owner policy corrects every observed baseline/50k-stage/loss/order-count drift in one projection', () => {
  const current = structuredClone({ ...DEFAULT_TRADING_POLICY, pilotStage: 'limited-50' as const,
    dailyLossLimitPercent: 5, maxDailyOrders: 10,
    maxAssetClassKrw: { domestic_stock: 100_000, us_stock: 100_000, crypto_spot: 100_000, crypto_futures: 100_000 } });
  const prepared = approvedAdministratorAutomaticLivePolicy(current);
  assert.equal(administratorAutomaticLivePolicyBlockers(current).length, 4);
  assert.deepEqual(administratorAutomaticLivePolicyBlockers(prepared), []);
  assert.equal(prepared.totalCapitalKrw, 4_000_000);
  assert.equal(prepared.pilotStage, 'formula-ai-exception');
  assert.equal(prepared.bitgetLeverage, 2);
  assert.equal(prepared.enabledStrategies.length, 6);
  assert.equal(current.totalCapitalKrw, 1_000_000);
});
test('policy projection never clears a sticky stop, grants unknown strategies or coerces leverage', () => {
  for (const stopped of [{ emergencyStopped: true }, { newEntriesStopped: true }]) {
    assert.throws(() => approvedAdministratorAutomaticLivePolicy({ ...DEFAULT_TRADING_POLICY, ...stopped }), /OWNER_RESUME/);
  }
  assert.throws(() => approvedAdministratorAutomaticLivePolicy({ ...DEFAULT_TRADING_POLICY,
    enabledStrategies: ['unproven-strategy'] }), /UNKNOWN_STRATEGY/);
  assert.throws(() => approvedAdministratorAutomaticLivePolicy({ ...DEFAULT_TRADING_POLICY,
    bitgetLeverage: 8 as never }), /LEVERAGE_INVALID/);
  for (const leverage of [2, 3, 4, 5, 6, 7]) {
    assert.equal(approvedAdministratorAutomaticLivePolicy({ ...DEFAULT_TRADING_POLICY,
      bitgetLeverage: leverage as never }).bitgetLeverage, leverage);
  }
});
