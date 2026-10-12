import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradePreSubmissionRiskService, TradePreSubmissionRiskError } from './trade-pre-submission-risk.service';
import { evaluateTradingPlan, normalizeTradingPolicy } from './trade-automation-risk.service';
import { hasServerManualOrderAuthority } from './manual-order-authority.service';
import { setTradingPlanMarketIntelligenceRunnerForTests } from './trade-market-intelligence.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput } from './trade-automation.types';

const user = '11111111-1111-1111-1111-111111111111';
function input(): TradingPlanInput {
  const at = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'live', strategyId: 'manual-chart',
    signalId: 'manual-chart:3fa85f64-5717-4562-b3fc-2c963f66afa6',
    symbol: 'KRW-BTC', market: 'KRW', side: 'buy', orderType: 'limit',
    quantity: 0.2, limitPrice: 100_000, estimatedKrw: 20_000, stopPrice: 95_000,
    targetPrices: [110_000], splitRatios: [100], signalReasons: ['TEST_ONLY_HUMAN_INTENT'],
    estimatedSlippagePercent: 0.1, averageSpreadPercent: 0.1,
    marketSnapshot: {
      observedAt: at, riskObservedAt: at, dataDelayMs: 0, oneMinuteMovePercent: 0,
      spreadPercent: 0.1, orderbookGapPercent: 0.1, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 0,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, plannedPrice: 100_000, marketStatus: 'OPEN',
      source: 'TEST_ONLY', availableLiquidityKrw: 1_000_000, estimatedSlippagePercent: 0.1,
      estimatedFeePercent: 0.05, correlatedExposurePercent: 0,
      signalState: 'READY_FOR_APPROVAL', signalObservedAt: at,
    },
  };
}
const policy = normalizeTradingPolicy({
  ...DEFAULT_TRADING_POLICY, pilotStage: 'validated', totalCapitalKrw: 5_000_000,
  mode: 'automatic', automaticEnabled: true, enabledStrategies: ['automatic-strategy-only'],
  marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: false },
  exchangeEnabled: { bitget: false, upbit: true, kiwoom: false, toss: false },
});
const options = { emergencyStopped: false, serverLiveEnabled: true, manualUserOrder: true };

