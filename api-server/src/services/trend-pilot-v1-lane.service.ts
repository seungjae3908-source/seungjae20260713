// Trend pilot v1 — per-member lane tick (orchestration only).
//
// Runs inside the member automatic-trading worker, AFTER the worker's own live
// exit block and only when the worker has already armed live entries for this
// tick. It never talks to an exchange directly: entries and exits are handed
// back to the worker's canonical path (createPlan → risk gate → execute), so the
// emergency stop, live arm, member access, max order, margin and isolation
// checks all still apply.
//
// Per tick and venue:
//   1. open pilot positions: apply newly closed 4h bars to the trailing stop
//      (breakeven at +1R, best − 2.5 ATR, tighten-only, flat after 180 bars) and
//      close with a reduce-only market order when the live price crosses it.
//      Bitget also keeps the initial stop as an exchange preset stop-loss.
//   2. read live equity → roll the KST day and the peak → guards (daily −2%,
//      kill at −40% from the peak; a kill only stops NEW entries)
//   3. symbols without a position: evaluate the just-closed bar once; on a
//      breakout, size from equity × 2% ÷ stop and submit one signed entry.
// State (peak, day, kill, trails, last processed bar) lives in a per-member
// ledger file; a missing or malformed ledger fails closed.
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

export type TrendPilotExitReason = 'TRAILING_TAKE_PROFIT' | 'STOP_LOSS';

export type TrendPilotLaneDependencies = {
  venue: TrendPilotVenue;
  userId: string;
  policy: TradingPolicy;
  nowMs: number;
  signingKey: string;
  fx: { krwPerQuoteCurrency: number; source: string };
  readClosedBars: (symbol: string) => Promise<TrendPilotCandle[]>;
  readQuote: (symbol: string) => Promise<TrendPilotQuote>;
  readAccount: () => Promise<TrendPilotAccount>;
  readContractRules?: (symbol: string) => Promise<TrendPilotContractRules>;
  /** Symbols use the plan form: BTCUSDT on Bitget, BTC on Upbit (adapters add KRW-). */
  /** Live positions of this lane's strategy on this venue (from canonical plans/orders). */
  positions: TrendPilotLanePosition[];
  /** Symbols held by anything else on this venue (manual or other strategies): never stacked. */
  foreignSymbols: ReadonlySet<string>;
  /** False while the worker's live entry arm/warmup is not complete: manage exits only. */
  entriesArmed: boolean;
  /** Today's live order count and open position count on the account (all strategies). */
  accountCounters: { dailyOrderCount: number; openPositionCount: number; consecutiveLosses: number; weeklyPnlPercent: number };
  submitEntry: (plan: TradingPlanInput) => Promise<{ status: 'SUBMITTED' | 'BLOCKED' | 'DUPLICATE'; blockCodes?: string[] }>;
  submitExit: (position: TrendPilotLanePosition, reason: TrendPilotExitReason, triggerPrice: number) => Promise<{ status: 'SUBMITTED' | 'BLOCKED' | 'DUPLICATE'; blockCodes?: string[] }>;
  loadLedger: () => Promise<TrendPilotLedger | null>;
  saveLedger: (ledger: TrendPilotLedger) => Promise<void>;
};

export type TrendPilotLaneEvent =
  | { kind: 'KILL'; drawdownFraction: number | null }
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

const MAX_ENTRY_DELAY_AFTER_CLOSE_MS = 25 * 60 * 1000; // stay inside the 30-minute authorization window
const MAX_QUOTE_AGE_MS = 30_000;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function errorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? 'UNKNOWN');
  return /^[A-Z0-9_:]{3,120}$/u.test(text) ? text : 'TREND_PILOT_STEP_FAILED';
}

function laneSymbols(venue: TrendPilotVenue): readonly string[] {
  return venue === 'bitget' ? TREND_PILOT_V1.symbols : TREND_PILOT_SPOT_V1.symbols.map((s) => s.replace(/^KRW-/u, ''));
}

