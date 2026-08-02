import { authorizedFetch } from '@/lib/auth-fetch';

export type BacktestStrategy = 'trend_pullback' | 'breakout' | 'vwap_reclaim';
export type BacktestSide = 'long' | 'short' | 'both';
export type BacktestFormValues = {
  symbol: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  strategy: BacktestStrategy;
  side: BacktestSide;
  riskPercent: number;
  leverage: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  fundingRatePerInterval: number;
  fundingIntervalHours: number;
  stopLossMode: 'percent' | 'atr' | 'swing';
  stopLossValue: number;
  takeProfitMode: 'risk_multiple' | 'percent';
  takeProfitValue: number;
  trailingEnabled: boolean;
  trailingActivationR: number;
  trailingDistanceR: number;
};
export type BacktestPerformance = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  averageRMultiple: number;
  expectancy: number;
  profitFactor: number | null;
};
export type BacktestTrade = {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  netPnl: number;
  entryFee: number;
  exitFee: number;
  slippageCost: number;
  fundingCost: number;
  rMultiple: number;
  exitReason: string;
  marketRegime: string;
};
export type BacktestResult = {
  ok: true;
  mode: 'backtest-only';
  orderSubmitted: false;
  symbol: string;
  timeframe: string;
  strategy: BacktestStrategy;
  initialCapital: number;
  finalCapital: number;
  totalReturnPercent: number;
  annualizedReturnPercent: number | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  expectancy: number;
  profitFactor: number | null;
  averageRMultiple: number;
  maximumDrawdown: number;
  maximumDrawdownPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  calmarRatio: number | null;
  totalFees: number;
  totalSlippage: number;
  totalFunding: number;
  longPerformance: BacktestPerformance;
  shortPerformance: BacktestPerformance;
  validationPerformance: Array<BacktestPerformance & { name: 'training' | 'validation' | 'test'; startTime: number; endTime: number; maximumDrawdown: number; maximumDrawdownPercent: number }>;
  walkForward: Array<{ startTime: number; endTime: number; totalTrades: number; netPnl: number; maximumDrawdown: number; expectancy: number }>;
  monthlyPerformance: Array<{ month: string; trades: number; netPnl: number; returnPercent: number }>;
  regimePerformance: Array<{ regime: string; trades: number; netPnl: number; winRate: number }>;
  equityCurve: Array<{ timestamp: number; equity: number }>;
  drawdownCurve: Array<{ timestamp: number; drawdown: number; drawdownPercent: number }>;
  trades: BacktestTrade[];
  warnings: string[];
  calculatedAt: string;
};

function dateToUtc(value: string, endOfDay = false) {
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  return Date.parse(`${value}${suffix}`);
}

export function toBacktestRequest(values: BacktestFormValues) {
  const parameters: Record<string, number | boolean> = values.strategy === 'trend_pullback'
    ? { fastPeriod: 20, slowPeriod: 50, pullbackTolerancePercent: 0.5, volumePeriod: 20, volumeMultiplier: 1 }
    : values.strategy === 'breakout'
      ? { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 }
      : { volumePeriod: 20, volumeMultiplier: 1.1 };
  return {
    market: 'crypto-futures' as const,
    symbol: values.symbol.trim().toUpperCase(),
    timeframe: values.timeframe,
    startTime: dateToUtc(values.startDate),
    endTime: dateToUtc(values.endDate, true),
    initialCapital: values.initialCapital,
    strategy: values.strategy,
    side: values.side,
    parameters,
    riskPercent: values.riskPercent,
    leverage: values.leverage,
    entryFeeRate: values.entryFeeRate,
    exitFeeRate: values.exitFeeRate,
    slippageRate: values.slippageRate,
    fundingRatePerInterval: values.fundingRatePerInterval,
    fundingIntervalHours: values.fundingIntervalHours,
    stopLossMode: values.stopLossMode,
    stopLossValue: values.stopLossValue,
    takeProfitMode: values.takeProfitMode,
    takeProfitValue: values.takeProfitValue,
    trailingStop: {
      enabled: values.trailingEnabled,
      activationR: values.trailingActivationR,
      distanceR: values.trailingDistanceR,
    },
    maximumConcurrentPositions: 1,
    maximumTradesPerDay: 10,
    intrabarPriority: 'stop_first' as const,
    validationSplit: { trainingPercent: 60, validationPercent: 20, testPercent: 20 },
  };
}

export async function runBacktest(values: BacktestFormValues): Promise<BacktestResult> {
  const response = await authorizedFetch('/api/backtests/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBacktestRequest(values)),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: BacktestResult; message?: string } | null;
  if (!response.ok || !body?.ok || !body.result) {
    throw new Error(body?.message || '백테스트를 실행하지 못했습니다.');
  }
  if (body.result.mode !== 'backtest-only' || body.result.orderSubmitted !== false) {
    throw new Error('백테스트 안전 계약을 확인하지 못했습니다.');
  }
  return body.result;
}
