import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TREND_PILOT_SPOT_V1, TREND_PILOT_V1, createTrendPilotLedger, type TrendPilotCandle, type TrendPilotLedger } from './trend-pilot-v1.core';
import { evaluateTrendPilotLiveException, signTrendPilotOccurrence, verifyTrendPilotOccurrence } from './trend-pilot-v1-authorization.service';
import { signTrendPilotPromotion, TREND_PILOT_PROMOTION_SCHEMA } from './trend-pilot-v1-promotion.service';
import {
  farTargetPrice, initialTrail, laneExposureKrw, laneNotionalCeilingKrw, laneOpenRiskKrw, runTrendPilotLaneTick,
  type TrendPilotAccountCounters, type TrendPilotLaneDependencies, type TrendPilotLanePosition,
} from './trend-pilot-v1-lane.service';
import { assertPublicLivePlanOrigin, publicPlanPolicy } from './public-live-plan-origin.service';
import { normalizeTradingPolicy, evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingPlanInput } from './trade-automation.types';

const H4 = TREND_PILOT_V1.intervalMs;
const KEY = 'k'.repeat(40);
const PROMOTION_KEY = 'p'.repeat(40);
// A passing PAPER track record for both lane strategies (the live exception requires it).
const PROMOTION_PATH = join(mkdtempSync(join(tmpdir(), 'trend-pilot-promotion-')), 'records.json');
writeFileSync(PROMOTION_PATH, JSON.stringify({
  records: [TREND_PILOT_V1.strategyId, TREND_PILOT_SPOT_V1.strategyId].map((strategyId) => signTrendPilotPromotion({
    schemaVersion: TREND_PILOT_PROMOTION_SCHEMA, strategyId, source: 'PAPER', afterCosts: true,
    closedTrades: 34, distinctSymbols: 4, winRate: 0.62, meanReturnPercent: 0.8, lowerBound95Percent: 0.1,
    issuedAtMs: Date.now() - 60_000, expiresAtMs: Date.now() + 7 * 24 * 3_600_000,
  }, PROMOTION_KEY)),
}));
const ENV = {
  TREND_PILOT_LIVE_ENABLED: 'true', TREND_PILOT_SIGNING_KEY: KEY,
  TREND_PILOT_PROMOTION_KEY: PROMOTION_KEY, TREND_PILOT_PROMOTION_RECORD_PATH: PROMOTION_PATH,
} as NodeJS.ProcessEnv;

/** 260 flat bars around 60,000, then a breakout bar closing at 63,000. */
function breakoutBars(lastOpenMs: number, breakout = true): TrendPilotCandle[] {
  const bars: TrendPilotCandle[] = [];
  const n = 260;
  for (let i = 0; i < n; i += 1) {
    const t = lastOpenMs - ((n - i) * H4);
    const base = 60_000 + ((i % 7) - 3) * 50;
    bars.push({ timestamp: t, open: base, high: base + 300, low: base - 300, close: base });
  }
  bars.push({ timestamp: lastOpenMs, open: 60_000, high: breakout ? 63_100 : 60_200, low: 59_900, close: breakout ? 63_000 : 60_100 });
  return bars;
}

function policy(overrides: Record<string, unknown> = {}) {
  return normalizeTradingPolicy({
    mode: 'automatic', automaticEnabled: true, pilotStage: 'limited-50', bitgetLeverage: 5,
    marketEnabled: { crypto_futures: true, crypto_spot: true, domestic_stock: false, us_stock: false },
    // Per-market live switch (default OFF) must be explicitly on for the lane to place live entries.
    liveMarketEnabled: { crypto_futures: true, crypto_spot: true, domestic_stock: false, us_stock: false },
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: false, toss: false },
    enabledStrategies: [TREND_PILOT_V1.strategyId, TREND_PILOT_SPOT_V1.strategyId],
    totalCapitalKrw: 10_000_000, maxOrderKrw: 1_000_000, maxInstrumentKrw: 1_000_000,
    totalDailyLossLimitPercent: 2, dailyLossLimitPercent: 2, maxConsecutiveLosses: 20, maxOpenPositions: 8,
    ...overrides,
  }, 1_000_000);
}