function laneStrategyId(venue: TrendPilotVenue): string {
  return venue === 'bitget' ? TREND_PILOT_V1.strategyId : TREND_PILOT_SPOT_V1.strategyId;
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
  if (!positive(position.entryPrice) || !positive(position.initialStopPrice) || !positive(riskUnit)) return null;
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

function roundTarget(price: number, step: number | null, side: TrendPilotSide): number {
  if (!positive(step)) return price;
  const units = side === 'long' ? Math.floor(price / step) : Math.ceil(price / step);
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step))));
  return Number((units * step).toFixed(decimals));
}

export async function runTrendPilotLaneTick(deps: TrendPilotLaneDependencies): Promise<TrendPilotLaneTickResult> {
  const events: TrendPilotLaneEvent[] = [];
  const { venue, nowMs } = deps;
  const result: TrendPilotLaneTickResult = { venue, equityKrw: null, allowEntry: false, guardBlockers: [], events, ledger: null };
  if (!positive(deps.fx.krwPerQuoteCurrency)) {
    events.push({ kind: 'ERROR', symbol: null, code: 'TREND_PILOT_FX_INVALID' });
    return result;
  }

  let ledger: TrendPilotLedger;
  try {
    ledger = (await deps.loadLedger()) ?? createTrendPilotLedger(deps.userId);
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
    return result; // no state → no entries, and positions keep their exchange/worker stops
  }

  const barsCache = new Map<string, TrendPilotCandle[]>();
  const bars = async (symbol: string) => {
    if (!barsCache.has(symbol)) barsCache.set(symbol, await deps.readClosedBars(symbol));
    return barsCache.get(symbol)!;
  };

  // ---- 2. manage open positions
  const openIds = new Set(deps.positions.map((p) => p.planId));
  for (const [planId] of Object.entries(ledger.trails)) {
    if (!openIds.has(planId)) ledger = recordTrendPilotClose(ledger, planId, 0, nowMs);
  }
  const currentStops = new Map<string, number>();
  for (const position of deps.positions) {
    try {
      let trail = ledger.trails[position.planId] ?? initialTrail(position);
      if (!trail) throw new Error('TREND_PILOT_POSITION_INVALID');
      const series = await bars(position.symbol);
      const atr = computeAtrSeries(series);
      let exit: 'TIME_EXIT' | 'STOP_BREACHED_ON_CLOSE' | null = null;
      const before = trail.stopPrice;
      const priceStep = deps.readContractRules ? (await deps.readContractRules(position.symbol)).priceStep : 1e-8;
      for (let i = 0; i < series.length; i += 1) {
        const bar = series[i];
        if (bar.timestamp < trail.entryBarOpenMs) continue;
        if (trail.lastProcessedBarOpenMs !== null && bar.timestamp <= trail.lastProcessedBarOpenMs) continue;
        const step = advanceTrendPilotStop(trail, bar, atr[i], priceStep);
        trail = { ...trail, ...step.state };
        if (step.exit) { exit = step.exit; break; }
      }
      ledger = { ...ledger, trails: { ...ledger.trails, [position.planId]: trail } };
      currentStops.set(position.planId, trail.stopPrice);
      if (trail.stopPrice !== before) events.push({ kind: 'STOP_MOVED', symbol: position.symbol, stopPrice: trail.stopPrice, stopKind: trail.stopKind });
      if (position.activeExit) continue;

      const quote = await deps.readQuote(position.symbol);
      if (!freshQuote(quote, nowMs)) throw new Error('TREND_PILOT_QUOTE_NOT_FRESH');
      const side = positionSide(position);
      // the price a market close would hit: bid for a long, ask for a short
      const closePrice = side === 'long' ? quote.bid : quote.ask;
      const crossed = side === 'long' ? closePrice <= trail.stopPrice : closePrice >= trail.stopPrice;
      if (exit || crossed) {
        const reason: TrendPilotExitReason = trail.stopKind === 'initial' && exit !== 'TIME_EXIT' ? 'STOP_LOSS' : 'TRAILING_TAKE_PROFIT';
        const submitted = await deps.submitExit(position, reason, exit === 'TIME_EXIT' ? closePrice : trail.stopPrice);
        events.push({ kind: 'EXIT', symbol: position.symbol, reason: exit ?? reason, status: submitted.status, stopPrice: trail.stopPrice });
      }
    } catch (error) {
      events.push({ kind: 'ERROR', symbol: position.symbol, code: errorCode(error) });
    }
  }

  // ---- account, day and kill guards (entries only; exits above never wait on this)
  let account: TrendPilotAccount;
  try {
    account = await deps.readAccount();
    if (!positive(account.equityKrw) || !Number.isFinite(account.availableKrw) || account.availableKrw < 0) throw new Error('TREND_PILOT_ACCOUNT_INVALID');
    if (nowMs - account.observedAtMs > 60_000 || account.observedAtMs > nowMs + 5_000) throw new Error('TREND_PILOT_ACCOUNT_STALE');
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
    try { await deps.saveLedger(ledger); } catch (saveError) { events.push({ kind: 'ERROR', symbol: null, code: errorCode(saveError) }); }
    return { ...result, ledger };
  }
  result.equityKrw = account.equityKrw;
  ledger = observeTrendPilotEquity(ledger, account.equityKrw, nowMs);
  // Daily loss is measured on equity (realized + open) against the KST day start.
  const dayPnl = account.equityKrw - (ledger.dayStartEquityKrw ?? account.equityKrw);
  const guards = evaluateTrendPilotGuards({
    equityKrw: account.equityKrw, peakEquityKrw: ledger.peakEquityKrw ?? account.equityKrw,
    dayStartEquityKrw: ledger.dayStartEquityKrw ?? account.equityKrw, dayRealizedPnlKrw: dayPnl, killed: ledger.killed,
  });
  if (guards.killNow) {
    ledger = killTrendPilot(ledger, 'KILL_DRAWDOWN_REACHED', nowMs);
    events.push({ kind: 'KILL', drawdownFraction: guards.drawdownFraction });
  }

  // ---- 3. entries
  result.allowEntry = guards.allowEntry && !ledger.killed && deps.entriesArmed;
  result.guardBlockers = ledger.killed && !guards.blockers.includes('KILL_SWITCH_ACTIVE')
    ? [...guards.blockers, 'KILL_SWITCH_ACTIVE'] : guards.blockers;
  if (result.allowEntry) {
    const held = new Set(deps.positions.map((p) => p.symbol.toUpperCase().replace(/^KRW-/u, '')));
    let openMarginKrw = deps.positions.reduce((sum, p) => sum + laneExposureKrw(venue, p), 0);
    let openRiskKrw = deps.positions.reduce((sum, p) => sum + laneOpenRiskKrw(p, currentStops.get(p.planId) ?? p.initialStopPrice, deps.fx.krwPerQuoteCurrency), 0);
    let openCount = deps.accountCounters.openPositionCount;
    let ordersToday = deps.accountCounters.dailyOrderCount;
    let availableKrw = account.availableKrw;
    for (const symbol of laneSymbols(venue)) {
      try {
        if (held.has(symbol) || deps.foreignSymbols.has(symbol)) continue;
        const series = await bars(symbol);
        const signal = venue === 'upbit' ? evaluateTrendPilotSpotSignal(series) : evaluateTrendPilotSignal(series);
        if (signal.blocker || signal.signalBarOpenMs === null) {
          if (signal.blocker && signal.blocker !== 'INSUFFICIENT_BARS') events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: [signal.blocker] });
          continue;
        }
        if (ledger.lastSignalBarOpenMs[symbol] === signal.signalBarOpenMs) continue;
        const closedAtMs = signal.signalBarOpenMs + TREND_PILOT_V1.intervalMs;
        if (nowMs - closedAtMs > MAX_ENTRY_DELAY_AFTER_CLOSE_MS) {
          // too late to enter at "next bar open"; mark the bar as seen
          ledger = { ...ledger, lastSignalBarOpenMs: { ...ledger.lastSignalBarOpenMs, [symbol]: signal.signalBarOpenMs } };
          continue;
        }
        if (!signal.side) {
          ledger = { ...ledger, lastSignalBarOpenMs: { ...ledger.lastSignalBarOpenMs, [symbol]: signal.signalBarOpenMs } };
          continue;
        }
        const quote = await deps.readQuote(symbol);
        if (!freshQuote(quote, nowMs)) throw new Error('TREND_PILOT_QUOTE_NOT_FRESH');
        const capitalBase = Math.min(deps.policy.totalCapitalKrw, account.equityKrw);
        const built = venue === 'bitget'
          ? await buildBitgetEntry({ deps, symbol, side: signal.side, atr: signal.atr!, quote, capitalBase, availableKrw, openMarginKrw, signalBarOpenMs: signal.signalBarOpenMs })
          : buildUpbitEntry({ deps, symbol, atr: signal.atr!, quote, capitalBase, availableKrw, signalBarOpenMs: signal.signalBarOpenMs });
        if (!built.planInput) {
          events.push({ kind: 'ENTRY_SKIPPED', symbol, blockers: built.blockers });
          ledger = { ...ledger, lastSignalBarOpenMs: { ...ledger.lastSignalBarOpenMs, [symbol]: signal.signalBarOpenMs } };
          continue;
        }
        const exposureNow = openMarginKrw;
        const planInput: TradingPlanInput = {
          ...built.planInput,
          marketSnapshot: {
            ...built.planInput.marketSnapshot,
            accountExposureKrw: exposureNow,
            instrumentExposureKrw: 0,
            strategyExposureKrw: exposureNow,
            assetClassExposureKrw: exposureNow,
            openRiskKrw,
            openPositionCount: openCount,
            dailyOrderCount: ordersToday,
            assetExposurePercent: capitalBase > 0 ? (exposureNow / capitalBase) * 100 : 100,
            correlatedExposurePercent: capitalBase > 0 ? Math.min(100, (exposureNow / capitalBase) * 100) : 100,
            consecutiveLosses: deps.accountCounters.consecutiveLosses,
            weeklyPnlPercent: deps.accountCounters.weeklyPnlPercent,
            dailyPnlPercent: ledger.dayStartEquityKrw ? (dayPnl / ledger.dayStartEquityKrw) * 100 : 0,
          },
        };
        const submitted = await deps.submitEntry(planInput);
        ledger = { ...ledger, lastSignalBarOpenMs: { ...ledger.lastSignalBarOpenMs, [symbol]: signal.signalBarOpenMs } };
        events.push({ kind: 'ENTRY', symbol, side: planInput.side, status: submitted.status, orderKrw: planInput.estimatedKrw, blockCodes: submitted.blockCodes ?? [] });
        if (submitted.status === 'SUBMITTED') {
          const exposure = venue === 'bitget' ? planInput.estimatedKrw / TREND_PILOT_V1.leverage : planInput.estimatedKrw;
          openMarginKrw += exposure;
          openRiskKrw += built.riskKrw ?? 0;
          openCount += 1;
          ordersToday += 1;
          if (venue === 'upbit') availableKrw = Math.max(0, availableKrw - planInput.estimatedKrw * (1 + TREND_PILOT_SPOT_V1.feeRate));
          else availableKrw = Math.max(0, availableKrw - exposure);
        }
      } catch (error) {
        events.push({ kind: 'ERROR', symbol, code: errorCode(error) });
      }
    }
  }

  try {
    await deps.saveLedger(ledger);
  } catch (error) {
    events.push({ kind: 'ERROR', symbol: null, code: errorCode(error) });
  }
  return { ...result, ledger };
}

