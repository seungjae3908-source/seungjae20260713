// Trend pilot v1 — per-member lane tick (orchestration only).
//
// Runs inside the member automatic-trading worker, AFTER the worker's own live
// exit block, only for automatic policies, and only while the live exit arm is
// present. It never talks to an exchange directly: entries and exits are handed
// back to the worker's canonical path (createPlan → risk gate → pre-submission
// → execute), so the emergency stop, live arm, member access, max order,
// margin, atomic budget and isolation checks all still apply.
//
// Per tick and venue:
//   1. open pilot positions: apply newly closed 4h bars to the trailing stop
//      (breakeven at +1R, best − 2.5 ATR, tighten-only); a closed-bar exit
//      (180-bar cap, stop crossed at the close) is kept pending and retried as a
//      forced close every tick; otherwise close when the live price crosses the
//      trail. Bitget also keeps the initial stop as an exchange preset stop-loss.
//      Nothing in this step depends on the account read.
//   2. account + journal context (lazy) → KST day and peak → guards (daily −2%
//      or the member's tighter limit, kill at −40% from the peak). A kill stops
//      NEW entries only; the owner re-arms with TREND_PILOT_REARM=<venue>:<killedAtMs>.
//   3. symbols without a position: evaluate the just-closed bar; on a breakout,
//      size from equity × 2% ÷ stop inside every policy/budget cap and submit one
//      signed entry (≤3 attempts per bar when blocked).
import {
  TREND_PILOT_SPOT_V1,
  TREND_PILOT_V1,
  advanceTrendPilotStop,
  computeAtrSeries,
  computeTrendPilotEntryPlan,
  computeTrendPilotSpotEntryPlan,
  createTrendPilotLedger,
  evaluateTrendPilotGuards,
  evaluateTrendPilotSignal,
  evaluateTrendPilotSpotSignal,
  killTrendPilot,
  observeTrendPilotEquity,
  rearmTrendPilot,
  recordTrendPilotClose,
  safeDivide,
  type TrendPilotCandle,
  type TrendPilotContractRules,
  type TrendPilotLedger,
  type TrendPilotSide,
  type TrendPilotTrail,
} from './trend-pilot-v1.core';
import { TREND_PILOT_LANE_REASON, signTrendPilotOccurrence } from './trend-pilot-v1-authorization.service';
import type { TradingPlanInput, TradingPolicy } from './trade-automation.types';

export type TrendPilotVenue = 'bitget' | 'upbit';

export type TrendPilotQuote = {
  bid: number;
  ask: number;
  last: number;
  observedAtMs: number;
  oneMinuteMovePercent: number;
  orderbookGapPercent: number;
  source: string;
};

export type TrendPilotAccount = {
  equityKrw: number; // Bitget: USDT account equity × fx; Upbit: KRW + holdings at mark
  availableKrw: number; // free margin (Bitget) or free KRW cash (Upbit)
  observedAtMs: number;
};

/** Account-wide figures from the canonical runtime (all live automatic plans). */
export type TrendPilotAccountCounters = {
  /** Notional sums as the atomic budget claim counts them. */
  accountNotionalKrw: number;
  /** Budget market limit for this venue's asset class (policy maxAssetClassKrw). */
  marketLimitKrw?: number;
  classNotionalKrw: number;
  strategyNotionalKrw: number;
  /** Gate exposures: identical, except pilot Bitget positions count by margin. */
  accountExposureKrw: number;
  assetClassExposureKrw: number;
  strategyExposureKrw: number;
  openRiskKrw: number;
  openPositionCount: number;
  dailyOrderCount: number;
  consecutiveLosses: number;
  weeklyPnlPercent: number;
  /** Canonical journal day P&L % (what the risk gate's DAILY_LOSS_LIMIT reads). */
  dailyPnlPercent: number;
};

export type TrendPilotEntryContext = {
  account: TrendPilotAccount;
  counters: TrendPilotAccountCounters;
  /** Manual holdings on this venue: never stacked with a pilot entry. */
  heldSymbols: ReadonlySet<string>;
};

export type TrendPilotLanePosition = {
  planId: string;
  strategyId: string;
  symbol: string;
  side: 'long' | 'short' | 'buy';
  entryPrice: number; // average fill, quote currency
  initialStopPrice: number;
  remainingQuantity: number;
  notionalKrw: number;
  leverage: number;
  openedAtMs: number;
  activeExit: boolean;
};

export type TrendPilotExitReason = 'TRAILING_TAKE_PROFIT' | 'STOP_LOSS' | 'FORCE_CLOSE';
export type TrendPilotSubmitStatus = 'SUBMITTED' | 'BLOCKED' | 'DUPLICATE' | 'STALE_POSITION';

