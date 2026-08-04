import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { evaluateTradingPlan, normalizeTradingPolicy } from './trade-automation-risk.service';
import { DEFAULT_TRADING_POLICY } from './trade-automation.types';
import {
  approvalGuard,
  createScannerSignal,
  revalidateScannerSignal,
  scannerSignalToPaperPlan,
} from './scanner-approval.service';
import type { ScannerSignalCandidate } from './scanner-approval.types';

const USER_ID = '33333333-3333-3333-3333-333333333333';

function candidate(overrides: Partial<ScannerSignalCandidate> = {}): ScannerSignalCandidate {
  const observedAt = new Date().toISOString();
  return {
    market: 'KR',
    symbol: '005930',
    displayName: '삼성전자',
    timeframe: '1D',
    currentPrice: 70_000,
    score: 78,
    confidence: 74,
    riskScore: 30,
    selectedConditions: ['거래량 증가', '5일선 돌파'],
    matchedSignals: ['거래량 증가', '5일선 돌파'],
    reasons: ['거래량 증가', '단기 추세 회복'],
    dataTimestamp: observedAt,
    marketSnapshot: {
      observedAt,
      dataDelayMs: 100,
      oneMinuteMovePercent: 0.4,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.2,
      halted: false,
    },
    ...overrides,
  };
}

test('scanner signal clamps scores, prevents NaN, and creates three condition-based entry legs', () => {
  const signal = createScannerSignal(candidate({
    score: Number.NaN,
    confidence: 150,
    riskScore: -10,
    scoreBreakdown: { trend: Number.POSITIVE_INFINITY, riskPenalty: -500 },
  }), { maximumOrderKrw: 100_000 });
  assert.equal(signal.score, 50);
  assert.equal(signal.confidence, 100);
  assert.equal(signal.scoreBreakdown.riskPenalty, -100);
  assert.equal(signal.entryPlan.legs.length, 3);
  assert.deepEqual(signal.entryPlan.legs.map((leg) => leg.allocationRate), [40, 35, 25]);
  assert.ok(signal.entryPlan.legs.every((leg) => Number.isFinite(leg.price) && leg.price > 0));
});

test('ready signal enables approval, one lost condition weakens it, and a crash invalidates it', () => {
  const createdAt = new Date();
  const signal = createScannerSignal(candidate({ dataTimestamp: createdAt.toISOString() }), {}, createdAt);
  assert.equal(signal.state, 'READY_FOR_APPROVAL');
  assert.equal(approvalGuard(signal).enabled, true);

  const weakened = revalidateScannerSignal(signal, candidate({
    score: 69,
    matchedSignals: ['거래량 증가'],
    dataTimestamp: new Date(createdAt.getTime() + 1_000).toISOString(),
  }), {}, new Date(createdAt.getTime() + 1_000));
  assert.equal(weakened.signal.state, 'WEAKENED');
  assert.equal(weakened.guard.enabled, false);

  const invalidated = revalidateScannerSignal(signal, candidate({
    score: 40,
    matchedSignals: [],
    dataTimestamp: new Date(createdAt.getTime() + 2_000).toISOString(),
    marketSnapshot: {
      ...candidate().marketSnapshot,
      observedAt: new Date(createdAt.getTime() + 2_000).toISOString(),
      oneMinuteMovePercent: -7,
    },
  }), {}, new Date(createdAt.getTime() + 2_000));
  assert.equal(invalidated.signal.state, 'INVALIDATED');
  assert.equal(invalidated.guard.enabled, false);
});

test('scanner conversion always produces approval-only paper plan and never enables live execution', () => {
  const signal = createScannerSignal(candidate(), { maximumOrderKrw: 120_000 });
  const plan = scannerSignalToPaperPlan(signal, { maximumOrderKrw: 120_000 }, candidate().marketSnapshot);
  assert.equal(plan.accountMode, 'paper');
  assert.equal(plan.exchange, 'kiwoom');
  assert.equal(plan.strategyId, 'scanner-approval-v1');
  assert.equal(plan.estimatedKrw, 48_000);
  assert.deepEqual(plan.splitRatios, [100]);
  assert.equal(plan.scannerApprovedTotalKrw, 120_000);
  assert.equal(plan.scannerEntryLegSequence, 1);
  assert.equal(plan.scannerSignal, signal);
  assert.ok(plan.approvalNonce);
});

test('approved first entry can activate only the next condition-maintained paper leg', () => {
  const ready = createScannerSignal(candidate({ currentPrice: 69_000 }), { maximumOrderKrw: 120_000 });
  const approved = {
    ...ready,
    state: 'APPROVED' as const,
    entryPlan: { legs: ready.entryPlan.legs.map((leg) => leg.sequence === 1 ? { ...leg, status: 'FILLED' as const } : leg) },
  };
  const second = scannerSignalToPaperPlan(approved, { maximumOrderKrw: 120_000 }, candidate().marketSnapshot, 2, 'parent-plan');
  assert.equal(second.accountMode, 'paper');
  assert.equal(second.scannerEntryLegSequence, 2);
  assert.equal(second.scannerParentPlanId, 'parent-plan');
  assert.equal(second.estimatedKrw, 42_000);
  assert.equal(second.marketSnapshot.assetExposurePercent, 4.8);
});

test('US stock scanner plans are allowed only as paper simulations', () => {
  const signal = createScannerSignal(candidate({ market: 'US', symbol: 'AAPL', displayName: 'Apple', currentPrice: 220 }));
  const plan = scannerSignalToPaperPlan(signal, { maximumOrderKrw: 100_000 }, candidate().marketSnapshot);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const paperDecision = evaluateTradingPlan(plan, policy, { emergencyStopped: false, serverLiveEnabled: false });
  assert.equal(paperDecision.allowed, true);
  const liveDecision = evaluateTradingPlan({ ...plan, accountMode: 'live' }, policy, {
    emergencyStopped: false,
    serverLiveEnabled: false,
  });
  assert.ok(liveDecision.blockCodes.includes('KIWOOM_DOMESTIC_ONLY'));
  assert.ok(liveDecision.blockCodes.includes('LIVE_EXECUTION_DISABLED'));
});

test('existing trade automation keeps idempotency and explicit approval for scanner paper plans', async () => {
  const repository = new InMemoryTradingRepository();
  const automation = new TradeAutomationService(repository);
  const signal = createScannerSignal(candidate(), { maximumOrderKrw: 100_000 });
  const input = scannerSignalToPaperPlan(signal, { maximumOrderKrw: 100_000 }, candidate().marketSnapshot);
  const policy = normalizeTradingPolicy(DEFAULT_TRADING_POLICY);
  const first = await automation.createPlan(USER_ID, input, policy, false);
  const duplicate = await automation.createPlan(USER_ID, input, policy, false);
  assert.ok(first.plan);
  assert.equal(first.plan?.state, 'APPROVAL_PENDING');
  assert.equal(duplicate.duplicate, true);
  const approved = await automation.approvePlan(USER_ID, first.plan!.id);
  const created = await automation.createOrder(USER_ID, approved);
  const repeated = await automation.createOrder(USER_ID, approved);
  assert.equal(created.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(created.order.id, repeated.order.id);
});