type BuiltEntry = { planInput: TradingPlanInput | null; blockers: string[]; riskKrw: number | null };

function baseSnapshot(quote: TrendPilotQuote, availableBalance: number, accountValueKrw: number, nowMs: number, executionPrice: number) {
  const midpoint = (quote.bid + quote.ask) / 2;
  return {
    observedAt: new Date(quote.observedAtMs).toISOString(),
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
    source: `${quote.source}+trend-pilot-v1`,
  };
}

async function buildBitgetEntry(input: {
  deps: TrendPilotLaneDependencies;
  symbol: string;
  side: TrendPilotSide;
  atr: number;
  quote: TrendPilotQuote;
  capitalBase: number;
  availableKrw: number;
  openMarginKrw: number;
  signalBarOpenMs: number;
}): Promise<BuiltEntry> {
  const { deps } = input;
  if (!deps.readContractRules) return { planInput: null, blockers: ['TREND_PILOT_CONTRACT_RULES_REQUIRED'], riskKrw: null };
  if (deps.policy.bitgetLeverage < TREND_PILOT_V1.leverage) return { planInput: null, blockers: ['TREND_PILOT_POLICY_LEVERAGE_BELOW_5X'], riskKrw: null };
  const rules = await deps.readContractRules(input.symbol);
  const referencePrice = input.side === 'long' ? input.quote.ask : input.quote.bid;
  const plan = computeTrendPilotEntryPlan({
    side: input.side, referencePrice, atr: input.atr, equityKrw: input.capitalBase,
    usdKrw: deps.fx.krwPerQuoteCurrency, maxOrderKrw: deps.policy.maxOrderKrw,
    openMarginKrw: input.openMarginKrw, contract: rules,
  });
  if (!plan.ok || plan.quantity === null || plan.stopPrice === null || plan.notionalKrw === null || plan.riskUnit === null) {
    return { planInput: null, blockers: plan.blockers.length ? plan.blockers : ['TREND_PILOT_PLAN_INVALID'], riskKrw: null };
  }
  const target = farTargetPrice(input.side, referencePrice, plan.riskUnit);
  if (target === null) return { planInput: null, blockers: ['TREND_PILOT_TARGET_INVALID'], riskKrw: null };
  const strategyId = TREND_PILOT_V1.strategyId;
  const signalOccurrenceId = signTrendPilotOccurrence({
    strategyId, exchange: 'bitget', symbol: input.symbol, side: input.side, signalBarOpenMs: input.signalBarOpenMs, stopPrice: plan.stopPrice,
  }, deps.signingKey);
  const midpoint = (input.quote.bid + input.quote.ask) / 2;
  return {
    riskKrw: plan.riskKrw,
    blockers: [],
    planInput: {
      exchange: 'bitget',
      accountMode: 'live',
      stockBroker: null,
      stockExchange: null,
      strategyId,
      signalId: `trend-pilot:${input.symbol}:${input.side}:${input.signalBarOpenMs}`,
      signalOccurrenceId,
      symbol: input.symbol,
      market: 'USDT-FUTURES',
      side: input.side,
      orderType: 'market',
      quantity: plan.quantity,
      quoteAmount: null,
      limitPrice: referencePrice,
      estimatedKrw: plan.notionalKrw,
      stopPrice: plan.stopPrice,
      targetPrices: [roundTarget(target, rules.priceStep, input.side)],
      splitRatios: [100],
      leverage: TREND_PILOT_V1.leverage,
      marginMode: 'isolated',
      reduceOnly: false,
      invalidateAction: 'hold',
      entryPrice: referencePrice,
      estimatedSlippagePercent: 0.05,
      averageSpreadPercent: ((input.quote.ask - input.quote.bid) / midpoint) * 100,
      economics: null,
      signalReasons: [
        TREND_PILOT_LANE_REASON,
        `진입 전략: ${strategyId} · 버전 ${TREND_PILOT_V1.strategyVersion}`,
        `신호: 4시간봉 55봉 ${input.side === 'long' ? '고점 돌파 + EMA200 위' : '저점 이탈 + EMA200 아래'}`,
        `크기: 잔고의 ${(TREND_PILOT_V1.riskFraction * 100).toFixed(1)}% 감수 · 손절 거리 ${((plan.stopFraction ?? 0) * 100).toFixed(2)}% · ${plan.capReason ?? '-'}`,
        `AUTO_ENTRY_QUANTITY_STEP:${rules.sizeStep}`,
        `AUTO_ENTRY_MINIMUM_QUANTITY:${rules.minTradeNum}`,
        `AUTO_ENTRY_MINIMUM_NOTIONAL_QUOTE:${rules.minTradeUsdt}`,
        `FX:${deps.fx.source}`,
      ],
      marketSnapshot: baseSnapshot(input.quote, input.availableKrw, input.capitalBase, deps.nowMs, referencePrice),
    },
  };
}

