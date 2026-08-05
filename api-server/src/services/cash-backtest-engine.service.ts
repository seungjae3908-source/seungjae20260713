import type { SpotBacktestCandle } from './upbit-backtest-data.service';
import { BacktestMarketContractError, type BacktestMarket } from './backtest-market-profile.service';

export type CashBacktestStrategy = 'trend_pullback' | 'breakout' | 'vwap_reclaim';
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

function averageVolume(candles: readonly CashBacktestCandle[], period: number) {
  return candles.map((_candle, index) => {
    if (index < period) return null;
    const window = candles.slice(index - period, index);
    return window.reduce((sum, candle) => sum + candle.volume, 0) / period;
  });
}

function signalsFor(request: CashBacktestRequest, candles: readonly CashBacktestCandle[]): Signal[] {
  const closes = candles.map((candle) => candle.close);
  const volumePeriod = Math.max(2, Math.trunc(numberParam(request, 'volumePeriod', 20)));
  const volumeMultiplier = Math.max(0, numberParam(request, 'volumeMultiplier', 1));
  const volumes = averageVolume(candles, volumePeriod);
  const signals: Signal[] = [];

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
      if (fastNow > slowNow && candles[index - 1].close <= fastPrevious * (1 + tolerance) && candles[index].close > fastNow && volumeOk) signals.push({ index, action: 'BUY' });
      if (fastNow < slowNow || candles[index].close < fastNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'breakout') {
    const lookback = Math.max(2, Math.trunc(numberParam(request, 'lookback', 20)));
    for (let index = lookback; index < candles.length; index += 1) {
      const previous = candles.slice(index - lookback, index);
      const high = Math.max(...previous.map((candle) => candle.high));
      const low = Math.min(...previous.map((candle) => candle.low));
      const average = volumes[index];
      if (average == null) continue;
      if (candles[index].close > high && candles[index].volume >= average * volumeMultiplier) signals.push({ index, action: 'BUY' });
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
        if (candles[index - 1].close <= previousVwap && candle.close > currentVwap && candle.volume >= average * volumeMultiplier) signals.push({ index, action: 'BUY' });
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
}

export function runCashBacktest(request: CashBacktestRequest, inputCandles: readonly CashBacktestCandle[]): CashBacktestResult {
  validateCashBacktestRequest(request);
  const candles = [...inputCandles].filter((candle) => candle.isClosed && finite(candle.timestamp) && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 60) throw new BacktestMarketContractError('INSUFFICIENT_CANDLES', '현물 백테스트에는 완료 캔들이 최소 60개 필요합니다.');
  const signals = signalsFor(request, candles);
  const signalMap = new Map(signals.map((signal) => [signal.index, signal.action]));
  const priority = request.intrabarPriority ?? 'stop_first';
  const trades: CashBacktestTrade[] = [];
  let cash = request.initialCapital;
  let position: null | { entryTime: number; entryPrice: number; quantity: number; entryFee: number; riskAmount: number; stop: number; target: number } = null;
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

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const day = new Date(candle.timestamp).toISOString().slice(0, 10);
    if (day !== currentDay) { currentDay = day; tradesToday = 0; }

    if (position) {
      const hitStop = candle.low <= position.stop;
      const hitTarget = candle.high >= position.target;
      if (hitStop && hitTarget) closePosition(index, priority === 'stop_first' ? position.stop : position.target, priority === 'stop_first' ? 'stop_loss' : 'take_profit');
      else if (hitStop) closePosition(index, position.stop, 'stop_loss');
      else if (hitTarget) closePosition(index, position.target, 'take_profit');
      else if (signalMap.get(index) === 'SELL') closePosition(index, candle.close, 'strategy_exit');
    }

    if (!position && signalMap.get(index) === 'BUY' && tradesToday < request.maximumTradesPerDay) {
      const rawEntryPrice = candle.close;
      const entryPrice = rawEntryPrice * (1 + request.slippageRate);
      const stopDistance = entryPrice * (request.stopLossPercent / 100);
      const riskAmount = cash * (request.riskPercent / 100);
      const affordableQuantity = cash / (entryPrice * (1 + request.entryFeeRate));
      const riskQuantity = riskAmount / stopDistance;
      const quantity = Math.min(affordableQuantity, riskQuantity);
      if (quantity > 0 && finite(quantity)) {
        const entryFee = quantity * entryPrice * request.entryFeeRate;
        const cost = quantity * entryPrice + entryFee;
        cash -= cost;
        totalFees += entryFee;
        totalSlippage += quantity * rawEntryPrice * request.slippageRate;
        position = { entryTime: candle.timestamp, entryPrice, quantity, entryFee, riskAmount, stop: entryPrice - stopDistance, target: entryPrice + stopDistance * request.takeProfitR };
        tradesToday += 1;
      }
    }

    const equity = cash + (position ? position.quantity * candle.close : 0);
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
    warnings: trades.length ? [] : ['조건을 충족한 매매가 없어 성과를 계산할 거래가 없습니다.'],
  };
}
