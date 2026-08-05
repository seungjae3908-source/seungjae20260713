import type { SpotBacktestCandle } from './upbit-backtest-data.service';
import { BacktestMarketContractError, type BacktestMarket } from './backtest-market-profile.service';
import {
  calculateCashSignals,
  cashAtrSeries,
  supportsRegimeTimeframe,
  type CashSignalStrategy,
} from './cash-backtest-signals.service';

export type CashBacktestStrategy = CashSignalStrategy;
export { calculateCashSignals } from './cash-backtest-signals.service';

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

type OpenCashPosition = {
  entryTime: number;
  entryPrice: number;
  quantity: number;
  entryFee: number;
  riskAmount: number;
  stop: number;
  target: number;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberParam = (request: CashBacktestRequest, key: string, fallback: number) => finite(request.parameters?.[key]) ? request.parameters![key] : fallback;

export function validateCashBacktestRequest(request: CashBacktestRequest) {
  if (!['kr-stock', 'us-stock', 'crypto-spot'].includes(request.market)) {
    throw new BacktestMarketContractError('INVALID_CASH_MARKET', '현물 백테스트 시장이 올바르지 않습니다.');
  }
  if (!finite(request.initialCapital) || request.initialCapital <= 0) {
    throw new BacktestMarketContractError('INVALID_CAPITAL', '초기 자본은 0보다 커야 합니다.');
  }
  if (!finite(request.riskPercent) || request.riskPercent <= 0 || request.riskPercent > 1) {
    throw new BacktestMarketContractError('INVALID_RISK_PERCENT', '거래당 위험률은 0% 초과 1% 이하여야 합니다.');
  }
  if (![request.entryFeeRate, request.exitFeeRate, request.slippageRate].every((value) => finite(value) && value >= 0 && value < 1)) {
    throw new BacktestMarketContractError('INVALID_COST_RATE', '수수료와 슬리피지 비율이 올바르지 않습니다.');
  }
  if (!finite(request.stopLossPercent) || request.stopLossPercent <= 0 || request.stopLossPercent >= 100) {
    throw new BacktestMarketContractError('INVALID_STOP_LOSS', '손절률이 올바르지 않습니다.');
  }
  if (!finite(request.takeProfitR) || request.takeProfitR <= 0) {
    throw new BacktestMarketContractError('INVALID_TAKE_PROFIT', '목표 R 값이 올바르지 않습니다.');
  }
  if (!Number.isInteger(request.maximumTradesPerDay) || request.maximumTradesPerDay < 1 || request.maximumTradesPerDay > 100) {
    throw new BacktestMarketContractError('INVALID_DAILY_TRADES', '일일 거래 수 제한이 올바르지 않습니다.');
  }
  if (numberParam(request, 'regimeFilterEnabled', 0) >= 1 && !supportsRegimeTimeframe(request.timeframe)) {
    throw new BacktestMarketContractError('REGIME_FILTER_TIMEFRAME_UNSUPPORTED', '다중 시간봉 장세 필터는 1~30분봉에서만 지원합니다.');
  }
  const minimumEntryRsi = numberParam(request, 'minimumEntryRsi', 0);
  const maximumEntryRsi = numberParam(request, 'maximumEntryRsi', 100);
  if (minimumEntryRsi < 0 || maximumEntryRsi > 100 || minimumEntryRsi > maximumEntryRsi) {
    throw new BacktestMarketContractError('INVALID_RSI_RANGE', '진입 RSI 범위가 올바르지 않습니다.');
  }
  const oversoldRsi = numberParam(request, 'oversoldRsi', 40);
  const recoveryRsi = numberParam(request, 'recoveryRsi', 50);
  if (oversoldRsi < 0 || recoveryRsi > 100 || oversoldRsi > recoveryRsi) {
    throw new BacktestMarketContractError('INVALID_RSI_RECOVERY_RANGE', '과매도·회복 RSI 범위가 올바르지 않습니다.');
  }
  if (numberParam(request, 'stopAtrMultiplier', 0) < 0) {
    throw new BacktestMarketContractError('INVALID_ATR_STOP', 'ATR 손절 배수는 0 이상이어야 합니다.');
  }
  if (numberParam(request, 'minimumStopToCostRatio', 0) < 0) {
    throw new BacktestMarketContractError('INVALID_STOP_COST_RATIO', '손절폭 대비 비용 비율은 0 이상이어야 합니다.');
  }
}

export function runCashBacktest(request: CashBacktestRequest, inputCandles: readonly CashBacktestCandle[]): CashBacktestResult {
  validateCashBacktestRequest(request);
  const candles = [...inputCandles]
    .filter((candle) => candle.isClosed && finite(candle.timestamp) && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length < 60) {
    throw new BacktestMarketContractError('INSUFFICIENT_CANDLES', '현물 백테스트에는 완료 캔들이 최소 60개 필요합니다.');
  }

  const signals = calculateCashSignals(request, candles);
  const signalMap = new Map(signals.map((signal) => [signal.index, signal.action]));
  const priority = request.intrabarPriority ?? 'stop_first';
  const strategyExitEnabled = numberParam(request, 'strategyExitEnabled', 1) >= 1;
  const entryOnNextOpen = numberParam(request, 'entryOnNextOpen', 0) >= 1;
  const executionAtrPeriod = Math.max(2, Math.trunc(numberParam(request, 'executionAtrPeriod', 14)));
  const stopAtrMultiplier = Math.max(0, numberParam(request, 'stopAtrMultiplier', 0));
  const minimumStopToCostRatio = Math.max(0, numberParam(request, 'minimumStopToCostRatio', 0));
  const executionAtr = cashAtrSeries(candles, executionAtrPeriod);
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
    trades.push({
      entryTime: position.entryTime,
      exitTime: candles[index].timestamp,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      netPnl,
      rMultiple,
      exitReason: reason,
    });
    position = null;
  };

  const openPosition = (index: number, rawEntryPrice: number) => {
    const entryPrice = rawEntryPrice * (1 + request.slippageRate);
    const atrValue = executionAtr[index];
    const percentStopDistance = entryPrice * (request.stopLossPercent / 100);
    const stopDistance = stopAtrMultiplier > 0 && atrValue != null && atrValue > 0
      ? atrValue * stopAtrMultiplier
      : percentStopDistance;
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
    position = {
      entryTime: candles[index].timestamp,
      entryPrice,
      quantity,
      entryFee,
      riskAmount: initialRiskAmount,
      stop: rawStopPrice,
      target: entryPrice + stopDistance * request.takeProfitR,
    };
    tradesToday += 1;
  };

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const day = new Date(candle.timestamp).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      tradesToday = 0;
    }

    if (!position && pendingEntry) {
      if (tradesToday < request.maximumTradesPerDay) openPosition(index, candle.open);
      pendingEntry = false;
    }

    const activePosition = position as OpenCashPosition | null;
    if (activePosition) {
      const hitStop = candle.low <= activePosition.stop;
      const hitTarget = candle.high >= activePosition.target;
      if (hitStop && hitTarget) {
        closePosition(
          index,
          priority === 'stop_first' ? activePosition.stop : activePosition.target,
          priority === 'stop_first' ? 'stop_loss' : 'take_profit',
        );
      } else if (hitStop) {
        closePosition(index, activePosition.stop, 'stop_loss');
      } else if (hitTarget) {
        closePosition(index, activePosition.target, 'take_profit');
      } else if (strategyExitEnabled && signalMap.get(index) === 'SELL') {
        closePosition(index, candle.close, 'strategy_exit');
      }
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
  const average = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
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
