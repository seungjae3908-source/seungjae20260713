import type { SpotBacktestCandle } from './upbit-backtest-data.service';
import { BacktestMarketContractError, type BacktestMarket } from './backtest-market-profile.service';

export type CashBacktestStrategy = 'trend_pullback' | 'breakout' | 'vwap_reclaim' | 'regime_pullback' | 'regime_rsi_reversal';
export type CashBacktestCandle = Omit<SpotBacktestCandle, 'market' | 'source'> & {
  market: 'kr-stock' | 'us-stock' | 'crypto-spot';
  source: string;
};
export type CashBacktestRequest = {
  market: Exclude<BacktestMarket, 'crypto-futures'>;
  symbol: string;
  timeframe: string;
  initialCapital: number;
  strategy: CashBacktestStrategy;
  parameters?: Record<string, number>;
  riskPercent: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  stopLossPercent: number;
  takeProfitR: number;
  maximumTradesPerDay: number;
  intrabarPriority?: 'stop_first' | 'target_first';
};
export type CashBacktestTrade = {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  netPnl: number;
  rMultiple: number;
  exitReason: 'stop_loss' | 'take_profit' | 'strategy_exit' | 'end_of_data';
};
export type CashBacktestResult = {
  ok: true;
  mode: 'backtest-only';
  orderSubmitted: false;
  market: CashBacktestRequest['market'];
  symbol: string;
  strategy: CashBacktestStrategy;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averageWinR: number;
  averageLossR: number;
  averageRMultiple: number;
  expectancy: number;
  profitFactor: number | null;
  initialCapital: number;
  finalCapital: number;
  totalReturnPercent: number;
  maximumDrawdown: number;
  maximumDrawdownPercent: number;
  totalFees: number;
  totalSlippage: number;
  trades: CashBacktestTrade[];
  warnings: string[];
};

type Signal = { index: number; action: 'BUY' | 'SELL' };
type TrendSnapshot = { fast: number; slow: number; slopePercent: number; bullish: boolean };
type OpenCashPosition = {
  entryTime: number;
  entryPrice: number;
  quantity: number;
  entryFee: number;
  riskAmount: number;
  stop: number;
  target: number;
};
const HOUR_MS = 60 * 60_000;
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberParam = (request: CashBacktestRequest, key: string, fallback: number) => finite(request.parameters?.[key]) ? request.parameters![key] : fallback;

function ema(values: readonly number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * multiplier + current * (1 - multiplier);
    output[index] = current;
  }
  return output;
}

function atr(candles: readonly CashBacktestCandle[], period: number) {
  const output: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < period) return output;
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  for (let index = period; index < candles.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]) / period;
    output[index] = current;
  }
  return output;
}

function rsi(values: readonly number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const valueFor = () => {
    if (averageLoss === 0 && averageGain === 0) return 50;
    if (averageLoss === 0) return 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };
  output[period] = valueFor();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    output[index] = valueFor();
  }
  return output;
}

function averageVolume(candles: readonly CashBacktestCandle[], period: number) {
  return candles.map((_candle, index) => {
    if (index < period) return null;
    const window = candles.slice(index - period, index);
    return window.reduce((sum, candle) => sum + candle.volume, 0) / period;
  });
}

function completedTrendSeries(candles: readonly CashBacktestCandle[], baseTimeframeMs: number, bucketMs: number, fastPeriod: number, slowPeriod: number) {
  const buckets: Array<{ endIndex: number; close: number }> = [];
  let currentKey: number | null = null;
  let currentEndIndex = -1;
  let currentClose = 0;
  let currentTimestamp = 0;
  const finalize = () => {
    if (currentKey == null || currentEndIndex < 0) return;
    const bucketEnd = (currentKey + 1) * bucketMs;
    if (currentTimestamp + baseTimeframeMs >= bucketEnd) buckets.push({ endIndex: currentEndIndex, close: currentClose });
  };
  for (let index = 0; index < candles.length; index += 1) {
    const key = Math.floor(candles[index].timestamp / bucketMs);
    if (currentKey != null && key !== currentKey) finalize();
    if (key !== currentKey) currentKey = key;
    currentEndIndex = index;
    currentClose = candles[index].close;
    currentTimestamp = candles[index].timestamp;
  }
  finalize();
  const closes = buckets.map((bucket) => bucket.close);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const snapshots = buckets.map((_bucket, index): TrendSnapshot | null => {
    const fastNow = fast[index];
    const slowNow = slow[index];
    const fastPrevious = index > 0 ? fast[index - 1] : null;
    if (fastNow == null || slowNow == null || fastPrevious == null || fastPrevious === 0) return null;
    return { fast: fastNow, slow: slowNow, slopePercent: (fastNow / fastPrevious - 1) * 100, bullish: fastNow > slowNow };
  });
  const output: Array<TrendSnapshot | null> = Array(candles.length).fill(null);
  let cursor = 0;
  let available: TrendSnapshot | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    while (cursor < buckets.length && buckets[cursor].endIndex <= index) {
      available = snapshots[cursor];
      cursor += 1;
    }
    output[index] = available;
  }
  return output;
}

