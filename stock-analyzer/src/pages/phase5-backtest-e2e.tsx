import { BacktestResearchPanel } from '@/components/backtest-research-panel';
import type { BacktestFormValues, BacktestResult } from '@/lib/backtest';

const START = Date.UTC(2026, 0, 1);

function fixtureResult(values: BacktestFormValues): BacktestResult {
  const trades = Array.from({ length: 24 }, (_, index) => ({
    id: `fixture-${index}`,
    side: index % 2 === 0 ? 'long' as const : 'short' as const,
    entryTime: START + index * 24 * 60 * 60_000,
    exitTime: START + index * 24 * 60 * 60_000 + 6 * 60 * 60_000,
    entryPrice: 100 + index,
    exitPrice: 101 + index * 0.9,
    quantity: 0.1,
    grossPnl: index % 3 === 0 ? -8 : 12,
    netPnl: index % 3 === 0 ? -10 : 9,
    entryFee: 0.6,
    exitFee: 0.6,
    slippageCost: 0.4,
    fundingCost: index % 2 === 0 ? 0.2 : -0.1,
    rMultiple: index % 3 === 0 ? -1 : 0.9,
    exitReason: index % 3 === 0 ? 'stop_loss' : 'take_profit',
    marketRegime: index % 2 === 0 ? 'uptrend' : 'ranging',
  }));
  const equityCurve = Array.from({ length: 25 }, (_, index) => ({
    timestamp: START + index * 24 * 60 * 60_000,
    equity: 10_000 + index * 6 - (index % 4) * 3,
  }));
  const drawdownCurve = equityCurve.slice(1).map((point, index) => ({
    timestamp: point.timestamp,
    drawdown: index % 4 * 3,
    drawdownPercent: index % 4 * 0.03,
  }));
  const performance = {
    trades: 12,
    wins: 8,
    losses: 4,
    winRate: 66.67,
    netPnl: 96,
    averageRMultiple: 0.27,
    expectancy: 8,
    profitFactor: 1.8,
  };
  return {
    ok: true,
    mode: 'backtest-only',
    orderSubmitted: false,
    symbol: values.symbol,
    timeframe: values.timeframe,
    strategy: values.strategy,
    initialCapital: values.initialCapital,
    finalCapital: 10_144,
    totalReturnPercent: 1.44,
    annualizedReturnPercent: 18.2,
    totalTrades: trades.length,
    winningTrades: 16,
    losingTrades: 8,
    winRate: 66.67,
    expectancy: 6,
    profitFactor: 1.8,
    averageRMultiple: 0.27,
    maximumDrawdown: 72,
    maximumDrawdownPercent: 0.71,
    sharpeRatio: 1.12,
    sortinoRatio: 1.64,
    calmarRatio: 2.56,
    totalFees: 28.8,
    totalSlippage: 9.6,
    totalFunding: 1.2,
    longPerformance: performance,
    shortPerformance: performance,
    validationPerformance: [
      { ...performance, name: 'training', startTime: START, endTime: START + 18 * 24 * 60 * 60_000, maximumDrawdown: 40, maximumDrawdownPercent: 0.4 },
      { ...performance, name: 'validation', startTime: START + 18 * 24 * 60 * 60_000, endTime: START + 24 * 24 * 60 * 60_000, maximumDrawdown: 22, maximumDrawdownPercent: 0.22 },
      { ...performance, name: 'test', startTime: START + 24 * 24 * 60 * 60_000, endTime: START + 30 * 24 * 60 * 60_000, maximumDrawdown: 28, maximumDrawdownPercent: 0.28 },
    ],
    walkForward: [
      { startTime: START, endTime: START + 10 * 24 * 60 * 60_000, totalTrades: 8, netPnl: 38, maximumDrawdown: 20, expectancy: 4.75 },
      { startTime: START + 10 * 24 * 60 * 60_000, endTime: START + 20 * 24 * 60 * 60_000, totalTrades: 8, netPnl: 42, maximumDrawdown: 18, expectancy: 5.25 },
      { startTime: START + 20 * 24 * 60 * 60_000, endTime: START + 30 * 24 * 60 * 60_000, totalTrades: 8, netPnl: 64, maximumDrawdown: 28, expectancy: 8 },
    ],
    monthlyPerformance: [{ month: '2026-01', trades: 24, netPnl: 144, returnPercent: 1.44 }],
    regimePerformance: [
      { regime: 'uptrend', trades: 12, netPnl: 100, winRate: 75 },
      { regime: 'ranging', trades: 12, netPnl: 44, winRate: 58.3 },
    ],
    equityCurve,
    drawdownCurve,
    trades,
    warnings: [
      'OHLC 한 봉에서 손절과 목표가가 모두 도달하면 보수적으로 손절을 우선합니다.',
      '실현 손익 기준 자산곡선이며 미실현 손익은 포함하지 않습니다.',
      '수수료·슬리피지·보유시간 기반 펀딩비를 반영했습니다.',
      'UTC 일 단위 세션 VWAP을 사용합니다.',
    ],
    calculatedAt: new Date().toISOString(),
  };
}

function emptyFixtureResult(values: BacktestFormValues): BacktestResult {
  const base = fixtureResult(values);
  const emptyPerformance = {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    netPnl: 0,
    averageRMultiple: 0,
    expectancy: 0,
    profitFactor: null,
  };
  return {
    ...base,
    finalCapital: values.initialCapital,
    totalReturnPercent: 0,
    annualizedReturnPercent: null,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    expectancy: 0,
    profitFactor: null,
    averageRMultiple: 0,
    maximumDrawdown: 0,
    maximumDrawdownPercent: 0,
    sharpeRatio: null,
    sortinoRatio: null,
    calmarRatio: null,
    totalFees: 0,
    totalSlippage: 0,
    totalFunding: 0,
    longPerformance: emptyPerformance,
    shortPerformance: emptyPerformance,
    validationPerformance: [
      { ...emptyPerformance, name: 'training', startTime: START, endTime: START + 18 * 24 * 60 * 60_000, maximumDrawdown: 0, maximumDrawdownPercent: 0 },
      { ...emptyPerformance, name: 'validation', startTime: START + 18 * 24 * 60 * 60_000, endTime: START + 24 * 24 * 60 * 60_000, maximumDrawdown: 0, maximumDrawdownPercent: 0 },
      { ...emptyPerformance, name: 'test', startTime: START + 24 * 24 * 60 * 60_000, endTime: START + 30 * 24 * 60 * 60_000, maximumDrawdown: 0, maximumDrawdownPercent: 0 },
    ],
    walkForward: [],
    monthlyPerformance: [],
    regimePerformance: [],
    equityCurve: [],
    drawdownCurve: [],
    trades: [],
    warnings: [
      '조건을 충족한 거래가 없어 성과 표본이 비어 있습니다.',
      'OHLC 한 봉에서 손절과 목표가가 모두 도달하면 보수적으로 손절을 우선합니다.',
    ],
  };
}

export default function Phase5BacktestE2EPage() {
  return <BacktestResearchPanel compact execute={async (values) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (values.symbol === 'ERRORUSDT') throw new Error('fixture 백테스트 오류');
    if (values.symbol === 'EMPTYUSDT') return emptyFixtureResult(values);
    return fixtureResult(values);
  }} />;
}
