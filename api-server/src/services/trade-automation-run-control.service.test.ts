import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTradingRepository, type TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { TradeExecutionService } from './trade-execution.service';
import { encryptTradingCredentials } from './trade-credential-vault.service';
import { normalizeTradingPolicy } from './trade-automation-risk.service';
import { tripKillSwitchForRiskFailure } from './trade-kill-switch.service';
import {
  autoRunMarketLanes,
  autoRunState,
  autoRunSwitchOn,
  autoStopRunForLossLimit,
  readAutoRunControl,
  recordAutoRunKillSwitch,
  recordAutoRunPolicyToggle,
  startAutoRun,
  stopAutoRun,
  type AutoRunLiveResolver,
} from './trade-automation-run-control.service';
import { DEFAULT_TRADING_POLICY, type TradingPlanInput, type TradingPolicy } from './trade-automation.types';

const USER = '33333333-3333-3333-3333-333333333333';
const paperOnly: AutoRunLiveResolver = () => false;
const futuresLive: AutoRunLiveResolver = (assetClass) => assetClass === 'crypto_futures';

function memberPolicy(overrides: Partial<TradingPolicy> = {}): TradingPolicy {
  return normalizeTradingPolicy({
    ...DEFAULT_TRADING_POLICY,
    // The owner's per-market live switches are ON so the server resolver decides the lane.
    liveMarketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
    mode: 'approval',
    automaticEnabled: false,
    marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: true, crypto_futures: true },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: false, toss: false },
    enabledAssets: { bitget: [], upbit: ['BTC'], kiwoom: [], toss: [] },
    enabledStrategies: ['breakout-v1'],
    ...overrides,
  });
}

async function seeded(policy = memberPolicy()) {
  const repository = new InMemoryTradingRepository();
  await repository.savePolicy(USER, policy);
  return repository;
}

function paperPlan(overrides: Partial<TradingPlanInput> = {}): TradingPlanInput {
  const observedAt = new Date().toISOString();
  return {
    exchange: 'upbit', accountMode: 'paper', strategyId: 'breakout-v1', signalId: 'run-signal-1',
    symbol: 'BTC', market: 'KRW', side: 'buy', orderType: 'market', quantity: null,
    quoteAmount: 100_000, limitPrice: null, estimatedKrw: 100_000, stopPrice: 90_000,
    targetPrices: [110_000], splitRatios: [100], leverage: null, marginMode: null,
    reduceOnly: false, invalidateAction: 'hold', signalReasons: ['trend', 'volume'],
    marketSnapshot: {
      observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0.5,
      spreadPercent: 0.1, orderbookGapPercent: 0.2, halted: false, availableBalance: 1_000_000,
      accountValueKrw: 5_000_000, dailyPnlPercent: 0, assetExposurePercent: 5,
      openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
      currentPrice: 100_000, plannedPrice: 100_000, marketStatus: 'OPEN',
      availableLiquidityKrw: 1_000_000, estimatedSlippagePercent: 0.1, estimatedFeePercent: 0.05,
      correlatedExposurePercent: 0, signalState: 'entry_ready', signalObservedAt: observedAt,
    },
    ...overrides,
  };
}

test('작동 turns the member run ON, writes an audit row and never opens a LIVE gate', async () => {
  const repository = await seeded();
  const result = await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.policy.mode, 'automatic');
  assert.equal(result.policy.automaticEnabled, true);
  assert.deepEqual(result.liveMarkets, []);
  assert.deepEqual(result.paperMarkets, ['crypto_spot', 'crypto_futures']);
  assert.equal(result.auditStorage, 'DATABASE');
  const stored = await repository.getPolicy(USER);
  assert.equal(autoRunSwitchOn(stored), true);
  // Paper/LIVE lane is decided only by the server resolver, never by 작동.
  const lanes = autoRunMarketLanes(stored, paperOnly);
  assert.equal(lanes.crypto_spot.lane, 'paper');
  assert.equal(lanes.crypto_futures.lane, 'paper');
  const audit = await repository.listRunAudit(USER, 10);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'RUN');
  assert.equal(audit[0].actor, 'member');
  assert.deepEqual(audit[0].paperMarkets, ['crypto_spot', 'crypto_futures']);
});

test('a LIVE market asks for the no-per-order-approval acknowledgement only the first time', async () => {
  const repository = await seeded();
  const first = await startAutoRun(repository, USER, { isLive: futuresLive, liveConfirmed: false });
  assert.deepEqual(first, {
    ok: false, status: 409, error: 'AUTO_RUN_LIVE_CONFIRMATION_REQUIRED', liveMarkets: ['crypto_futures'],
  });
  assert.equal(autoRunSwitchOn(await repository.getPolicy(USER)), false, 'nothing changes without the acknowledgement');
  assert.equal((await repository.listRunAudit(USER, 10)).length, 0);

  const confirmed = await startAutoRun(repository, USER, { isLive: futuresLive, liveConfirmed: true });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.deepEqual(confirmed.liveMarkets, ['crypto_futures']);
  assert.deepEqual((await readAutoRunControl(repository, USER)).control.liveConfirmedMarkets, ['crypto_futures']);

  await stopAutoRun(repository, USER, { isLive: futuresLive });
  const again = await startAutoRun(repository, USER, { isLive: futuresLive, liveConfirmed: false });
  assert.equal(again.ok, true, 'already acknowledged market does not ask again');
});