export type TrendPilotLaneDependencies = {
  venue: TrendPilotVenue;
  userId: string;
  policy: TradingPolicy;
  nowMs: number;
  signingKey: string;
  /** null when the fx quote is unavailable: exits still run, entries do not. */
  fx: { krwPerQuoteCurrency: number; source: string } | null;
  /** False while the worker's live entry arm/warmup is not complete: manage exits only. */
  entriesArmed: boolean;
  /** Owner re-arm after a kill: exactly `${venue}:${killedAtMs}` (env TREND_PILOT_REARM). */
  rearmToken: string | null;
  /** Symbols use the plan form: BTCUSDT on Bitget, BTC on Upbit (adapters add KRW-). */
  readClosedBars: (symbol: string) => Promise<TrendPilotCandle[]>;
  readQuote: (symbol: string) => Promise<TrendPilotQuote>;
  readContractRules?: (symbol: string) => Promise<TrendPilotContractRules>;
  /** Read only after exits have been handled. */
  readEntryContext: () => Promise<TrendPilotEntryContext>;
  /** Live positions of this lane's strategy on this venue (from canonical plans/orders). */
  positions: TrendPilotLanePosition[];
  /** Symbols held on this venue by other automatic strategies. */
  foreignSymbols: ReadonlySet<string>;
  submitEntry: (plan: TradingPlanInput) => Promise<{ status: TrendPilotSubmitStatus; blockCodes?: string[] }>;
  submitExit: (position: TrendPilotLanePosition, reason: TrendPilotExitReason, triggerPrice: number) => Promise<{ status: TrendPilotSubmitStatus; blockCodes?: string[] }>;
  loadLedger: () => Promise<TrendPilotLedger | null>;
  saveLedger: (ledger: TrendPilotLedger) => Promise<void>;
};

export type TrendPilotLaneEvent =
  | { kind: 'KILL'; drawdownFraction: number | null; reason: string }
  | { kind: 'REARM' }
  | { kind: 'ENTRY'; symbol: string; side: string; status: string; orderKrw: number | null; blockCodes: string[] }
  | { kind: 'ENTRY_SKIPPED'; symbol: string; blockers: string[] }
  | { kind: 'EXIT'; symbol: string; reason: string; status: string; stopPrice: number }
  | { kind: 'STOP_MOVED'; symbol: string; stopPrice: number; stopKind: string }
  | { kind: 'ERROR'; symbol: string | null; code: string };

export type TrendPilotLaneTickResult = {
  venue: TrendPilotVenue;
  equityKrw: number | null;
  allowEntry: boolean;
  guardBlockers: string[];
  events: TrendPilotLaneEvent[];
  ledger: TrendPilotLedger | null;
};

const MAX_ENTRY_DELAY_AFTER_CLOSE_MS = 25 * 60 * 1000; // inside the 30-minute authorization window
const MAX_QUOTE_AGE_MS = 15_000; // pre-submission requires a signal observation ≤ 30 s old
const MAX_ENTRY_ATTEMPTS_PER_BAR = 3;
// The canonical gates turn FAST_MOVE_DETECTED into a GLOBAL emergency stop
// (trade-kill-switch.service.ts). Never submit into a ≥ 5% one-minute move;
// the bar's attempt counter retries on a later tick.
const FAST_MOVE_SKIP_PERCENT = 4;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function errorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? 'UNKNOWN');
  const head = text.split(':')[0];
  return /^[A-Z0-9_]{3,120}$/u.test(head) ? head : 'TREND_PILOT_STEP_FAILED';
}

function laneSymbols(venue: TrendPilotVenue): readonly string[] {
  return venue === 'bitget' ? TREND_PILOT_V1.symbols : TREND_PILOT_SPOT_V1.symbols.map((s) => s.replace(/^KRW-/u, ''));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^KRW-/u, '');
}

function positionSide(position: TrendPilotLanePosition): TrendPilotSide {
  return position.side === 'short' ? 'short' : 'long';
}

function freshQuote(quote: TrendPilotQuote, nowMs: number): boolean {
  return positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid && positive(quote.last)
    && Number.isFinite(quote.observedAtMs) && quote.observedAtMs <= nowMs + 5_000 && nowMs - quote.observedAtMs <= MAX_QUOTE_AGE_MS;
}

