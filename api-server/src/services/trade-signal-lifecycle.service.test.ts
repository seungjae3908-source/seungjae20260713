import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import {
  applySignalValidation,
  approvalStatus,
  evaluateSignalLifecycle,
  initializeSignalLifecycle,
  SIGNAL_VALIDATION_MAX_AGE_MS,
} from './trade-signal-lifecycle.service';
import { DEFAULT_TRADING_POLICY, type TradingPlan, type TradingPlanInput } from './trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-08-04T05:00:00.000Z');

function input(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  return {
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'scanner-v1',
    signalId: 'signal-ready',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: null,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [50, 30, 20],
    invalidateAction: 'hold',
    signalReasons: ['trend', 'volume'],
    signalWarnings: [],
    signalScore: 82,
    signalConfidence: 78,
    minimumSignalScore: 70,
    minimumSignalConfidence: 65,
    minimumRiskReward: 1.5,
    signalRiskReward: 2,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    marketSnapshot: {
      observedAt: NOW.toISOString(),
      dataDelayMs: 100,
      oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.2,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 5_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 5,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    ...overrides,
  };
}

function planFromInput(value: TradingPlanInput): TradingPlan {
  const approvalExpiresAt = new Date(NOW.getTime() + 10 * 60_000).toISOString();
  return {
    ...value,
    ...initializeSignalLifecycle(value, approvalExpiresAt, NOW),
    id: 'plan-1',
    userId: USER,
    idempotencyKey: 'key-1',
    state: 'APPROVAL_PENDING',
    approvalExpiresAt,
    approvedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

test('valid signal is ready and keeps the approval button enabled', () => {
  const plan = planFromInput(input());
  assert.equal(plan.signalState, 'READY_FOR_APPROVAL');
  assert.equal(plan.signalScore, 82);
  assert.equal(plan.signalConfidence, 78);
  assert.equal(approvalStatus(plan, NOW).approvalEnabled, true);
  assert.equal(plan.signalStateHistory.length, 1);
});

test('small score or confidence deficit weakens the signal and disables approval', () => {
  const plan = planFromInput(input());
  const result = applySignalValidation(plan, {
    score: 66,
    confidence: 62,
    coreConditionsMaintained: true,
    riskReward: 2,
    reasons: ['volume weakened'],
    dataTimestamp: NOW.toISOString(),
  }, NOW);
  assert.equal(result.evaluation.state, 'WEAKENED');
  assert.equal(approvalStatus(plan, NOW).approvalEnabled, false);
  assert.equal(approvalStatus(plan, NOW).reasonCode, 'SIGNAL_WEAKENED');
  assert.equal(plan.state, 'APPROVAL_PENDING');
});

test('core condition break, collapsed risk reward, and stale data invalidate the signal', () => {
  const minimums = {
    minimumSignalScore: 70,
    minimumSignalConfidence: 65,
    minimumRiskReward: 1.5,
    signalExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const coreBreak = evaluateSignalLifecycle(minimums, {
    score: 90,
    confidence: 90,
    coreConditionsMaintained: false,
    riskReward: 3,
    dataTimestamp: NOW.toISOString(),
  }, NOW);
  assert.equal(coreBreak.state, 'INVALIDATED');
  assert.equal(coreBreak.reasonCode, 'SIGNAL_CORE_CONDITION_BROKEN');

  const rewardBreak = evaluateSignalLifecycle(minimums, {
    score: 90,
    confidence: 90,
    coreConditionsMaintained: true,
    riskReward: 1.2,
    dataTimestamp: NOW.toISOString(),
  }, NOW);
  assert.equal(rewardBreak.state, 'INVALIDATED');
  assert.equal(rewardBreak.reasonCode, 'SIGNAL_RISK_REWARD_BELOW_MINIMUM');

  const stale = evaluateSignalLifecycle(minimums, {
    score: 90,
    confidence: 90,
    coreConditionsMaintained: true,
    riskReward: 3,
    dataTimestamp: new Date(NOW.getTime() - SIGNAL_VALIDATION_MAX_AGE_MS - 1).toISOString(),
  }, NOW);
  assert.equal(stale.state, 'INVALIDATED');
  assert.equal(stale.reasonCode, 'SIGNAL_DATA_STALE');
});

test('approval expires or requires a recent server validation', () => {
  const expired = planFromInput(input());
  expired.approvalExpiresAt = new Date(NOW.getTime() - 1).toISOString();
  assert.equal(approvalStatus(expired, NOW).reasonCode, 'APPROVAL_EXPIRED');

  const stale = planFromInput(input());
  stale.lastSignalValidatedAt = new Date(NOW.getTime() - SIGNAL_VALIDATION_MAX_AGE_MS - 1).toISOString();
  assert.equal(approvalStatus(stale, NOW).reasonCode, 'SIGNAL_REVALIDATION_REQUIRED');
});

test('service rejects approval after weakening and permanently expires an invalidated plan', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  await repository.savePolicy(USER, normalizeTradingPolicy(DEFAULT_TRADING_POLICY));
  const created = await service.createPlan(USER, input({
    signalId: 'service-weakening',
    marketSnapshot: { ...input().marketSnapshot, observedAt: new Date().toISOString() },
    signalExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }), normalizeTradingPolicy(DEFAULT_TRADING_POLICY), false);
  assert.ok(created.plan);
  assert.equal(created.approval?.approvalEnabled, true);

  const weakened = await service.revalidatePlan(USER, created.plan!.id, {
    score: 68,
    confidence: 63,
    coreConditionsMaintained: true,
    riskReward: 2,
    reasons: ['volume weakened'],
    dataTimestamp: new Date().toISOString(),
    marketSnapshot: { ...created.plan!.marketSnapshot, observedAt: new Date().toISOString() },
  });
  assert.equal(weakened.plan.state, 'APPROVAL_PENDING');
  assert.equal(weakened.plan.signalState, 'WEAKENED');
  assert.equal(weakened.approval.approvalEnabled, false);
  await assert.rejects(
    () => service.approvePlan(USER, created.plan!.id),
    /TRADE_PLAN_SIGNAL_NOT_APPROVABLE/,
  );

  const invalidated = await service.revalidatePlan(USER, created.plan!.id, {
    score: 80,
    confidence: 80,
    coreConditionsMaintained: false,
    riskReward: 2,
    reasons: ['support lost'],
    dataTimestamp: new Date().toISOString(),
    invalidationReason: 'SUPPORT_LEVEL_BROKEN',
    marketSnapshot: { ...created.plan!.marketSnapshot, observedAt: new Date().toISOString() },
  });
  assert.equal(invalidated.plan.signalState, 'INVALIDATED');
  assert.equal(invalidated.plan.state, 'EXPIRED');
  assert.equal(invalidated.approval.approvalEnabled, false);
  assert.equal(invalidated.plan.signalInvalidationReason, 'SUPPORT_LEVEL_BROKEN');
});

test('invalidating after partial fill preserves the fill and requests cancellation of the remainder', async () => {
  const repository = new InMemoryTradingRepository();
  const service = new TradeAutomationService(repository);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  await repository.savePolicy(USER, policy);
  const created = await service.createPlan(USER, input({
    signalId: 'partial-fill-invalidation',
    quantity: 10,
    quoteAmount: 100_000,
    marketSnapshot: { ...input().marketSnapshot, observedAt: new Date().toISOString() },
    signalExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }), policy, false);
  assert.ok(created.plan);
  const approved = await service.approvePlan(USER, created.plan!.id);
  const { order } = await service.createOrder(USER, approved);
  await service.transition(order, 'ACCEPTED', 'TEST_ACCEPTED');
  await service.transition(order, 'PARTIALLY_FILLED', 'TEST_PARTIAL', { filledQuantity: 4 });

  const result = await service.invalidatePlan(USER, approved.id, 'SIGNAL_CORE_CONDITION_BROKEN');
  assert.equal(result.order?.state, 'CANCEL_REQUESTED');
  assert.equal(result.filledQuantityPreserved, 4);
  assert.equal(result.plan.signalState, 'INVALIDATED');
  assert.equal(result.plan.signalInvalidationReason, 'SIGNAL_CORE_CONDITION_BROKEN');
});