const COUNTERS: TrendPilotAccountCounters = {
  accountNotionalKrw: 0, classNotionalKrw: 0, strategyNotionalKrw: 0, accountExposureKrw: 0, assetClassExposureKrw: 0,
  strategyExposureKrw: 0, openRiskKrw: 0, openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
  weeklyPnlPercent: 0, dailyPnlPercent: 0,
};

type Harness = TrendPilotLaneDependencies & { saved: TrendPilotLedger[]; entries: TradingPlanInput[]; exits: Array<{ planId: string; reason: string; price: number }>; contextReads: number };

function deps(over: Partial<TrendPilotLaneDependencies> & { nowMs: number; equityKrw?: number; counters?: Partial<TrendPilotAccountCounters> }): Harness {
  const saved: TrendPilotLedger[] = [];
  const entries: TradingPlanInput[] = [];
  const exits: Array<{ planId: string; reason: string; price: number }> = [];
  const lastOpen = over.nowMs - H4 - (5 * 60_000); // a bar that closed 5 minutes ago
  const harness = { saved, entries, exits, contextReads: 0 } as unknown as Harness;
  const base: TrendPilotLaneDependencies = {
    venue: 'bitget', userId: 'u1', policy: policy(), nowMs: over.nowMs, signingKey: KEY,
    fx: { krwPerQuoteCurrency: 1_400, source: 'UPBIT:KRW-USDT' }, entriesArmed: true, rearmToken: null,
    readClosedBars: async () => breakoutBars(lastOpen),
    readQuote: async () => ({ bid: 62_990, ask: 63_000, last: 63_000, observedAtMs: over.nowMs - 1_000, oneMinuteMovePercent: 0.05, orderbookGapPercent: 0.01, source: 'test' }),
    readContractRules: async () => ({ minTradeNum: 0.0001, sizeStep: 0.0001, minTradeUsdt: 5, priceStep: 0.1 }),
    readEntryContext: async () => {
      harness.contextReads += 1;
      return { account: { equityKrw: over.equityKrw ?? 100_000, availableKrw: over.equityKrw ?? 100_000, observedAtMs: over.nowMs - 1_000 }, counters: { ...COUNTERS, ...over.counters }, heldSymbols: new Set() };
    },
    positions: [], foreignSymbols: new Set(),
    submitEntry: async (plan) => { entries.push(plan); return { status: 'SUBMITTED' }; },
    submitExit: async (position, reason, price) => { exits.push({ planId: position.planId, reason, price }); return { status: 'SUBMITTED' }; },
    loadLedger: async () => null,
    saveLedger: async (ledger) => { saved.push(ledger); },
  };
  const { equityKrw: _e, counters: _c, ...rest } = over;
  return Object.assign(harness, base, rest);
}

test('signature binds strategy, symbol, side, signal id, bar, stop, size and amount', () => {
  const bar = 1_760_000_000_000 - (1_760_000_000_000 % H4);
  const occ = { strategyId: TREND_PILOT_V1.strategyId, exchange: 'bitget' as const, symbol: 'BTCUSDT', side: 'long', signalId: 'sig-1', signalBarOpenMs: bar, stopPrice: 61_500, quantity: 0.0011, estimatedKrw: 92_400 };
  const id = signTrendPilotOccurrence(occ, KEY);
  const plan = { strategyId: occ.strategyId, exchange: 'bitget' as const, symbol: 'BTCUSDT', side: 'long' as const, stopPrice: 61_500, signalOccurrenceId: id, signalId: 'sig-1', quantity: 0.0011, estimatedKrw: 92_400 };
  assert.equal(verifyTrendPilotOccurrence(plan, KEY), bar);
  for (const [field, value] of [['stopPrice', 61_000], ['side', 'short'], ['symbol', 'ETHUSDT'], ['signalId', 'sig-2'], ['quantity', 0.01], ['estimatedKrw', 900_000]] as const) {
    assert.equal(verifyTrendPilotOccurrence({ ...plan, [field]: value }, KEY), null, `${field} tampering`);
  }
  assert.equal(verifyTrendPilotOccurrence(plan, 'x'.repeat(40)), null, 'other key');
  assert.throws(() => signTrendPilotOccurrence(occ, 'short'));
});

