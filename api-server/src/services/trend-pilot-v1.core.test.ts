import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TREND_PILOT_V1,
  advanceTrendPilotStop,
  computeAtrSeries,
  computeAverageEntryPrice,
  computePositionPnl,
  computeReturnOnMargin,
  computeRMultiple,
  computeTrendPilotEntryPlan,
  estimateIsolatedLiquidationPrice,
  evaluateTrendPilotGuards,
  evaluateTrendPilotSignal,
  floorToStep,
  kstDayKey,
  roundStopToTick,
  safeDivide,
  selectClosedBars,
  type TrendPilotCandle,
  type TrendPilotPositionState,
} from './trend-pilot-v1.core';

// Verbatim copy of trendSignalsV1 from research-production/src/trend-pilot-backtest-v1.mjs
// (draft PR #1946) — the live rule must match the backtested rule bar for bar.
function trendSignalsV1(candles: TrendPilotCandle[], { channel = 55, ema = 200 } = {}) {
  const long = new Array(candles.length).fill(false);
  const short = new Array(candles.length).fill(false);
  const k = 2 / (ema + 1);
  let e: number | null = null;
  for (let i = 0; i < candles.length; i += 1) {
    e = e === null ? candles[i].close : (candles[i].close * k) + (e * (1 - k));
    if (i < Math.max(channel, ema)) continue;
    const prior = candles.slice(i - channel, i);
    const hi = Math.max(...prior.map((c) => c.high));
    const lo = Math.min(...prior.map((c) => c.low));
    long[i] = candles[i].close > hi && candles[i].close > e;
    short[i] = candles[i].close < lo && candles[i].close < e;
  }
  return { long, short };
}

const H4 = TREND_PILOT_V1.intervalMs;
const T0 = Date.UTC(2025, 0, 1);
const RULES = { minTradeNum: 0.0001, sizeStep: 0.0001, minTradeUsdt: 5, priceStep: 0.1 };

function walk(n: number, seed: number, drift = 0): TrendPilotCandle[] {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out: TrendPilotCandle[] = [];
  let price = 60_000;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = open * (1 + drift + ((rnd() - 0.5) * 0.03));
    out.push({ timestamp: T0 + (i * H4), open, close, high: Math.max(open, close) * (1 + (rnd() * 0.006)), low: Math.min(open, close) * (1 - (rnd() * 0.006)), volume: 1 });
    price = close;
  }
  return out;
}

test('arithmetic helpers fail closed on bad input', () => {
  assert.equal(safeDivide(1, 0), null);
  assert.equal(safeDivide(Number.NaN, 1), null);
  assert.equal(safeDivide(6, 3), 2);
  assert.equal(floorToStep(0.30000000004, 0.1), 0.3);
  assert.equal(floorToStep(0.12345, 0.001), 0.123);
  assert.equal(floorToStep(-1, 0.1), null);
  assert.equal(floorToStep(1, 0), null);
  assert.equal(roundStopToTick(100.04, 0.1, 'long'), 100.1);
  assert.equal(roundStopToTick(100.06, 0.1, 'short'), 100);
  assert.equal(computePositionPnl('long', 100, 110, 2), 20);
  assert.equal(computePositionPnl('short', 100, 110, 2), -20);
  assert.equal(computePositionPnl('long', 0, 110, 2), null);
  assert.equal(computeReturnOnMargin(10, 0), null);
  assert.equal(computeReturnOnMargin(10, 50), 0.2);
  assert.equal(computeRMultiple('short', 100, 96, 2), 2);
  assert.equal(computeRMultiple('long', 100, 96, 0), null);
  assert.equal(computeAverageEntryPrice([{ price: 100, quantity: 1 }, { price: 110, quantity: 3 }]), 107.5);
  assert.equal(computeAverageEntryPrice([]), null);
  assert.equal(computeAverageEntryPrice([{ price: 100, quantity: 0 }]), null);
  const liqLong = estimateIsolatedLiquidationPrice('long', 100, 5, 0.005);
  assert.ok(liqLong !== null && Math.abs(liqLong - 80.5) < 1e-9);
  assert.equal(estimateIsolatedLiquidationPrice('long', 100, 0, 0.005), null);
  assert.equal(kstDayKey(Date.UTC(2026, 9, 17, 15, 30)), '2026-10-18');
});