function regimeEntryGate(request: CashBacktestRequest, candles: readonly CashBacktestCandle[]) {
  const enabled = numberParam(request, 'regimeFilterEnabled', 0) >= 1;
  if (!enabled) return Array(candles.length).fill(true) as boolean[];
  const baseTimeframeMs = TIMEFRAME_MS[request.timeframe];
  if (!baseTimeframeMs) return Array(candles.length).fill(false) as boolean[];
  const fast1h = Math.max(2, Math.trunc(numberParam(request, 'regimeFastPeriod1h', 12)));
  const slow1h = Math.max(fast1h + 1, Math.trunc(numberParam(request, 'regimeSlowPeriod1h', 26)));
  const fast4h = Math.max(2, Math.trunc(numberParam(request, 'regimeFastPeriod4h', 12)));
  const slow4h = Math.max(fast4h + 1, Math.trunc(numberParam(request, 'regimeSlowPeriod4h', 26)));
  const minimumSlopePercent = numberParam(request, 'minimumTrendSlopePercent', 0);
  const oneHour = completedTrendSeries(candles, baseTimeframeMs, HOUR_MS, fast1h, slow1h);
  const fourHour = completedTrendSeries(candles, baseTimeframeMs, 4 * HOUR_MS, fast4h, slow4h);
  return candles.map((candle, index) => {
    const oneHourState = oneHour[index];
    const fourHourState = fourHour[index];
    return Boolean(oneHourState && fourHourState && oneHourState.bullish && fourHourState.bullish
      && oneHourState.slopePercent >= minimumSlopePercent && fourHourState.slopePercent >= minimumSlopePercent
      && candle.close >= oneHourState.slow && candle.close >= fourHourState.slow);
  });
}