test('bitget: breakout → one signed 5x isolated entry, accepted by the risk gate; manual replay refused', async () => {
  const nowMs = Date.now();
  const d = deps({ nowMs });
  const result = await runTrendPilotLaneTick(d);
  assert.equal(result.allowEntry, true, result.guardBlockers.join());
  assert.deepEqual(result.events.filter((e) => e.kind === 'ERROR'), []);
  const plan = d.entries.find((p) => p.symbol === 'BTCUSDT')!;
  assert.ok(plan);
  assert.equal(plan.side, 'long');
  assert.equal(plan.leverage, 5);
  assert.equal(plan.marginMode, 'isolated');
  assert.equal(plan.marketSnapshot.signalState, 'entry_ready');
  assert.ok(plan.marketSnapshot.signalObservedAt);
  assert.ok(plan.stopPrice < 63_000 && plan.stopPrice >= 63_000 * (1 - 0.025) - 0.1);
  assert.ok(plan.estimatedKrw > 50_000 && plan.estimatedKrw <= 1_000_000);
  assert.ok(plan.targetPrices[0] > 63_000 * 1.2);
  // one attempt per bar: the same bar does not re-enter
  const again = deps({ nowMs, loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(again);
  assert.equal(again.entries.length, 0);

  const previous = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const decision = evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: true });
    assert.deepEqual(decision.blockCodes, [], decision.blockCodes.join());
    assert.ok(decision.warnings.includes('TREND_PILOT_LIVE_EXCEPTION_V1:RESEARCH_PROMOTION_BYPASSED'));
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: true, serverLiveEnabled: true }).blockCodes.includes('EMERGENCY_STOP_ACTIVE'));
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: false }).blockCodes.includes('LIVE_EXECUTION_DISABLED'));
    // No paper-promotion evidence => the exception is denied (owner rule: paper first).
    const noRecord = evaluateTrendPilotLiveException(plan, d.policy, Date.now(), { TREND_PILOT_LIVE_ENABLED: 'true', TREND_PILOT_SIGNING_KEY: KEY } as NodeJS.ProcessEnv);
    assert.equal(noRecord.allowed, false);
    assert.deepEqual(noRecord.blockCodes, ['TREND_PILOT_PROMOTION_REQUIRED']);
    // The per-market live switch stays authoritative: lane entries are refused while it is OFF.
    assert.ok(evaluateTradingPlan(plan, policy({ liveMarketEnabled: { crypto_futures: false, crypto_spot: false, domestic_stock: false, us_stock: false } }), { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('LIVE_MARKET_SWITCH_OFF'));
    // altered size or stop → no exception
    for (const forged of [{ ...plan, stopPrice: plan.stopPrice - 500 }, { ...plan, estimatedKrw: plan.estimatedKrw * 2, quantity: (plan.quantity ?? 0) * 2 }, { ...plan, signalId: 'replay-2' }]) {
      const blocked = evaluateTradingPlan(forged, d.policy, { emergencyStopped: false, serverLiveEnabled: true });
      assert.ok(blocked.blockCodes.includes('TREND_PILOT_SIGNATURE_INVALID'), blocked.blockCodes.join());
      assert.ok(blocked.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
    }
    // the public plans API: the lane reason is server-only, and the request-local
    // policy is approval mode, which the exception refuses
    assert.throws(() => assertPublicLivePlanOrigin({ ...plan, executionMode: 'manual' } as never), /PUBLIC_AUTOMATIC_LIVE_ORIGIN_FORBIDDEN/u);
    const stripped = { ...plan, signalReasons: plan.signalReasons.filter((r) => r !== 'TREND_PILOT_LANE_V1') };
    const manualPolicy = publicPlanPolicy(stripped, d.policy);
    assert.equal(evaluateTrendPilotLiveException(plan, manualPolicy, nowMs, ENV).allowed, false);
    assert.deepEqual(evaluateTrendPilotLiveException(plan, manualPolicy, nowMs, ENV).blockCodes, ['TREND_PILOT_AUTOMATIC_POLICY_REQUIRED']);
    const notEnabled = evaluateTradingPlan(plan, policy({ enabledStrategies: ['OTHER'] }), { emergencyStopped: false, serverLiveEnabled: true });
    assert.ok(notEnabled.blockCodes.includes('TREND_PILOT_STRATEGY_NOT_ENABLED'));
    process.env.TREND_PILOT_LIVE_ENABLED = 'false';
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('TREND_PILOT_LIVE_DISABLED'));
  } finally {
    for (const k of Object.keys(ENV)) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
  }
  const stale = evaluateTrendPilotLiveException(plan, d.policy, nowMs + (2 * 3_600_000), ENV);
  assert.deepEqual(stale.blockCodes, ['TREND_PILOT_SIGNAL_STALE']);
});

