export interface ScannerBacktestTrade {
  returnPercent: number;
  holdingMinutes: number;
  maePercent: number;
  mfePercent: number;
  slippageBps?: number;
}

export interface ScalpingBacktestMetrics {
  strategy: 'scalping';
  trades: number;
  winRate: number;
  expectancyPercent: number;
  profitFactor: number | null;
  medianHoldingMinutes: number | null;
  averageSlippageBps: number | null;
  maxAdverseExcursionPercent: number | null;
}

export interface SwingBacktestMetrics {
  strategy: 'swing';
  trades: number;
  winRate: number;
  expectancyPercent: number;
  profitFactor: number | null;
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

function base(trades: ScannerBacktestTrade[]) {
  const valid = trades.filter((trade) => (
    Number.isFinite(trade.returnPercent)
    && Number.isFinite(trade.holdingMinutes)
    && trade.holdingMinutes >= 0
    && Number.isFinite(trade.maePercent)
    && Number.isFinite(trade.mfePercent)
  ));
  const winners = valid.filter((trade) => trade.returnPercent > 0).length;
  return {
    valid,
    trades: valid.length,
    winRate: valid.length ? winners / valid.length * 100 : 0,
    expectancyPercent: average(valid.map((trade) => trade.returnPercent)) ?? 0,
    profitFactor: profitFactor(valid),
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
    medianHoldingHours: median(summary.valid.map((trade) => trade.holdingMinutes / 60)),
    averageMfePercent: average(summary.valid.map((trade) => trade.mfePercent)),
    averageMaePercent: average(summary.valid.map((trade) => trade.maePercent)),
  };
}
