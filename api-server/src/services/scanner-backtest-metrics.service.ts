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

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function profitFactor(trades: ScannerBacktestTrade[]): number | null {
  const gains = trades.filter((trade) => trade.returnPercent > 0)
    .reduce((sum, trade) => sum + trade.returnPercent, 0);
  const losses = Math.abs(trades.filter((trade) => trade.returnPercent < 0)
    .reduce((sum, trade) => sum + trade.returnPercent, 0));
  if (losses === 0) return gains > 0 ? Number.POSITIVE_INFINITY : null;
  return gains / losses;
}

function maxDrawdownPercent(returns: number[]): number | null {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let maximum = 0;
  for (const returnPercent of returns) {
    equity *= 1 + returnPercent / 100;
    peak = Math.max(peak, equity);
    if (peak <= 0) continue;
    maximum = Math.max(maximum, (peak - equity) / peak * 100);
  }
  return -maximum;
}

function tradeSharpe(returns: number[]): number | null {
  if (returns.length < 2) return null;
  const mean = average(returns);
  if (mean == null) return null;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const standardDeviation = Math.sqrt(variance);
  if (!Number.isFinite(standardDeviation) || standardDeviation === 0) return null;
  return mean / standardDeviation * Math.sqrt(returns.length);
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
    winRate: valid.length ? winners.length / valid.length * 100 : 0,
    expectancyPercent: average(returns) ?? 0,
    profitFactor: profitFactor(valid),
    averageWinPercent: average(winners.map((trade) => trade.returnPercent)),
    averageLossPercent: average(losers.map((trade) => trade.returnPercent)),
    maxDrawdownPercent: maxDrawdownPercent(returns),
    tradeSharpe: tradeSharpe(returns),
    netReturnPercent: compoundedReturnPercent(returns),
  };
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