export interface ScannerBacktestTrade {
  returnPercent: number;
  holdingMinutes: number;
  maePercent: number;
  mfePercent: number;
  slippageBps?: number;
}

interface CommonBacktestMetrics {
  trades: number;
  winRate: number;
  expectancyPercent: number;
  profitFactor: number | null;
  averageWinPercent: number | null;
  averageLossPercent: number | null;
  maxDrawdownPercent: number | null;
  tradeSharpe: number | null;
  netReturnPercent: number;
}

export interface ScalpingBacktestMetrics extends CommonBacktestMetrics {
  strategy: 'scalping';
  medianHoldingMinutes: number | null;
  averageSlippageBps: number | null;
  maxAdverseExcursionPercent: number | null;
}

export interface SwingBacktestMetrics extends CommonBacktestMetrics {
  strategy: 'swing';
  medianHoldingHours: number | null;
  averageMfePercent: number | null;
  averageMaePercent: number | null;
}

/**
 * POSITION result contract only.
 *
 * The calculator consumes already-produced per-trade outcomes. It does not
 * establish trade-lifecycle provenance, OOS admission, or Full Cost authority.
 * `netReturnPercent` retains the legacy field name, but the explicit cost and
 * profitability flags below prevent this bounded calculator from being treated
 * as authoritative full-cost profitability evidence.
 */
export interface PositionBacktestMetrics {
  strategy: 'position';
  inputTrades: number;
  trades: number;
  excludedTrades: number;
  sampleComplete: boolean;
  winRate: number | null;
  expectancyPercent: number | null;
  profitFactor: number | null;
  averageWinPercent: number | null;
  averageLossPercent: number | null;
  maxDrawdownPercent: number | null;
  tradeSharpe: number | null;
  netReturnPercent: number | null;
  medianHoldingDays: number | null;
  averageMfePercent: number | null;
  averageMaePercent: number | null;
  returnCostBasis: 'UNVERIFIED_UPSTREAM_RETURN';
  fullCostAdjusted: false;
  profitabilityClaimAllowed: false;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  const result = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number.isFinite(result) ? result : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const result = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  return Number.isFinite(result) ? result : null;
}

function profitFactor(trades: ScannerBacktestTrade[]): number | null {
  const gains = trades.filter((trade) => trade.returnPercent > 0)
    .reduce((sum, trade) => sum + trade.returnPercent, 0);
  const losses = Math.abs(trades.filter((trade) => trade.returnPercent < 0)
    .reduce((sum, trade) => sum + trade.returnPercent, 0));
  if (losses === 0) return gains > 0 ? Number.POSITIVE_INFINITY : null;
  const result = gains / losses;
  return Number.isFinite(result) ? result : null;
}

function maxDrawdownPercent(returns: number[]): number | null {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let maximum = 0;
  for (const returnPercent of returns) {
    equity *= 1 + returnPercent / 100;
    if (!Number.isFinite(equity)) return null;
    peak = Math.max(peak, equity);
    if (peak <= 0) continue;
    maximum = Math.max(maximum, (peak - equity) / peak * 100);
  }
  const result = -maximum;
  return Number.isFinite(result) ? result : null;
}

function tradeSharpe(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = average(returns);
  if (mean == null) return null;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const standardDeviation = Math.sqrt(variance);
  if (!Number.isFinite(standardDeviation) || standardDeviation === 0) return null;
  const result = mean / standardDeviation * Math.sqrt(returns.length);
  return Number.isFinite(result) ? result : null;
}

function compoundedReturnPercent(returns: number[]): number {
  const equity = returns.reduce((value, returnPercent) => value * (1 + returnPercent / 100), 1);
  return (equity - 1) * 100;
}

function base(trades: ScannerBacktestTrade[]): CommonBacktestMetrics & { valid: ScannerBacktestTrade[] } {
  const valid = trades.filter((trade) => (
    Number.isFinite(trade.returnPercent)
    && Number.isFinite(trade.holdingMinutes)
    && trade.holdingMinutes >= 0
    && Number.isFinite(trade.maePercent)
    && Number.isFinite(trade.mfePercent)
  ));
  const winners = valid.filter((trade) => trade.returnPercent > 0);
  const losers = valid.filter((trade) => trade.returnPercent < 0);
  const returns = valid.map((trade) => trade.returnPercent);
  return {
    valid,
    trades: valid.length,
    // Breakeven trades remain in the eligible denominator and are not winners.
    winRate: valid.length ? winners.length / valid.length * 100 : 0,
    // Canonical calculator expectancy is the arithmetic mean of per-trade returnPercent.
    expectancyPercent: average(returns) ?? 0,
    profitFactor: profitFactor(valid),
    averageWinPercent: average(winners.map((trade) => trade.returnPercent)),
    averageLossPercent: average(losers.map((trade) => trade.returnPercent)),
    maxDrawdownPercent: maxDrawdownPercent(returns),
    // This is trade-level distribution Sharpe, not a calendar-annualized market Sharpe.
    tradeSharpe: tradeSharpe(returns),
    netReturnPercent: compoundedReturnPercent(returns),
  };
}

