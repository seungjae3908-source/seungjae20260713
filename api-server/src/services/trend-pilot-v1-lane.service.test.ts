import test from 'node:test';
import assert from 'node:assert/strict';

import { TREND_PILOT_SPOT_V1, TREND_PILOT_V1, createTrendPilotLedger, type TrendPilotCandle, type TrendPilotLedger } from './trend-pilot-v1.core';
import { evaluateTrendPilotLiveException, signTrendPilotOccurrence, verifyTrendPilotOccurrence } from './trend-pilot-v1-authorization.service';
import { farTargetPrice, initialTrail, laneExposureKrw, laneOpenRiskKrw, runTrendPilotLaneTick, type TrendPilotLaneDependencies, type TrendPilotLanePosition } from './trend-pilot-v1-lane.service';
import { normalizeTradingPolicy, evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingPlanInput } from './trade-automation.types';

const H4 = TREND_PILOT_V1.intervalMs;
const KEY = 'k'.repeat(40);
const ENV = { TREND_PILOT_LIVE_ENABLED: 'true', TREND_PILOT_SIGNING_KEY: KEY } as NodeJS.ProcessEnv;

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
    exchangeEnabled: { bitget: true, upbit: true, kiwoom: false, toss: false },
    enabledStrategies: [TREND_PILOT_V1.strategyId, TREND_PILOT_SPOT_V1.strategyId],
    totalCapitalKrw: 10_000_000, maxOrderKrw: 1_000_000, maxInstrumentKrw: 1_000_000,
    totalDailyLossLimitPercent: 2, dailyLossLimitPercent: 2,
    ...overrides,
  }, 1_000_000);
}

function deps(over: Partial<TrendPilotLaneDependencies> & { nowMs: number }): TrendPilotLaneDependencies & { saved: TrendPilotLedger[]; entries: TradingPlanInput[]; exits: Array<{ planId: string; reason: string; price: number }> } {
  const saved: TrendPilotLedger[] = [];
  const entries: TradingPlanInput[] = [];
  const exits: Array<{ planId: string; reason: string; price: number }> = [];
  const lastOpen = over.nowMs - H4 - (5 * 60_000); // a bar that closed 5 minutes ago
  const base: TrendPilotLaneDependencies = {
    venue: 'bitget', userId: 'u1', policy: policy(), nowMs: over.nowMs, signingKey: KEY,
    fx: { krwPerQuoteCurrency: 1_400, source: 'UPBIT:KRW-USDT' },
    readClosedBars: async () => breakoutBars(lastOpen),
    readQuote: async () => ({ bid: 62_990, ask: 63_000, last: 63_000, observedAtMs: over.nowMs - 1_000, oneMinuteMovePercent: 0.05, orderbookGapPercent: 0.01, source: 'test' }),
    readAccount: async () => ({ equityKrw: 100_000, availableKrw: 100_000, observedAtMs: over.nowMs - 1_000 }),
    readContractRules: async () => ({ minTradeNum: 0.0001, sizeStep: 0.0001, minTradeUsdt: 5, priceStep: 0.1 }),
    positions: [], foreignSymbols: new Set(), entriesArmed: true,
    accountCounters: { dailyOrderCount: 0, openPositionCount: 0, consecutiveLosses: 0, weeklyPnlPercent: 0 },
    submitEntry: async (plan) => { entries.push(plan); return { status: 'SUBMITTED' }; },
    submitExit: async (position, reason, price) => { exits.push({ planId: position.planId, reason, price }); return { status: 'SUBMITTED' }; },
    loadLedger: async () => null,
    saveLedger: async (ledger) => { saved.push(ledger); },
  };
  return Object.assign({ ...base, ...over }, { saved, entries, exits });
}

