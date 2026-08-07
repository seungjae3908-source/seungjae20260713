import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionCoordinator } from './trade-execution-coordinator.service';
import { evaluateTradingPlan, normalizeTradingPolicy } from './trade-automation-risk.service';
import {
  APPROVAL_ORDER_LIFECYCLE_STATES,
  assertApprovalOrderLifecycleTransition,
  canTransitionApprovalOrderLifecycle,
  deriveApprovalOrderLifecycleState,
} from './trade-approval-lifecycle.service';
import { DEFAULT_TRADING_POLICY, type TradingOrder, type TradingPlan } from './trade-automation.types';

const USER_ID = '11111111-1111-1111-1111-111111111111';
let sequence = 0;

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function tradingPlan(overrides: Partial<TradingPlan> = {}): TradingPlan {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'approval-runtime-test',
    signalId: nextId('signal'),
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'market',
    quantity: 1,
    quoteAmount: 100_000,
    limitPrice: null,
    estimatedKrw: 100_000,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['runtime-safety-test'],
    signalWarnings: [],
    signalScore: 90,
    signalConfidence: 90,
    minimumSignalScore: 70,
    minimumSignalConfidence: 60,
    minimumRiskReward: 1.5,
    signalRiskReward: 2,
    signalCoreConditionsMaintained: true,
    signalExpiresAt: future,
    scannerContext: null,
    marketSnapshot: {
      observedAt: now,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.05,
      orderbookGapPercent: 0.05,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      currentPrice: 100_000,
    },
    id: nextId('plan'),
    userId: USER_ID,
    idempotencyKey: nextId('idempotency'),
    state: 'SUBMITTED',
    approvalExpiresAt: future,
    approvedAt: now,
    signalState: 'READY_FOR_APPROVAL',
    lastSignalValidatedAt: now,
    signalInvalidationReason: null,
    signalStateHistory: [],
    createdAt: now,
    updatedAt: now,
    riskAssessment: null,
    ...overrides,
  };
}

function tradingOrder(plan: TradingPlan, overrides: Partial<TradingOrder> = {}): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: nextId('order'),
    userId: plan.userId,
    planId: plan.id,
    exchange: plan.exchange,
    clientOrderId: nextId('client'),
    exchangeOrderId: null,
    state: 'SUBMITTED',
    requestedQuantity: plan.quantity ?? null,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seed(repository: InMemoryTradingRepository, plan: TradingPlan, order: TradingOrder) {
  await repository.insertPlan(plan);
  await repository.insertOrder(order);
}

