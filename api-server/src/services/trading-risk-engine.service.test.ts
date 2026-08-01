import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTradingRisk,
  floorQuantityToStep,
  TRADING_RISK_POLICY,
  type RiskEngineInput,
} from './trading-risk-engine.service';

const baseInput = (patch: Partial<RiskEngineInput> = {}): RiskEngineInput => ({
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  side: 'long',
  accountBalance: 10_000,
  entryPrice: 100,
  stopLossPrice: 99,
  targetPrice1: 103,
  targetPrice2: 105,
  leverage: 2,
  riskPercent: 0.5,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  estimatedFundingRate: 0.0001,
  quantityStep: 0.001,
  minimumQuantity: 0.001,
  minimumNotional: 5,
  dailyRealizedPnl: 0,
  weeklyRealizedPnl: 0,
  consecutiveLosses: 0,
  openExposure: 0,
  sameDirectionExposure: 0,
  dataStatus: 'live',
  ...patch,
});

function closeTo(actual: number | null, expected: number, tolerance = 1e-8) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${actual} != ${expected}`);
}

test('blocks zero account balance', () => {
  const result = calculateTradingRisk(baseInput({ accountBalance: 0 }));
  assert.equal(result.allowed, false);
  assert.ok(result.blockCodes.includes('INVALID_ACCOUNT_BALANCE'));
});

test('blocks invalid long stop at or above entry', () => {
  const result = calculateTradingRisk(baseInput({ stopLossPrice: 100 }));
  assert.ok(result.blockCodes.includes('INVALID_STOP_LOSS'));
});

test('blocks invalid short stop at or below entry', () => {
  const result = calculateTradingRisk(baseInput({ side: 'short', stopLossPrice: 100, targetPrice1: 97, targetPrice2: 95 }));
  assert.ok(result.blockCodes.includes('INVALID_STOP_LOSS'));
});

test('blocks invalid target direction', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 99 }));
  assert.ok(result.blockCodes.includes('INVALID_TARGET_PRICE'));
});

test('blocks NaN numeric input', () => {
  const result = calculateTradingRisk(baseInput({ entryPrice: Number.NaN }));
  assert.ok(result.blockCodes.includes('INVALID_ENTRY_PRICE'));
});

test('blocks Infinity numeric input', () => {
  const result = calculateTradingRisk(baseInput({ leverage: Number.POSITIVE_INFINITY }));
  assert.ok(result.blockCodes.includes('INVALID_LEVERAGE'));
});

test('blocks risk percent above policy maximum', () => {
  const result = calculateTradingRisk(baseInput({ riskPercent: TRADING_RISK_POLICY.maximumRiskPercent + 0.01 }));
  assert.ok(result.blockCodes.includes('INVALID_RISK_PERCENT'));
});

test('blocks negative fee or slippage rate', () => {
  const result = calculateTradingRisk(baseInput({ entryFeeRate: -0.0001 }));
  assert.ok(result.blockCodes.includes('INVALID_COST_RATE'));
});

test('calculates long position quantity from total per-unit loss', () => {
  const result = calculateTradingRisk(baseInput());
  assert.equal(result.allowed, true);
  assert.ok((result.rawQuantity ?? 0) > 40);
  assert.ok((result.recommendedQuantity ?? 0) <= (result.rawQuantity ?? 0));
});

test('calculates short position quantity', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
  }));
  assert.equal(result.allowed, true);
  assert.ok((result.recommendedQuantity ?? 0) > 0);
});

test('floors quantity to exchange step without rounding up', () => {
  assert.equal(floorQuantityToStep(12.3499, 0.01), 12.34);
  assert.equal(floorQuantityToStep(0.000099, 0.00001), 0.00009);
});

test('applies quantity step to recommended quantity', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0,
    exitFeeRate: 0,
    slippageRate: 0,
    estimatedFundingRate: 0,
    quantityStep: 3,
  }));
  assert.equal(result.rawQuantity, 50);
  assert.equal(result.recommendedQuantity, 48);
});

test('blocks quantity below minimum quantity', () => {
  const result = calculateTradingRisk(baseInput({ minimumQuantity: 100 }));
  assert.ok(result.blockCodes.includes('MINIMUM_QUANTITY'));
});

test('blocks notional below minimum notional', () => {
  const result = calculateTradingRisk(baseInput({ minimumNotional: 10_000 }));
  assert.ok(result.blockCodes.includes('MINIMUM_NOTIONAL'));
});

test('keeps estimated maximum loss within maximum risk after all costs', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0.002,
    exitFeeRate: 0.002,
    slippageRate: 0.003,
    estimatedFundingRate: 0.001,
  }));
  assert.ok((result.estimatedMaximumLoss ?? Infinity) <= (result.maximumRiskAmount ?? 0) + 1e-8);
});

test('higher leverage does not increase maximum permitted loss', () => {
  const low = calculateTradingRisk(baseInput({ leverage: 2 }));
  const high = calculateTradingRisk(baseInput({ leverage: 20 }));
  closeTo(low.maximumRiskAmount, high.maximumRiskAmount as number);
  closeTo(low.estimatedMaximumLoss, high.estimatedMaximumLoss as number);
  closeTo(low.recommendedQuantity, high.recommendedQuantity as number);
  assert.ok((high.requiredMargin ?? Infinity) < (low.requiredMargin ?? 0));
});

test('calculates entry fee from entry notional', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(result.estimatedEntryFee, (result.notionalValue as number) * input.entryFeeRate);
});

test('calculates stop exit fee from stop notional', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(result.estimatedExitFeeAtStop, (result.recommendedQuantity as number) * input.stopLossPrice * input.exitFeeRate);
});

test('calculates two-sided slippage cost', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(
    result.estimatedSlippageCost,
    (result.recommendedQuantity as number) * (input.entryPrice + input.stopLossPrice) * input.slippageRate,
  );
});

test('uses absolute funding rate as conservative cost', () => {
  const positive = calculateTradingRisk(baseInput({ estimatedFundingRate: 0.001 }));
  const negative = calculateTradingRisk(baseInput({ estimatedFundingRate: -0.001 }));
  closeTo(positive.estimatedFundingCost, negative.estimatedFundingCost as number);
});

test('supports zero fee, slippage, and funding costs', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0,
    exitFeeRate: 0,
    slippageRate: 0,
    estimatedFundingRate: 0,
  }));
  assert.equal(result.recommendedQuantity, 50);
  assert.equal(result.estimatedMaximumLoss, 50);
});

test('calculates target one net profit and risk reward', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.estimatedProfit1 ?? 0) > 0);
  assert.ok((result.riskReward1 ?? 0) >= 1.5);
});

test('calculates target two independently', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.estimatedProfit2 ?? 0) > (result.estimatedProfit1 ?? 0));
  assert.ok((result.riskReward2 ?? 0) > (result.riskReward1 ?? 0));
});

test('blocks risk reward below one', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 101.1, targetPrice2: null }));
  assert.ok(result.blockCodes.includes('RISK_REWARD_TOO_LOW'));
});

test('warns for risk reward between one and one point five', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 101.7, targetPrice2: null }));
  assert.equal(result.blockCodes.includes('RISK_REWARD_TOO_LOW'), false);
  assert.ok(result.warnings.some((warning) => warning.includes('강한 경고 구간')));
});

test('leaves risk reward null when no target is supplied', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: null, targetPrice2: null }));
  assert.equal(result.riskReward1, null);
  assert.equal(result.riskReward2, null);
  assert.equal(result.blockCodes.includes('RISK_REWARD_TOO_LOW'), false);
  assert.ok(result.warnings.some((warning) => warning.includes('목표가가 없어')));
});

test('blocks at daily realized loss limit', () => {
  const result = calculateTradingRisk(baseInput({ dailyRealizedPnl: -100 }));
  assert.ok(result.blockCodes.includes('DAILY_LOSS_LIMIT'));
});

test('blocks at weekly realized loss limit', () => {
  const result = calculateTradingRisk(baseInput({ weeklyRealizedPnl: -300 }));
  assert.ok(result.blockCodes.includes('WEEKLY_LOSS_LIMIT'));
});

test('blocks after configured consecutive loss count', () => {
  const result = calculateTradingRisk(baseInput({ consecutiveLosses: 3 }));
  assert.ok(result.blockCodes.includes('CONSECUTIVE_LOSS_LIMIT'));
});

test('blocks total exposure above account multiple', () => {
  const result = calculateTradingRisk(baseInput({ openExposure: 27_000 }));
  assert.ok(result.blockCodes.includes('EXPOSURE_LIMIT'));
});

test('blocks same direction exposure above account multiple', () => {
  const result = calculateTradingRisk(baseInput({ sameDirectionExposure: 17_000 }));
  assert.ok(result.blockCodes.includes('EXPOSURE_LIMIT'));
});

test('cached data is visible but blocked for entry assessment', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'cached' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
  assert.ok(result.warnings.some((warning) => warning.includes('캐시 데이터')));
});

test('delayed data is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'delayed' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('error data status is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'error' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('insufficient data status is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'insufficient' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('live data permits an otherwise valid scenario', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'live' }));
  assert.equal(result.allowed, true);
});

test('calculates long liquidation approximation', () => {
  const result = calculateTradingRisk(baseInput({ leverage: 10, maintenanceMarginRate: 0.005 }));
  closeTo(result.estimatedLiquidationPrice, 90.5);
});

test('calculates short liquidation approximation', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
    leverage: 10,
    maintenanceMarginRate: 0.005,
  }));
  closeTo(result.estimatedLiquidationPrice, 109.5);
});

test('blocks when stop is beyond or too close to liquidation estimate', () => {
  const result = calculateTradingRisk(baseInput({ leverage: 100 }));
  assert.ok(result.blockCodes.includes('LIQUIDATION_TOO_CLOSE'));
});

test('warns when maintenance margin rate is assumed', () => {
  const result = calculateTradingRisk(baseInput({ maintenanceMarginRate: null }));
  assert.ok(result.warnings.some((warning) => warning.includes('유지증거금률 정보가 없어')));
  assert.ok(result.warnings.some((warning) => warning.includes('실제 청산가격')));
});

test('long break-even price is above entry after fees and slippage', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.breakEvenPrice ?? 0) > 100);
});

test('short break-even price is below entry after fees and slippage', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
  }));
  assert.ok((result.breakEvenPrice ?? Infinity) < 100);
});

test('funding direction warning distinguishes likely payment or receipt', () => {
  const longPositive = calculateTradingRisk(baseInput({ estimatedFundingRate: 0.001 }));
  const shortPositive = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
    estimatedFundingRate: 0.001,
  }));
  assert.ok(longPositive.warnings.some((warning) => warning.includes('지급 가능성')));
  assert.ok(shortPositive.warnings.some((warning) => warning.includes('수취 가능성')));
});

test('missing exchange quantity rules do not fabricate values', () => {
  const result = calculateTradingRisk(baseInput({
    quantityStep: null,
    minimumQuantity: null,
    minimumNotional: null,
  }));
  assert.ok((result.recommendedQuantity ?? 0) > 0);
  assert.ok(result.warnings.includes('거래소 최소 주문 규칙을 확인할 수 없습니다.'));
});
