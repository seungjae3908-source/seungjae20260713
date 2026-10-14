// Pure, side-effect-free expected-value gate for scanner candidates.
//
// This module never touches the network, the database, an exchange, or any
// order path. It only turns historical candles + a deterministic signal rule
// into cost-adjusted outcome samples, then decides whether the rule's
// measured edge is positive *after* fees and slippage with enough evidence.
// Inputs are plain numbers; outputs are plain numbers/strings.

export interface EvCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TripleBarrierParams {
  /** Stop distance as a percentage of the entry price (e.g. 1.2 = 1.2%). */
  stopPercent: number;
  /** Target distance as a percentage of the entry price. */
  targetPercent: number;
  /** Maximum holding time in candles (vertical barrier). */
  maxBars: number;
  /** Exchange fee per side, in percent (Upbit KRW spot default 0.05). */
  feePercentPerSide: number;
  /** Assumed adverse slippage per side, in percent. */
  slippagePercentPerSide: number;
}

export type BarrierOutcome = 'TARGET' | 'STOP' | 'TIME';

export interface TripleBarrierResult {
  outcome: BarrierOutcome;
  /** Net return in percent after fees and slippage on both sides. */
  netReturnPercent: number;
  grossReturnPercent: number;
  barsHeld: number;
}

export interface EvStatistics {
  sampleCount: number;
  winCount: number;
  winRate: number;
  averageWinPercent: number;
  averageLossPercent: number;
  expectedValuePercent: number;
  standardErrorPercent: number;
  /** Conservative bound: mean minus `confidenceZ` standard errors. */
  lowerBoundPercent: number;
}

export interface EvGateOptions {
  minSamples: number;
  /** The conservative lower bound must exceed this (percent). */
  minLowerBoundPercent: number;
  confidenceZ: number;
}

export interface EvGateDecision {
  allowed: boolean;
  blockers: string[];
  stats: EvStatistics;
}

export const UPBIT_SPOT_FEE_PERCENT_PER_SIDE = 0.05;
export const DEFAULT_SLIPPAGE_PERCENT_PER_SIDE = 0.05;

export const DEFAULT_EV_GATE_OPTIONS: EvGateOptions = Object.freeze({
  minSamples: 30,
  minLowerBoundPercent: 0,
  confidenceZ: 1,
});

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function validateParams(params: TripleBarrierParams) {
  if (!finitePositive(params.stopPercent)) throw new RangeError('EV_STOP_PERCENT_INVALID');
  if (!finitePositive(params.targetPercent)) throw new RangeError('EV_TARGET_PERCENT_INVALID');
  if (!Number.isInteger(params.maxBars) || params.maxBars < 1) throw new RangeError('EV_MAX_BARS_INVALID');
  if (!Number.isFinite(params.feePercentPerSide) || params.feePercentPerSide < 0) {
    throw new RangeError('EV_FEE_INVALID');
  }
  if (!Number.isFinite(params.slippagePercentPerSide) || params.slippagePercentPerSide < 0) {
    throw new RangeError('EV_SLIPPAGE_INVALID');
  }
}