test('signal matches the research backtest rule bar for bar', () => {
  const bars = walk(900, 7, 0.0005);
  const research = trendSignalsV1(bars, { channel: 55, ema: 200 });
  let longs = 0; let shorts = 0;
  for (let i = TREND_PILOT_V1.minimumBars; i < bars.length; i += 1) {
    const live = evaluateTrendPilotSignal(bars.slice(0, i + 1));
    assert.equal(live.side === 'long', research.long[i], `long @${i}`);
    assert.equal(live.side === 'short', research.short[i], `short @${i}`);
    if (live.side === 'long') longs += 1;
    if (live.side === 'short') shorts += 1;
  }
  assert.ok(longs + shorts > 0, 'fixture produces signals');
});

test('signal requires enough contiguous closed bars', () => {
  const bars = walk(300, 3);
  assert.equal(evaluateTrendPilotSignal(bars.slice(0, 100)).blocker, 'INSUFFICIENT_BARS');
  const gap = [...bars.slice(0, 250), ...bars.slice(251)];
  assert.equal(evaluateTrendPilotSignal(gap).blocker, 'BAR_GAP');
  // the still-forming bar is never used
  const now = bars.at(-1)!.timestamp + (H4 / 2);
  assert.equal(selectClosedBars(bars, now).length, bars.length - 1);
  assert.equal(selectClosedBars([{ timestamp: T0, open: 1, high: 0.5, low: 0.4, close: 1 }], T0 + H4).length, 0);
  assert.equal(computeAtrSeries(bars)[13], null);
  assert.ok((computeAtrSeries(bars)[14] ?? 0) > 0);
});

test('sizing: balance × 2% ÷ stop, capped by max order and 5x margin', () => {
  // 100,000 KRW, BTC 60,000 USDT, ATR 600 → stop = min(1,200, 1,500) = 1,200 (2%)
  const base = { side: 'long' as const, referencePrice: 60_000, atr: 600, equityKrw: 100_000, usdKrw: 1_400, maxOrderKrw: 500_000, openMarginKrw: 0, contract: RULES };
  const plan = computeTrendPilotEntryPlan(base);
  assert.equal(plan.ok, true, plan.blockers.join());
  assert.equal(plan.stopPrice, 58_800);
  assert.equal(plan.capReason, 'RISK');
  assert.ok(Math.abs(plan.wantedNotionalKrw! - 100_000) < 1e-6);
  // BTC size step 0.0001 (≈8,400 KRW) floors 0.00119 → 0.0011: never more than the budget
  assert.equal(plan.quantity, 0.0011);
  assert.equal(Math.round(plan.notionalKrw!), 92_400);
  assert.equal(Math.round(plan.riskKrw!), 1_848);
  assert.ok(plan.marginKrw! <= 20_000);

  // Wider ATR is capped at 2.5% of price
  const wide = computeTrendPilotEntryPlan({ ...base, atr: 2_000 });
  assert.equal(wide.stopPrice, 58_500);

  // Short: stop above entry
  const short = computeTrendPilotEntryPlan({ ...base, side: 'short' });
  assert.equal(short.stopPrice, 61_200);

  // Compounding: 2,000,000 KRW wants 2M → member cap 500k binds
  const big = computeTrendPilotEntryPlan({ ...base, equityKrw: 2_000_000 });
  assert.equal(big.capReason, 'MAX_ORDER');
  assert.ok(big.notionalKrw! <= 500_000);

  // Tight stop on a small balance → 5x margin binds
  const tight = computeTrendPilotEntryPlan({ ...base, atr: 30, maxOrderKrw: 1_000_000 });
  assert.equal(tight.capReason, 'MARGIN');
  assert.ok(tight.notionalKrw! <= 500_000);
  const crowded = computeTrendPilotEntryPlan({ ...base, atr: 30, maxOrderKrw: 1_000_000, openMarginKrw: 60_000 });
  assert.ok(crowded.notionalKrw! <= 200_000 + 1e-6);
});

