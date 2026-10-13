import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { enforceMemberTradingPolicy } from './trade-automation-policy-guard.service';

function normalized(overrides: Record<string, unknown> = {}) {
  return normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    ...overrides,
  } as never);
}

test('member policy save never relaxes stricter hidden safety limits', () => {
  const current = normalized({
    maxInstrumentKrw: 400_000,
    maxAssetClassKrw: {
      domestic_stock: 450_000,
      us_stock: 450_000,
      crypto_spot: 300_000,
      crypto_futures: 250_000,
    },
    weeklyLossLimitPercent: 4,
    riskPerTradePercent: { bitget: 0.05, upbit: 0.08, kiwoom: 0.1, toss: 0.1 },
    totalDailyLossLimitPercent: 0.5,
    minExpectedValueR: 0.4,
    minStrategySampleSize: 120,
    minProfitFactor: 1.5,
    maxStrategyDrawdownPercent: 8,
    maxEstimatedSlippagePercent: 0.1,
    maxAverageSpreadPercent: 0.08,
    maxCorrelatedExposurePercent: 25,
    maxEconomicsAgeHours: 8,
  });
  const candidate = normalized();
  const enforced = enforceMemberTradingPolicy(candidate, current);

  assert.equal(enforced.maxInstrumentKrw, 400_000);
  assert.deepEqual(enforced.maxAssetClassKrw, current.maxAssetClassKrw);
  assert.equal(enforced.weeklyLossLimitPercent, 4);
  assert.deepEqual(enforced.riskPerTradePercent, current.riskPerTradePercent);
  assert.equal(enforced.totalDailyLossLimitPercent, 0.5);
  assert.equal(enforced.minExpectedValueR, 0.4);
  assert.equal(enforced.minStrategySampleSize, 120);
  assert.equal(enforced.minProfitFactor, 1.5);
  assert.equal(enforced.maxStrategyDrawdownPercent, 8);
  assert.equal(enforced.maxEstimatedSlippagePercent, 0.1);
  assert.equal(enforced.maxAverageSpreadPercent, 0.08);
  assert.equal(enforced.maxCorrelatedExposurePercent, 25);
  assert.equal(enforced.maxEconomicsAgeHours, 8);
});

test('member policy save may tighten hidden safety limits further', () => {
  const current = normalized({
    maxInstrumentKrw: 400_000,
    weeklyLossLimitPercent: 4,
    minExpectedValueR: 0.4,
    minStrategySampleSize: 120,
    minProfitFactor: 1.5,
    maxEstimatedSlippagePercent: 0.1,
  });
  const candidate = normalized({
    maxInstrumentKrw: 300_000,
    weeklyLossLimitPercent: 3,
    minExpectedValueR: 0.5,
    minStrategySampleSize: 150,
    minProfitFactor: 1.6,
    maxEstimatedSlippagePercent: 0.08,
  });
  const enforced = enforceMemberTradingPolicy(candidate, current);

  assert.equal(enforced.maxInstrumentKrw, 300_000);
  assert.equal(enforced.weeklyLossLimitPercent, 3);
  assert.equal(enforced.minExpectedValueR, 0.5);
  assert.equal(enforced.minStrategySampleSize, 150);
  assert.equal(enforced.minProfitFactor, 1.6);
  assert.equal(enforced.maxEstimatedSlippagePercent, 0.08);
});
