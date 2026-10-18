import type { NormalizedCandle } from './futures-market-data.service';
import type { BacktestPaperHandoff } from '../../../packages/strategy-hypothesis/src/backtest-paper-handoff.js';
import {
  atrSeries,
  averageVolumeSeries,
  emaSeries,
  rollingHighestSeries,
  rollingLowestSeries,
  sanitizeClosedCandles,
  utcSessionVwapSeries,
} from './backtest-indicators.service';
import { calculateTradingRisk } from './trading-risk-engine.service';

export type BacktestMarket = 'kr-stock' | 'us-stock' | 'crypto-spot' | 'crypto-futures';
export type BacktestSide = 'long' | 'short' | 'both';
export type BacktestStrategyType =
  | 'trend_pullback'
  | 'breakout'
  | 'vwap_reclaim'
  | 'volume_breakout'
  | 'multi_timeframe_trend'
  | 'support_resistance_bounce';
export type IntrabarPriority = 'stop_first' | 'target_first';
export type BacktestMarketRegime = 'uptrend' | 'downtrend' | 'ranging' | 'volatility_expansion' | 'insufficient';
export type BacktestValidationSplit = { trainingPercent: number; validationPercent: number; testPercent: number };
export type BacktestRequest = {
  market: BacktestMarket; symbol: string; timeframe: string; startTime: number; endTime: number;
  initialCapital: number; strategy: BacktestStrategyType; side: BacktestSide;
  parameters: Record<string, number | boolean>; riskPercent: number; leverage: number;
  entryFeeRate: number; exitFeeRate: number; slippageRate: number;
  fundingRatePerInterval?: number; fundingIntervalHours?: number;
  stopLossMode: 'percent' | 'atr' | 'swing'; stopLossValue: number;
  takeProfitMode: 'risk_multiple' | 'percent'; takeProfitValue: number;
  trailingStop?: { enabled: boolean; activationR?: number; distanceR?: number };
  maximumConcurrentPositions: number; maximumTradesPerDay: number;
  intrabarPriority?: IntrabarPriority; validationSplit?: BacktestValidationSplit;
  quantityStep?: number | null; quantityPrecision?: number | null;
  minimumQuantity?: number | null; minimumNotional?: number | null;
  maximumLeverage?: number | null;
  contractRulesStatus?: 'live' | 'delayed' | 'cached' | 'disconnected' | 'error' | 'insufficient';
};
export type BacktestTrade = {
  id: string; symbol: string; side: 'long' | 'short'; signalTime: number; entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number; stopLossPrice: number; takeProfitPrice: number;
  quantity: number; leverage: number; notionalValue: number; grossPnl: number;
  entryFee: number; exitFee: number; slippageCost: number; fundingCost: number; netPnl: number;
  pnlPercent: number; rMultiple: number; maximumFavorableExcursion: number; maximumAdverseExcursion: number;
  exitReason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'strategy_exit' | 'end_of_data'; marketRegime: string;
};
export type BacktestEquityPoint = { timestamp: number; equity: number };
export type BacktestDrawdownPoint = { timestamp: number; equity: number; runningPeak: number; drawdown: number; drawdownPercent: number };
export type BacktestMonthlyPerformance = { month: string; trades: number; netPnl: number; returnPercent: number };
export type BacktestRegimePerformance = { regime: string; trades: number; netPnl: number; winRate: number };
export type BacktestPerformanceSlice = { trades: number; wins: number; losses: number; winRate: number; netPnl: number; averageRMultiple: number; expectancy: number; profitFactor: number | null };
export type BacktestSegmentPerformance = BacktestPerformanceSlice & { name: 'training' | 'validation' | 'test'; startTime: number; endTime: number; maximumDrawdown: number; maximumDrawdownPercent: number };
export type BacktestWalkForwardWindow = { startTime: number; endTime: number; totalTrades: number; netPnl: number; maximumDrawdown: number; expectancy: number };
export type BacktestResult = {
  paperHandoffRunId?: string;
  paperHandoffs?: readonly BacktestPaperHandoff[];
  ok: true; mode: 'backtest-only'; orderSubmitted: false; market: BacktestMarket; symbol: string; timeframe: string; strategy: BacktestStrategyType;
  startTime: number; endTime: number; initialCapital: number; finalCapital: number; totalReturnPercent: number;
  annualizedReturnPercent: number | null; totalTrades: number; winningTrades: number; losingTrades: number; winRate: number;
  averageWin: number; averageLoss: number; averageRMultiple: number; expectancy: number; profitFactor: number | null;
  maximumDrawdown: number; maximumDrawdownPercent: number;
  /** Peak-to-trough including unrealized loss of open positions at each bar's adverse extreme (the realized-only figure above understates risk). */
  markedMaximumDrawdown: number; markedMaximumDrawdownPercent: number; maximumConsecutiveWins: number; maximumConsecutiveLosses: number;
  sharpeRatio: number | null; sortinoRatio: number | null; calmarRatio: number | null;
  totalFees: number; totalSlippage: number; totalFunding: number;
  longPerformance: BacktestPerformanceSlice; shortPerformance: BacktestPerformanceSlice;
  monthlyPerformance: BacktestMonthlyPerformance[]; regimePerformance: BacktestRegimePerformance[];
  /** Filled by the route from the member's recent runs of the same strategy on the same symbol. */
  selectionBias?: BacktestSelectionBias;
  validationPerformance: BacktestSegmentPerformance[]; walkForward: BacktestWalkForwardWindow[];
  equityCurve: BacktestEquityPoint[]; drawdownCurve: BacktestDrawdownPoint[]; trades: BacktestTrade[];
  warnings: string[]; calculatedAt: string;
};
type Signal = { index: number; side: 'long' | 'short'; regime: BacktestMarketRegime };
type OpenPosition = {
  id: string; side: 'long' | 'short'; signalTime: number; entryTime: number; rawEntryPrice: number; entryPrice: number;
  stopLossPrice: number; activeStopPrice: number; takeProfitPrice: number; quantity: number; leverage: number;
  notionalValue: number; entryFee: number; initialRiskAmount: number; marketRegime: BacktestMarketRegime;
  maximumFavorableExcursion: number; maximumAdverseExcursion: number; pendingStrategyExit: boolean;
};
export class BacktestValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BacktestValidationError'; }
}
export const BACKTEST_LIMITS = Object.freeze({ minimumCandles: 60, maximumCandles: 20_000, maximumDurationMs: 366 * 24 * 60 * 60_000, maximumConcurrentPositions: 5, maximumTradesPerDay: 100, maximumLeverage: 7 });
const IMPLEMENTED_STRATEGIES = new Set<BacktestStrategyType>(['trend_pullback', 'breakout', 'vwap_reclaim']);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const parameterNumber = (parameters: Record<string, number | boolean>, key: string, fallback: number) => typeof parameters[key] === 'number' && Number.isFinite(parameters[key]) ? parameters[key] as number : fallback;
const parameterBoolean = (parameters: Record<string, number | boolean>, key: string, fallback: boolean) => typeof parameters[key] === 'boolean' ? parameters[key] as boolean : fallback;