test('sizing blocks bad inputs, minimum orders and out-of-range settings', () => {
  const base = { side: 'long' as const, referencePrice: 60_000, atr: 600, equityKrw: 100_000, usdKrw: 1_400, maxOrderKrw: 500_000, openMarginKrw: 0, contract: RULES };
  assert.deepEqual(computeTrendPilotEntryPlan({ ...base, equityKrw: 0 }).blockers, ['NO_EQUITY']);
  assert.deepEqual(computeTrendPilotEntryPlan({ ...base, usdKrw: Number.NaN }).blockers, ['INVALID_FX']);
  assert.deepEqual(computeTrendPilotEntryPlan({ ...base, leverage: 10 }).blockers, ['LEVERAGE_OUT_OF_RANGE']);
  assert.deepEqual(computeTrendPilotEntryPlan({ ...base, riskFraction: 0.05 }).blockers, ['RISK_FRACTION_OUT_OF_RANGE']);
  assert.deepEqual(computeTrendPilotEntryPlan({ ...base, contract: { ...RULES, sizeStep: 0 } }).blockers, ['INVALID_CONTRACT_RULES']);
  const tiny = computeTrendPilotEntryPlan({ ...base, equityKrw: 5_000 });
  assert.equal(tiny.ok, false);
  assert.ok(tiny.blockers.includes('BELOW_MIN_NOTIONAL') || tiny.blockers.includes('QUANTITY_BELOW_STEP'));
  assert.equal(computeTrendPilotEntryPlan({ ...base, contract: { ...RULES, minTradeNum: 0.01 } }).blockers.includes('BELOW_MIN_TRADE_NUM'), true);
  // 7x with a 2.5% stop leaves liquidation ~13.8% away > 3 × 2.5% → allowed
  assert.equal(computeTrendPilotEntryPlan({ ...base, atr: 2_000, leverage: 7 }).ok, true);
});

test('stop management: breakeven at +1R, ATR trail, tighten-only, time exit', () => {
  const state: TrendPilotPositionState = {
    side: 'long', entryPrice: 60_000, riskUnit: 1_200, entryAtr: 600, stopPrice: 58_800, stopKind: 'initial',
    bestPrice: 60_000, maxFavorableR: 0, entryBarOpenMs: T0, lastProcessedBarOpenMs: null,
  };
  const bar = (i: number, high: number, low: number, close: number): TrendPilotCandle => ({ timestamp: T0 + (i * H4), open: close, high, low, close });
  const a = advanceTrendPilotStop(state, bar(0, 60_500, 59_800, 60_300), 600, 0.1);
  assert.equal(a.state.stopPrice, 59_000, 'trail from the start (best 60,500 − 1,500)');
  assert.equal(a.state.stopKind, 'trailing');
  const flat = advanceTrendPilotStop(state, bar(0, 60_100, 59_800, 60_000), 600, 0.1);
  assert.equal(flat.state.stopPrice, 58_800, 'trail below the initial stop never loosens it');
  assert.equal(a.exit, null);
  const b = advanceTrendPilotStop(a.state, bar(1, 61_300, 60_200, 61_100), 600, 0.1);
  assert.equal(b.state.stopKind, 'breakeven');
  assert.equal(b.state.stopPrice, 60_000);
  const c = advanceTrendPilotStop(b.state, bar(2, 64_000, 61_000, 63_500), 600, 0.1);
  assert.equal(c.state.stopKind, 'trailing');
  assert.equal(c.state.stopPrice, 62_500);
  const d = advanceTrendPilotStop(c.state, bar(3, 63_000, 62_600, 62_800), 900, 0.1);
  assert.equal(d.state.stopPrice, 62_500, 'wider ATR never loosens the stop');
  assert.equal(advanceTrendPilotStop(d.state, bar(3, 70_000, 69_000, 69_500), 600, 0.1).stopChanged, false, 'same bar twice ignored');
  const e = advanceTrendPilotStop(d.state, bar(4, 62_700, 62_000, 62_100), 600, 0.1);
  assert.equal(e.exit, 'STOP_BREACHED_ON_CLOSE');
  const late = advanceTrendPilotStop({ ...state, lastProcessedBarOpenMs: T0 + (178 * H4) }, bar(179, 60_100, 59_900, 60_000), 600, 0.1);
  assert.equal(late.barsHeld, 180);
  assert.equal(late.exit, 'TIME_EXIT');

  const shortState: TrendPilotPositionState = { ...state, side: 'short', stopPrice: 61_200, bestPrice: 60_000 };
  const s = advanceTrendPilotStop(shortState, bar(0, 60_100, 58_500, 58_700), 600, 0.1);
  assert.equal(s.state.stopPrice, 60_000);
  assert.equal(s.state.stopKind, 'breakeven');
});