/** A first sight of an open position (e.g. after a restart): rebuild its trail from the plan. */
export function initialTrail(position: TrendPilotLanePosition): TrendPilotTrail | null {
  const riskUnit = Math.abs(position.entryPrice - position.initialStopPrice);
  if (!positive(position.entryPrice) || !positive(position.initialStopPrice) || !positive(riskUnit) || !Number.isFinite(position.openedAtMs)) return null;
  const barMs = Math.floor(position.openedAtMs / TREND_PILOT_V1.intervalMs) * TREND_PILOT_V1.intervalMs;
  return {
    planId: position.planId,
    symbol: position.symbol,
    side: positionSide(position),
    entryPrice: position.entryPrice,
    riskUnit,
    // stop = min(2 ATR, 2.5%) → ATR ≥ riskUnit / 2; used only until a live ATR exists
    entryAtr: riskUnit / TREND_PILOT_V1.stopAtrMultiple,
    stopPrice: position.initialStopPrice,
    stopKind: 'initial',
    bestPrice: position.entryPrice,
    maxFavorableR: 0,
    entryBarOpenMs: barMs,
    lastProcessedBarOpenMs: null,
    pendingExit: null,
  };
}

/** Pure: KRW exposure a pilot position consumes (margin on Bitget, notional on Upbit). */
export function laneExposureKrw(venue: TrendPilotVenue, position: Pick<TrendPilotLanePosition, 'notionalKrw' | 'leverage'>): number {
  if (!positive(position.notionalKrw)) return 0;
  if (venue === 'upbit') return position.notionalKrw;
  const margin = safeDivide(position.notionalKrw, Math.max(1, position.leverage));
  return margin ?? position.notionalKrw;
}

/** Pure: open risk in KRW for a position at its current stop (never negative). */
export function laneOpenRiskKrw(position: TrendPilotLanePosition, stopPrice: number, krwPerQuote: number): number {
  const distance = positionSide(position) === 'long' ? position.entryPrice - stopPrice : stopPrice - position.entryPrice;
  if (!positive(distance) || !positive(position.remainingQuantity) || !positive(krwPerQuote)) return 0;
  return distance * position.remainingQuantity * krwPerQuote;
}

/** Pure: a far protective target (12R) so the exchange preset take-profit almost never caps a trend. */
export function farTargetPrice(side: TrendPilotSide, entryPrice: number, riskUnit: number): number | null {
  if (!positive(entryPrice) || !positive(riskUnit)) return null;
  const target = side === 'long' ? entryPrice + (12 * riskUnit) : Math.max(entryPrice * 0.1, entryPrice - (12 * riskUnit));
  return positive(target) ? target : null;
}

/**
 * Pure: the largest order notional (KRW) every downstream cap allows: member
 * max order and instrument cap, and the atomic budget's strategy and total
 * limits on the configured total capital; plus the account-level stops the
 * canonical gate would otherwise turn into a global emergency stop.
 */
export function laneNotionalCeilingKrw(policy: TradingPolicy, counters: TrendPilotAccountCounters): { ceilingKrw: number; blockers: string[] } {
  const blockers: string[] = [];
  const capital = policy.totalCapitalKrw;
  const strategyRoom = (capital * policy.maxAssetPercent / 100) - counters.strategyNotionalKrw;
  const instrumentCap = Math.min(policy.maxInstrumentKrw, capital * policy.maxAssetPercent / 100);
  const totalRoom = capital - counters.accountNotionalKrw;
  const marketRoom = Number.isFinite(counters.marketLimitKrw) ? counters.marketLimitKrw! - counters.classNotionalKrw : Infinity;
  const ceilingKrw = Math.min(policy.maxOrderKrw, instrumentCap, strategyRoom, totalRoom, marketRoom);
  if (counters.openPositionCount >= policy.maxOpenPositions) blockers.push('OPEN_POSITION_LIMIT');
  if (policy.maxDailyOrders > 0 && counters.dailyOrderCount >= policy.maxDailyOrders) blockers.push('DAILY_ORDER_LIMIT');
  if (counters.consecutiveLosses >= policy.maxConsecutiveLosses) blockers.push('CONSECUTIVE_LOSS_LIMIT');
  if (counters.weeklyPnlPercent <= -policy.weeklyLossLimitPercent) blockers.push('WEEKLY_LOSS_LIMIT');
  if (counters.dailyPnlPercent <= -policy.dailyLossLimitPercent) blockers.push('POLICY_DAILY_LOSS_LIMIT');
  if (!(ceilingKrw > 0)) blockers.push('BUDGET_ROOM_EXHAUSTED');
  return { ceilingKrw: Math.max(0, ceilingKrw), blockers };
}

function markSignal(ledger: TrendPilotLedger, symbol: string, bar: number): TrendPilotLedger {
  const attempts = { ...ledger.signalAttempts };
  delete attempts[symbol];
  return { ...ledger, lastSignalBarOpenMs: { ...ledger.lastSignalBarOpenMs, [symbol]: bar }, signalAttempts: attempts };
}