test('signature binds strategy, symbol, side, bar and stop; exception fails closed', () => {
  const occ = { strategyId: TREND_PILOT_V1.strategyId, exchange: 'bitget' as const, symbol: 'BTCUSDT', side: 'long', signalBarOpenMs: 1_760_000_000_000 - (1_760_000_000_000 % H4), stopPrice: 61_500 };
  const id = signTrendPilotOccurrence(occ, KEY);
  const plan = { strategyId: occ.strategyId, exchange: 'bitget' as const, symbol: 'BTCUSDT', side: 'long' as const, stopPrice: 61_500, signalOccurrenceId: id };
  assert.equal(verifyTrendPilotOccurrence(plan, KEY), occ.signalBarOpenMs);
  assert.equal(verifyTrendPilotOccurrence({ ...plan, stopPrice: 61_000 }, KEY), null, 'stop tampering');
  assert.equal(verifyTrendPilotOccurrence({ ...plan, side: 'short' }, KEY), null, 'side tampering');
  assert.equal(verifyTrendPilotOccurrence({ ...plan, symbol: 'ETHUSDT' }, KEY), null, 'symbol tampering');
  assert.equal(verifyTrendPilotOccurrence(plan, 'x'.repeat(40)), null, 'other key');
  assert.throws(() => signTrendPilotOccurrence(occ, 'short'));
});

test('bitget: breakout → one signed 5x isolated entry sized from equity, accepted by the risk gate', async () => {
  const nowMs = Date.now();
  const d = deps({ nowMs });
  const result = await runTrendPilotLaneTick(d);
  assert.equal(result.allowEntry, true, result.guardBlockers.join());
  const errs = result.events.filter((e) => e.kind === 'ERROR');
  assert.deepEqual(errs, []);
  assert.equal(d.entries.filter((p) => p.symbol === 'BTCUSDT').length, 1);
  const plan = d.entries.find((p) => p.symbol === 'BTCUSDT')!;
  assert.equal(plan.side, 'long');
  assert.equal(plan.leverage, 5);
  assert.equal(plan.marginMode, 'isolated');
  assert.ok(plan.stopPrice < 63_000 && plan.stopPrice >= 63_000 * (1 - 0.025) - 0.1);
  assert.ok(plan.estimatedKrw > 50_000 && plan.estimatedKrw <= 1_000_000);
  assert.ok(plan.targetPrices[0] > 63_000 * 1.2);
  // one attempt per bar: the same bar does not re-enter
  const again = deps({ nowMs, loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(again);
  assert.equal(again.entries.length, 0);

  // The canonical risk gate accepts this plan under the pilot exception …
  const previous = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const decision = evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: true });
    assert.deepEqual(decision.blockCodes, [], decision.blockCodes.join());
    assert.ok(decision.warnings.includes('TREND_PILOT_LIVE_EXCEPTION_V1:RESEARCH_PROMOTION_BYPASSED'));
    // … and still enforces the ordinary caps
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: true, serverLiveEnabled: true }).blockCodes.includes('EMERGENCY_STOP_ACTIVE'));
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: false }).blockCodes.includes('LIVE_EXECUTION_DISABLED'));
    assert.ok(evaluateTradingPlan({ ...plan, estimatedKrw: 2_000_000 }, d.policy, { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('MAX_ORDER_AMOUNT'));
    // a forged or altered plan gets no exception
    const forged = { ...plan, stopPrice: plan.stopPrice - 500 };
    const forgedDecision = evaluateTradingPlan(forged, d.policy, { emergencyStopped: false, serverLiveEnabled: true });
    assert.ok(forgedDecision.blockCodes.includes('TREND_PILOT_SIGNATURE_INVALID'));
    assert.ok(forgedDecision.blockCodes.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
    const notEnabled = evaluateTradingPlan(plan, policy({ enabledStrategies: ['OTHER'] }), { emergencyStopped: false, serverLiveEnabled: true });
    assert.ok(notEnabled.blockCodes.includes('TREND_PILOT_STRATEGY_NOT_ENABLED'));
    process.env.TREND_PILOT_LIVE_ENABLED = 'false';
    assert.ok(evaluateTradingPlan(plan, d.policy, { emergencyStopped: false, serverLiveEnabled: true }).blockCodes.includes('TREND_PILOT_LIVE_DISABLED'));
  } finally {
    for (const k of Object.keys(ENV)) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
  }
  // stale signal: same plan, checked 2 hours later
  const stale = evaluateTrendPilotLiveException(plan, d.policy, nowMs + (2 * 3_600_000), ENV);
  assert.deepEqual(stale.blockCodes, ['TREND_PILOT_SIGNAL_STALE']);
});