export function validateBacktestRequest(request: BacktestRequest) {
  const markets = new Set<BacktestMarket>(['kr-stock', 'us-stock', 'crypto-spot', 'crypto-futures']);
  if (!markets.has(request.market)) throw new BacktestValidationError('INVALID_MARKET', '지원하지 않는 시장입니다.');
  if (request.market === 'kr-stock' && !/^\d{6}$/u.test(request.symbol)) {
    throw new BacktestValidationError('INVALID_SYMBOL', '국내주식 종목코드는 6자리여야 합니다.');
  }
  if (request.market === 'us-stock' && !/^[A-Z0-9.-]{1,16}$/u.test(request.symbol)) {
    throw new BacktestValidationError('INVALID_SYMBOL', '미국주식 종목 형식이 올바르지 않습니다.');
  }
  if (request.market === 'crypto-spot' && !/^(?:KRW-)?[A-Z0-9]{1,20}$/u.test(request.symbol)) {
    throw new BacktestValidationError('INVALID_SYMBOL', '코인현물 종목 형식이 올바르지 않습니다.');
  }
  if (request.market === 'crypto-futures' && !/^[A-Z0-9]{2,16}USDT$/u.test(request.symbol)) {
    throw new BacktestValidationError('INVALID_SYMBOL', '코인선물 종목 형식이 올바르지 않습니다.');
  }
  if (!IMPLEMENTED_STRATEGIES.has(request.strategy)) throw new BacktestValidationError('UNSUPPORTED_STRATEGY', '지원하지 않는 전략입니다.');
  if (!['long', 'short', 'both'].includes(request.side)) throw new BacktestValidationError('INVALID_SIDE', '백테스트 방향이 올바르지 않습니다.');
  if (request.market !== 'crypto-futures' && request.side !== 'long') {
    throw new BacktestValidationError('LONG_ONLY_MARKET', '국내주식·미국주식·코인현물은 매수 전략만 지원합니다.');
  }
  if (!finite(request.startTime) || !finite(request.endTime) || request.startTime >= request.endTime) throw new BacktestValidationError('INVALID_PERIOD', '백테스트 기간이 올바르지 않습니다.');
  if (request.endTime - request.startTime > BACKTEST_LIMITS.maximumDurationMs) throw new BacktestValidationError('PERIOD_LIMIT_EXCEEDED', '백테스트 기간 상한을 초과했습니다.');
  if (!finite(request.initialCapital) || request.initialCapital <= 0) throw new BacktestValidationError('INVALID_CAPITAL', '초기 자본은 0보다 커야 합니다.');
  if (!finite(request.riskPercent) || request.riskPercent <= 0 || request.riskPercent > 1) throw new BacktestValidationError('INVALID_RISK_PERCENT', '거래당 위험률은 0% 초과 1% 이하여야 합니다.');
  const maximumLeverage = request.market === 'crypto-futures' ? BACKTEST_LIMITS.maximumLeverage : 1;
  if (!finite(request.leverage) || request.leverage < 1 || request.leverage > maximumLeverage) {
    throw new BacktestValidationError('INVALID_LEVERAGE', request.market === 'crypto-futures' ? '코인선물 레버리지는 1~7배만 지원합니다.' : '현물·주식 백테스트는 1배만 지원합니다.');
  }
  for (const rate of [request.entryFeeRate, request.exitFeeRate, request.slippageRate]) if (!finite(rate) || rate < 0 || rate >= 1) throw new BacktestValidationError('INVALID_COST_RATE', '수수료와 슬리피지 비율이 올바르지 않습니다.');
  if (!finite(request.stopLossValue) || request.stopLossValue <= 0) throw new BacktestValidationError('INVALID_STOP_LOSS', '손절 값은 0보다 커야 합니다.');
  if (!finite(request.takeProfitValue) || request.takeProfitValue <= 0) throw new BacktestValidationError('INVALID_TAKE_PROFIT', '목표 값은 0보다 커야 합니다.');
  if (!Number.isInteger(request.maximumConcurrentPositions) || request.maximumConcurrentPositions < 1 || request.maximumConcurrentPositions > BACKTEST_LIMITS.maximumConcurrentPositions) throw new BacktestValidationError('INVALID_CONCURRENCY', '동시 포지션 수 제한이 올바르지 않습니다.');
  if (!Number.isInteger(request.maximumTradesPerDay) || request.maximumTradesPerDay < 1 || request.maximumTradesPerDay > BACKTEST_LIMITS.maximumTradesPerDay) throw new BacktestValidationError('INVALID_DAILY_TRADES', '일일 거래 수 제한이 올바르지 않습니다.');
  const delay = request.parameters?.entryDelayBars; if (delay !== undefined && (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 5)) throw new BacktestValidationError('INVALID_ENTRY_DELAY', '주문 지연은 0~5봉의 정수만 지원합니다.');
  const split = request.validationSplit ?? { trainingPercent: 60, validationPercent: 20, testPercent: 20 };
  const total = split.trainingPercent + split.validationPercent + split.testPercent;
  if ([split.trainingPercent, split.validationPercent, split.testPercent].some((value) => !finite(value) || value <= 0) || Math.abs(total - 100) > 1e-9) throw new BacktestValidationError('INVALID_VALIDATION_SPLIT', '학습·검증·테스트 비율의 합은 100이어야 합니다.');
}
function sideAllowed(requestSide: BacktestSide, side: 'long' | 'short') { return requestSide === 'both' || requestSide === side; }
function classifyRegimes(candles: readonly NormalizedCandle[]): BacktestMarketRegime[] {
  const closes = candles.map((candle) => candle.close); const fast = emaSeries(closes, 20); const slow = emaSeries(closes, 50); const atr = atrSeries(candles, 14);
  const atrAverage = atr.map((value, index) => { if (value == null || index < 33) return null; const window = atr.slice(index - 19, index + 1).filter((item): item is number => item != null); return window.length === 20 ? window.reduce((sum, item) => sum + item, 0) / window.length : null; });
  return candles.map((_candle, index) => { const fastValue = fast[index]; const slowValue = slow[index]; const atrValue = atr[index]; const averageAtr = atrAverage[index]; if (fastValue == null || slowValue == null || atrValue == null) return 'insufficient'; if (averageAtr != null && averageAtr > 0 && atrValue / averageAtr >= 1.5) return 'volatility_expansion'; const slope = index > 0 && fast[index - 1] != null ? fastValue - (fast[index - 1] ?? fastValue) : 0; if (fastValue > slowValue && slope >= 0) return 'uptrend'; if (fastValue < slowValue && slope <= 0) return 'downtrend'; return 'ranging'; });
}
export function calculateStrategySignals(request: BacktestRequest, candles: readonly NormalizedCandle[]): Signal[] {
  const closes = candles.map((candle) => candle.close); const highs = candles.map((candle) => candle.high); const lows = candles.map((candle) => candle.low); const regimes = classifyRegimes(candles); const signals: Signal[] = [];
  const volumePeriod = Math.max(2, Math.trunc(parameterNumber(request.parameters, 'volumePeriod', 20))); const volumeMultiplier = Math.max(0, parameterNumber(request.parameters, 'volumeMultiplier', 1)); const averageVolume = averageVolumeSeries(candles, volumePeriod);
  if (request.strategy === 'trend_pullback') {
    const fastPeriod = Math.max(2, Math.trunc(parameterNumber(request.parameters, 'fastPeriod', 20))); const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(parameterNumber(request.parameters, 'slowPeriod', 50))); const tolerance = Math.max(0, parameterNumber(request.parameters, 'pullbackTolerancePercent', 0.5)) / 100; const fast = emaSeries(closes, fastPeriod); const slow = emaSeries(closes, slowPeriod);
    for (let index = 1; index < candles.length; index += 1) { const fastNow = fast[index]; const slowNow = slow[index]; const fastPrevious = fast[index - 1]; const average = averageVolume[index]; if (fastNow == null || slowNow == null || fastPrevious == null || average == null) continue; const volumeOk = candles[index].volume >= average * volumeMultiplier; const longSignal = fastNow > slowNow && candles[index - 1].close <= fastPrevious * (1 + tolerance) && candles[index].close > fastNow && volumeOk; const shortSignal = fastNow < slowNow && candles[index - 1].close >= fastPrevious * (1 - tolerance) && candles[index].close < fastNow && volumeOk; if (longSignal && sideAllowed(request.side, 'long')) signals.push({ index, side: 'long', regime: regimes[index] }); if (shortSignal && sideAllowed(request.side, 'short')) signals.push({ index, side: 'short', regime: regimes[index] }); }
  }
  if (request.strategy === 'breakout') {
    const lookback = Math.max(2, Math.trunc(parameterNumber(request.parameters, 'lookback', 20))); const previousHigh = rollingHighestSeries(highs, lookback, { excludeCurrent: true }); const previousLow = rollingLowestSeries(lows, lookback, { excludeCurrent: true });
    for (let index = 0; index < candles.length; index += 1) { const highBoundary = previousHigh[index]; const lowBoundary = previousLow[index]; const average = averageVolume[index]; if (highBoundary == null || lowBoundary == null || average == null) continue; const volumeOk = candles[index].volume >= average * volumeMultiplier; if (candles[index].close > highBoundary && volumeOk && sideAllowed(request.side, 'long')) signals.push({ index, side: 'long', regime: regimes[index] }); if (candles[index].close < lowBoundary && volumeOk && sideAllowed(request.side, 'short')) signals.push({ index, side: 'short', regime: regimes[index] }); }
  }
  if (request.strategy === 'vwap_reclaim') {
    const vwap = utcSessionVwapSeries(candles);
    for (let index = 1; index < candles.length; index += 1) { const currentVwap = vwap[index]; const previousVwap = vwap[index - 1]; const average = averageVolume[index]; if (currentVwap == null || previousVwap == null || average == null) continue; const volumeOk = candles[index].volume >= average * volumeMultiplier; if (candles[index - 1].close <= previousVwap && candles[index].close > currentVwap && volumeOk && sideAllowed(request.side, 'long')) signals.push({ index, side: 'long', regime: regimes[index] }); if (candles[index - 1].close >= previousVwap && candles[index].close < currentVwap && volumeOk && sideAllowed(request.side, 'short')) signals.push({ index, side: 'short', regime: regimes[index] }); }
  }
  return signals;
}
function stopPriceFor(request: BacktestRequest, candles: readonly NormalizedCandle[], signalIndex: number, side: 'long' | 'short', entryPrice: number, atr: Array<number | null>) {
  if (request.stopLossMode === 'percent') { const distance = entryPrice * request.stopLossValue / 100; return side === 'long' ? entryPrice - distance : entryPrice + distance; }
  if (request.stopLossMode === 'atr') { const value = atr[signalIndex]; if (value == null || !(value > 0)) return null; const distance = value * request.stopLossValue; return side === 'long' ? entryPrice - distance : entryPrice + distance; }
  const lookback = Math.max(2, Math.trunc(parameterNumber(request.parameters, 'swingLookback', 5))); const start = Math.max(0, signalIndex - lookback + 1); const window = candles.slice(start, signalIndex + 1); if (window.length < 2) return null; return side === 'long' ? Math.min(...window.map((candle) => candle.low)) : Math.max(...window.map((candle) => candle.high));
}
function targetPriceFor(request: BacktestRequest, side: 'long' | 'short', entryPrice: number, stopPrice: number) { if (request.takeProfitMode === 'percent') { const distance = entryPrice * request.takeProfitValue / 100; return side === 'long' ? entryPrice + distance : entryPrice - distance; } const distance = Math.abs(entryPrice - stopPrice) * request.takeProfitValue; return side === 'long' ? entryPrice + distance : entryPrice - distance; }
const adverseEntryPrice = (open: number, side: 'long' | 'short', rate: number) => side === 'long' ? open * (1 + rate) : open * (1 - rate);
const adverseExitPrice = (raw: number, side: 'long' | 'short', rate: number) => side === 'long' ? raw * (1 - rate) : raw * (1 + rate);
const utcDay = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
const TIMEFRAME_BAR_MS: Readonly<Record<string, number>> = Object.freeze({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '60m': 3_600_000, '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000 });
/**
 * Number of funding settlements (epoch-aligned every fundingIntervalHours, i.e. 00/08/16 UTC for 8h) a position was held through.
 * A fill at the bar open is not charged for a settlement at that instant. Stop/target/end-of-data exits happen somewhere inside
 * the exit bar, so the whole bar is assumed held (conservative); a strategy exit fills at the bar open.
 */
export function fundingSettlementsHeld(entryTime: number, exitTime: number, reason: BacktestTrade['exitReason'], request: Pick<BacktestRequest, 'timeframe' | 'fundingIntervalHours'>): number {
  const intervalHours = request.fundingIntervalHours ?? 8; if (!(intervalHours > 0)) return 0;
  const intervalMs = intervalHours * 3_600_000; const barMs = TIMEFRAME_BAR_MS[request.timeframe] ?? 0;
  const heldUntil = reason === 'strategy_exit' ? exitTime : exitTime + Math.max(0, barMs - 1);
  return Math.max(0, Math.floor(heldUntil / intervalMs) - Math.floor(entryTime / intervalMs));
}
function exitPosition(position: OpenPosition, rawExitPrice: number, exitTime: number, reason: BacktestTrade['exitReason'], request: BacktestRequest): BacktestTrade {
  const exitPrice = adverseExitPrice(rawExitPrice, position.side, request.slippageRate); const rawGrossPnl = position.side === 'long' ? (rawExitPrice - position.rawEntryPrice) * position.quantity : (position.rawEntryPrice - rawExitPrice) * position.quantity; const filledGrossPnl = position.side === 'long' ? (exitPrice - position.entryPrice) * position.quantity : (position.entryPrice - exitPrice) * position.quantity; const slippageCost = Math.max(0, rawGrossPnl - filledGrossPnl); const exitFee = exitPrice * position.quantity * request.exitFeeRate; const intervals = request.market === 'crypto-futures' ? fundingSettlementsHeld(position.entryTime, exitTime, reason, request) : 0; const fundingRate = request.market === 'crypto-futures' ? request.fundingRatePerInterval ?? 0 : 0; const fundingCost = position.notionalValue * fundingRate * intervals * (position.side === 'long' ? 1 : -1); const netPnl = rawGrossPnl - position.entryFee - exitFee - slippageCost - fundingCost;
  return { id: position.id, symbol: request.symbol, side: position.side, signalTime: position.signalTime, entryTime: position.entryTime, exitTime, entryPrice: position.entryPrice, exitPrice, stopLossPrice: position.stopLossPrice, takeProfitPrice: position.takeProfitPrice, quantity: position.quantity, leverage: position.leverage, notionalValue: position.notionalValue, grossPnl: rawGrossPnl, entryFee: position.entryFee, exitFee, slippageCost, fundingCost, netPnl, pnlPercent: position.notionalValue > 0 ? netPnl / position.notionalValue * 100 : 0, rMultiple: position.initialRiskAmount > 0 ? netPnl / position.initialRiskAmount : 0, maximumFavorableExcursion: position.maximumFavorableExcursion, maximumAdverseExcursion: position.maximumAdverseExcursion, exitReason: reason, marketRegime: position.marketRegime };
}
function performanceSlice(trades: readonly BacktestTrade[]): BacktestPerformanceSlice { const wins = trades.filter((trade) => trade.netPnl > 0); const losses = trades.filter((trade) => trade.netPnl < 0); const grossWins = wins.reduce((sum, trade) => sum + trade.netPnl, 0); const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0)); return { trades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0), averageRMultiple: trades.length ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / trades.length : 0, expectancy: trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0, profitFactor: grossLosses > 0 ? grossWins / grossLosses : null }; }
function drawdowns(initialCapital: number, trades: readonly BacktestTrade[]) { let equity = initialCapital; let peak = initialCapital; const equityCurve: BacktestEquityPoint[] = [{ timestamp: trades[0]?.entryTime ?? 0, equity }]; const drawdownCurve: BacktestDrawdownPoint[] = []; let maximumDrawdown = 0; let maximumDrawdownPercent = 0; for (const trade of trades) { equity += trade.netPnl; peak = Math.max(peak, equity); const drawdown = Math.max(0, peak - equity); const drawdownPercent = peak > 0 ? drawdown / peak * 100 : 0; maximumDrawdown = Math.max(maximumDrawdown, drawdown); maximumDrawdownPercent = Math.max(maximumDrawdownPercent, drawdownPercent); equityCurve.push({ timestamp: trade.exitTime, equity }); drawdownCurve.push({ timestamp: trade.exitTime, equity, runningPeak: peak, drawdown, drawdownPercent }); } return { equity, equityCurve, drawdownCurve, maximumDrawdown, maximumDrawdownPercent }; }
function dailyReturns(initialCapital: number, trades: readonly BacktestTrade[], window?: { readonly startTime: number; readonly endTime: number; readonly market: BacktestMarket }) { const pnlByDay = new Map<string, number>(); for (const trade of trades) pnlByDay.set(utcDay(trade.exitTime), (pnlByDay.get(utcDay(trade.exitTime)) ?? 0) + trade.netPnl); const days = new Set(pnlByDay.keys()); const isStock = window?.market === 'kr-stock' || window?.market === 'us-stock'; if (window && Number.isFinite(window.startTime) && Number.isFinite(window.endTime) && window.endTime > window.startTime) { for (let t = Math.floor(window.startTime / 86_400_000) * 86_400_000; t <= window.endTime; t += 86_400_000) { const weekday = new Date(t).getUTCDay(); if (!isStock || (weekday !== 0 && weekday !== 6)) days.add(utcDay(t)); } } let equity = initialCapital; const returns: number[] = []; for (const day of [...days].sort()) { const pnl = pnlByDay.get(day) ?? 0; returns.push(equity > 0 ? pnl / equity : 0); equity += pnl; } return returns; }
function ratioStatistics(initialCapital: number, trades: readonly BacktestTrade[], window?: { readonly startTime: number; readonly endTime: number; readonly market: BacktestMarket }) { const returns = dailyReturns(initialCapital, trades, window); const periodsPerYear = window?.market === 'kr-stock' || window?.market === 'us-stock' ? 252 : 365; if (returns.length < 5) return { sharpe: null, sortino: null }; const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length; const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1); const deviation = Math.sqrt(Math.max(0, variance)); const downside = returns.filter((value) => value < 0); const downsideDeviation = downside.length ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length) : 0; return { sharpe: deviation > 0 ? mean / deviation * Math.sqrt(periodsPerYear) : null, sortino: downsideDeviation > 0 ? mean / downsideDeviation * Math.sqrt(periodsPerYear) : null }; }
function consecutiveCounts(trades: readonly BacktestTrade[]) { let wins = 0; let losses = 0; let maxWins = 0; let maxLosses = 0; for (const trade of trades) { if (trade.netPnl > 0) { wins += 1; losses = 0; } else if (trade.netPnl < 0) { losses += 1; wins = 0; } else { wins = 0; losses = 0; } maxWins = Math.max(maxWins, wins); maxLosses = Math.max(maxLosses, losses); } return { maxWins, maxLosses }; }
function validationSegments(request: BacktestRequest, trades: readonly BacktestTrade[]): BacktestSegmentPerformance[] { const split = request.validationSplit ?? { trainingPercent: 60, validationPercent: 20, testPercent: 20 }; const duration = request.endTime - request.startTime; const trainingEnd = request.startTime + duration * split.trainingPercent / 100; const validationEnd = trainingEnd + duration * split.validationPercent / 100; const ranges: Array<{ name: BacktestSegmentPerformance['name']; startTime: number; endTime: number }> = [{ name: 'training', startTime: request.startTime, endTime: trainingEnd }, { name: 'validation', startTime: trainingEnd, endTime: validationEnd }, { name: 'test', startTime: validationEnd, endTime: request.endTime }]; return ranges.map((range) => { const selected = trades.filter((trade) => trade.entryTime >= range.startTime && trade.entryTime < range.endTime); const slice = performanceSlice(selected); const dd = drawdowns(request.initialCapital, selected); return { ...slice, ...range, maximumDrawdown: dd.maximumDrawdown, maximumDrawdownPercent: dd.maximumDrawdownPercent }; }); }
function walkForwardWindows(request: BacktestRequest, trades: readonly BacktestTrade[]) { const totalDuration = request.endTime - request.startTime; const windowDuration = totalDuration / 3; if (!(windowDuration > 0)) return []; const result: BacktestWalkForwardWindow[] = []; for (let index = 0; index < 3; index += 1) { const startTime = request.startTime + windowDuration * index; const endTime = index === 2 ? request.endTime : startTime + windowDuration; const selected = trades.filter((trade) => trade.entryTime >= startTime && trade.entryTime < endTime); const slice = performanceSlice(selected); const dd = drawdowns(request.initialCapital, selected); result.push({ startTime, endTime, totalTrades: selected.length, netPnl: slice.netPnl, maximumDrawdown: dd.maximumDrawdown, expectancy: slice.expectancy }); } return result; }