function countAttempt(ledger: TrendPilotLedger, symbol: string, bar: number): TrendPilotLedger {
  const prior = ledger.signalAttempts[symbol];
  const count = prior && prior.bar === bar ? prior.count + 1 : 1;
  if (count >= MAX_ENTRY_ATTEMPTS_PER_BAR) return markSignal(ledger, symbol, bar);
  return { ...ledger, signalAttempts: { ...ledger.signalAttempts, [symbol]: { bar, count } } };
}

async function persist(deps: TrendPilotLaneDependencies, ledger: TrendPilotLedger, events: TrendPilotLaneEvent[]) {
  try {
    await deps.saveLedger(ledger);
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
  }
}

export async function runTrendPilotLaneTick(deps: TrendPilotLaneDependencies): Promise<TrendPilotLaneTickResult> {
  const events: TrendPilotLaneEvent[] = [];
  const { venue, nowMs } = deps;
  const result: TrendPilotLaneTickResult = { venue, equityKrw: null, allowEntry: false, guardBlockers: [], events, ledger: null };

  let ledger: TrendPilotLedger;
  try {
    const stored = await deps.loadLedger();
    if (stored) ledger = stored;
    else {
      ledger = createTrendPilotLedger(deps.userId);
      // A lost state file must not silently reset a kill or a drawdown peak
      // while positions are open; the owner re-arms explicitly.
      if (deps.positions.length > 0) ledger = killTrendPilot(ledger, 'LEDGER_MISSING_WITH_POSITIONS', nowMs);
    }
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
    return result; // no state → no entries; positions keep their exchange/worker stops
  }

  const barsCache = new Map<string, TrendPilotCandle[]>();
  const bars = async (symbol: string) => {
    if (!barsCache.has(symbol)) barsCache.set(symbol, await deps.readClosedBars(symbol));
    return barsCache.get(symbol)!;
  };

  // ---- 1. manage open positions (independent of account, fx and journal reads)
  const openIds = new Set(deps.positions.map((p) => p.planId));
  for (const planId of Object.keys(ledger.trails)) {
    if (!openIds.has(planId)) ledger = recordTrendPilotClose(ledger, planId, 0, nowMs);
  }
  for (const position of deps.positions) {
    try {
      let trail = ledger.trails[position.planId] ?? initialTrail(position);
      if (!trail) throw new Error('TREND_PILOT_POSITION_INVALID');
      const before = trail.stopPrice;
      try {
        const series = await bars(position.symbol);
        const atr = computeAtrSeries(series);
        const priceStep = deps.readContractRules ? (await deps.readContractRules(position.symbol)).priceStep : 1e-8;
        for (let i = 0; i < series.length && !trail.pendingExit; i += 1) {
          const bar = series[i];
          if (bar.timestamp < trail.entryBarOpenMs) continue;
          if (trail.lastProcessedBarOpenMs !== null && bar.timestamp <= trail.lastProcessedBarOpenMs) continue;
          const step = advanceTrendPilotStop(trail, bar, atr[i], priceStep);
          trail = { ...trail, ...step.state, pendingExit: step.exit ?? trail.pendingExit ?? null };
        }
      } catch (error) {
        // Bars unavailable: keep the last trail; the live-price check below still runs.
        events.push({ kind: 'ERROR', symbol: position.symbol, code: errorCode(error) });
      }
      ledger = { ...ledger, trails: { ...ledger.trails, [position.planId]: trail } };
      if (trail.stopPrice !== before) events.push({ kind: 'STOP_MOVED', symbol: position.symbol, stopPrice: trail.stopPrice, stopKind: trail.stopKind });
      if (position.activeExit) continue;

      const side = positionSide(position);
      let reason: TrendPilotExitReason | null = null;
      if (trail.pendingExit) {
        reason = 'FORCE_CLOSE';
      } else {
        const quote = await deps.readQuote(position.symbol);
        if (!freshQuote(quote, nowMs)) throw new Error('TREND_PILOT_QUOTE_NOT_FRESH');
        // the price a market close would hit: bid for a long, ask for a short
        const closePrice = side === 'long' ? quote.bid : quote.ask;
        const crossed = side === 'long' ? closePrice <= trail.stopPrice : closePrice >= trail.stopPrice;
        if (crossed) reason = trail.stopKind === 'initial' ? 'STOP_LOSS' : 'TRAILING_TAKE_PROFIT';
      }
      if (reason) {
        const submitted = await deps.submitExit(position, reason, trail.stopPrice);
        events.push({ kind: 'EXIT', symbol: position.symbol, reason: trail.pendingExit ?? reason, status: submitted.status, stopPrice: trail.stopPrice });
      }
    } catch (error) {
      events.push({ kind: 'ERROR', symbol: position.symbol, code: errorCode(error) });
    }
  }

  // ---- 2. account, journal, day and kill guards (entries only)
  let context: TrendPilotEntryContext;
  try {
    context = await deps.readEntryContext();
    const { account } = context;
    if (!positive(account.equityKrw) || !Number.isFinite(account.availableKrw) || account.availableKrw < 0) throw new Error('TREND_PILOT_ACCOUNT_INVALID');
    if (nowMs - account.observedAtMs > 60_000 || account.observedAtMs > nowMs + 5_000) throw new Error('TREND_PILOT_ACCOUNT_STALE');
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
    await persist(deps, ledger, events);
    return { ...result, ledger };
  }
  const { account, counters } = context;
  result.equityKrw = account.equityKrw;
  if (ledger.killed && deps.rearmToken && deps.rearmToken === `${venue}:${ledger.killedAtMs}`) {
    ledger = rearmTrendPilot(ledger, account.equityKrw, nowMs);
    events.push({ kind: 'REARM' });
  }
  ledger = observeTrendPilotEquity(ledger, account.equityKrw, nowMs);
  // Daily loss is measured on equity (realized + open) against the KST day start.
  const dayPnl = account.equityKrw - (ledger.dayStartEquityKrw ?? account.equityKrw);
  const policyDailyFraction = Math.min(deps.policy.dailyLossLimitPercent, deps.policy.totalDailyLossLimitPercent) / 100;
  const guards = evaluateTrendPilotGuards({
    equityKrw: account.equityKrw, peakEquityKrw: ledger.peakEquityKrw ?? account.equityKrw,
    dayStartEquityKrw: ledger.dayStartEquityKrw ?? account.equityKrw, dayRealizedPnlKrw: dayPnl,
    killed: ledger.killed, dailyLossFraction: policyDailyFraction,
  });
  if (guards.killNow) {
    ledger = killTrendPilot(ledger, 'KILL_DRAWDOWN_REACHED', nowMs);
    events.push({ kind: 'KILL', drawdownFraction: guards.drawdownFraction, reason: 'KILL_DRAWDOWN_REACHED' });
  }
  const ceiling = laneNotionalCeilingKrw(deps.policy, counters);
  const blockers = [...guards.blockers, ...ceiling.blockers];
  if (ledger.killed && !blockers.includes('KILL_SWITCH_ACTIVE')) blockers.push('KILL_SWITCH_ACTIVE');
  if (!deps.fx || !positive(deps.fx.krwPerQuoteCurrency)) blockers.push('TREND_PILOT_FX_UNAVAILABLE');
  if (!deps.entriesArmed) blockers.push('LIVE_ENTRY_NOT_ARMED');
  result.guardBlockers = blockers;
  result.allowEntry = blockers.length === 0;

  // ---- 3. entries
  if (result.allowEntry && deps.fx) {
    const fx = deps.fx;
    const held = new Set([...deps.positions.map((p) => p.symbol), ...deps.foreignSymbols, ...context.heldSymbols].map(normalizeSymbol));
    const capitalBase = Math.min(deps.policy.totalCapitalKrw, account.equityKrw);
    const ownMarginKrw = deps.positions.reduce((sum, p) => sum + laneExposureKrw(venue, p), 0);
    // Bitget: never size past free margin either (other positions, open orders).
    let openMarginKrw = venue === 'bitget' ? Math.max(ownMarginKrw, capitalBase - account.availableKrw) : ownMarginKrw;
    let availableKrw = account.availableKrw;
    const live: TrendPilotAccountCounters = { ...counters };
    let ceilingKrw = ceiling.ceilingKrw;
    const riskBudgetKrw = deps.policy.totalCapitalKrw * deps.policy.totalDailyLossLimitPercent / 100;
    for (const symbol of laneSymbols(venue)) {
      if (held.has(symbol)) continue;
      let signalBar: number | null = null;
      try {
        const series = await bars(symbol);
        const signal = venue === 'upbit' ? evaluateTrendPilotSpotSignal(series) : evaluateTrendPilotSignal(series);
        if (signal.blocker || signal.signalBarOpenMs === null) {
          if (signal.blocker && signal.blocker !== 'INSUFFICIENT_BARS') events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: [signal.blocker] });
          continue;
        }
        signalBar = signal.signalBarOpenMs;
        if (ledger.lastSignalBarOpenMs[symbol] === signalBar) continue;
        const closedAtMs = signalBar + TREND_PILOT_V1.intervalMs;
        if (!signal.side || nowMs - closedAtMs > MAX_ENTRY_DELAY_AFTER_CLOSE_MS) { ledger = markSignal(ledger, symbol, signalBar); continue; }
        if (live.openPositionCount >= deps.policy.maxOpenPositions) { events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: ['OPEN_POSITION_LIMIT'] }); break; }
        const quote = await deps.readQuote(symbol);
        if (!freshQuote(quote, nowMs)) throw new Error('TREND_PILOT_QUOTE_NOT_FRESH');
        if (!Number.isFinite(quote.oneMinuteMovePercent) || Math.abs(quote.oneMinuteMovePercent) >= FAST_MOVE_SKIP_PERCENT) {
          events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: ['TREND_PILOT_FAST_MOVE'] });
          ledger = countAttempt(ledger, symbol, signalBar);
          continue;
        }
        const built = venue === 'bitget'
          ? await buildBitgetEntry({ deps, fx, symbol, side: signal.side, atr: signal.atr!, quote, capitalBase, ceilingKrw, openMarginKrw, signalBarOpenMs: signalBar })
          : buildUpbitEntry({ deps, symbol, atr: signal.atr!, quote, capitalBase, ceilingKrw, availableKrw, signalBarOpenMs: signalBar });
        if (!built.planInput) {
          events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: built.blockers });
          ledger = markSignal(ledger, symbol, signalBar);
          continue;
        }
        if (live.openRiskKrw + (built.riskKrw ?? 0) > riskBudgetKrw) {
          events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: ['OPEN_RISK_BUDGET'] });
          ledger = markSignal(ledger, symbol, signalBar);
          continue;
        }
        const exposureKrw = venue === 'bitget' ? built.planInput.estimatedKrw / TREND_PILOT_V1.leverage : built.planInput.estimatedKrw;
        const planInput: TradingPlanInput = {
          ...built.planInput,
          marketSnapshot: {
            ...built.planInput.marketSnapshot,
            accountExposureKrw: live.accountExposureKrw,
            instrumentExposureKrw: 0,
            strategyExposureKrw: live.strategyExposureKrw,
            assetClassExposureKrw: live.assetClassExposureKrw,
            openRiskKrw: live.openRiskKrw,
            openPositionCount: live.openPositionCount,
            dailyOrderCount: live.dailyOrderCount,
            assetExposurePercent: capitalBase > 0 ? (live.assetClassExposureKrw / capitalBase) * 100 : 100,
            correlatedExposurePercent: capitalBase > 0 ? Math.min(100, (live.assetClassExposureKrw / capitalBase) * 100) : 100,
            consecutiveLosses: live.consecutiveLosses,
            weeklyPnlPercent: live.weeklyPnlPercent,
            // The gate reads the canonical journal; the lane's own equity guard ran above.
            dailyPnlPercent: live.dailyPnlPercent,
          },
        };
        const submitted = await deps.submitEntry(planInput);
        events.push({ kind: 'ENTRY', symbol, side: planInput.side, status: submitted.status, orderKrw: planInput.estimatedKrw, blockCodes: submitted.blockCodes ?? [] });
        if (submitted.status === 'SUBMITTED' || submitted.status === 'DUPLICATE') ledger = markSignal(ledger, symbol, signalBar);
        else ledger = countAttempt(ledger, symbol, signalBar);
        if (submitted.status === 'SUBMITTED') {
          held.add(symbol);
          openMarginKrw += exposureKrw;
          live.accountExposureKrw += exposureKrw;
          live.assetClassExposureKrw += exposureKrw;
          live.strategyExposureKrw += exposureKrw;
          live.accountNotionalKrw += planInput.estimatedKrw;
          live.classNotionalKrw += planInput.estimatedKrw;
          live.strategyNotionalKrw += planInput.estimatedKrw;
          live.openRiskKrw += built.riskKrw ?? 0;
          live.openPositionCount += 1;
          live.dailyOrderCount += 1;
          ceilingKrw = laneNotionalCeilingKrw(deps.policy, live).ceilingKrw;
          if (venue === 'upbit') availableKrw = Math.max(0, availableKrw - planInput.estimatedKrw * (1 + TREND_PILOT_SPOT_V1.feeRate));
        }
      } catch (error) {
        events.push({ kind: 'ERROR', symbol, code: errorCode(error) });
        if (signalBar !== null) ledger = countAttempt(ledger, symbol, signalBar);
      }
    }
  }

  await persist(deps, ledger, events);
  return { ...result, ledger };
}