test('no entry: not armed, killed, daily loss, held symbol, late signal, no breakout', async () => {
  const nowMs = Date.now();
  const lastOpen = nowMs - H4 - (5 * 60_000);
  const notArmed = deps({ nowMs, entriesArmed: false });
  await runTrendPilotLaneTick(notArmed);
  assert.equal(notArmed.entries.length, 0);

  const killedLedger = { ...createTrendPilotLedger('u1'), killed: true, killReason: 'KILL_DRAWDOWN_REACHED' };
  const killed = deps({ nowMs, loadLedger: async () => killedLedger });
  const killedResult = await runTrendPilotLaneTick(killed);
  assert.equal(killed.entries.length, 0);
  assert.ok(killedResult.guardBlockers.includes('KILL_SWITCH_ACTIVE'));

  // drawdown −40% from the stored peak arms the kill switch
  const peakLedger = { ...createTrendPilotLedger('u1'), peakEquityKrw: 170_000 };
  const dd = deps({ nowMs, loadLedger: async () => peakLedger });
  const ddResult = await runTrendPilotLaneTick(dd);
  assert.ok(ddResult.events.some((e) => e.kind === 'KILL'));
  assert.equal(dd.saved.at(-1)!.killed, true);
  assert.equal(dd.entries.length, 0);

  // equity 2% below today's start → daily stop
  const day = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  const dayLedger = { ...createTrendPilotLedger('u1'), peakEquityKrw: 102_100, dayKey: day, dayStartEquityKrw: 102_100 };
  const daily = deps({ nowMs, loadLedger: async () => dayLedger });
  const dailyResult = await runTrendPilotLaneTick(daily);
  assert.ok(dailyResult.guardBlockers.includes('DAILY_LOSS_LIMIT'));
  assert.equal(daily.entries.length, 0);

  const held = deps({ nowMs, foreignSymbols: new Set(['BTCUSDT', 'ETHUSDT']) });
  await runTrendPilotLaneTick(held);
  assert.equal(held.entries.length, 0);

  const late = deps({ nowMs, readClosedBars: async () => breakoutBars(nowMs - H4 - (40 * 60_000)) });
  await runTrendPilotLaneTick(late);
  assert.equal(late.entries.length, 0);

  const flat = deps({ nowMs, readClosedBars: async () => breakoutBars(lastOpen, false) });
  await runTrendPilotLaneTick(flat);
  assert.equal(flat.entries.length, 0);

  const staleQuote = deps({ nowMs, readQuote: async () => ({ bid: 1, ask: 1, last: 1, observedAtMs: nowMs - 120_000, oneMinuteMovePercent: 0, orderbookGapPercent: 0, source: 't' }) });
  const staleResult = await runTrendPilotLaneTick(staleQuote);
  assert.equal(staleQuote.entries.length, 0);
  assert.ok(staleResult.events.some((e) => e.kind === 'ERROR' && e.code === 'TREND_PILOT_QUOTE_NOT_FRESH'));
});