test('guards: daily loss 2% and kill switch at -40% from peak', () => {
  const ok = evaluateTrendPilotGuards({ equityKrw: 100_000, peakEquityKrw: 100_000, dayStartEquityKrw: 100_000, dayRealizedPnlKrw: -1_900, killed: false });
  assert.equal(ok.allowEntry, true);
  const day = evaluateTrendPilotGuards({ equityKrw: 98_000, peakEquityKrw: 100_000, dayStartEquityKrw: 100_000, dayRealizedPnlKrw: -2_000, killed: false });
  assert.deepEqual(day.blockers, ['DAILY_LOSS_LIMIT']);
  const notYet = evaluateTrendPilotGuards({ equityKrw: 112_500, peakEquityKrw: 150_000, dayStartEquityKrw: 113_000, dayRealizedPnlKrw: -500, killed: false });
  assert.equal(notYet.killNow, false, '-25% no longer stops');
  const kill = evaluateTrendPilotGuards({ equityKrw: 90_000, peakEquityKrw: 150_000, dayStartEquityKrw: 90_500, dayRealizedPnlKrw: -500, killed: false });
  assert.equal(kill.killNow, true);
  assert.equal(kill.allowEntry, false);
  const already = evaluateTrendPilotGuards({ equityKrw: 200_000, peakEquityKrw: 200_000, dayStartEquityKrw: 200_000, dayRealizedPnlKrw: 0, killed: true });
  assert.deepEqual(already.blockers, ['KILL_SWITCH_ACTIVE']);
  assert.equal(already.killNow, false);
  assert.equal(evaluateTrendPilotGuards({ equityKrw: Number.NaN, peakEquityKrw: 1, dayStartEquityKrw: 1, dayRealizedPnlKrw: 0, killed: false }).allowEntry, false);
});

test('ledger: day roll, peak, close accounting, kill and re-arm, client oid', async () => {
  const core = await import('./trend-pilot-v1.core');
  const day1 = Date.UTC(2026, 9, 18, 1);
  let l = core.observeTrendPilotEquity(core.createTrendPilotLedger('m1'), 100_000, day1);
  assert.equal(l.dayStartEquityKrw, 100_000);
  l = core.recordTrendPilotClose(l, 'BTCUSDT', -1_500, day1 + 3_600_000);
  assert.equal(l.dayRealizedPnlKrw, -1_500);
  l = core.observeTrendPilotEquity(l, 98_500, day1 + 7_200_000);
  assert.equal(l.dayStartEquityKrw, 100_000, 'same KST day keeps the start');
  assert.equal(l.peakEquityKrw, 100_000);
  l = core.observeTrendPilotEquity(l, 98_500, day1 + 86_400_000);
  assert.equal(l.dayRealizedPnlKrw, 0, 'new KST day resets');
  assert.equal(l.dayStartEquityKrw, 98_500);
  l = core.killTrendPilot(l, 'KILL_DRAWDOWN_REACHED', day1);
  assert.equal(core.killTrendPilot(l, 'again', day1 + 1).killReason, 'KILL_DRAWDOWN_REACHED');
  l = core.rearmTrendPilot(l, 90_000, day1);
  assert.equal(l.killed, false);
  assert.equal(l.peakEquityKrw, 90_000);
  const a = core.trendPilotClientOid('m1', 'BTCUSDT', T0);
  assert.equal(a, core.trendPilotClientOid('m1', 'BTCUSDT', T0));
  assert.notEqual(a, core.trendPilotClientOid('m1', 'ETHUSDT', T0));
  assert.notEqual(a, core.trendPilotClientOid('m2', 'BTCUSDT', T0));
  assert.ok(a.length <= 40);
});