type BuiltEntry = { planInput: TradingPlanInput | null; blockers: string[]; riskKrw: number | null };

function baseSnapshot(quote: TrendPilotQuote, availableBalance: number, accountValueKrw: number, nowMs: number, executionPrice: number) {
  const midpoint = (quote.bid + quote.ask) / 2;
  const observedAt = new Date(quote.observedAtMs).toISOString();
  return {
    observedAt,
    riskObservedAt: new Date(nowMs).toISOString(),
    dataDelayMs: Math.max(0, nowMs - quote.observedAtMs),
    oneMinuteMovePercent: quote.oneMinuteMovePercent,
    spreadPercent: ((quote.ask - quote.bid) / midpoint) * 100,
    orderbookGapPercent: quote.orderbookGapPercent,
    halted: false,
    availableBalance,
    accountValueKrw,
    dailyPnlPercent: 0,
    assetExposurePercent: 0,
    openPositionCount: 0,
    dailyOrderCount: 0,
    consecutiveLosses: 0,
    existingPositionSide: null,
    benchmarkDrawdownPercent: null,
    currentPrice: executionPrice,
    plannedPrice: executionPrice,
    marketStatus: 'OPEN' as const,
    // The breakout was confirmed on the closed bar and the quote re-read now;
    // the worker re-stamps this with the provider preflight read (≤ 30 s).
    signalState: 'entry_ready' as const,
    signalObservedAt: observedAt,
    source: `${quote.source}+trend-pilot-v1`,
  };
}

