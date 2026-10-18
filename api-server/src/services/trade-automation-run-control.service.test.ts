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
  recordAutoRunResume,
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

  // Owner decision 2026-10-18: a member's daily loss limit is member-scoped.
  // It never halts other members through the global switch.
  assert.equal(await repository.getGlobalEmergencyStop(), false);
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

test('member-scoped kill switch stops only that member; 작동 needs the confirmed resume first', async () => {
  const OTHER = '44444444-4444-4444-4444-444444444444';
  const repository = await seeded();
  await repository.savePolicy(OTHER, memberPolicy());
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  await startAutoRun(repository, OTHER, { isLive: paperOnly, liveConfirmed: false });
  const service = new TradeAutomationService(repository);
  const running = await repository.getPolicy(USER);
  const fast = paperPlan({
    signalId: 'run-fast',
    marketSnapshot: { ...paperPlan().marketSnapshot, oneMinuteMovePercent: 7 },
  });
  const blocked = await service.createPlan(USER, fast, running, false);
  assert.equal(blocked.plan, null);
  assert.ok(blocked.decision.blockCodes.includes('FAST_MOVE_DETECTED'));
  assert.equal(await repository.getGlobalEmergencyStop(), false, 'one member’s fast move never halts everyone');
  const policy = await repository.getPolicy(USER);
  assert.equal(policy.newEntriesStopped, true);
  const { control } = await readAutoRunControl(repository, USER);
  assert.equal(control.lastAction, 'KILL_SWITCH');
  assert.equal(control.lastReason, 'FAST_MOVE_DETECTED');
  assert.equal(autoRunState(policy, control, false), 'KILL_SWITCH');
  const restart = await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  assert.equal(restart.ok, false);
  assert.equal(!restart.ok && restart.error, 'MEMBER_TRADING_RESUME_REQUIRED');
  // The other member keeps running.
  assert.equal(autoRunSwitchOn(await repository.getPolicy(OTHER)), true);
});

test('stop / 작동 OFF keeps automatic authority for a protective exit of an owned automatic entry only', async () => {
  const repository = await seeded();
  const service = new TradeAutomationService(repository);
  await startAutoRun(repository, USER, { isLive: paperOnly, liveConfirmed: false });
  const entry = await service.createPlan(USER, paperPlan({ signalId: 'owned-entry' }), await repository.getPolicy(USER), false);
  assert.equal(entry.plan?.executionMode, 'automatic');
  const exit = (signalId: string, entryPlanId: string) => paperPlan({
    signalId, side: 'sell', reduceOnly: true, quantity: 1, quoteAmount: null, estimatedKrw: 100_000,
    signalReasons: ['AUTO_EXIT', `AUTO_EXIT_ENTRY_PLAN:${entryPlanId}`, 'AUTO_EXIT_REASON:STOP_LOSS'],
  });
  for (const stop of ['run-off', 'emergency'] as const) {
    if (stop === 'run-off') await stopAutoRun(repository, USER, { isLive: paperOnly });
    else await repository.savePolicy(USER, { ...await repository.getPolicy(USER), mode: 'approval', emergencyStopped: true });
    const stopped = await repository.getPolicy(USER);
    // A new entry stays blocked from automatic execution.
    const newEntry = await service.createPlan(USER, paperPlan({ signalId: `new-entry-${stop}` }), stopped, stop === 'emergency');
    if (newEntry.plan) {
      assert.equal(newEntry.plan.executionMode, 'manual');
      await assert.rejects(() => service.beginAutomaticPlan(USER, newEntry.plan!.id, { protectiveExit: true }), /USER_APPROVAL_REQUIRED/);
    } else assert.ok(newEntry.decision.blockCodes.includes('EMERGENCY_STOP_ACTIVE'));
    // The protective exit keeps its automatic path.
    const created = await service.createPlan(USER, exit(`exit-${stop}`, entry.plan!.id), stopped, stop === 'emergency',
      { protectiveExit: true });
    assert.equal(created.plan?.executionMode, 'automatic', stop);
    const submitted = await service.beginAutomaticPlan(USER, created.plan!.id, { protectiveExit: true });
    assert.equal(submitted.state, 'SUBMITTED', stop);
    // Without the worker's protective-exit request, or for a plan it does not own, nothing changes.
    const unflagged = await service.createPlan(USER, exit(`exit-unflagged-${stop}`, entry.plan!.id), stopped, false);
    assert.equal(unflagged.plan?.executionMode, 'manual');
    const foreign = await service.createPlan(USER, exit(`exit-foreign-${stop}`, 'not-an-owned-plan'), stopped, false,
      { protectiveExit: true });
    assert.equal(foreign.plan?.executionMode, 'manual');
    await assert.rejects(() => service.beginAutomaticPlan(USER, foreign.plan!.id, { protectiveExit: true }), /USER_APPROVAL_REQUIRED/);
    await repository.savePolicy(USER, { ...stopped, mode: 'automatic', automaticEnabled: true, emergencyStopped: false });
  }
});

test('confirmed resume is audited and leaves the run OFF', async () => {
  const repository = await seeded(memberPolicy({ emergencyStopped: true }));
  const before = await repository.getPolicy(USER);
  const audit = await recordAutoRunResume(repository, USER, { policyBefore: before, isLive: futuresLive });
  assert.equal(audit.auditRecorded, true);
  const [entry] = await repository.listRunAudit(USER, 1);
  assert.equal(entry.action, 'STOP');
  assert.equal(entry.reason, 'MEMBER_RESUME');
  assert.equal(entry.actor, 'member');
  assert.equal((await readAutoRunControl(repository, USER)).control.lastAction, 'STOP');
});