async function withoutOutbound<T>(operation: () => Promise<T>) {
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error('OUTBOUND_REQUEST_BLOCKED_BY_TEST');
  }) as typeof fetch;
  try {
    const value = await operation();
    return { value, outbound };
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('approval lifecycle defines all required states and blocks approval bypass transitions', () => {
  assert.deepEqual(APPROVAL_ORDER_LIFECYCLE_STATES, [
    'signal_received', 'risk_review', 'plan_created', 'awaiting_user_approval', 'approved',
    'rejected', 'expired', 'submitting', 'partially_filled', 'filled', 'cancel_requested',
    'cancelled', 'failed', 'condition_invalidated', 'exit_planned', 'closed',
  ]);
  assert.equal(canTransitionApprovalOrderLifecycle('awaiting_user_approval', 'approved'), true);
  assert.equal(canTransitionApprovalOrderLifecycle('approved', 'submitting'), true);
  assert.equal(canTransitionApprovalOrderLifecycle('partially_filled', 'cancel_requested'), true);
  assert.equal(canTransitionApprovalOrderLifecycle('filled', 'exit_planned'), true);
  assert.equal(canTransitionApprovalOrderLifecycle('exit_planned', 'awaiting_user_approval'), true);
  assert.throws(
    () => assertApprovalOrderLifecycleTransition('awaiting_user_approval', 'submitting'),
    /INVALID_APPROVAL_ORDER_LIFECYCLE_TRANSITION/,
  );
  assert.throws(
    () => assertApprovalOrderLifecycleTransition('filled', 'submitting'),
    /INVALID_APPROVAL_ORDER_LIFECYCLE_TRANSITION/,
  );
});

test('derived lifecycle keeps invalidation and approval states distinct', () => {
  const awaiting = tradingPlan({ state: 'APPROVAL_PENDING', approvedAt: null });
  assert.equal(deriveApprovalOrderLifecycleState(awaiting), 'awaiting_user_approval');
  assert.equal(deriveApprovalOrderLifecycleState({ ...awaiting, signalState: 'INVALIDATED' }), 'condition_invalidated');
  const submittedOrder = tradingOrder(awaiting);
  assert.equal(deriveApprovalOrderLifecycleState(awaiting, submittedOrder), 'submitting');
  assert.equal(deriveApprovalOrderLifecycleState(awaiting, { ...submittedOrder, state: 'PARTIALLY_FILLED' }), 'partially_filled');
});

test('approval risk limits cover weekly loss, instrument, asset class, and new-entry stop', () => {
  const policy = normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    newEntriesStopped: true,
    weeklyLossLimitPercent: 4,
    maxInstrumentKrw: 150_000,
    maxAssetClassKrw: {
      domestic_stock: 250_000,
      us_stock: 250_000,
      crypto_spot: 250_000,
      crypto_futures: 250_000,
    },
  });
  const input = tradingPlan({
    exchange: 'kiwoom',
    accountMode: 'paper',
    market: 'KR',
    symbol: '005930',
    quantity: 1,
    quoteAmount: null,
    estimatedKrw: 100_000,
    marketSnapshot: {
      ...tradingPlan().marketSnapshot,
      weeklyPnlPercent: -4.2,
      instrumentExposureKrw: 60_000,
      assetClassExposureKrw: 160_000,
    },
  });
  const decision = evaluateTradingPlan(input, policy, { emergencyStopped: false, serverLiveEnabled: false });
  for (const code of ['NEW_ENTRIES_STOPPED', 'WEEKLY_LOSS_LIMIT', 'INSTRUMENT_AMOUNT_LIMIT', 'ASSET_CLASS_AMOUNT_LIMIT']) {
    assert.ok(decision.blockCodes.includes(code), code);
  }

  const exitDecision = evaluateTradingPlan({
    ...input,
    reduceOnly: true,
    marketSnapshot: {
      ...input.marketSnapshot,
      weeklyPnlPercent: 0,
      instrumentExposureKrw: 0,
      assetClassExposureKrw: 0,
    },
  }, policy, { emergencyStopped: false, serverLiveEnabled: false });
  assert.equal(exitDecision.blockCodes.includes('NEW_ENTRIES_STOPPED'), false);
});

test('paper execution is fully local, auditable, and sends zero outbound requests', async () => {
  const repository = new InMemoryTradingRepository();
  const coordinator = new TradeExecutionCoordinator(repository);
  const plan = tradingPlan();
  const order = tradingOrder(plan);
  await seed(repository, plan, order);

  const { value: result, outbound } = await withoutOutbound(() => coordinator.execute(USER_ID, plan, order));
  assert.equal(outbound, 0);
  assert.equal(result.state, 'FILLED');
  assert.equal(result.filledQuantity, 1);
  assert.equal(result.exchangeOrderId, `paper-${order.clientOrderId}`);

  const events = await repository.listEvents(USER_ID);
  const accepted = events.find((event) => event.toState === 'ACCEPTED');
  const filled = events.find((event) => event.toState === 'FILLED');
  assert.ok(accepted);
  assert.ok(filled);
  assert.equal(accepted.userId, USER_ID);
  assert.equal(accepted.fromState, 'SUBMITTED');
  assert.equal(accepted.reason, 'PAPER_MOCK_BROKER_ACCEPTED');
  assert.equal(accepted.metadata.privateApiRequestSent, false);
  assert.equal(filled?.metadata.exchangeRequestSent, false);
  assert.ok(Number.isFinite(Date.parse(accepted.createdAt)));
});