export function calculateCashSignals(request: CashBacktestRequest, candles: readonly CashBacktestCandle[]): Signal[] {
  const closes = candles.map((candle) => candle.close);
  const volumePeriod = Math.max(2, Math.trunc(numberParam(request, 'volumePeriod', 20)));
  const volumeMultiplier = Math.max(0, numberParam(request, 'volumeMultiplier', 1));
  const volumes = averageVolume(candles, volumePeriod);
  const rsiPeriod = Math.max(2, Math.trunc(numberParam(request, 'rsiPeriod', 14)));
  const minimumEntryRsi = Math.max(0, numberParam(request, 'minimumEntryRsi', 0));
  const maximumEntryRsi = Math.min(100, numberParam(request, 'maximumEntryRsi', 100));
  const rsiValues = rsi(closes, rsiPeriod);
  const signals: Signal[] = [];
  const entryGate = regimeEntryGate(request, candles);
  const cooldownBars = Math.max(0, Math.trunc(numberParam(request, 'cooldownBars', 0)));
  let lastBuyIndex = Number.NEGATIVE_INFINITY;
  const pushBuy = (index: number) => {
    const rsiValue = rsiValues[index];
    if (!entryGate[index] || rsiValue == null || rsiValue < minimumEntryRsi || rsiValue > maximumEntryRsi || index - lastBuyIndex <= cooldownBars) return;
    signals.push({ index, action: 'BUY' });
    lastBuyIndex = index;
  };

  if (request.strategy === 'regime_rsi_reversal') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const oversoldRsi = Math.max(0, Math.min(100, numberParam(request, 'oversoldRsi', 40)));
    const recoveryRsi = Math.max(oversoldRsi, Math.min(100, numberParam(request, 'recoveryRsi', 50)));
    const oversoldLookback = Math.max(2, Math.trunc(numberParam(request, 'oversoldLookback', 6)));
    const maximumExtension = Math.max(0, numberParam(request, 'maximumExtensionPercent', 1.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = Math.max(2, oversoldLookback); index < candles.length; index += 1) {
      const fastNow = fast[index];
      const slowNow = slow[index];
      const previousRsi = rsiValues[index - 1];
      const currentRsi = rsiValues[index];
      const average = volumes[index];
      if (fastNow == null || slowNow == null || previousRsi == null || currentRsi == null || average == null) continue;
      const recentRsi = rsiValues.slice(index - oversoldLookback, index).filter((value): value is number => value != null);
      const recentOversold = recentRsi.some((value) => value <= oversoldRsi);
      const recovered = previousRsi <= recoveryRsi && currentRsi > recoveryRsi;
      const current = candles[index];
      const previous = candles[index - 1];
      const trendHeld = fastNow > slowNow && current.close >= slowNow;
      const confirmed = current.close > current.open && current.close > previous.high && current.close <= fastNow * (1 + maximumExtension);
      const volumeOk = current.volume >= average * volumeMultiplier;
      if (trendHeld && recentOversold && recovered && confirmed && volumeOk) pushBuy(index);
      if (current.close < slowNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'regime_pullback') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const tolerance = Math.max(0, numberParam(request, 'pullbackTolerancePercent', 0.25)) / 100;
    const maximumExtension = Math.max(0, numberParam(request, 'maximumExtensionPercent', 0.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = 2; index < candles.length; index += 1) {
      const fastNow = fast[index];
      const slowNow = slow[index];
      const fastPrevious = fast[index - 1];
      const slowPrevious = slow[index - 1];
      const average = volumes[index];
      if (fastNow == null || slowNow == null || fastPrevious == null || slowPrevious == null || average == null) continue;
      const previous = candles[index - 1];
      const current = candles[index];
      const trendHeld = fastNow > slowNow && fastPrevious > slowPrevious && previous.close >= slowPrevious;
      const pullbackTouched = previous.low <= fastPrevious * (1 + tolerance);
      const confirmed = current.close > current.open && current.close > previous.high && current.close > fastNow && current.close <= fastNow * (1 + maximumExtension);
      const volumeOk = current.volume >= average * volumeMultiplier;
      if (trendHeld && pullbackTouched && confirmed && volumeOk) pushBuy(index);
      if (current.close < slowNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'trend_pullback') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const tolerance = Math.max(0, numberParam(request, 'pullbackTolerancePercent', 0.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = 1; index < candles.length; index += 1) {
      const fastNow = fast[index];
      const fastPrevious = fast[index - 1];
      const slowNow = slow[index];
      const average = volumes[index];
      if (fastNow == null || fastPrevious == null || slowNow == null || average == null) continue;
      const volumeOk = candles[index].volume >= average * volumeMultiplier;
      if (fastNow > slowNow && candles[index - 1].close <= fastPrevious * (1 + tolerance) && candles[index].close > fastNow && volumeOk) pushBuy(index);
      if (fastNow < slowNow || candles[index].close < fastNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'breakout') {
    const lookback = Math.max(2, Math.trunc(numberParam(request, 'lookback', 20)));
    const atrPeriod = Math.max(2, Math.trunc(numberParam(request, 'atrPeriod', 14)));
    const minimumBreakoutAtr = Math.max(0, numberParam(request, 'minimumBreakoutAtr', 0));
    const maximumBreakoutAtr = Math.max(minimumBreakoutAtr, numberParam(request, 'maximumBreakoutAtr', Number.POSITIVE_INFINITY));
    const atrValues = atr(candles, atrPeriod);
    for (let index = lookback; index < candles.length; index += 1) {
      const previous = candles.slice(index - lookback, index);
      const high = Math.max(...previous.map((candle) => candle.high));
      const low = Math.min(...previous.map((candle) => candle.low));
      const average = volumes[index];
      if (average == null) continue;
      const breakoutDistance = candles[index].close - high;
      const atrValue = atrValues[index];
      const breakoutRatio = atrValue != null && atrValue > 0 ? breakoutDistance / atrValue : null;
      const breakoutDistanceOk = minimumBreakoutAtr === 0
        ? maximumBreakoutAtr === Number.POSITIVE_INFINITY || (breakoutRatio != null && breakoutRatio <= maximumBreakoutAtr)
        : breakoutRatio != null && breakoutRatio >= minimumBreakoutAtr && breakoutRatio <= maximumBreakoutAtr;
      if (breakoutDistance > 0 && breakoutDistanceOk && candles[index].volume >= average * volumeMultiplier) pushBuy(index);
      if (candles[index].close < low) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'vwap_reclaim') {
    let cumulativeValue = 0;
    let cumulativeVolume = 0;
    let previousVwap: number | null = null;
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      cumulativeValue += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
      cumulativeVolume += candle.volume;
      const currentVwap = cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : null;
      const average = volumes[index];
      if (index > 0 && currentVwap != null && previousVwap != null && average != null) {
        if (candles[index - 1].close <= previousVwap && candle.close > currentVwap && candle.volume >= average * volumeMultiplier) pushBuy(index);
        if (candles[index - 1].close >= previousVwap && candle.close < currentVwap) signals.push({ index, action: 'SELL' });
      }
      previousVwap = currentVwap;
    }
  }
  return signals;
}

export function validateCashBacktestRequest(request: CashBacktestRequest) {
  if (!['kr-stock', 'us-stock', 'crypto-spot'].includes(request.market)) throw new BacktestMarketContractError('INVALID_CASH_MARKET', '현물 백테스트 시장이 올바르지 않습니다.');
  if (!finite(request.initialCapital) || request.initialCapital <= 0) throw new BacktestMarketContractError('INVALID_CAPITAL', '초기 자본은 0보다 커야 합니다.');
  if (!finite(request.riskPercent) || request.riskPercent <= 0 || request.riskPercent > 1) throw new BacktestMarketContractError('INVALID_RISK_PERCENT', '거래당 위험률은 0% 초과 1% 이하여야 합니다.');
  if (![request.entryFeeRate, request.exitFeeRate, request.slippageRate].every((value) => finite(value) && value >= 0 && value < 1)) throw new BacktestMarketContractError('INVALID_COST_RATE', '수수료와 슬리피지 비율이 올바르지 않습니다.');
  if (!finite(request.stopLossPercent) || request.stopLossPercent <= 0 || request.stopLossPercent >= 100) throw new BacktestMarketContractError('INVALID_STOP_LOSS', '손절률이 올바르지 않습니다.');
  if (!finite(request.takeProfitR) || request.takeProfitR <= 0) throw new BacktestMarketContractError('INVALID_TAKE_PROFIT', '목표 R 값이 올바르지 않습니다.');
  if (!Number.isInteger(request.maximumTradesPerDay) || request.maximumTradesPerDay < 1 || request.maximumTradesPerDay > 100) throw new BacktestMarketContractError('INVALID_DAILY_TRADES', '일일 거래 수 제한이 올바르지 않습니다.');
  if (numberParam(request, 'regimeFilterEnabled', 0) >= 1 && !TIMEFRAME_MS[request.timeframe]) throw new BacktestMarketContractError('REGIME_FILTER_TIMEFRAME_UNSUPPORTED', '다중 시간봉 장세 필터는 1~30분봉에서만 지원합니다.');
  const minimumEntryRsi = numberParam(request, 'minimumEntryRsi', 0);
  const maximumEntryRsi = numberParam(request, 'maximumEntryRsi', 100);
  if (minimumEntryRsi < 0 || maximumEntryRsi > 100 || minimumEntryRsi > maximumEntryRsi) throw new BacktestMarketContractError('INVALID_RSI_RANGE', '진입 RSI 범위가 올바르지 않습니다.');
  const oversoldRsi = numberParam(request, 'oversoldRsi', 40);
  const recoveryRsi = numberParam(request, 'recoveryRsi', 50);
  if (oversoldRsi < 0 || recoveryRsi > 100 || oversoldRsi > recoveryRsi) throw new BacktestMarketContractError('INVALID_RSI_RECOVERY_RANGE', '과매도·회복 RSI 범위가 올바르지 않습니다.');
  if (numberParam(request, 'stopAtrMultiplier', 0) < 0) throw new BacktestMarketContractError('INVALID_ATR_STOP', 'ATR 손절 배수는 0 이상이어야 합니다.');
  if (numberParam(request, 'minimumStopToCostRatio', 0) < 0) throw new BacktestMarketContractError('INVALID_STOP_COST_RATIO', '손절폭 대비 비용 비율은 0 이상이어야 합니다.');
}

export function runCashBacktest(request: CashBacktestRequest, inputCandles: readonly CashBacktestCandle[]): CashBacktestResult {
  validateCashBacktestRequest(request);
  const candles = [...inputCandles].filter((candle) => candle.isClosed && finite(candle.timestamp) && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 60) throw new BacktestMarketContractError('INSUFFICIENT_CANDLES', '현물 백테스트에는 완료 캔들이 최소 60개 필요합니다.');
  const signals = calculateCashSignals(request, candles);
  const signalMap = new Map(signals.map((signal) => [signal.index, signal.action]));
  const priority = request.intrabarPriority ?? 'stop_first';
  const strategyExitEnabled = numberParam(request, 'strategyExitEnabled', 1) >= 1;
  const entryOnNextOpen = numberParam(request, 'entryOnNextOpen', 0) >= 1;
  const executionAtrPeriod = Math.max(2, Math.trunc(numberParam(request, 'executionAtrPeriod', 14)));
  const stopAtrMultiplier = Math.max(0, numberParam(request, 'stopAtrMultiplier', 0));
  const minimumStopToCostRatio = Math.max(0, numberParam(request, 'minimumStopToCostRatio', 0));
  const executionAtr = atr(candles, executionAtrPeriod);
  const trades: CashBacktestTrade[] = [];
  let cash = request.initialCapital;
  let position: OpenCashPosition | null = null;
  let pendingEntry = false;
  let totalFees = 0;
  let totalSlippage = 0;
  let peak = cash;
  let maximumDrawdown = 0;
  let tradesToday = 0;
  let currentDay = '';

  const closePosition = (index: number, rawExitPrice: number, reason: CashBacktestTrade['exitReason']) => {
    if (!position) return;
    const exitPrice = rawExitPrice * (1 - request.slippageRate);
    const slippage = position.quantity * rawExitPrice * request.slippageRate;
    const gross = position.quantity * (exitPrice - position.entryPrice);
    const exitFee = position.quantity * exitPrice * request.exitFeeRate;
    const netPnl = gross - position.entryFee - exitFee;
    cash += position.quantity * exitPrice - exitFee;
    totalFees += exitFee;
    totalSlippage += slippage;
    const rMultiple = position.riskAmount > 0 ? netPnl / position.riskAmount : 0;
    trades.push({ entryTime: position.entryTime, exitTime: candles[index].timestamp, entryPrice: position.entryPrice, exitPrice, quantity: position.quantity, netPnl, rMultiple, exitReason: reason });
    position = null;
  };

  const openPosition = (index: number, rawEntryPrice: number) => {
    const entryPrice = rawEntryPrice * (1 + request.slippageRate);
    const atrValue = executionAtr[index];
    const percentStopDistance = entryPrice * (request.stopLossPercent / 100);
    const stopDistance = stopAtrMultiplier > 0 && atrValue != null && atrValue > 0 ? atrValue * stopAtrMultiplier : percentStopDistance;
    const rawStopPrice = entryPrice - stopDistance;
    if (!(rawStopPrice > 0)) return;
    const conservativeExitPrice = rawStopPrice * (1 - request.slippageRate);
    const entryFeePerUnit = entryPrice * request.entryFeeRate;
    const exitFeePerUnit = conservativeExitPrice * request.exitFeeRate;
    const executionCostPerUnit = rawStopPrice * request.slippageRate + entryFeePerUnit + exitFeePerUnit;
    if (minimumStopToCostRatio > 0 && executionCostPerUnit > 0 && stopDistance / executionCostPerUnit < minimumStopToCostRatio) return;
    const totalLossPerUnit = entryPrice - conservativeExitPrice + entryFeePerUnit + exitFeePerUnit;
    if (!(totalLossPerUnit > 0) || !finite(totalLossPerUnit)) return;
    const maximumRiskAmount = cash * (request.riskPercent / 100);
    const affordableQuantity = cash / (entryPrice * (1 + request.entryFeeRate));
    const riskQuantity = maximumRiskAmount / totalLossPerUnit;
    const quantity = Math.min(affordableQuantity, riskQuantity);
    if (!(quantity > 0) || !finite(quantity)) return;
    const entryFee = quantity * entryPrice * request.entryFeeRate;
    const cost = quantity * entryPrice + entryFee;
    cash -= cost;
    totalFees += entryFee;
    totalSlippage += quantity * rawEntryPrice * request.slippageRate;
    const initialRiskAmount = quantity * totalLossPerUnit;
    position = { entryTime: candles[index].timestamp, entryPrice, quantity, entryFee, riskAmount: initialRiskAmount, stop: rawStopPrice, target: entryPrice + stopDistance * request.takeProfitR };
    tradesToday += 1;
  };

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const day = new Date(candle.timestamp).toISOString().slice(0, 10);
    if (day !== currentDay) { currentDay = day; tradesToday = 0; }

    if (!position && pendingEntry) {
      if (tradesToday < request.maximumTradesPerDay) openPosition(index, candle.open);
      pendingEntry = false;
    }

    const activePosition = position as OpenCashPosition | null;
    if (activePosition) {
      const hitStop = candle.low <= activePosition.stop;
      const hitTarget = candle.high >= activePosition.target;
      if (hitStop && hitTarget) closePosition(index, priority === 'stop_first' ? activePosition.stop : activePosition.target, priority === 'stop_first' ? 'stop_loss' : 'take_profit');
      else if (hitStop) closePosition(index, activePosition.stop, 'stop_loss');
      else if (hitTarget) closePosition(index, activePosition.target, 'take_profit');
      else if (strategyExitEnabled && signalMap.get(index) === 'SELL') closePosition(index, candle.close, 'strategy_exit');
    }

    if (!position && !pendingEntry && signalMap.get(index) === 'BUY' && tradesToday < request.maximumTradesPerDay) {
      if (entryOnNextOpen) pendingEntry = true;
      else openPosition(index, candle.close);
    }

    const markedPosition = position as OpenCashPosition | null;
    const equity = cash + (markedPosition ? markedPosition.quantity * candle.close : 0);
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }

  if (position) closePosition(candles.length - 1, candles.at(-1)!.close, 'end_of_data');
  const winning = trades.filter((trade) => trade.netPnl > 0);
  const losing = trades.filter((trade) => trade.netPnl <= 0);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const grossProfit = winning.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losing.reduce((sum, trade) => sum + trade.netPnl, 0));
  const averageRMultiple = average(trades.map((trade) => trade.rMultiple));
  const warnings: string[] = [];
  if (numberParam(request, 'regimeFilterEnabled', 0) >= 1) warnings.push('완료된 1시간·4시간봉만 사용하는 market-regime 진입 필터를 적용했습니다.');
  if (!strategyExitEnabled) warnings.push('조기 전략청산을 끄고 손절·목표가·데이터 종료만으로 청산했습니다.');
  if (entryOnNextOpen) warnings.push('신호가 확정된 다음 완료 봉의 시가에 진입했습니다.');
  if (stopAtrMultiplier > 0) warnings.push(`ATR(${executionAtrPeriod}) × ${stopAtrMultiplier} 손절폭을 적용했습니다.`);
  warnings.push('수수료와 슬리피지를 포함한 총 손절 비용으로 수량과 R을 계산했습니다.');
  if (minimumStopToCostRatio > 0) warnings.push(`손절폭이 예상 체결 비용의 ${minimumStopToCostRatio}배 미만인 진입은 제외했습니다.`);
  if (!trades.length) warnings.push('조건을 충족한 매매가 없어 성과를 계산할 거래가 없습니다.');
  return {
    ok: true,
    mode: 'backtest-only',
    orderSubmitted: false,
    market: request.market,
    symbol: request.symbol,
    strategy: request.strategy,
    totalTrades: trades.length,
    winningTrades: winning.length,
    losingTrades: losing.length,
    winRate: trades.length ? winning.length / trades.length * 100 : 0,
    averageWinR: average(winning.map((trade) => trade.rMultiple)),
    averageLossR: average(losing.map((trade) => trade.rMultiple)),
    averageRMultiple,
    expectancy: averageRMultiple,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    initialCapital: request.initialCapital,
    finalCapital: cash,
    totalReturnPercent: (cash / request.initialCapital - 1) * 100,
    maximumDrawdown,
    maximumDrawdownPercent: peak > 0 ? maximumDrawdown / peak * 100 : 0,
    totalFees,
    totalSlippage,
    trades,
    warnings,
  };
}