export function runBacktest(request: BacktestRequest, rawCandles: readonly NormalizedCandle[], now = new Date()): BacktestResult {
  validateBacktestRequest(request); const sanitized = sanitizeClosedCandles(rawCandles); const identityMismatches = sanitized.data.filter((candle) => candle.market !== request.market || candle.symbol !== request.symbol); if (identityMismatches.length) throw new BacktestValidationError('CANDLE_IDENTITY_MISMATCH', '시장·종목이 다른 캔들이 섞여 있어 실행을 중단했습니다.'); const candles = sanitized.data.filter((candle) => candle.timestamp >= request.startTime && candle.timestamp <= request.endTime); if (candles.length < BACKTEST_LIMITS.minimumCandles) throw new BacktestValidationError('INSUFFICIENT_CANDLES', `최소 ${BACKTEST_LIMITS.minimumCandles}개의 완료 캔들이 필요합니다.`); if (candles.length > BACKTEST_LIMITS.maximumCandles) throw new BacktestValidationError('CANDLE_LIMIT_EXCEEDED', '백테스트 최대 캔들 수를 초과했습니다.');
  const warnings = [...sanitized.warnings]; const priority = request.intrabarPriority ?? 'stop_first'; warnings.push(priority === 'stop_first' ? '같은 봉에서 손절과 목표가가 모두 닿으면 손절을 우선합니다.' : '같은 봉에서 손절과 목표가가 모두 닿으면 목표가를 우선합니다.', '실현 손익 기준 자산곡선입니다.', '보유 중 평가손실을 포함한 최대낙폭은 markedMaximumDrawdown을 보세요.', '일별 실현수익률로 위험조정 지표를 계산합니다.', '협정세계시 기준 하루 단위 거래량가중평균가를 사용합니다.'); if (request.market === 'crypto-futures') warnings.push('펀딩비는 실제 정산 시각(UTC 기준 간격 배수)을 지난 횟수에 고정 비율을 곱해 계산합니다. 시점별 실제 펀딩 이력은 반영하지 않습니다.');
  const signals = calculateStrategySignals(request, candles); const signalsByIndex = new Map<number, Signal[]>(); for (const signal of signals) signalsByIndex.set(signal.index, [...(signalsByIndex.get(signal.index) ?? []), signal]); const atr = atrSeries(candles, 14); const openPositions: OpenPosition[] = []; const trades: BacktestTrade[] = []; const tradesPerDay = new Map<string, number>(); let equity = request.initialCapital; let tradeSequence = 0; const entryDelayBars = Math.min(5, Math.max(0, Math.trunc(parameterNumber(request.parameters, 'entryDelayBars', 0)))); if (entryDelayBars > 0) warnings.push(`주문 지연 ${entryDelayBars}봉을 반영해 신호 봉 이후 ${entryDelayBars + 1}번째 봉 시가에 진입합니다.`); let markedPeak = request.initialCapital; let markedMaximumDrawdown = 0; let markedMaximumDrawdownPercent = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    for (let positionIndex = openPositions.length - 1; positionIndex >= 0; positionIndex -= 1) {
      const position = openPositions[positionIndex]; const favorableMove = position.side === 'long' ? candle.high - position.entryPrice : position.entryPrice - candle.low; const adverseMove = position.side === 'long' ? position.entryPrice - candle.low : candle.high - position.entryPrice; position.maximumFavorableExcursion = Math.max(position.maximumFavorableExcursion, favorableMove * position.quantity); position.maximumAdverseExcursion = Math.max(position.maximumAdverseExcursion, adverseMove * position.quantity); let rawExit: number | null = null; let reason: BacktestTrade['exitReason'] | null = null;
      if (position.pendingStrategyExit) { rawExit = candle.open; reason = 'strategy_exit'; } else { const stopTouched = position.side === 'long' ? candle.low <= position.activeStopPrice : candle.high >= position.activeStopPrice; const targetTouched = position.side === 'long' ? candle.high >= position.takeProfitPrice : candle.low <= position.takeProfitPrice; /* a bar that opens through the stop (overnight/weekend gap) fills at the open, never at the better stop price */ const stopFill = position.side === 'long' ? Math.min(position.activeStopPrice, candle.open) : Math.max(position.activeStopPrice, candle.open); if (stopTouched && targetTouched) { const stopFirst = priority === 'stop_first'; rawExit = stopFirst ? stopFill : position.takeProfitPrice; reason = stopFirst ? (position.activeStopPrice === position.stopLossPrice ? 'stop_loss' : 'trailing_stop') : 'take_profit'; } else if (stopTouched) { rawExit = stopFill; reason = position.activeStopPrice === position.stopLossPrice ? 'stop_loss' : 'trailing_stop'; } else if (targetTouched) { rawExit = position.takeProfitPrice; reason = 'take_profit'; } }
      if (rawExit != null && reason != null) { const trade = exitPosition(position, rawExit, candle.timestamp, reason, request); trades.push(trade); equity += trade.netPnl; openPositions.splice(positionIndex, 1); continue; }
      const trailing = request.trailingStop; if (trailing?.enabled) { const activationR = trailing.activationR ?? 1; const distanceR = trailing.distanceR ?? 1; const initialDistance = Math.abs(position.entryPrice - position.stopLossPrice); if (initialDistance > 0) { const activationDistance = initialDistance * activationR; const trailingDistance = initialDistance * distanceR; if (position.side === 'long' && candle.high >= position.entryPrice + activationDistance) position.activeStopPrice = Math.max(position.activeStopPrice, candle.high - trailingDistance); if (position.side === 'short' && candle.low <= position.entryPrice - activationDistance) position.activeStopPrice = Math.min(position.activeStopPrice, candle.low + trailingDistance); } }
    }
    { const closeUnrealized = openPositions.reduce((sum, position) => sum + (position.side === 'long' ? (candle.close - position.entryPrice) : (position.entryPrice - candle.close)) * position.quantity, 0); const worstUnrealized = openPositions.reduce((sum, position) => sum + (position.side === 'long' ? (candle.low - position.entryPrice) : (position.entryPrice - candle.high)) * position.quantity, 0); markedPeak = Math.max(markedPeak, equity + closeUnrealized); const trough = equity + Math.min(closeUnrealized, worstUnrealized); const drawdown = Math.max(0, markedPeak - trough); markedMaximumDrawdown = Math.max(markedMaximumDrawdown, drawdown); if (markedPeak > 0) markedMaximumDrawdownPercent = Math.max(markedMaximumDrawdownPercent, drawdown / markedPeak * 100); }
    const completedSignals = signalsByIndex.get(index) ?? []; if (parameterBoolean(request.parameters, 'exitOnOppositeSignal', false)) for (const position of openPositions) if (completedSignals.some((signal) => signal.side !== position.side)) position.pendingStrategyExit = true;
    const entryIndex = index + 1 + entryDelayBars; if (entryIndex >= candles.length) continue;
    for (const signal of completedSignals) {
      if (openPositions.length >= request.maximumConcurrentPositions) break; const entryCandle = candles[entryIndex]; const day = utcDay(entryCandle.timestamp); const count = tradesPerDay.get(day) ?? 0; if (count >= request.maximumTradesPerDay) continue; const rawEntryPrice = entryCandle.open; const entryPrice = adverseEntryPrice(rawEntryPrice, signal.side, request.slippageRate); const stopLossPrice = stopPriceFor(request, candles, index, signal.side, entryPrice, atr); if (stopLossPrice == null || stopLossPrice <= 0) continue; /* a gap or order delay can put the fill beyond the planned stop: no valid trade */ if (signal.side === 'long' ? stopLossPrice >= entryPrice : stopLossPrice <= entryPrice) continue; const takeProfitPrice = targetPriceFor(request, signal.side, entryPrice, stopLossPrice); if (takeProfitPrice <= 0) continue;
      const riskMarket = request.market === 'crypto-futures' ? 'crypto-futures' : request.market === 'crypto-spot' ? 'crypto-spot' : 'stock';
      const risk = calculateTradingRisk({ market: riskMarket, symbol: request.symbol, side: signal.side, accountBalance: equity, entryPrice, stopLossPrice, targetPrice1: takeProfitPrice, targetPrice2: null, leverage: request.leverage, riskPercent: request.riskPercent, entryFeeRate: request.entryFeeRate, exitFeeRate: request.exitFeeRate, slippageRate: request.slippageRate, estimatedFundingRate: request.market === 'crypto-futures' ? Math.abs(request.fundingRatePerInterval ?? 0) : 0, quantityStep: request.quantityStep, quantityPrecision: request.quantityPrecision, minimumQuantity: request.minimumQuantity, minimumNotional: request.minimumNotional, maintenanceMarginRate: null, maximumLeverage: request.market === 'crypto-futures' ? request.maximumLeverage : 1, appMaximumLeverage: request.market === 'crypto-futures' ? BACKTEST_LIMITS.maximumLeverage : 1, contractRulesStatus: request.contractRulesStatus, dataStatus: 'live', dailyRealizedPnl: 0, weeklyRealizedPnl: 0, consecutiveLosses: 0, openExposure: openPositions.reduce((sum, position) => sum + position.notionalValue, 0), sameDirectionExposure: openPositions.filter((position) => position.side === signal.side).reduce((sum, position) => sum + position.notionalValue, 0) }, now);
      if (!risk.allowed || risk.recommendedQuantity == null || risk.notionalValue == null || risk.estimatedEntryFee == null || risk.estimatedMaximumLoss == null) { warnings.push(...risk.warnings); continue; }
      tradeSequence += 1; openPositions.push({ id: `${request.symbol}-${entryCandle.timestamp}-${tradeSequence}`, side: signal.side, signalTime: candle.timestamp, entryTime: entryCandle.timestamp, rawEntryPrice, entryPrice, stopLossPrice, activeStopPrice: stopLossPrice, takeProfitPrice, quantity: risk.recommendedQuantity, leverage: request.leverage, notionalValue: risk.notionalValue, entryFee: risk.estimatedEntryFee, initialRiskAmount: risk.estimatedMaximumLoss, marketRegime: signal.regime, maximumFavorableExcursion: 0, maximumAdverseExcursion: 0, pendingStrategyExit: false }); tradesPerDay.set(day, count + 1);
    }
  }
  const finalCandle = candles.at(-1); if (finalCandle) for (const position of [...openPositions]) { const trade = exitPosition(position, finalCandle.close, finalCandle.timestamp, 'end_of_data', request); trades.push(trade); equity += trade.netPnl; }
  trades.sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime); const slice = performanceSlice(trades); const wins = trades.filter((trade) => trade.netPnl > 0); const losses = trades.filter((trade) => trade.netPnl < 0); const dd = drawdowns(request.initialCapital, trades); const ratios = ratioStatistics(request.initialCapital, trades, { startTime: request.startTime, endTime: request.endTime, market: request.market }); const consecutive = consecutiveCounts(trades); const durationYears = (request.endTime - request.startTime) / (365.25 * 24 * 60 * 60_000); const totalReturnPercent = (dd.equity - request.initialCapital) / request.initialCapital * 100; const annualizedReturnPercent = durationYears >= 30 / 365.25 && dd.equity > 0 ? ((dd.equity / request.initialCapital) ** (1 / durationYears) - 1) * 100 : null; if (annualizedReturnPercent == null) warnings.push('기간이 짧거나 최종 자산이 0 이하라 연환산 수익률을 계산하지 않았습니다.'); if (slice.profitFactor == null) warnings.push('총 손실 거래가 없어 Profit Factor를 null로 반환했습니다.'); if (ratios.sharpe == null || ratios.sortino == null) warnings.push('일별 수익률 표본이 5개 미만이거나 변동성이 없어 Sharpe·Sortino를 null로 반환했습니다.');
  const monthlyMap = new Map<string, BacktestTrade[]>(); const regimeMap = new Map<string, BacktestTrade[]>(); for (const trade of trades) { const month = new Date(trade.exitTime).toISOString().slice(0, 7); monthlyMap.set(month, [...(monthlyMap.get(month) ?? []), trade]); regimeMap.set(trade.marketRegime, [...(regimeMap.get(trade.marketRegime) ?? []), trade]); }
  const monthlyPerformance = [...monthlyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, monthTrades]) => { const netPnl = monthTrades.reduce((sum, trade) => sum + trade.netPnl, 0); return { month, trades: monthTrades.length, netPnl, returnPercent: netPnl / request.initialCapital * 100 }; }); const regimePerformance = [...regimeMap.entries()].map(([regime, regimeTrades]) => { const perf = performanceSlice(regimeTrades); return { regime, trades: regimeTrades.length, netPnl: perf.netPnl, winRate: perf.winRate }; });
  return { ok: true, mode: 'backtest-only', orderSubmitted: false, market: request.market, symbol: request.symbol, timeframe: request.timeframe, strategy: request.strategy, startTime: request.startTime, endTime: request.endTime, initialCapital: request.initialCapital, finalCapital: dd.equity, totalReturnPercent, annualizedReturnPercent, totalTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length, winRate: slice.winRate, averageWin: wins.length ? wins.reduce((sum, trade) => sum + trade.netPnl, 0) / wins.length : 0, averageLoss: losses.length ? losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length : 0, averageRMultiple: slice.averageRMultiple, expectancy: slice.expectancy, profitFactor: slice.profitFactor, maximumDrawdown: dd.maximumDrawdown, maximumDrawdownPercent: dd.maximumDrawdownPercent, markedMaximumDrawdown: Math.max(markedMaximumDrawdown, dd.maximumDrawdown), markedMaximumDrawdownPercent: Math.max(markedMaximumDrawdownPercent, dd.maximumDrawdownPercent), maximumConsecutiveWins: consecutive.maxWins, maximumConsecutiveLosses: consecutive.maxLosses, sharpeRatio: ratios.sharpe, sortinoRatio: ratios.sortino, calmarRatio: annualizedReturnPercent != null && dd.maximumDrawdownPercent > 0 ? annualizedReturnPercent / dd.maximumDrawdownPercent : null, totalFees: trades.reduce((sum, trade) => sum + trade.entryFee + trade.exitFee, 0), totalSlippage: trades.reduce((sum, trade) => sum + trade.slippageCost, 0), totalFunding: trades.reduce((sum, trade) => sum + trade.fundingCost, 0), longPerformance: performanceSlice(trades.filter((trade) => trade.side === 'long')), shortPerformance: performanceSlice(trades.filter((trade) => trade.side === 'short')), monthlyPerformance, regimePerformance, validationPerformance: validationSegments(request, trades), walkForward: walkForwardWindows(request, trades), equityCurve: dd.equityCurve, drawdownCurve: dd.drawdownCurve, trades, warnings: unique(warnings), calculatedAt: now.toISOString() };
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const low = 0.02425;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/**
 * Best annualized Sharpe that `runs` zero-skill configurations would show by chance over `years`
 * (Bailey & Lopez de Prado 2014 expected maximum; standard error of an annualized Sharpe ~ 1/sqrt(years)).
 */