function entryReasons(strategyId: string, version: string, description: string, stopFraction: number | null, capReason: string | null, sizing: string[], fxSource: string) {
  return [
    TREND_PILOT_LANE_REASON,
    `진입 전략: ${strategyId} · 버전 ${version}`,
    description,
    `크기: 잔고의 ${(TREND_PILOT_V1.riskFraction * 100).toFixed(1)}% 감수 · 손절 거리 ${((stopFraction ?? 0) * 100).toFixed(2)}% · ${capReason ?? '-'}`,
    ...sizing,
    `FX:${fxSource}`,
  ];
}

async function buildBitgetEntry(input: {
  deps: TrendPilotLaneDependencies;
  fx: { krwPerQuoteCurrency: number; source: string };
  symbol: string;
  side: TrendPilotSide;
  atr: number;
  quote: TrendPilotQuote;
  capitalBase: number;
  ceilingKrw: number;
  openMarginKrw: number;
  signalBarOpenMs: number;
}): Promise<BuiltEntry> {
  const { deps } = input;
  if (!deps.readContractRules) return { planInput: null, blockers: ['TREND_PILOT_CONTRACT_RULES_REQUIRED'], riskKrw: null };
  if (deps.policy.bitgetLeverage < TREND_PILOT_V1.leverage) return { planInput: null, blockers: ['TREND_PILOT_POLICY_LEVERAGE_BELOW_5X'], riskKrw: null };
  if (!(input.ceilingKrw > 0)) return { planInput: null, blockers: ['BUDGET_ROOM_EXHAUSTED'], riskKrw: null };
  const rules = await deps.readContractRules(input.symbol);
  const referencePrice = input.side === 'long' ? input.quote.ask : input.quote.bid;
  const plan = computeTrendPilotEntryPlan({
    side: input.side, referencePrice, atr: input.atr, equityKrw: input.capitalBase,
    usdKrw: input.fx.krwPerQuoteCurrency, maxOrderKrw: input.ceilingKrw,
    openMarginKrw: input.openMarginKrw, contract: rules,
  });
  if (!plan.ok || plan.quantity === null || plan.stopPrice === null || plan.notionalKrw === null || plan.riskUnit === null) {
    return { planInput: null, blockers: plan.blockers.length ? plan.blockers : ['TREND_PILOT_PLAN_INVALID'], riskKrw: null };
  }
  const target = farTargetPrice(input.side, referencePrice, plan.riskUnit);
  if (target === null) return { planInput: null, blockers: ['TREND_PILOT_TARGET_INVALID'], riskKrw: null };
  const strategyId = TREND_PILOT_V1.strategyId;
  const signalId = `trend-pilot:${input.symbol}:${input.side}:${input.signalBarOpenMs}`;
  const estimatedKrw = plan.notionalKrw;
  const signalOccurrenceId = signTrendPilotOccurrence({
    strategyId, exchange: 'bitget', symbol: input.symbol, side: input.side, signalId,
    signalBarOpenMs: input.signalBarOpenMs, stopPrice: plan.stopPrice, quantity: plan.quantity, estimatedKrw,
  }, deps.signingKey);
  const midpoint = (input.quote.bid + input.quote.ask) / 2;
  const tick = rules.priceStep;
  const units = input.side === 'long' ? Math.floor(target / tick) : Math.ceil(target / tick);
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(tick))));
  return {
    riskKrw: plan.riskKrw,
    blockers: [],
    planInput: {
      exchange: 'bitget',
      accountMode: 'live',
      stockBroker: null,
      stockExchange: null,
      strategyId,
      signalId,
      signalOccurrenceId,
      symbol: input.symbol,
      market: 'USDT-FUTURES',
      side: input.side,
      orderType: 'market',
      quantity: plan.quantity,
      quoteAmount: null,
      limitPrice: referencePrice,
      estimatedKrw,
      stopPrice: plan.stopPrice,
      targetPrices: [Number((units * tick).toFixed(decimals))],
      splitRatios: [100],
      leverage: TREND_PILOT_V1.leverage,
      marginMode: 'isolated',
      reduceOnly: false,
      invalidateAction: 'hold',
      entryPrice: referencePrice,
      estimatedSlippagePercent: 0.05,
      averageSpreadPercent: ((input.quote.ask - input.quote.bid) / midpoint) * 100,
      economics: null,
      signalReasons: entryReasons(strategyId, TREND_PILOT_V1.strategyVersion,
        `신호: 4시간봉 55봉 ${input.side === 'long' ? '고점 돌파 + EMA200 위' : '저점 이탈 + EMA200 아래'}`,
        plan.stopFraction, plan.capReason,
        [`AUTO_ENTRY_QUANTITY_STEP:${rules.sizeStep}`, `AUTO_ENTRY_MINIMUM_QUANTITY:${rules.minTradeNum}`, `AUTO_ENTRY_MINIMUM_NOTIONAL_QUOTE:${rules.minTradeUsdt}`],
        input.fx.source),
      marketSnapshot: baseSnapshot(input.quote, Math.max(0, input.capitalBase - input.openMarginKrw), input.capitalBase, deps.nowMs, referencePrice),
    },
  };
}