test('정지 turns the run OFF, keeps the market choices and records the stop', async () => {
  const repository = await seeded();
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  const stopped = await stopAutoRun(repository, USER, { isLive: paperOnly });
  assert.equal(stopped.wasRunning, true);
  const policy = await repository.getPolicy(USER);
  assert.equal(policy.automaticEnabled, false);
  assert.equal(policy.marketEnabled.crypto_spot, true);
  const { control } = await readAutoRunControl(repository, USER);
  assert.equal(autoRunState(policy, control, false), 'STOPPED');
  const audit = await repository.listRunAudit(USER, 10);
  assert.deepEqual(audit.map((entry) => entry.action), ['STOP', 'RUN']);
  assert.equal(audit[0].reason, 'MEMBER_STOP');
});

test('작동 is refused under a kill switch, a global stop or with no enabled market', async () => {
  const killed = await seeded(memberPolicy({ emergencyStopped: true }));
  assert.equal((await startAutoRun(killed, USER, { isLive: paperOnly, liveConfirmed: true })).ok, false);
  const global = await seeded();
  await global.setGlobalEmergencyStop(true, USER);
  const blocked = await startAutoRun(global, USER, { isLive: paperOnly, liveConfirmed: true });
  assert.equal(!blocked.ok && blocked.error, 'GLOBAL_EMERGENCY_STOP_ACTIVE');
  const none = await seeded(memberPolicy({
    marketEnabled: { domestic_stock: false, us_stock: false, crypto_spot: false, crypto_futures: false },
  }));
  const noMarket = await startAutoRun(none, USER, { isLive: paperOnly, liveConfirmed: true });
  assert.equal(!noMarket.ok && noMarket.error, 'AUTO_RUN_MARKET_REQUIRED');
});

test('while 작동 is ON an automatic order needs no per-order approval; after 정지 it is not placed', async () => {
  const repository = await seeded();
  const service = new TradeAutomationService(repository);
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  const running = await repository.getPolicy(USER);
  const created = await service.createPlan(USER, paperPlan(), running, false);
  assert.equal(created.plan?.executionMode, 'automatic');
  const submitted = await service.beginAutomaticPlan(USER, created.plan!.id);
  assert.equal(submitted.state, 'SUBMITTED');
  const order = await service.createOrder(USER, submitted);
  assert.equal(order.order.state, 'SUBMITTED');
  // Idempotency: the same signal never creates a second order.
  assert.equal((await service.createPlan(USER, paperPlan(), running, false)).duplicate, true);
  assert.equal((await service.createOrder(USER, submitted)).duplicate, true);

  await stopAutoRun(repository, USER, { isLive: paperOnly });
  const stopped = await repository.getPolicy(USER);
  const later = await service.createPlan(USER, paperPlan({ signalId: 'run-signal-2' }), stopped, false);
  assert.equal(later.plan?.executionMode, 'manual');
  await assert.rejects(() => service.beginAutomaticPlan(USER, later.plan!.id), /USER_APPROVAL_REQUIRED/);
});

test('daily loss limit auto-stops a running member, records why, and 작동 can restart it', async () => {
  const repository = await seeded();
  const service = new TradeAutomationService(repository);
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  const running = await repository.getPolicy(USER);
  const losing = paperPlan({
    signalId: 'run-loss',
    marketSnapshot: { ...paperPlan().marketSnapshot, dailyPnlPercent: -(running.dailyLossLimitPercent + 1) },
  });
  const blocked = await service.createPlan(USER, losing, running, false);
  assert.equal(blocked.plan, null);
  assert.ok(blocked.decision.blockCodes.includes('DAILY_LOSS_LIMIT'));
  const policy = await repository.getPolicy(USER);
  assert.equal(policy.newEntriesStopped, true, 'new entries stop; protective exits keep their path');
  assert.equal(autoRunSwitchOn(policy), false);
  const { control } = await readAutoRunControl(repository, USER);
  assert.equal(control.lastAction, 'AUTO_STOP');
  assert.equal(control.lastReason, 'DAILY_LOSS_LIMIT');
  assert.equal(autoRunState(policy, control, false), 'AUTO_STOPPED');
  const audit = await repository.listRunAudit(USER, 10);
  assert.equal(audit[0].action, 'AUTO_STOP');
  assert.equal(audit[0].actor, 'system');

  // The existing global kill switch for DAILY_LOSS_LIMIT stays in force.
  assert.equal(await repository.getGlobalEmergencyStop(), true);
  await repository.setGlobalEmergencyStop(false, USER);
  const restarted = await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  assert.equal(restarted.ok, true);
  assert.equal((await repository.getPolicy(USER)).newEntriesStopped, false);
});