test('open position: trail moves on closed bars and a crossed trail exits; account failure still manages exits', async () => {
  const nowMs = Date.now();
  const lastOpen = Math.floor(nowMs / H4) * H4 - H4;
  const position: TrendPilotLanePosition = {
    planId: 'p1', strategyId: TREND_PILOT_V1.strategyId, symbol: 'BTCUSDT', side: 'long', entryPrice: 60_000,
    initialStopPrice: 58_800, remainingQuantity: 0.001, notionalKrw: 84_000, leverage: 5,
    openedAtMs: lastOpen - (3 * H4) + 60_000, activeExit: false,
  };
  const bars: TrendPilotCandle[] = [];
  for (let i = 0; i < 231; i += 1) bars.push({ timestamp: lastOpen - ((233 - i) * H4), open: 60_000, high: 60_300, low: 59_700, close: 60_000 });
  bars.push({ timestamp: lastOpen - (2 * H4), open: 60_000, high: 62_000, low: 59_900, close: 61_800 });
  bars.push({ timestamp: lastOpen - H4, open: 61_800, high: 64_000, low: 61_500, close: 63_800 });
  bars.push({ timestamp: lastOpen, open: 63_800, high: 64_200, low: 63_000, close: 63_500 });
  const d = deps({
    nowMs, positions: [position], readClosedBars: async () => bars,
    readQuote: async () => ({ bid: 61_900, ask: 61_910, last: 61_900, observedAtMs: nowMs - 500, oneMinuteMovePercent: -0.5, orderbookGapPercent: 0.01, source: 't' }),
    readAccount: async () => { throw new Error('TREND_PILOT_ACCOUNT_STALE'); },
  });
  const result = await runTrendPilotLaneTick(d);
  const trail = d.saved.at(-1)!.trails.p1;
  assert.ok(trail.stopPrice > 60_000, `trailed to ${trail.stopPrice}`);
  assert.equal(trail.stopKind, 'trailing');
  assert.equal(d.exits.length, 1, 'bid 61,900 is below the trail (64,200 − 2.5 × ATR ≈ 61,985)');
  assert.equal(d.exits[0].reason, 'TRAILING_TAKE_PROFIT');
  assert.equal(d.entries.length, 0, 'no account → no entries');
  assert.ok(result.events.some((e) => e.kind === 'ERROR' && e.code === 'TREND_PILOT_ACCOUNT_STALE'));

  // an exit already in flight is not duplicated; a closed position drops its trail
  const inflight = deps({ nowMs, positions: [{ ...position, activeExit: true }], readClosedBars: async () => bars, loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(inflight);
  assert.equal(inflight.exits.length, 0);
  const closed = deps({ nowMs, positions: [], readClosedBars: async () => bars, loadLedger: async () => d.saved.at(-1)! });
  await runTrendPilotLaneTick(closed);
  assert.deepEqual(Object.keys(closed.saved.at(-1)!.trails), []);
  assert.equal(closed.saved.at(-1)!.closedCount, 1);
});

test('upbit: long-only market buy by KRW amount; helpers', async () => {
  const nowMs = Date.now();
  const lastOpen = nowMs - H4 - (5 * 60_000);
  const krwBars = breakoutBars(lastOpen).map((b) => ({ ...b, open: b.open * 1500, high: b.high * 1500, low: b.low * 1500, close: b.close * 1500 }));
  const d = deps({
    nowMs, venue: 'upbit', fx: { krwPerQuoteCurrency: 1, source: 'NATIVE_KRW' }, readContractRules: undefined,
    readClosedBars: async () => krwBars,
    readQuote: async () => ({ bid: 94_480_000, ask: 94_500_000, last: 94_500_000, observedAtMs: nowMs - 500, oneMinuteMovePercent: 0.1, orderbookGapPercent: 0.02, source: 't' }),
    readAccount: async () => ({ equityKrw: 300_000, availableKrw: 300_000, observedAtMs: nowMs - 500 }),
  });
  await runTrendPilotLaneTick(d);
  assert.equal(d.entries.length, TREND_PILOT_SPOT_V1.symbols.length > 0 ? d.entries.length : 0);
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
});