export function expectedMaxNoiseSharpe(runs: number, years: number): number | null {
  if (!Number.isFinite(runs) || runs < 2 || !Number.isFinite(years) || years <= 0) return null;
  const gamma = 0.5772156649015329;
  return (1 / Math.sqrt(years)) * ((1 - gamma) * inverseNormalCdf(1 - 1 / runs) + gamma * inverseNormalCdf(1 - 1 / (runs * Math.E)));
}
export type BacktestSelectionBias = { runs: number; expectedMaxNoiseSharpe: number | null; observedSharpe: number | null; indistinguishableFromNoise: boolean };
/** Pure: compares the observed Sharpe with what the same number of tries would give by luck. */
export function evaluateSelectionBias(runs: number, observedSharpe: number | null, startTime: number, endTime: number): BacktestSelectionBias {
  const years = (endTime - startTime) / (365.25 * 24 * 3_600_000);
  const expected = expectedMaxNoiseSharpe(runs, years);
  return { runs, expectedMaxNoiseSharpe: expected, observedSharpe, indistinguishableFromNoise: expected != null && (observedSharpe == null || observedSharpe <= expected) };
}
export function selectionBiasWarning(bias: BacktestSelectionBias): string | null {
  if (bias.runs < 5 || bias.expectedMaxNoiseSharpe == null) return null;
  const expected = bias.expectedMaxNoiseSharpe.toFixed(2);
  const observed = bias.observedSharpe == null ? '계산 불가' : bias.observedSharpe.toFixed(2);
  return bias.indistinguishableFromNoise
    ? `같은 종목·전략으로 ${bias.runs}가지 조건을 시험했습니다. 우연만으로도 최고 샤프가 약 ${expected}까지 나오는데 이번 결과(${observed})는 그 이하라 우연과 구분되지 않습니다.`
    : `같은 종목·전략으로 ${bias.runs}가지 조건을 시험했습니다. 우연만으로도 최고 샤프가 약 ${expected}까지 나오므로, 이번 결과(${observed})는 그 값을 넘어야 의미가 있습니다. 조건을 더 바꿔 보면 기준이 올라갑니다.`;
}
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`; return JSON.stringify(value) ?? 'null'; }
const SELECTION_WINDOW_MS = 24 * 60 * 60_000;
const SELECTION_MAX_KEYS = 500;
const selectionRuns = new Map<string, Map<string, number>>();

/** Counts distinct settings a member tried on the same strategy and symbol within 24 hours (including this one). */
export function recordSelectionRun(memberKey: string, request: BacktestRequest, now = Date.now()): number {
  const family = `${memberKey}|${request.market}|${request.symbol}|${request.strategy}`;
  const { startTime: _start, endTime: _end, ...settings } = request;
  const configuration = stableJson(settings);
  const runs = selectionRuns.get(family) ?? new Map<string, number>();
  for (const [key, at] of runs) if (now - at > SELECTION_WINDOW_MS) runs.delete(key);
  runs.set(configuration, now);
  selectionRuns.delete(family); selectionRuns.set(family, runs);
  while (selectionRuns.size > SELECTION_MAX_KEYS) { const oldest = selectionRuns.keys().next().value; if (oldest === undefined) break; selectionRuns.delete(oldest); }
  return runs.size;
}

export function resetSelectionRunsForTests() { selectionRuns.clear(); }
export function measureBacktestPerformance(request: BacktestRequest, candles: readonly NormalizedCandle[]) { const before = process.memoryUsage().heapUsed; const started = performance.now(); const result = runBacktest(request, candles); return { candleCount: candles.length, tradeCount: result.totalTrades, durationMs: performance.now() - started, heapDeltaBytes: process.memoryUsage().heapUsed - before, timedOut: false }; }
