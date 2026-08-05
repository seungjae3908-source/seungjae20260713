export type UsMicrocapCandle = {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type UsMicrocapStrategyConfig = {
  id: string;
  label: string;
  initialCapital: number;
  minimumPrice: number;
  maximumPrice: number;
  averageVolumeLookback: number;
  breakoutLookback: number;
  minimumAverageDollarVolume: number;
  minimumRelativeVolume: number;
  minimumDailyChangePercent: number;
  maximumDailyChangePercent: number;
  maximumFiveDayReturnPercent: number;
  maximumTwentyDayReturnPercent: number;
  minimumCloseLocation: number;
  maximumUpperWickPercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  maximumHoldingDays: number;
  maximumConcurrentPositions: number;
  maximumPositionPercent: number;
  riskPerTradePercent: number;
  roundTripCostPercent: number;
  slippagePercent: number;
};

export type UsMicrocapSignal = {
  symbol: string;
  signalTime: number;
  entryTime: number;
  score: number;
  close: number;
  dailyChangePercent: number;
  relativeVolume: number;
  averageDollarVolume: number;
  fiveDayReturnPercent: number;
  twentyDayReturnPercent: number;
  closeLocation: number;
  upperWickPercent: number;
};

export type UsMicrocapTrade = {
  symbol: string;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  investedCapital: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  netReturnPercent: number;
  exitReason: 'STOP' | 'TARGET' | 'TIME' | 'END_OF_DATA';
  signalScore: number;
};

export type UsMicrocapPerformance = {
  strategyId: string;
  strategyLabel: string;
  initialCapital: number;
  finalCapital: number;
  netPnl: number;
  totalReturnPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averageNetReturnPercent: number;
  averageWinPercent: number;
  averageLossPercent: number;
  payoffRatio: number | null;
  profitFactor: number | null;
  maximumDrawdownPercent: number;
  maximumConsecutiveLosses: number;
  totalCosts: number;
  targetHits: number;
  stopHits: number;
  timeExits: number;
  trades: UsMicrocapTrade[];
};

export type UsMicrocapOptimizationResult = {
  mode: 'backtest-only';
  orderSubmitted: false;
  selectedStrategy: UsMicrocapStrategyConfig | null;
  training: UsMicrocapPerformance | null;
  validation: UsMicrocapPerformance | null;
  test: UsMicrocapPerformance | null;
  candidates: Array<{
    strategy: UsMicrocapStrategyConfig;
    training: UsMicrocapPerformance;
    trainingScore: number;
    rejectedReasons: string[];
  }>;
  validationPassed: boolean;
  testPassed: boolean;
  liveEligible: false;
  warnings: string[];
  generatedAt: string;
};

type Position = {
  symbol: string;
  signal: UsMicrocapSignal;
  entryPrice: number;
  entryTime: number;
  quantity: number;
  investedCapital: number;
  stopPrice: number;
  targetPrice: number;
  holdingDays: number;
};

type BacktestWindow = { entryStartTime?: number; entryEndTime?: number };

const round = (value: number, digits = 4): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const average = (values: readonly number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const percentChange = (from: number, to: number): number =>
  from > 0 ? ((to - from) / from) * 100 : 0;

function validCandle(candle: UsMicrocapCandle): boolean {
  return Boolean(candle.symbol.trim())
    && Number.isFinite(candle.timestamp)
    && candle.timestamp > 0
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    && candle.open > 0
    && candle.high > 0
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high);
}

export const DEFAULT_US_MICROCAP_STRATEGIES: readonly UsMicrocapStrategyConfig[] = Object.freeze([
  {
    id: 'conservative', label: '보수형', initialCapital: 1_000_000,
    minimumPrice: 0.5, maximumPrice: 20, averageVolumeLookback: 20, breakoutLookback: 20,
    minimumAverageDollarVolume: 5_000_000, minimumRelativeVolume: 3,
    minimumDailyChangePercent: 8, maximumDailyChangePercent: 35,
    maximumFiveDayReturnPercent: 60, maximumTwentyDayReturnPercent: 150,
    minimumCloseLocation: 0.72, maximumUpperWickPercent: 22,
    stopLossPercent: 6, takeProfitPercent: 11, maximumHoldingDays: 3,
    maximumConcurrentPositions: 3, maximumPositionPercent: 30, riskPerTradePercent: 0.5,
    roundTripCostPercent: 0.35, slippagePercent: 0.25,
  },
  {
    id: 'balanced', label: '균형형', initialCapital: 1_000_000,
    minimumPrice: 0.5, maximumPrice: 20, averageVolumeLookback: 20, breakoutLookback: 20,
    minimumAverageDollarVolume: 3_000_000, minimumRelativeVolume: 2.5,
    minimumDailyChangePercent: 6, maximumDailyChangePercent: 40,
    maximumFiveDayReturnPercent: 80, maximumTwentyDayReturnPercent: 180,
    minimumCloseLocation: 0.65, maximumUpperWickPercent: 28,
    stopLossPercent: 7, takeProfitPercent: 12, maximumHoldingDays: 4,
    maximumConcurrentPositions: 3, maximumPositionPercent: 30, riskPerTradePercent: 0.5,
    roundTripCostPercent: 0.35, slippagePercent: 0.3,
  },
  {
    id: 'strict-breakout', label: '강한 돌파형', initialCapital: 1_000_000,
    minimumPrice: 1, maximumPrice: 15, averageVolumeLookback: 30, breakoutLookback: 30,
    minimumAverageDollarVolume: 8_000_000, minimumRelativeVolume: 4,
    minimumDailyChangePercent: 10, maximumDailyChangePercent: 32,
    maximumFiveDayReturnPercent: 55, maximumTwentyDayReturnPercent: 130,
    minimumCloseLocation: 0.78, maximumUpperWickPercent: 18,
    stopLossPercent: 5.5, takeProfitPercent: 10, maximumHoldingDays: 3,
    maximumConcurrentPositions: 2, maximumPositionPercent: 30, riskPerTradePercent: 0.4,
    roundTripCostPercent: 0.35, slippagePercent: 0.2,
  },
]);

export function validateUsMicrocapStrategy(config: UsMicrocapStrategyConfig): void {
  const positive = [
    config.initialCapital, config.minimumPrice, config.maximumPrice, config.averageVolumeLookback,
    config.breakoutLookback, config.minimumAverageDollarVolume, config.minimumRelativeVolume,
    config.stopLossPercent, config.takeProfitPercent, config.maximumHoldingDays,
    config.maximumConcurrentPositions, config.maximumPositionPercent, config.riskPerTradePercent,
  ];
  if (!config.id.trim() || !config.label.trim()) throw new Error('STRATEGY_ID_REQUIRED');
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('INVALID_POSITIVE_PARAMETER');
  if (config.minimumPrice >= config.maximumPrice) throw new Error('INVALID_PRICE_RANGE');
  if (!Number.isInteger(config.averageVolumeLookback) || !Number.isInteger(config.breakoutLookback)) throw new Error('INVALID_LOOKBACK');
  if (!Number.isInteger(config.maximumHoldingDays) || !Number.isInteger(config.maximumConcurrentPositions)) throw new Error('INVALID_INTEGER_PARAMETER');
  if (config.maximumPositionPercent > 100 || config.riskPerTradePercent > 2) throw new Error('UNSAFE_POSITION_RISK');
  if (config.minimumCloseLocation < 0 || config.minimumCloseLocation > 1) throw new Error('INVALID_CLOSE_LOCATION');
  if ([config.roundTripCostPercent, config.slippagePercent].some((value) => !Number.isFinite(value) || value < 0 || value >= 10)) throw new Error('INVALID_COST_RATE');
}

export function normalizeUsMicrocapCandles(input: readonly UsMicrocapCandle[]): UsMicrocapCandle[] {
  const seen = new Set<string>();
  const rows = input
    .filter(validCandle)
    .map((candle) => ({ ...candle, symbol: candle.symbol.trim().toUpperCase() }))
    .sort((left, right) => left.timestamp - right.timestamp || left.symbol.localeCompare(right.symbol));
  return rows.filter((candle) => {
    const key = `${candle.symbol}:${candle.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreSignal(input: Omit<UsMicrocapSignal, 'score' | 'symbol' | 'signalTime' | 'entryTime' | 'close'>): number {
  const relativeVolumeScore = clamp((input.relativeVolume - 1) * 12, 0, 32);
  const momentumScore = clamp(input.dailyChangePercent * 0.8, 0, 24);
  const closeScore = clamp((input.closeLocation - 0.5) * 60, 0, 24);
  const liquidityScore = clamp(Math.log10(Math.max(1, input.averageDollarVolume)) * 3 - 14, 0, 12);
  const heatPenalty = clamp(Math.max(0, input.fiveDayReturnPercent - 35) * 0.25, 0, 12);
  const wickPenalty = clamp(input.upperWickPercent * 0.2, 0, 8);
  return round(clamp(40 + relativeVolumeScore + momentumScore + closeScore + liquidityScore - heatPenalty - wickPenalty, 0, 100), 2);
}

export function detectUsMicrocapSignal(
  candles: readonly UsMicrocapCandle[],
  index: number,
  config: UsMicrocapStrategyConfig,
): UsMicrocapSignal | null {
  validateUsMicrocapStrategy(config);
  const required = Math.max(config.averageVolumeLookback, config.breakoutLookback, 20) + 1;
  if (index < required || index >= candles.length - 1) return null;
  const current = candles[index];
  const previous = candles[index - 1];
  if (!current || !previous || current.symbol !== previous.symbol) return null;
  if (current.close < config.minimumPrice || current.close > config.maximumPrice) return null;

  const volumeWindow = candles.slice(index - config.averageVolumeLookback, index);
  const breakoutWindow = candles.slice(index - config.breakoutLookback, index);
  if (volumeWindow.length !== config.averageVolumeLookback || breakoutWindow.length !== config.breakoutLookback) return null;
  if (volumeWindow.some((row) => row.symbol !== current.symbol) || breakoutWindow.some((row) => row.symbol !== current.symbol)) return null;

  const averageVolume = average(volumeWindow.map((row) => row.volume));
  const averageDollarVolume = average(volumeWindow.map((row) => row.close * row.volume));
  if (!(averageVolume > 0) || averageDollarVolume < config.minimumAverageDollarVolume) return null;
  const relativeVolume = current.volume / averageVolume;
  if (relativeVolume < config.minimumRelativeVolume) return null;

  const dailyChangePercent = percentChange(previous.close, current.close);
  if (dailyChangePercent < config.minimumDailyChangePercent || dailyChangePercent > config.maximumDailyChangePercent) return null;
  const previousHigh = Math.max(...breakoutWindow.map((row) => row.high));
  if (!(current.close > previousHigh)) return null;

  const fiveDayBase = candles[index - 5];
  const twentyDayBase = candles[index - 20];
  if (!fiveDayBase || !twentyDayBase || fiveDayBase.symbol !== current.symbol || twentyDayBase.symbol !== current.symbol) return null;
  const fiveDayReturnPercent = percentChange(fiveDayBase.close, current.close);
  const twentyDayReturnPercent = percentChange(twentyDayBase.close, current.close);
  if (fiveDayReturnPercent > config.maximumFiveDayReturnPercent || twentyDayReturnPercent > config.maximumTwentyDayReturnPercent) return null;

  const range = current.high - current.low;
  if (!(range > 0)) return null;
  const closeLocation = (current.close - current.low) / range;
  const upperWickPercent = ((current.high - Math.max(current.open, current.close)) / range) * 100;
  if (closeLocation < config.minimumCloseLocation || upperWickPercent > config.maximumUpperWickPercent) return null;

  const metrics = {
    dailyChangePercent, relativeVolume, averageDollarVolume, fiveDayReturnPercent,
    twentyDayReturnPercent, closeLocation, upperWickPercent,
  };
  return {
    symbol: current.symbol,
    signalTime: current.timestamp,
    entryTime: candles[index + 1].timestamp,
    close: current.close,
    score: scoreSignal(metrics),
    ...metrics,
  };
}

function maximumDrawdownPercent(equityCurve: readonly number[]): number {
  let peak = 0;
  let maximum = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maximum = Math.max(maximum, ((peak - equity) / peak) * 100);
  }
  return maximum;
}

function summarize(
  config: UsMicrocapStrategyConfig,
  trades: UsMicrocapTrade[],
  finalCapital: number,
  equityCurve: number[],
): UsMicrocapPerformance {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl <= 0);
  const totalProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const averageWin = average(wins.map((trade) => trade.netReturnPercent));
  const averageLoss = average(losses.map((trade) => trade.netReturnPercent));
  let consecutiveLosses = 0;
  let maximumConsecutiveLosses = 0;
  for (const trade of trades) {
    if (trade.netPnl <= 0) {
      consecutiveLosses += 1;
      maximumConsecutiveLosses = Math.max(maximumConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }
  const netPnl = finalCapital - config.initialCapital;
  return {
    strategyId: config.id,
    strategyLabel: config.label,
    initialCapital: round(config.initialCapital, 2),
    finalCapital: round(finalCapital, 2),
    netPnl: round(netPnl, 2),
    totalReturnPercent: round((netPnl / config.initialCapital) * 100, 2),
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: round(trades.length ? (wins.length / trades.length) * 100 : 0, 2),
    averageNetReturnPercent: round(average(trades.map((trade) => trade.netReturnPercent)), 3),
    averageWinPercent: round(averageWin, 3),
    averageLossPercent: round(averageLoss, 3),
    payoffRatio: averageLoss < 0 ? round(averageWin / Math.abs(averageLoss), 3) : null,
    profitFactor: totalLoss > 0 ? round(totalProfit / totalLoss, 3) : totalProfit > 0 ? 99 : null,
    maximumDrawdownPercent: round(maximumDrawdownPercent(equityCurve), 2),
    maximumConsecutiveLosses,
    totalCosts: round(trades.reduce((sum, trade) => sum + trade.costs, 0), 2),
    targetHits: trades.filter((trade) => trade.exitReason === 'TARGET').length,
    stopHits: trades.filter((trade) => trade.exitReason === 'STOP').length,
    timeExits: trades.filter((trade) => trade.exitReason === 'TIME' || trade.exitReason === 'END_OF_DATA').length,
    trades,
  };
}

export function runUsMicrocapBacktest(
  rawCandles: readonly UsMicrocapCandle[],
  config: UsMicrocapStrategyConfig,
  window: BacktestWindow = {},
): UsMicrocapPerformance {
  validateUsMicrocapStrategy(config);
  const candles = normalizeUsMicrocapCandles(rawCandles);
  const bySymbol = new Map<string, UsMicrocapCandle[]>();
  for (const candle of candles) {
    const rows = bySymbol.get(candle.symbol) ?? [];
    rows.push(candle);
    bySymbol.set(candle.symbol, rows);
  }

  const candidateByEntryTime = new Map<number, Array<{ signal: UsMicrocapSignal; entryCandle: UsMicrocapCandle }>>();
  const candleBySymbolAndTime = new Map<string, UsMicrocapCandle>();
  const timestamps = new Set<number>();
  for (const [symbol, rows] of bySymbol) {
    for (const candle of rows) {
      candleBySymbolAndTime.set(`${symbol}:${candle.timestamp}`, candle);
      timestamps.add(candle.timestamp);
    }
    for (let index = 0; index < rows.length - 1; index += 1) {
      const signal = detectUsMicrocapSignal(rows, index, config);
      if (!signal) continue;
      if (window.entryStartTime != null && signal.entryTime < window.entryStartTime) continue;
      if (window.entryEndTime != null && signal.entryTime > window.entryEndTime) continue;
      const entryCandle = rows[index + 1];
      const candidates = candidateByEntryTime.get(signal.entryTime) ?? [];
      candidates.push({ signal, entryCandle });
      candidateByEntryTime.set(signal.entryTime, candidates);
    }
  }

  const dates = [...timestamps].sort((left, right) => left - right);
  let cash = config.initialCapital;
  const positions = new Map<string, Position>();
  const trades: UsMicrocapTrade[] = [];
  const equityCurve: number[] = [config.initialCapital];

  const closePosition = (position: Position, candle: UsMicrocapCandle, exitPrice: number, reason: UsMicrocapTrade['exitReason']) => {
    const grossProceeds = exitPrice * position.quantity;
    const grossPnl = grossProceeds - position.investedCapital;
    const costRate = (config.roundTripCostPercent + config.slippagePercent) / 100;
    const costs = position.investedCapital * costRate;
    const netPnl = grossPnl - costs;
    cash += position.investedCapital + netPnl;
    trades.push({
      symbol: position.symbol,
      signalTime: position.signal.signalTime,
      entryTime: position.entryTime,
      exitTime: candle.timestamp,
      entryPrice: round(position.entryPrice, 6),
      exitPrice: round(exitPrice, 6),
      quantity: round(position.quantity, 6),
      investedCapital: round(position.investedCapital, 2),
      grossPnl: round(grossPnl, 2),
      costs: round(costs, 2),
      netPnl: round(netPnl, 2),
      netReturnPercent: round((netPnl / position.investedCapital) * 100, 4),
      exitReason: reason,
      signalScore: position.signal.score,
    });
    positions.delete(position.symbol);
  };

  for (const timestamp of dates) {
    const candidates = [...(candidateByEntryTime.get(timestamp) ?? [])]
      .sort((left, right) => right.signal.score - left.signal.score || left.signal.symbol.localeCompare(right.signal.symbol));
    for (const { signal, entryCandle } of candidates) {
      if (positions.size >= config.maximumConcurrentPositions) break;
      if (positions.has(signal.symbol) || !(entryCandle.open > 0)) continue;
      const equity = cash + [...positions.values()].reduce((sum, position) => sum + position.investedCapital, 0);
      const maximumPositionValue = equity * config.maximumPositionPercent / 100;
      const riskBudget = equity * config.riskPerTradePercent / 100;
      const riskPerShare = entryCandle.open * config.stopLossPercent / 100;
      const quantityByRisk = riskPerShare > 0 ? riskBudget / riskPerShare : 0;
      const quantityByPosition = maximumPositionValue / entryCandle.open;
      const quantityByCash = cash / entryCandle.open;
      const quantity = Math.floor(Math.min(quantityByRisk, quantityByPosition, quantityByCash));
      if (quantity < 1) continue;
      const investedCapital = quantity * entryCandle.open;
      cash -= investedCapital;
      positions.set(signal.symbol, {
        symbol: signal.symbol,
        signal,
        entryPrice: entryCandle.open,
        entryTime: timestamp,
        quantity,
        investedCapital,
        stopPrice: entryCandle.open * (1 - config.stopLossPercent / 100),
        targetPrice: entryCandle.open * (1 + config.takeProfitPercent / 100),
        holdingDays: 0,
      });
    }

    for (const position of [...positions.values()]) {
      const candle = candleBySymbolAndTime.get(`${position.symbol}:${timestamp}`);
      if (!candle || timestamp < position.entryTime) continue;
      position.holdingDays += 1;
      const hitStop = candle.low <= position.stopPrice;
      const hitTarget = candle.high >= position.targetPrice;
      if (hitStop) {
        closePosition(position, candle, position.stopPrice, 'STOP');
      } else if (hitTarget) {
        closePosition(position, candle, position.targetPrice, 'TARGET');
      } else if (position.holdingDays >= config.maximumHoldingDays) {
        closePosition(position, candle, candle.close, 'TIME');
      }
    }

    const markedEquity = cash + [...positions.values()].reduce((sum, position) => {
      const candle = candleBySymbolAndTime.get(`${position.symbol}:${timestamp}`);
      return sum + (candle?.close ?? position.entryPrice) * position.quantity;
    }, 0);
    equityCurve.push(markedEquity);
  }

  const finalTimestamp = dates.at(-1);
  if (finalTimestamp != null) {
    for (const position of [...positions.values()]) {
      const candle = candleBySymbolAndTime.get(`${position.symbol}:${finalTimestamp}`);
      if (candle) closePosition(position, candle, candle.close, 'END_OF_DATA');
    }
  }
  return summarize(config, trades, cash, [...equityCurve, cash]);
}

function candidateTrainingScore(performance: UsMicrocapPerformance): number {
  const profitFactor = performance.profitFactor ?? 0;
  const samplePenalty = performance.totalTrades < 30 ? (30 - performance.totalTrades) * 2 : 0;
  return round(
    performance.totalReturnPercent
      + Math.min(20, profitFactor * 6)
      + performance.winRate * 0.08
      - performance.maximumDrawdownPercent * 1.25
      - samplePenalty,
    3,
  );
}

function segmentBoundaries(candles: readonly UsMicrocapCandle[]): { trainingEnd: number; validationEnd: number } | null {
  const dates = [...new Set(candles.map((candle) => candle.timestamp))].sort((left, right) => left - right);
  if (dates.length < 100) return null;
  const trainingIndex = Math.max(0, Math.floor(dates.length * 0.6) - 1);
  const validationIndex = Math.max(trainingIndex + 1, Math.floor(dates.length * 0.8) - 1);
  return { trainingEnd: dates[trainingIndex], validationEnd: dates[validationIndex] };
}

function rejectTraining(performance: UsMicrocapPerformance): string[] {
  const reasons: string[] = [];
  if (performance.totalTrades < 30) reasons.push(`학습 표본 ${performance.totalTrades}회로 30회 미달`);
  if (performance.netPnl <= 0) reasons.push('학습 구간 비용 후 누적수익이 0 이하');
  if ((performance.profitFactor ?? 0) < 1.1) reasons.push('학습 구간 수익계수 1.1 미달');
  if (performance.maximumDrawdownPercent > 25) reasons.push('학습 구간 최대낙폭 25% 초과');
  return reasons;
}

function segmentPassed(performance: UsMicrocapPerformance, minimumTrades: number): boolean {
  return performance.totalTrades >= minimumTrades
    && performance.netPnl > 0
    && (performance.profitFactor ?? 0) >= 1.1
    && performance.maximumDrawdownPercent <= 20
    && performance.maximumConsecutiveLosses <= 8;
}

export function optimizeUsMicrocapStrategy(
  rawCandles: readonly UsMicrocapCandle[],
  strategies: readonly UsMicrocapStrategyConfig[] = DEFAULT_US_MICROCAP_STRATEGIES,
): UsMicrocapOptimizationResult {
  const candles = normalizeUsMicrocapCandles(rawCandles);
  const boundaries = segmentBoundaries(candles);
  const warnings = [
    '실제 주문을 생성하거나 전송하지 않는 백테스트 전용 결과입니다.',
    'OHLCV만으로 과거 공시·오퍼링·워런트·거래정지·상장폐지 위험을 완전히 재현할 수 없습니다.',
    '현재 상장 종목만 사용한 데이터는 생존편향이 생길 수 있으므로 상장폐지 종목을 포함한 데이터가 필요합니다.',
    '일봉 데이터는 장중 체결 순서를 알 수 없어 같은 봉에서 손절과 목표가가 모두 닿으면 손절을 우선합니다.',
  ];
  if (!boundaries) {
    return {
      mode: 'backtest-only', orderSubmitted: false, selectedStrategy: null,
      training: null, validation: null, test: null, candidates: [],
      validationPassed: false, testPassed: false, liveEligible: false,
      warnings: [...warnings, '검증 구간을 나눌 최소 100거래일 데이터가 없습니다.'],
      generatedAt: new Date().toISOString(),
    };
  }

  const candidates = strategies.map((strategy) => {
    const training = runUsMicrocapBacktest(candles, strategy, { entryEndTime: boundaries.trainingEnd });
    return {
      strategy,
      training,
      trainingScore: candidateTrainingScore(training),
      rejectedReasons: rejectTraining(training),
    };
  });
  const accepted = candidates
    .filter((candidate) => candidate.rejectedReasons.length === 0)
    .sort((left, right) => right.trainingScore - left.trainingScore || left.strategy.id.localeCompare(right.strategy.id));
  const selected = accepted[0] ?? null;
  if (!selected) {
    return {
      mode: 'backtest-only', orderSubmitted: false, selectedStrategy: null,
      training: null, validation: null, test: null, candidates,
      validationPassed: false, testPassed: false, liveEligible: false,
      warnings: [...warnings, '학습 구간 기준을 통과한 전략이 없어 모의투자 후보를 자동 차단했습니다.'],
      generatedAt: new Date().toISOString(),
    };
  }

  const validation = runUsMicrocapBacktest(candles, selected.strategy, {
    entryStartTime: boundaries.trainingEnd + 1,
    entryEndTime: boundaries.validationEnd,
  });
  const test = runUsMicrocapBacktest(candles, selected.strategy, {
    entryStartTime: boundaries.validationEnd + 1,
  });
  const validationPassed = segmentPassed(validation, 20);
  const testPassed = segmentPassed(test, 20);
  const combinedTrades = validation.totalTrades + test.totalTrades;
  if (!validationPassed) warnings.push('검증 구간 기준을 통과하지 못해 모의투자 자동 진입 후보를 차단합니다.');
  if (!testPassed) warnings.push('미사용 테스트 구간 기준을 통과하지 못해 모의투자 자동 진입 후보를 차단합니다.');
  if (combinedTrades < 200) warnings.push(`검증·테스트 합계 ${combinedTrades}회로 실전 검토 최소 200회에 미달합니다.`);

  return {
    mode: 'backtest-only',
    orderSubmitted: false,
    selectedStrategy: selected.strategy,
    training: selected.training,
    validation,
    test,
    candidates,
    validationPassed,
    testPassed,
    liveEligible: false,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}
