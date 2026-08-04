import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import {
  enforceMemberTradingPolicy,
  resumeMemberTradingPolicy,
} from './trade-automation-policy-guard.service';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';

test('member policy cannot advance pilot stage or weaken baseline safety thresholds', () => {
  const current = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const candidate = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    pilotStage: 'validated',
    riskOptimizationEnabled: false,
    riskPerTradePercent: { bitget: 1, upbit: 1, kiwoom: 1 },
    totalDailyLossLimitPercent: 2,
    minExpectedValueR: 0,
    minStrategySampleSize: 20,
    minProfitFactor: 1,
    maxStrategyDrawdownPercent: 50,
    maxEstimatedSlippagePercent: 2,
    maxAverageSpreadPercent: 2,
    maxCorrelatedExposurePercent: 100,
    maxEconomicsAgeHours: 168,
  });

  const guarded = enforceMemberTradingPolicy(candidate, current);
  assert.equal(guarded.pilotStage, 'approval-20');
  assert.equal(guarded.riskOptimizationEnabled, true);
  assert.deepEqual(guarded.riskPerTradePercent, { bitget: 0.1, upbit: 0.2, kiwoom: 0.25 });
  assert.equal(guarded.totalDailyLossLimitPercent, 1);
  assert.equal(guarded.minExpectedValueR, 0.15);
  assert.equal(guarded.minStrategySampleSize, 50);
  assert.equal(guarded.minProfitFactor, 1.2);
  assert.equal(guarded.maxStrategyDrawdownPercent, 15);
  assert.equal(guarded.maxEstimatedSlippagePercent, 0.25);
  assert.equal(guarded.maxAverageSpreadPercent, 0.15);
  assert.equal(guarded.maxCorrelatedExposurePercent, 40);
  assert.equal(guarded.maxEconomicsAgeHours, 24);
});

test('emergency stop is sticky through ordinary settings changes', () => {
  const current = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, emergencyStopped: true });
  const candidate = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, emergencyStopped: false });
  assert.equal(enforceMemberTradingPolicy(candidate, current).emergencyStopped, true);
});

test('confirmed resume returns to approval mode with every exchange disabled', () => {
  const current = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    mode: 'automatic',
    automaticEnabled: true,
    emergencyStopped: true,
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: true },
  });
  const resumed = resumeMemberTradingPolicy(current);
  assert.equal(resumed.mode, 'approval');
  assert.equal(resumed.automaticEnabled, false);
  assert.equal(resumed.emergencyStopped, false);
  assert.deepEqual(resumed.exchangeEnabled, { bitget: false, upbit: false, kiwoom: false });
});