test('loss auto-stop is idempotent and ignores members that are not running', async () => {
  const repository = await seeded();
  assert.equal((await autoStopRunForLossLimit(repository, USER, ['DAILY_LOSS_LIMIT'])).stopped, false);
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  assert.equal((await autoStopRunForLossLimit(repository, USER, ['SPREAD_TOO_WIDE'])).stopped, false);
  await tripKillSwitchForRiskFailure({ repository, userId: USER, blockCodes: ['TOTAL_DAILY_LOSS_BUDGET'] });
  assert.equal((await repository.getPolicy(USER)).newEntriesStopped, true);
  assert.equal(await repository.getGlobalEmergencyStop(), false, 'TOTAL_DAILY_LOSS_BUDGET is not a global kill code');
  assert.equal((await autoStopRunForLossLimit(repository, USER, ['DAILY_LOSS_LIMIT'])).stopped, false);
  assert.equal((await repository.listRunAudit(USER, 10)).filter((entry) => entry.action === 'AUTO_STOP').length, 1);
});

test('kill switch and settings toggles are audited; audit falls back to the server log without storage', async () => {
  const repository = await seeded();
  const before = await repository.getPolicy(USER);
  const after: TradingPolicy = { ...before, mode: 'automatic', automaticEnabled: true };
  const toggled = await recordAutoRunPolicyToggle(repository, USER, { before, after, isLive: futuresLive });
  assert.equal(toggled?.auditStorage, 'DATABASE');
  assert.deepEqual((await readAutoRunControl(repository, USER)).control.liveConfirmedMarkets, ['crypto_futures']);
  assert.equal(await recordAutoRunPolicyToggle(repository, USER, { before: after, after, isLive: futuresLive }), null);
  await recordAutoRunKillSwitch(repository, USER, { policyBefore: after, isLive: futuresLive });
  const audit = await repository.listRunAudit(USER, 10);
  assert.deepEqual(audit.map((entry) => entry.action), ['KILL_SWITCH', 'RUN']);
  assert.deepEqual(audit[0].liveMarkets, ['crypto_futures']);

  const failing = await seeded();
  const brokenStorage: TradingRepository = Object.assign(Object.create(Object.getPrototypeOf(failing)), failing, {
    async appendRunAudit() { throw new Error('AUTO_RUN_AUDIT_STORAGE_UNAVAILABLE'); },
    async getRunControl() { throw new Error('AUTO_RUN_STORAGE_UNAVAILABLE'); },
  });
  const logged: unknown[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { logged.push(args); };
  try {
    const started = await startAutoRun(brokenStorage, USER, { isLive: paperOnly, liveConfirmed: false });
    assert.equal(started.ok && started.auditStorage, 'SERVER_LOG');
  } finally {
    console.info = originalInfo;
  }
  assert.equal(logged.length, 1);
  assert.equal(autoRunSwitchOn(await failing.getPolicy(USER)), true);
});

test('execution service fills a 작동 automatic Paper order without ever calling approvePlan', async () => {
  const repository = await seeded();
  const automation = new TradeAutomationService(repository);
  let approvals = 0;
  const originalApprove = automation.approvePlan.bind(automation);
  automation.approvePlan = async (...args) => { approvals += 1; return originalApprove(...args); };
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  const running = await repository.getPolicy(USER);
  const created = await automation.createPlan(USER, paperPlan({ signalId: 'run-exec' }), running, false);
  const submitted = await automation.beginAutomaticPlan(USER, created.plan!.id);
  const { order } = await automation.createOrder(USER, submitted);
  const masterKey = Buffer.alloc(32, 5).toString('base64');
  await repository.saveConnection({
    userId: USER, exchange: 'upbit', accountMode: 'paper', configured: true,
    encryptedCredentials: encryptTradingCredentials({ accessKey: 'paper', secretKey: 'paper' }, masterKey),
    lastVerifiedAt: null, lastErrorCode: null, updatedAt: new Date().toISOString(),
  });
  const nativeFetch = globalThis.fetch;
  const previous = process.env.TRADING_CREDENTIAL_MASTER_KEY;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound += 1; throw new Error('outbound blocked'); }) as typeof fetch;
  process.env.TRADING_CREDENTIAL_MASTER_KEY = masterKey;
  try {
    const executed = await new TradeExecutionService(repository).execute(USER, submitted, order);
    assert.equal(executed.state, 'FILLED');
    assert.equal(outbound, 0, 'Paper lane sends nothing to a provider');
    assert.equal(approvals, 0, 'no per-order approval step');
  } finally {
    globalThis.fetch = nativeFetch;
    if (previous == null) delete process.env.TRADING_CREDENTIAL_MASTER_KEY;
    else process.env.TRADING_CREDENTIAL_MASTER_KEY = previous;
  }
});

test('a market stays Paper when the owner switch is OFF even if the server gate is open', () => {
  const switchedOff = memberPolicy({
    liveMarketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: false },
  });
  assert.equal(autoRunMarketLanes(switchedOff, futuresLive).crypto_futures.lane, 'paper');
  assert.equal(autoRunMarketLanes(memberPolicy(), futuresLive).crypto_futures.lane, 'live');
});
