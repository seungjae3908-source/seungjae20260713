import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { normalizeTradingPolicy, evaluateTradingPlan } from './trade-automation-risk.service';
import { TradeAutomationService } from './trade-automation.service';
import {
  calculateExpectedValueR,
  calculateRiskSizedOrderLimitKrw,
  evaluateTradingOptimization,
} from './trade-automation-optimization.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function input(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  const now = Date.now();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: `signal-${now}`,
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 40_000, limitPrice: null, estimatedKrw: 40_000, stopPrice: 98_000,
    targetPrices: [104_000, 108_000], splitRatios: [50, 50], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend', 'volume'],
    signalState: 'confirmed', signalExpiresAt: new Date(now + 5 * 60_000).toISOString(),
    entryPrice: 100_000, entryZoneLow: 99_000, entryZoneHigh: 101_000,
    estimatedSlippagePercent: 0.1, averageSpreadPercent: 0.1,
    economics: {
      sampleSize: 80, winProbability: 0.55, averageWinR: 1.5, averageLossR: 1,
      estimatedCostsR: 0.05, profitFactor: 1.4, maxDrawdownPercent: 8,
      marketRegime: 'bull', calibratedAt: new Date(now).toISOString(),
    },
    marketSnapshot: {
      observedAt: new Date(now).toISOString(), dataDelayMs: 100, oneMinuteMovePercent: 0.2,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 2,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, correlatedExposurePercent: 5,
    },
    ...overrides,
  };
}

test('cost-aware EV subtracts losses and all estimated costs', () => {
  const value = calculateExpectedValueR({
    sampleSize: 100, winProbability: 0.55, averageWinR: 1.5, averageLossR: 1,
    estimatedCostsR: 0.05, profitFactor: 1.3, maxDrawdownPercent: 10,
    marketRegime: 'bull', calibratedAt: new Date().toISOString(),
  });
  assert.equal(Number(value?.toFixed(3)), 0.325);
});

test('risk sizing caps order notional from account risk and stop distance', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const sizing = calculateRiskSizedOrderLimitKrw(input(), policy);
  assert.equal(sizing.stopDistancePercent, 2);
  assert.equal(sizing.riskBudgetKrw, 1_000);
  assert.equal(sizing.maximumOrderKrw, 50_000);
  const blocked = evaluateTradingOptimization(input({ estimatedKrw: 60_000 }), policy);
  assert.ok(blocked.blockCodes.includes('RISK_BUDGET_EXCEEDED'));
});

test('live plans require confirmed fresh signals, entry zone, slippage and calibrated economics', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const decision = evaluateTradingPlan(input({
    accountMode: 'live', signalState: 'weakening', signalExpiresAt: new Date(Date.now() - 1).toISOString(),
    entryZoneLow: 95_000, entryZoneHigh: 99_000, estimatedSlippagePercent: null, economics: null,
  }), policy, { emergencyStopped: false, serverLiveEnabled: true });
  for (const code of ['SIGNAL_NOT_CONFIRMED', 'SIGNAL_EXPIRED', 'ENTRY_ZONE_LEFT',
    'ESTIMATED_SLIPPAGE_REQUIRED', 'ECONOMICS_REQUIRED']) {
    assert.ok(decision.blockCodes.includes(code), code);
  }
});

test('expected value, sample, profit factor and drawdown independently block unsafe live strategies', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const decision = evaluateTradingOptimization(input({
    accountMode: 'live',
    economics: {
      sampleSize: 20, winProbability: 0.4, averageWinR: 1, averageLossR: 1,
      estimatedCostsR: 0.1, profitFactor: 0.9, maxDrawdownPercent: 30,
      marketRegime: 'sideways', calibratedAt: new Date().toISOString(),
    },
  }), policy);
  for (const code of ['INSUFFICIENT_STRATEGY_SAMPLE', 'EXPECTED_VALUE_TOO_LOW',
    'PROFIT_FACTOR_TOO_LOW', 'STRATEGY_DRAWDOWN_TOO_HIGH']) {
    assert.ok(decision.blockCodes.includes(code), code);
  }
});