test('no entry: not armed, killed, drawdown, daily loss (pilot and policy), budget, held, late, flat, stale quote', async () => {
  const nowMs = Date.now();
  const run = async (over: Partial<TrendPilotLaneDependencies> & { equityKrw?: number; counters?: Partial<TrendPilotAccountCounters> }) => {
    const d = deps({ nowMs, ...over });
    const result = await runTrendPilotLaneTick(d);
    return { d, result };
  };
  assert.equal((await run({ entriesArmed: false })).d.entries.length, 0);
  assert.equal((await run({ fx: null })).result.guardBlockers.includes('TREND_PILOT_FX_UNAVAILABLE'), true);

  const killed = await run({ loadLedger: async () => ({ ...createTrendPilotLedger('u1'), killed: true, killedAtMs: 123, killReason: 'KILL_DRAWDOWN_REACHED' }) });
  assert.equal(killed.d.entries.length, 0);
  assert.ok(killed.result.guardBlockers.includes('KILL_SWITCH_ACTIVE'));
  // owner re-arm with the exact token
  const rearmed = await run({ rearmToken: 'bitget:123', loadLedger: async () => ({ ...createTrendPilotLedger('u1'), killed: true, killedAtMs: 123, killReason: 'KILL_DRAWDOWN_REACHED' }) });
  assert.ok(rearmed.result.events.some((e) => e.kind === 'REARM'));
  assert.ok(rearmed.d.entries.length >= 1);
  const wrongToken = await run({ rearmToken: 'bitget:999', loadLedger: async () => ({ ...createTrendPilotLedger('u1'), killed: true, killedAtMs: 123, killReason: 'x' }) });
  assert.equal(wrongToken.d.entries.length, 0);

  const dd = await run({ loadLedger: async () => ({ ...createTrendPilotLedger('u1'), peakEquityKrw: 170_000 }) });
  assert.ok(dd.result.events.some((e) => e.kind === 'KILL'));
  assert.equal(dd.d.saved.at(-1)!.killed, true);
  assert.equal(dd.d.entries.length, 0);
  const notYet = await run({ loadLedger: async () => ({ ...createTrendPilotLedger('u1'), peakEquityKrw: 140_000 }) });
  assert.equal(notYet.d.saved.at(-1)!.killed, false, '−28.6% does not kill at the −40% line');

  const day = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  const dayLedger = { ...createTrendPilotLedger('u1'), peakEquityKrw: 102_100, dayKey: day, dayStartEquityKrw: 102_100 };
  assert.ok((await run({ loadLedger: async () => dayLedger })).result.guardBlockers.includes('DAILY_LOSS_LIMIT'));
  // the member's tighter policy daily limit (1%) applies to the pilot too
  const tight = { ...dayLedger, peakEquityKrw: 101_200, dayStartEquityKrw: 101_200 };
  assert.ok((await run({ loadLedger: async () => tight, policy: policy({ dailyLossLimitPercent: 1 }) })).result.guardBlockers.includes('DAILY_LOSS_LIMIT'));
  // journal already at the policy line → stop before the gate trips the global emergency stop
  assert.ok((await run({ counters: { dailyPnlPercent: -2 } })).result.guardBlockers.includes('POLICY_DAILY_LOSS_LIMIT'));
  assert.ok((await run({ counters: { consecutiveLosses: 20 } })).result.guardBlockers.includes('CONSECUTIVE_LOSS_LIMIT'));
  assert.ok((await run({ counters: { accountNotionalKrw: 10_000_000 } })).result.guardBlockers.includes('BUDGET_ROOM_EXHAUSTED'));

  assert.equal((await run({ foreignSymbols: new Set(['BTCUSDT', 'ETHUSDT']) })).d.entries.length, 0);
  assert.equal((await run({ readClosedBars: async () => breakoutBars(nowMs - H4 - (40 * 60_000)) })).d.entries.length, 0);
  assert.equal((await run({ readClosedBars: async () => breakoutBars(nowMs - H4 - (5 * 60_000), false) })).d.entries.length, 0);
  const staleQuote = await run({ readQuote: async () => ({ bid: 1, ask: 1, last: 1, observedAtMs: nowMs - 120_000, oneMinuteMovePercent: 0, orderbookGapPercent: 0, source: 't' }) });
  assert.equal(staleQuote.d.entries.length, 0);
  assert.ok(staleQuote.result.events.some((e) => e.kind === 'ERROR' && e.code === 'TREND_PILOT_QUOTE_NOT_FRESH'));
  const fast = await run({ readQuote: async () => ({ bid: 62_990, ask: 63_000, last: 63_000, observedAtMs: nowMs - 500, oneMinuteMovePercent: 4.5, orderbookGapPercent: 0.01, source: 't' }) });
  assert.equal(fast.d.entries.length, 0, 'never enter into a fast move (global kill-switch code)');
  assert.ok(fast.result.events.some((e) => e.kind === 'ENTRY_SKIPPED' && e.blockers.includes('TREND_PILOT_FAST_MOVE')));
  // a transient failure retries the same bar, at most 3 times
  let ledger: TrendPilotLedger | null = null;
  for (let i = 0; i < 4; i += 1) {
    const t = await run({ submitEntry: async () => ({ status: 'BLOCKED', blockCodes: ['MARKET_DATA_DELAYED'] }), loadLedger: async () => ledger, foreignSymbols: new Set(['ETHUSDT']) });
    ledger = t.d.saved.at(-1)!;
    const attempted = t.result.events.filter((e) => e.kind === 'ENTRY').length;
    assert.equal(attempted, i < 3 ? 1 : 0, `attempt ${i + 1}`);
  }
});