function buildUpbitEntry(input: {
  deps: TrendPilotLaneDependencies;
  symbol: string;
  atr: number;
  quote: TrendPilotQuote;
  capitalBase: number;
  ceilingKrw: number;
  availableKrw: number;
  signalBarOpenMs: number;
}): BuiltEntry {
  const { deps } = input;
  if (!(input.ceilingKrw > 0)) return { planInput: null, blockers: ['BUDGET_ROOM_EXHAUSTED'], riskKrw: null };
  const plan = computeTrendPilotSpotEntryPlan({
    referencePriceKrw: input.quote.ask, atrKrw: input.atr, equityKrw: input.capitalBase,
    availableKrw: input.availableKrw, maxOrderKrw: input.ceilingKrw,
  });
  if (!plan.ok || plan.orderKrw === null || plan.stopPriceKrw === null || plan.riskUnitKrw === null) {
    return { planInput: null, blockers: plan.blockers.length ? plan.blockers : ['TREND_PILOT_PLAN_INVALID'], riskKrw: null };
  }
  const target = farTargetPrice('long', input.quote.ask, plan.riskUnitKrw);
  if (target === null) return { planInput: null, blockers: ['TREND_PILOT_TARGET_INVALID'], riskKrw: null };
  const strategyId = TREND_PILOT_SPOT_V1.strategyId;
  const signalId = `trend-pilot-spot:${input.symbol}:${input.signalBarOpenMs}`;
  const signalOccurrenceId = signTrendPilotOccurrence({
    strategyId, exchange: 'upbit', symbol: input.symbol, side: 'buy', signalId,
    signalBarOpenMs: input.signalBarOpenMs, stopPrice: plan.stopPriceKrw, quantity: plan.expectedVolume, estimatedKrw: plan.orderKrw,
  }, deps.signingKey);
  const midpoint = (input.quote.bid + input.quote.ask) / 2;
  return {
    riskKrw: plan.riskKrw,
    blockers: [],
    planInput: {
      exchange: 'upbit',
      accountMode: 'live',
      stockBroker: null,
      stockExchange: null,
      strategyId,
      signalId,
      signalOccurrenceId,
      symbol: input.symbol,
      market: 'KRW',
      side: 'buy',
      orderType: 'market',
      quantity: plan.expectedVolume,
      quoteAmount: plan.orderKrw,
      limitPrice: input.quote.ask,
      estimatedKrw: plan.orderKrw,
      stopPrice: plan.stopPriceKrw,
      targetPrices: [target],
      splitRatios: [100],
      leverage: null,
      marginMode: null,
      reduceOnly: false,
      invalidateAction: 'hold',
      entryPrice: input.quote.ask,
      estimatedSlippagePercent: 0.07,
      averageSpreadPercent: ((input.quote.ask - input.quote.bid) / midpoint) * 100,
      economics: null,
      signalReasons: entryReasons(strategyId, TREND_PILOT_SPOT_V1.strategyVersion,
        '신호: 4시간봉 55봉 고점 돌파 + EMA200 위 (현물 매수만)', plan.stopFraction, plan.capReason,
        ['AUTO_ENTRY_QUANTITY_STEP:0.00000001', 'AUTO_ENTRY_MINIMUM_QUANTITY:0.00000001', `AUTO_ENTRY_MINIMUM_NOTIONAL_QUOTE:${TREND_PILOT_SPOT_V1.minOrderKrw}`],
        'NATIVE_KRW'),
      marketSnapshot: baseSnapshot(input.quote, input.availableKrw, input.capitalBase, deps.nowMs, input.quote.ask),
    },
  };
}