test('mock adapters stay local even when legacy mock/live environment flags are enabled', async () => {
  const keys = [
    'ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_ACTIVATION_APPROVED',
    'BITGET_LIVE_ORDER_ENABLED',
    'UPBIT_LIVE_ORDER_ENABLED',
    'KIWOOM_LIVE_ORDER_ENABLED',
    'KIWOOM_MOCK_ORDER_ENABLED',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'true';
  try {
    const repository = new InMemoryTradingRepository();
    const coordinator = new TradeExecutionCoordinator(repository);
    const plan = tradingPlan({ exchange: 'kiwoom', accountMode: 'mock', market: 'KR', symbol: '005930' });
    const order = tradingOrder(plan);
    await seed(repository, plan, order);
    const { value: result, outbound } = await withoutOutbound(() => coordinator.execute(USER_ID, plan, order));
    assert.equal(outbound, 0);
    assert.equal(result.state, 'FILLED');
    assert.match(result.exchangeOrderId ?? '', /^paper-/);
  } finally {
    restoreEnvironment(previous);
  }
});

test('live execution stays blocked with zero private API requests even when every legacy live flag is true', async () => {
  const keys = [
    'ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_ACTIVATION_APPROVED',
    'BITGET_LIVE_ORDER_ENABLED',
    'UPBIT_LIVE_ORDER_ENABLED',
    'KIWOOM_LIVE_ORDER_ENABLED',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'true';
  try {
    const repository = new InMemoryTradingRepository();
    const coordinator = new TradeExecutionCoordinator(repository);
    const plan = tradingPlan({ accountMode: 'live' });
    const order = tradingOrder(plan);
    await seed(repository, plan, order);
    const { value: result, outbound } = await withoutOutbound(() => coordinator.execute(USER_ID, plan, order));
    assert.equal(outbound, 0);
    assert.equal(result.state, 'REJECTED');
    assert.equal(result.lastErrorCode, 'LIVE_EXECUTION_DISABLED');
    const events = await repository.listEvents(USER_ID);
    assert.equal(events.at(-1)?.reason, 'LIVE_EXECUTION_DISABLED_BY_RUNTIME_AIRGAP');
    assert.equal(events.at(-1)?.metadata.privateApiRequestSent, false);
  } finally {
    restoreEnvironment(previous);
  }
});

test('partial-fill cancellation preserves fills and never submits an exchange cancel', async () => {
  const repository = new InMemoryTradingRepository();
  const coordinator = new TradeExecutionCoordinator(repository);
  const plan = tradingPlan();
  const order = tradingOrder(plan, {
    state: 'PARTIALLY_FILLED',
    requestedQuantity: 1,
    filledQuantity: 0.4,
    averageFillPrice: 99_500,
  });
  await seed(repository, plan, order);

  const { value: result, outbound } = await withoutOutbound(() => coordinator.cancel(USER_ID, plan, order));
  assert.equal(outbound, 0);
  assert.equal(result.state, 'CANCELED');
  assert.equal(result.filledQuantity, 0.4);
  assert.equal(result.averageFillPrice, 99_500);
  const events = await repository.listEvents(USER_ID);
  assert.deepEqual(events.map((event) => event.toState), ['CANCEL_REQUESTED', 'CANCELED']);
  assert.equal(events.at(-1)?.metadata.privateApiRequestSent, false);
});

test('process restart recovery is local for paper orders and performs zero authenticated status queries', async () => {
  const repository = new InMemoryTradingRepository();
  const coordinator = new TradeExecutionCoordinator(repository);
  const plan = tradingPlan();
  const order = tradingOrder(plan, { state: 'ACCEPTED' });
  await seed(repository, plan, order);

  const { value: result, outbound } = await withoutOutbound(() => coordinator.reconcileRecoverableOrders(USER_ID));
  assert.equal(outbound, 0);
  assert.equal(result.resolved, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(result.queriesSent, 0);
  assert.equal(result.authenticationRequests, 0);
  assert.equal(result.statusQueries, 0);
  assert.equal(result.orders[0]?.state, 'ACCEPTED');
  const events = await repository.listEvents(USER_ID);
  assert.ok(events.some((event) => event.reason === 'SERVER_RESTART_RECONCILIATION_REQUIRED'));
  assert.ok(events.some((event) => event.reason === 'PAPER_MOCK_RECOVERY_LOCAL_RECONCILED'));
});