function roundTo(value: number, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Simulates one long entry at the OPEN of the candle after `signalIndex`
 * (a signal observed on a closed candle cannot trade at that candle's close).
 * When a single candle touches both barriers, the STOP is assumed to hit first
 * (the conservative ordering). Returns null when there is not enough future
 * data to resolve the trade honestly.
 */
export function simulateTripleBarrierLong(
  candles: readonly EvCandle[],
  signalIndex: number,
  params: TripleBarrierParams,
): TripleBarrierResult | null {
  validateParams(params);
  const entryIndex = signalIndex + 1;
  if (!Number.isInteger(signalIndex) || signalIndex < 0 || entryIndex >= candles.length) return null;
  const entryCandle = candles[entryIndex];
  const slippage = params.slippagePercentPerSide / 100;
  const entryPrice = entryCandle.open * (1 + slippage);
  if (!finitePositive(entryPrice)) return null;

  const stopPrice = entryPrice * (1 - params.stopPercent / 100);
  const targetPrice = entryPrice * (1 + params.targetPercent / 100);
  const windowEnd = entryIndex + params.maxBars - 1;
  const lastIndex = Math.min(windowEnd, candles.length - 1);

  const finish = (outcome: BarrierOutcome, exitRaw: number, barsHeld: number): TripleBarrierResult => {
    const exitPrice = exitRaw * (1 - slippage);
    const net = (exitPrice / entryPrice - 1) * 100 - params.feePercentPerSide * 2;
    return {
      outcome,
      netReturnPercent: roundTo(net),
      grossReturnPercent: roundTo((exitRaw / entryPrice - 1) * 100),
      barsHeld,
    };
  };

  for (let index = entryIndex; index <= lastIndex; index += 1) {
    const candle = candles[index];
    // Stop first when one candle spans both barriers (conservative).
    // A candle that opens below the stop gaps through it: fill at the open.
    if (candle.low <= stopPrice) return finish('STOP', Math.min(stopPrice, candle.open), index - entryIndex + 1);
    if (candle.high >= targetPrice) return finish('TARGET', targetPrice, index - entryIndex + 1);
  }
  // The time barrier is only honest when the whole window exists in the data.
  if (windowEnd > candles.length - 1) return null;
  return finish('TIME', candles[lastIndex].close, lastIndex - entryIndex + 1);
}

/**
 * Applies a deterministic signal predicate over history and returns the
 * resolved, cost-adjusted outcomes. Signals closer together than `cooldownBars`
 * are skipped so overlapping trades do not inflate the sample count.
 */
export function collectOutcomeSamples(
  candles: readonly EvCandle[],
  isSignal: (index: number) => boolean,
  params: TripleBarrierParams,
  options: { startIndex?: number; cooldownBars?: number } = {},
): TripleBarrierResult[] {
  validateParams(params);
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const cooldown = Math.max(1, options.cooldownBars ?? params.maxBars);
  const results: TripleBarrierResult[] = [];
  let nextAllowed = startIndex;
  for (let index = startIndex; index < candles.length - 1; index += 1) {
    if (index < nextAllowed || !isSignal(index)) continue;
    const result = simulateTripleBarrierLong(candles, index, params);
    if (!result) continue;
    results.push(result);
    nextAllowed = index + cooldown;
  }
  return results;
}

export function summarizeOutcomes(netReturnsPercent: readonly number[]): EvStatistics {
  const values = netReturnsPercent.filter((value) => Number.isFinite(value));
  const count = values.length;
  if (count === 0) {
    return {
      sampleCount: 0,
      winCount: 0,
      winRate: 0,
      averageWinPercent: 0,
      averageLossPercent: 0,
      expectedValuePercent: 0,
      standardErrorPercent: 0,
      lowerBoundPercent: 0,
    };
  }
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value <= 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = count > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)
    : 0;
  const standardError = Math.sqrt(variance / count);
  return {
    sampleCount: count,
    winCount: wins.length,
    winRate: roundTo(wins.length / count, 4),
    averageWinPercent: wins.length ? roundTo(wins.reduce((sum, value) => sum + value, 0) / wins.length) : 0,
    averageLossPercent: losses.length ? roundTo(losses.reduce((sum, value) => sum + value, 0) / losses.length) : 0,
    expectedValuePercent: roundTo(mean),
    standardErrorPercent: roundTo(standardError),
    // Callers that need a confidence bound use evaluateEvGate (mean - z * SE).
    lowerBoundPercent: roundTo(mean),
  };
}

/**
 * Allows a rule only when it has enough resolved samples and its conservative
 * edge (mean minus `confidenceZ` standard errors) is above the floor.
 * Fail-closed: every uncertainty is a blocker.
 */
export function evaluateEvGate(
  netReturnsPercent: readonly number[],
  options: Partial<EvGateOptions> = {},
): EvGateDecision {
  const merged: EvGateOptions = { ...DEFAULT_EV_GATE_OPTIONS, ...options };
  const base = summarizeOutcomes(netReturnsPercent);
  const stats: EvStatistics = {
    ...base,
    lowerBoundPercent: roundTo(base.expectedValuePercent - merged.confidenceZ * base.standardErrorPercent),
  };
  const blockers: string[] = [];
  if (stats.sampleCount < merged.minSamples) blockers.push('EV_SAMPLES_INSUFFICIENT');
  if (stats.expectedValuePercent <= 0) blockers.push('EV_NOT_POSITIVE_AFTER_COSTS');
  if (stats.lowerBoundPercent <= merged.minLowerBoundPercent) blockers.push('EV_LOWER_BOUND_NOT_POSITIVE');
  return { allowed: blockers.length === 0, blockers, stats };
}

export interface AtrSizingInput {
  /** Account value the risk budget is measured against, in KRW. */
  accountValueKrw: number;
  /** Maximum loss at the stop, as a percent of account value. */
  riskPercent: number;
  entryPrice: number;
  /** Distance between entry and stop, in price units (> 0). */
  stopDistance: number;
  /** Hard cap on notional per entry, in KRW (for example 1,000,000). */
  maxEntryKrw: number;
}

export interface AtrSizingResult {
  quantity: number;
  notionalKrw: number;
  riskKrw: number;
  cappedByMaxEntry: boolean;
}

/** Risk-based quantity: loss at the stop equals riskPercent of the account, then capped. */
export function sizeEntryByStopDistance(input: AtrSizingInput): AtrSizingResult | null {
  const values = [input.accountValueKrw, input.riskPercent, input.entryPrice, input.stopDistance, input.maxEntryKrw];
  if (values.some((value) => !finitePositive(value))) return null;
  const riskBudgetKrw = input.accountValueKrw * input.riskPercent / 100;
  const riskBasedQuantity = riskBudgetKrw / input.stopDistance;
  const cappedQuantity = input.maxEntryKrw / input.entryPrice;
  const quantity = Math.min(riskBasedQuantity, cappedQuantity);
  if (!finitePositive(quantity)) return null;
  return {
    quantity,
    notionalKrw: roundTo(quantity * input.entryPrice, 2),
    riskKrw: roundTo(quantity * input.stopDistance, 2),
    cappedByMaxEntry: cappedQuantity < riskBasedQuantity,
  };
}