test('manual validation omits historical profitability only; no invented expected return', () => {
  const decision = evaluateTradingPlan(input(), policy, options);
  assert.equal(decision.allowed, true, decision.blockCodes.join(','));
  assert.equal(decision.optimization?.expectedValueR, null);
  const automatic = evaluateTradingPlan(input(), policy, { ...options, manualUserOrder: false });
  assert.ok(automatic.blockCodes.includes('ECONOMICS_REQUIRED'));
  assert.ok(automatic.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  assert.ok(automatic.blockCodes.includes('STRATEGY_NOT_ENABLED'));
});
test('manual validation still blocks balance, limit, stop, spread, stale data and kill switch failures', () => {
  for (const [code, mutate] of [
    ['INSUFFICIENT_BALANCE', (p: TradingPlanInput) => { p.marketSnapshot.availableBalance = 0; }],
    ['MAX_ORDER_AMOUNT', (p: TradingPlanInput) => { p.estimatedKrw = policy.maxOrderKrw + 1; }],
    ['EXIT_PLAN_REQUIRED', (p: TradingPlanInput) => { p.stopPrice = 0; }],
    ['AVERAGE_SPREAD_TOO_WIDE', (p: TradingPlanInput) => { p.averageSpreadPercent = 5; }],
    ['MARKET_SNAPSHOT_STALE', (p: TradingPlanInput) => { p.marketSnapshot.observedAt = new Date(Date.now() - 60_000).toISOString(); }],
  ] as const) {
    const p = input(); mutate(p);
    assert.ok(evaluateTradingPlan(p, policy, options).blockCodes.includes(code), code);
  }
  assert.ok(evaluateTradingPlan(input(), policy, { ...options, emergencyStopped: true }).blockCodes.includes('EMERGENCY_STOP_ACTIVE'));
  assert.ok(evaluateTradingPlan(input(), { ...policy, pilotStage: 'approval-20' }, options).blockCodes.includes('PILOT_LIVE_DISABLED'));
  assert.ok(evaluateTradingPlan(input(), policy, { ...options, serverLiveEnabled: false }).blockCodes.includes('LIVE_EXECUTION_DISABLED'));
});

test('server-owned manual authority survives approval and preflight; spoofing and auto execution remain blocked', async () => {
  const env = {
    TRADING_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 19).toString('base64'),
    LIVE_TRADING: 'true', ORDER_EXECUTION_ENABLED: 'true', LIVE_TRADING_ACTIVATION_APPROVED: 'true',
    REAL_ORDER_ENABLED: 'true', PRIVATE_TRADING_API_ALLOWED: 'true', UPBIT_LIVE_ORDER_ENABLED: 'true',
    SPOT_LIVE_LIMITED_ACTIVATION_APPROVED: 'true', executionAuthority: 'SPOT_LIVE_LIMITED',
    SPOT_LIVE_CAPABILITY_ALLOWLIST: 'BALANCE_READ,POSITION_READ,OPEN_ORDER_READ,ORDER_CREATE,ORDER_CANCEL,ORDER_AMEND',
    SPOT_LIVE_MARKET_ALLOWLIST: 'KR_STOCK,US_STOCK,CRYPTO_SPOT',
    AUTO_TRADING: 'true', LIVE_AUTOMATIC_TRADING_ENABLED: 'true',
    MEMBER_AUTO_TRADING_PAPER_ONLY_ENABLED: 'false', TRADING_EMERGENCY_STOP: 'false',
  };
  const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    setTradingPlanMarketIntelligenceRunnerForTests(async () => ({ status: 'READY', warnings: [], autoTrading: {
      mode: 'ELIGIBLE_FOR_PARENT_GATE', orderAllowed: false, evidenceReady: true,
      parentEligibilityReady: true, hardBlockReason: null,
    } } as any));
    const repository = new InMemoryTradingRepository();
    await repository.savePolicy(user, policy);
    const service = new TradeAutomationService(repository);
    const spoof = await service.createPlan(user, { ...input(), executionMode: 'manual', manualOrderAuthority: 'a'.repeat(64) } as TradingPlanInput, policy, false);
    assert.equal(spoof.plan, null);
    assert.ok(spoof.decision.blockCodes.includes('ECONOMICS_REQUIRED'));
    const created = await service.createPlan(user, input(), policy, false, { manualApprovalOnly: true });
    assert.ok(created.plan, created.decision.blockCodes.join(','));
    assert.equal(created.plan.executionMode, 'manual');
    assert.equal(created.plan.state, 'APPROVAL_PENDING');
    assert.equal(created.plan.approvedAt, null);
    assert.equal(hasServerManualOrderAuthority(created.plan), true);
    assert.equal(hasServerManualOrderAuthority({ ...created.plan, quantity: 10 }), false);
    assert.equal(hasServerManualOrderAuthority({ ...created.plan, userId: 'another-user' }), false);
    assert.equal(hasServerManualOrderAuthority({ ...created.plan, executionMode: 'automatic' }), false);
    assert.equal((await repository.listOrders(user)).length, 0);
    await assert.rejects(service.beginAutomaticPlan(user, created.plan.id), /USER_APPROVAL_REQUIRED/);
    const approved = await service.approvePlan(user, created.plan.id);
    assert.equal(hasServerManualOrderAuthority(approved), true);
    const { order } = await service.createOrder(user, approved);
    const risk = new TradePreSubmissionRiskService(repository);
    const checked = await risk.evaluate({ userId: user, expectedPlan: approved, order, snapshot: input().marketSnapshot, serverLiveEnabled: true });
    assert.equal(checked.allowed, true);
    await assert.rejects(risk.evaluate({ userId: user, expectedPlan: approved, order,
      snapshot: { ...input().marketSnapshot, availableBalance: 0 }, serverLiveEnabled: true }),
    (e: unknown) => e instanceof TradePreSubmissionRiskError && e.result.blockCodes.includes('INSUFFICIENT_BALANCE'));
  } finally {
    setTradingPlanMarketIntelligenceRunnerForTests(null);
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