function buildUpbitEntry(input: {
  deps: TrendPilotLaneDependencies;
  symbol: string;
  atr: number;
  quote: TrendPilotQuote;
  capitalBase: number;
  availableKrw: number;
  signalBarOpenMs: number;
}): BuiltEntry {
  const { deps } = input;
  const plan = computeTrendPilotSpotEntryPlan({
    referencePriceKrw: input.quote.ask, atrKrw: input.atr, equityKrw: input.capitalBase,
    availableKrw: input.availableKrw, maxOrderKrw: deps.policy.maxOrderKrw,
  });
  if (!plan.ok || plan.orderKrw === null || plan.stopPriceKrw === null || plan.riskUnitKrw === null) {
    return { planInput: null, blockers: plan.blockers.length ? plan.blockers : ['TREND_PILOT_PLAN_INVALID'], riskKrw: null };
  }
  const target = farTargetPrice('long', input.quote.ask, plan.riskUnitKrw);
  if (target === null) return { planInput: null, blockers: ['TREND_PILOT_TARGET_INVALID'], riskKrw: null };
  const strategyId = TREND_PILOT_SPOT_V1.strategyId;
  const signalOccurrenceId = signTrendPilotOccurrence({
    strategyId, exchange: 'upbit', symbol: input.symbol, side: 'buy', signalBarOpenMs: input.signalBarOpenMs, stopPrice: plan.stopPriceKrw,
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
      signalId: `trend-pilot-spot:${input.symbol}:${input.signalBarOpenMs}`,
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
      signalReasons: [
        TREND_PILOT_LANE_REASON,
        `진입 전략: ${strategyId} · 버전 ${TREND_PILOT_SPOT_V1.strategyVersion}`,
        '신호: 4시간봉 55봉 고점 돌파 + EMA200 위 (현물 매수만)',
        `크기: 잔고의 ${(TREND_PILOT_V1.riskFraction * 100).toFixed(1)}% 감수 · 손절 거리 ${((plan.stopFraction ?? 0) * 100).toFixed(2)}% · ${plan.capReason ?? '-'}`,
        'AUTO_ENTRY_QUANTITY_STEP:0.00000001',
        'AUTO_ENTRY_MINIMUM_QUANTITY:0.00000001',
        `AUTO_ENTRY_MINIMUM_NOTIONAL_QUOTE:${TREND_PILOT_SPOT_V1.minOrderKrw}`,
        'FX:NATIVE_KRW',
      ],
      marketSnapshot: baseSnapshot(input.quote, input.availableKrw, input.capitalBase, deps.nowMs, input.quote.ask),
    },
  };
}