function trendBars(lastOpen: number): TrendPilotCandle[] {
  const bars: TrendPilotCandle[] = [];
  for (let i = 0; i < 231; i += 1) bars.push({ timestamp: lastOpen - ((233 - i) * H4), open: 60_000, high: 60_300, low: 59_700, close: 60_000 });
  bars.push({ timestamp: lastOpen - (2 * H4), open: 60_000, high: 62_000, low: 59_900, close: 61_800 });
  bars.push({ timestamp: lastOpen - H4, open: 61_800, high: 64_000, low: 61_500, close: 63_800 });
  bars.push({ timestamp: lastOpen, open: 63_800, high: 64_200, low: 63_000, close: 63_500 });
  return bars;
}

test('open position: trail moves on closed bars, a crossed trail exits; account failure never blocks exits', async () => {
  const nowMs = Date.now();
  const lastOpen = Math.floor(nowMs / H4) * H4 - H4;
  const position: TrendPilotLanePosition = {
    planId: 'p1', strategyId: TREND_PILOT_V1.strategyId, symbol: 'BTCUSDT', side: 'long', entryPrice: 60_000,
    initialStopPrice: 58_800, remainingQuantity: 0.001, notionalKrw: 84_000, leverage: 5,
    openedAtMs: lastOpen - (3 * H4) + 60_000, activeExit: false,
  };
  const d = deps({
    nowMs, positions: [position], readClosedBars: async () => trendBars(lastOpen),
    readQuote: async () => ({ bid: 61_900, ask: 61_910, last: 61_900, observedAtMs: nowMs - 500, oneMinuteMovePercent: -0.5, orderbookGapPercent: 0.01, source: 't' }),
    readEntryContext: async () => { throw new Error('TREND_PILOT_ACCOUNT_STALE'); },
    loadLedger: async () => createTrendPilotLedger('u1'),
  });
  const result = await runTrendPilotLaneTick(d);
  const trail = d.saved.at(-1)!.trails.p1;
  assert.ok(trail.stopPrice > 60_000, `trailed to ${trail.stopPrice}`);
  assert.equal(trail.stopKind, 'trailing');
  assert.equal(d.exits.length, 1, 'bid 61,900 is below the trail (64,200 − 2.5 × ATR ≈ 61,985)');
  assert.equal(d.exits[0].reason, 'TRAILING_TAKE_PROFIT');
  assert.equal(d.entries.length, 0, 'no account → no entries');
  assert.ok(result.events.some((e) => e.kind === 'ERROR' && e.code === 'TREND_PILOT_ACCOUNT_STALE'));

  const inflight = deps({ nowMs, positions: [{ ...position, activeExit: true }], readClosedBars: async () => trendBars(lastOpen), loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(inflight);
  assert.equal(inflight.exits.length, 0);
  const closed = deps({ nowMs, positions: [], readClosedBars: async () => trendBars(lastOpen), loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(closed);
  assert.deepEqual(Object.keys(closed.saved.at(-1)!.trails), []);
  assert.equal(closed.saved.at(-1)!.closedCount, 1);

  // a missing ledger with an open position fails closed (kill until re-armed)
  const lost = deps({ nowMs, positions: [position], readClosedBars: async () => trendBars(lastOpen) });
  await runTrendPilotLaneTick(lost);
  assert.equal(lost.saved.at(-1)!.killed, true);
  assert.equal(lost.saved.at(-1)!.killReason, 'LEDGER_MISSING_WITH_POSITIONS');
});

test('holding cap: a closed-bar exit is forced and retried every tick until accepted', async () => {
  const nowMs = Date.now();
  const lastOpen = Math.floor(nowMs / H4) * H4 - H4;
  const position: TrendPilotLanePosition = {
    planId: 'p9', strategyId: TREND_PILOT_V1.strategyId, symbol: 'ETHUSDT', side: 'short', entryPrice: 3_000,
    initialStopPrice: 3_060, remainingQuantity: 0.03, notionalKrw: 126_000, leverage: 5,
    openedAtMs: lastOpen - (179 * H4) + 60_000, activeExit: false,
  };
  const flat: TrendPilotCandle[] = [];
  for (let i = 0; i < 240; i += 1) flat.push({ timestamp: lastOpen - ((239 - i) * H4), open: 3_000, high: 3_010, low: 2_990, close: 3_000 });
  let ledger: TrendPilotLedger | null = createTrendPilotLedger('u1');
  const blocked = deps({ nowMs, positions: [position], readClosedBars: async () => flat, loadLedger: async () => ledger,
    submitExit: async () => ({ status: 'BLOCKED', blockCodes: ['BLOCKED_RECHECK'] }) });
  await runTrendPilotLaneTick(blocked);
  ledger = blocked.saved.at(-1)!;
  assert.equal(ledger.trails.p9.pendingExit, 'TIME_EXIT');
  const retry = deps({ nowMs: nowMs + 30_000, positions: [position], readClosedBars: async () => flat, loadLedger: async () => ledger });
  await runTrendPilotLaneTick(retry);
  assert.deepEqual(retry.exits.map((e) => e.reason), ['FORCE_CLOSE'], 'retried on the next tick without a new bar');
});

test('upbit: long-only market buy by KRW amount within cash; helpers', async () => {
  const nowMs = Date.now();
  const lastOpen = nowMs - H4 - (5 * 60_000);
  const krwBars = breakoutBars(lastOpen).map((b) => ({ ...b, open: b.open * 1500, high: b.high * 1500, low: b.low * 1500, close: b.close * 1500 }));
  const d = deps({
    nowMs, venue: 'upbit', fx: { krwPerQuoteCurrency: 1, source: 'NATIVE_KRW' }, readContractRules: undefined, equityKrw: 300_000,
    readClosedBars: async () => krwBars,
    readQuote: async () => ({ bid: 94_480_000, ask: 94_500_000, last: 94_500_000, observedAtMs: nowMs - 500, oneMinuteMovePercent: 0.1, orderbookGapPercent: 0.02, source: 't' }),
  });
  await runTrendPilotLaneTick(d);
  assert.ok(d.entries.length >= 1);
  for (const plan of d.entries) {
    assert.equal(plan.exchange, 'upbit');
    assert.equal(plan.side, 'buy');
    assert.equal(plan.market, 'KRW');
    assert.ok(plan.quoteAmount! >= 5_000);
    assert.ok(!plan.symbol.startsWith('KRW-'));
  }
  const total = d.entries.reduce((s, p) => s + p.estimatedKrw * (1 + TREND_PILOT_SPOT_V1.feeRate), 0);
  assert.ok(total <= 300_000 + 1, 'cash is never over-committed across symbols');

  assert.equal(laneExposureKrw('bitget', { notionalKrw: 500_000, leverage: 5 }), 100_000);
  assert.equal(laneExposureKrw('upbit', { notionalKrw: 500_000, leverage: 1 }), 500_000);
  const pos = { planId: 'x', strategyId: 's', symbol: 'BTCUSDT', side: 'short' as const, entryPrice: 100, initialStopPrice: 102, remainingQuantity: 2, notionalKrw: 1, leverage: 5, openedAtMs: 0, activeExit: false };
  assert.equal(laneOpenRiskKrw(pos, 102, 1_000), 4_000);
  assert.equal(laneOpenRiskKrw(pos, 99, 1_000), 0, 'stop past entry → no open risk');
  assert.equal(farTargetPrice('short', 100, 10), 10);
  assert.equal(initialTrail({ ...pos, initialStopPrice: 100 }), null);
  const ceiling = laneNotionalCeilingKrw(policy({ totalCapitalKrw: 1_000_000, maxAssetPercent: 30 }), { ...COUNTERS, strategyNotionalKrw: 250_000 });
  assert.equal(ceiling.ceilingKrw, 50_000, 'strategy room = 30% of 1,000,000 − 250,000');
  const market = laneNotionalCeilingKrw(policy(), { ...COUNTERS, marketLimitKrw: 400_000, classNotionalKrw: 350_000 });
  assert.equal(market.ceilingKrw, 50_000, 'budget market room = maxAssetClassKrw − class notional');
});

test('write-ahead: the signal bar is saved BEFORE the order; a failing save sends no order; an ambiguous submit is never retried', async () => {
  const nowMs = Date.now();
  // 1) order of operations: the reservation is already durable when submitEntry runs
  const order: string[] = [];
  const d1 = deps({
    nowMs,
    foreignSymbols: new Set(['ETHUSDT']),
    submitEntry: async () => { order.push('submit'); return { status: 'SUBMITTED' }; },
    saveLedger: async (ledger) => { order.push(Object.keys(ledger.lastSignalBarOpenMs).length ? 'save:reserved' : 'save:plain'); },
  });
  await runTrendPilotLaneTick(d1);
  assert.ok(order.indexOf('save:reserved') >= 0 && order.indexOf('save:reserved') < order.indexOf('submit'), order.join());

  // 2) reservation cannot be saved → no order at all
  const d2 = deps({ nowMs, foreignSymbols: new Set(['ETHUSDT']), saveLedger: async () => { throw new Error('DISK_FULL'); } });
  const r2 = await runTrendPilotLaneTick(d2);
  assert.equal(d2.entries.length, 0);
  assert.ok(r2.events.some((e) => e.kind === 'ERROR' && e.code === 'DISK_FULL'));

  // 3) submit throws after reservation (outcome unknown) → bar stays reserved, next tick does not re-enter
  let saved: TrendPilotLedger | null = null;
  const d3 = deps({
    nowMs, foreignSymbols: new Set(['ETHUSDT']),
    submitEntry: async () => { throw new Error('NETWORK_TIMEOUT'); },
    saveLedger: async (ledger) => { saved = ledger; },
  });
  await runTrendPilotLaneTick(d3);
  assert.ok(saved && Object.keys((saved as TrendPilotLedger).lastSignalBarOpenMs).length > 0);
  const d4 = deps({ nowMs, foreignSymbols: new Set(['ETHUSDT']), loadLedger: async () => saved });
  await runTrendPilotLaneTick(d4);
  assert.equal(d4.entries.length, 0);
});

test('owner alerts: kill, failed exit and lane-level state errors alert; per-symbol data hiccups stay silent; delivery failure never throws', async () => {
  const { trendPilotAlerts, notifyTrendPilotEvents } = await import('./live-trading-safety-telegram.service');
  const events = [
    { kind: 'KILL' as const, drawdownFraction: 0.2, reason: 'DRAWDOWN' },
    { kind: 'EXIT' as const, symbol: 'BTCUSDT', reason: 'STOP_LOSS', status: 'BLOCKED', stopPrice: 60_000 },
    { kind: 'EXIT' as const, symbol: 'ETHUSDT', reason: 'STOP_LOSS', status: 'SUBMITTED', stopPrice: 3_000 },
    { kind: 'ERROR' as const, symbol: null, code: 'LEDGER_READ_FAILED' },
    { kind: 'ERROR' as const, symbol: 'BTCUSDT', code: 'TREND_PILOT_QUOTE_NOT_FRESH' },
    { kind: 'ENTRY_SKIPPED' as const, symbol: 'BTCUSDT', blockers: ['X'] },
  ];
  const alerts = trendPilotAlerts('bitget', events);
  assert.deepEqual(alerts.map((a) => a.dedupe).sort(), ['exit:bitget:BTCUSDT', 'kill:bitget', 'state:bitget:LEDGER_READ_FAILED']);
  assert.deepEqual(trendPilotAlerts('upbit', []), []);
  const sent: string[] = [];
  const ok = await notifyTrendPilotEvents({ userId: 'u1', venue: 'upbit', events, now: new Date('2026-10-18T00:00:00Z') },
    (async (payload: { alert: { title: string } }) => { sent.push(payload.alert.title); return { delivered: true }; }) as never);
  assert.equal(ok.length, 3);
  assert.equal(sent.length, 3);
  const failed = await notifyTrendPilotEvents({ userId: 'u1', venue: 'bitget', events, now: new Date() },
    (async () => { throw new Error('TELEGRAM_DOWN'); }) as never);
  assert.deepEqual(failed, [null, null, null]);
});

test('lane access: exits survive emergency stop and arm loss; entries need arm, no stop, AUTO ON', async () => {
  const { trendPilotLaneAccess } = await import('./trend-pilot-v1-lane.service');
  const base = { liveModeRequested: true, pilotEnabled: true, memberCanRunAutomation: true, mode: 'automatic', automaticEnabled: true, emergencyStopped: false, entriesArmed: true };
  assert.deepEqual(trendPilotLaneAccess(base), { runLanes: true, entriesArmed: true });
  assert.deepEqual(trendPilotLaneAccess({ ...base, emergencyStopped: true }), { runLanes: true, entriesArmed: false }, 'emergency stop: exits only');
  assert.deepEqual(trendPilotLaneAccess({ ...base, entriesArmed: false }), { runLanes: true, entriesArmed: false }, 'arm lost: exits only');
  for (const off of [{ liveModeRequested: false }, { pilotEnabled: false }, { memberCanRunAutomation: false }, { mode: 'manual' }, { automaticEnabled: false }]) {
    assert.deepEqual(trendPilotLaneAccess({ ...base, ...off }), { runLanes: false, entriesArmed: false }, JSON.stringify(off));
  }
});