test('first live futures pilot is approval-only, one-x and BTC or ETH only', () => {
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const decision = evaluateTradingOptimization(input({
    exchange: 'bitget', accountMode: 'live', market: 'USDT-FUTURES', symbol: 'SOLUSDT',
    side: 'long', quantity: 1, quoteAmount: null, leverage: 2, marginMode: 'isolated',
  }), policy);
  assert.ok(decision.blockCodes.includes('PILOT_FUTURES_ONE_X_ONLY'));
  assert.ok(decision.blockCodes.includes('PILOT_FUTURES_ASSET_LIMIT'));
});

test('approval requires a fresh live revalidation and invalidated conditions expire the plan', async () => {
  const previous = {
    global: process.env.ORDER_EXECUTION_ENABLED,
    approved: process.env.LIVE_TRADING_ACTIVATION_APPROVED,
    upbit: process.env.UPBIT_LIVE_ORDER_ENABLED,
  };
  process.env.ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_ACTIVATION_APPROVED = 'true';
  process.env.UPBIT_LIVE_ORDER_ENABLED = 'true';
  try {
    const repository = new InMemoryTradingRepository();
    const service = new TradeAutomationService(repository);
    const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
    await repository.savePolicy(USER_ID, policy);
    const created = await service.createPlan(USER_ID, input({ accountMode: 'live', signalId: 'live-revalidation' }), policy, false);
    assert.ok(created.plan);
    await assert.rejects(() => service.approvePlan(USER_ID, created.plan!.id), /TRADE_PLAN_REVALIDATION_REQUIRED/);
    await assert.rejects(() => service.approvePlan(USER_ID, created.plan!.id, {
      marketSnapshot: { ...created.plan!.marketSnapshot, observedAt: new Date().toISOString(), currentPrice: 102_000 },
      signalState: 'invalid', signalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      entryPrice: 100_000, entryZoneLow: 99_000, entryZoneHigh: 101_000,
      estimatedSlippagePercent: 0.1, averageSpreadPercent: 0.1, economics: created.plan!.economics,
    }), /TRADE_PLAN_RISK_RECHECK_FAILED/);
    assert.equal((await repository.getPlan(USER_ID, created.plan!.id))?.state, 'EXPIRED');
  } finally {
    if (previous.global === undefined) delete process.env.ORDER_EXECUTION_ENABLED;
    else process.env.ORDER_EXECUTION_ENABLED = previous.global;
    if (previous.approved === undefined) delete process.env.LIVE_TRADING_ACTIVATION_APPROVED;
    else process.env.LIVE_TRADING_ACTIVATION_APPROVED = previous.approved;
    if (previous.upbit === undefined) delete process.env.UPBIT_LIVE_ORDER_ENABLED;
    else process.env.UPBIT_LIVE_ORDER_ENABLED = previous.upbit;
  }
});

test('automatic submission reruns the full risk gate and expires stale signals', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY, mode: 'automatic', automaticEnabled: true,
    exchangeEnabled: { bitget: false, upbit: true, kiwoom: false },
    enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [] }, enabledStrategies: ['breakout-v1'],
  });
  await repository.savePolicy(USER_ID, policy);
  const created = await service.createPlan(USER_ID, input({
    signalId: 'automatic-stale', signalState: null, signalExpiresAt: null,
    entryPrice: null, entryZoneLow: null, entryZoneHigh: null,
    estimatedSlippagePercent: null, averageSpreadPercent: null, economics: null,
  }), policy, false);
  assert.equal(created.plan?.state, 'PLANNED');
  created.plan!.marketSnapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
  await repository.savePlan(created.plan!);
  await assert.rejects(() => service.beginAutomaticPlan(USER_ID, created.plan!.id), /TRADE_PLAN_RISK_RECHECK_FAILED/);
  assert.equal((await repository.getPlan(USER_ID, created.plan!.id))?.state, 'EXPIRED');
});
