import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';
import {
  AUTOMATIC_PAPER_FUTURES_LEVERAGE,
  MANUAL_PAPER_FUTURES_MAX_LEVERAGE,
  automaticPaperFuturesLeverageBlockers,
  scopeAutomaticPaperFuturesRiskPolicy,
  validateManualPaperFuturesLeverage,
} from './paper-futures-mode-policy.service';

const automaticPaperPlan: Pick<TradingPlanInput, 'accountMode' | 'exchange' | 'leverage' | 'marginMode'> = {
  accountMode: 'paper', exchange: 'bitget', leverage: 7, marginMode: 'isolated',
};

test('member LIVE futures remains 3x while the non-persisted automatic Paper projection is fixed 7x', () => {
  const stored = normalizeTradingPolicy({ ...DEFAULT_TRADING_POLICY, bitgetLeverage: 7 }, 500_000);
  assert.equal(stored.bitgetLeverage, 3);
  const paperRisk = scopeAutomaticPaperFuturesRiskPolicy(stored, automaticPaperPlan, 'automatic');
  assert.equal(paperRisk.bitgetLeverage, AUTOMATIC_PAPER_FUTURES_LEVERAGE);
  assert.notEqual(paperRisk, stored);
  assert.equal(stored.bitgetLeverage, 3, 'never modify or save member LIVE ceiling');
  assert.equal(scopeAutomaticPaperFuturesRiskPolicy(
    stored, { ...automaticPaperPlan, accountMode: 'live' }, 'automatic',
  ), stored, 'never widen a LIVE plan');
  assert.equal(scopeAutomaticPaperFuturesRiskPolicy(
    stored, automaticPaperPlan, 'manual',
  ), stored, 'manual Paper must not inherit the automatic 7x projection');
  assert.deepEqual(automaticPaperFuturesLeverageBlockers(automaticPaperPlan, 'automatic'), []);
});

test('automatic Paper futures rejects 3x, absent, 8x, cross and missing isolated margin', () => {
  for (const leverage of [1, 2, 3, 4, 5, 6, 8, 125, null]) {
    assert.ok(automaticPaperFuturesLeverageBlockers(
      { ...automaticPaperPlan, leverage }, 'automatic',
    ).includes('AUTOMATIC_PAPER_FUTURES_7X_REQUIRED'), String(leverage));
  }
  assert.ok(automaticPaperFuturesLeverageBlockers(
    { ...automaticPaperPlan, marginMode: 'crossed' }, 'automatic',
  ).includes('AUTOMATIC_PAPER_FUTURES_ISOLATED_REQUIRED'));
  assert.ok(automaticPaperFuturesLeverageBlockers(
    { ...automaticPaperPlan, marginMode: null }, 'automatic',
  ).length > 0);
  assert.deepEqual(automaticPaperFuturesLeverageBlockers(
    { ...automaticPaperPlan, accountMode: 'live', leverage: 3 }, 'automatic',
  ), [], 'LIVE validation is owned by existing LIVE risk');
  assert.deepEqual(automaticPaperFuturesLeverageBlockers(
    { ...automaticPaperPlan, exchange: 'upbit', leverage: null }, 'automatic',
  ), [], 'cash markets are unleveraged');
});

test('manual futures simulator accepts each integer 1..125 and rejects invalid inputs', () => {
  assert.equal(MANUAL_PAPER_FUTURES_MAX_LEVERAGE, 125);
  for (let value = 1; value <= 125; value++) {
    assert.equal(validateManualPaperFuturesLeverage(value), true);
  }
  for (const invalid of [0, 126, 1.5, -7, Number.NaN, Infinity, '7', null, undefined]) {
    assert.equal(validateManualPaperFuturesLeverage(invalid), false, String(invalid));
  }
});
