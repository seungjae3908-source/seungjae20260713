import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTradingRisk,
  floorQuantityToRules,
  type RiskEngineInput,
} from './trading-risk-engine.service';

const baseInput: RiskEngineInput = {
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  side: 'long',
  accountBalance: 1_000,
  entryPrice: 100,
  stopLossPrice: 98,
  targetPrice1: 104,
  targetPrice2: 106,
  leverage: 2,
  riskPercent: 0.5,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  estimatedFundingRate: 0.0001,
  quantityStep: 0.001,
  quantityPrecision: 3,
  minimumQuantity: 0.001,
  minimumNotional: 5,
  maintenanceMarginRate: null,
  maximumLeverage: 125,
  appMaximumLeverage: 10,
  contractRulesStatus: 'live',
  dailyRealizedPnl: 0,
  weeklyRealizedPnl: 0,
  consecutiveLosses: 0,
  openExposure: 0,
  sameDirectionExposure: 0,
  dataStatus: 'live',
};

function calculate(patch: Partial<RiskEngineInput> = {}) {
  return calculateTradingRisk({ ...baseInput, ...patch }, new Date('2026-08-02T00:00:00.000Z'));
}

test('floors 0.019999999 to 0.019 for a 0.001 quantity step', () => {
  assert.equal(floorQuantityToRules(0.019999999, 0.001, 3), 0.019);
});

test('quantity precision applies when stricter than quantity step', () => {
  assert.equal(floorQuantityToRules(0.019999999, 0.001, 2), 0.01);
});

test('quantity step applies when stricter than quantity precision', () => {
  assert.equal(floorQuantityToRules(1.239, 0.05, 3), 1.2);
});

test('final risk quantity uses the effective contract step', () => {
  const result = calculate({ quantityStep: 0.01, quantityPrecision: 3 });
  assert.equal(result.effectiveQuantityStep, 0.01);
  assert.equal((result.recommendedQuantity ?? 0) % 0.01, 0);
});

test('minimum quantity is checked after flooring', () => {
  const result = calculate({ minimumQuantity: 100 });
  assert.ok(result.blockCodes.includes('MINIMUM_QUANTITY'));
});

test('minimum notional is checked after flooring', () => {
  const result = calculate({ minimumNotional: 10_000 });
  assert.ok(result.blockCodes.includes('MINIMUM_NOTIONAL'));
});

test('exchange maximum leverage produces a distinct block code', () => {
  const result = calculate({ leverage: 6, maximumLeverage: 5 });
  assert.ok(result.blockCodes.includes('LEVERAGE_EXCEEDS_EXCHANGE_LIMIT'));
});

test('app safety leverage limit blocks even when exchange allows more', () => {
  const result = calculate({ leverage: 11, maximumLeverage: 125, appMaximumLeverage: 10 });
  assert.ok(result.blockCodes.includes('LEVERAGE_EXCEEDS_APP_LIMIT'));
  assert.ok(!result.blockCodes.includes('LEVERAGE_EXCEEDS_EXCHANGE_LIMIT'));
});

for (const status of ['cached', 'delayed', 'disconnected', 'error', 'insufficient'] as const) {
  test(`contract rules status ${status} blocks entry assessment`, () => {
    const result = calculate({ contractRulesStatus: status });
    assert.ok(result.blockCodes.includes('CONTRACT_RULES_NOT_LIVE'));
    assert.equal(result.allowed, false);
  });
}

test('missing contract quantities remain calculable but warn without fabricated rules', () => {
  const result = calculate({
    quantityStep: null,
    quantityPrecision: null,
    minimumQuantity: null,
    minimumNotional: null,
  });
  assert.ok(result.warnings.includes('거래소 최소 주문 규칙을 확인할 수 없습니다.'));
  assert.equal(result.effectiveQuantityStep, null);
});

test('final maximum loss remains within the configured maximum risk', () => {
  const result = calculate({ quantityStep: 0.003, quantityPrecision: 3 });
  assert.ok(result.estimatedMaximumLoss != null);
  assert.ok(result.maximumRiskAmount != null);
  assert.ok(result.estimatedMaximumLoss! <= result.maximumRiskAmount! + 1e-9);
});

test('live contract rules preserve an otherwise valid scenario', () => {
  const result = calculate();
  assert.equal(result.blockCodes.includes('CONTRACT_RULES_NOT_LIVE'), false);
  assert.equal(result.blockCodes.includes('LEVERAGE_EXCEEDS_APP_LIMIT'), false);
  assert.equal(result.blockCodes.includes('LEVERAGE_EXCEEDS_EXCHANGE_LIMIT'), false);
});