function isValidPositionTrade(trade: ScannerBacktestTrade): boolean {
  return Number.isFinite(trade.returnPercent)
    && Number.isFinite(trade.holdingMinutes)
    && trade.holdingMinutes >= 0
    && Number.isFinite(trade.maePercent)
    && trade.maePercent <= 0
    && Number.isFinite(trade.mfePercent)
    && trade.mfePercent >= 0;
}

function finiteOrNull(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function calculateScalpingBacktestMetrics(
  trades: ScannerBacktestTrade[],
): ScalpingBacktestMetrics {
  const summary = base(trades);
  const slippage = summary.valid
    .map((trade) => trade.slippageBps)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    strategy: 'scalping',
    trades: summary.trades,
    winRate: summary.winRate,
    expectancyPercent: summary.expectancyPercent,
    profitFactor: summary.profitFactor,
    averageWinPercent: summary.averageWinPercent,
    averageLossPercent: summary.averageLossPercent,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    tradeSharpe: summary.tradeSharpe,
    netReturnPercent: summary.netReturnPercent,
    medianHoldingMinutes: median(summary.valid.map((trade) => trade.holdingMinutes)),
    averageSlippageBps: average(slippage),
    maxAdverseExcursionPercent: summary.valid.length
      ? Math.min(...summary.valid.map((trade) => trade.maePercent))
      : null,
  };
}

export function calculateSwingBacktestMetrics(
  trades: ScannerBacktestTrade[],
): SwingBacktestMetrics {
  const summary = base(trades);
  return {
    strategy: 'swing',
    trades: summary.trades,
    winRate: summary.winRate,
    expectancyPercent: summary.expectancyPercent,
    profitFactor: summary.profitFactor,
    averageWinPercent: summary.averageWinPercent,
    averageLossPercent: summary.averageLossPercent,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    tradeSharpe: summary.tradeSharpe,
    netReturnPercent: summary.netReturnPercent,
    medianHoldingHours: median(summary.valid.map((trade) => trade.holdingMinutes / 60)),
    averageMfePercent: average(summary.valid.map((trade) => trade.mfePercent)),
    averageMaePercent: average(summary.valid.map((trade) => trade.maePercent)),
  };
}

export function calculatePositionBacktestMetrics(
  trades: ScannerBacktestTrade[],
): PositionBacktestMetrics {
  const valid = trades.filter(isValidPositionTrade);
  const excludedTrades = trades.length - valid.length;
  const sampleComplete = excludedTrades === 0;
  const metricsReady = sampleComplete && valid.length > 0;
  const winners = valid.filter((trade) => trade.returnPercent > 0);
  const losers = valid.filter((trade) => trade.returnPercent < 0);
  const returns = valid.map((trade) => trade.returnPercent);

  return {
    strategy: 'position',
    inputTrades: trades.length,
    trades: valid.length,
    excludedTrades,
    sampleComplete,
    // Breakeven trades stay in the eligible denominator and are not winners.
    winRate: metricsReady ? finiteOrNull(winners.length / valid.length * 100) : null,
    // POSITION expectancy is the arithmetic mean of the exact eligible return universe.
    expectancyPercent: metricsReady ? average(returns) : null,
    // No-loss samples have an undefined PF denominator. Never serialize Infinity.
    profitFactor: metricsReady ? finiteOrNull(profitFactor(valid)) : null,
    averageWinPercent: metricsReady ? average(winners.map((trade) => trade.returnPercent)) : null,
    averageLossPercent: metricsReady ? average(losers.map((trade) => trade.returnPercent)) : null,
    maxDrawdownPercent: metricsReady ? maxDrawdownPercent(returns) : null,
    tradeSharpe: metricsReady ? tradeSharpe(returns) : null,
    netReturnPercent: metricsReady ? finiteOrNull(compoundedReturnPercent(returns)) : null,
    medianHoldingDays: metricsReady
      ? median(valid.map((trade) => trade.holdingMinutes / (60 * 24)))
      : null,
    averageMfePercent: metricsReady ? average(valid.map((trade) => trade.mfePercent)) : null,
    averageMaePercent: metricsReady ? average(valid.map((trade) => trade.maePercent)) : null,
    returnCostBasis: 'UNVERIFIED_UPSTREAM_RETURN',
    fullCostAdjusted: false,
    profitabilityClaimAllowed: false,
  };
}
