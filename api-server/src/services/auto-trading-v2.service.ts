import { createHash } from 'node:crypto';

export const AUTO_TRADING_V2_STRATEGY_ID = 'crypto-futures-pullback-v1';
export const AUTO_TRADING_V2_STRATEGY_VERSION = '1.0.0';
export const AUTO_TRADING_V2_SUPPORTED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
export const AUTO_TRADING_V2_EXECUTION_PROFILE = 'USDT-M-FUTURES' as const;

export const AUTO_TRADING_V2_CONFIG = Object.freeze({
  autoTradingUi: true,
  paperTrading: true,
  shadowTrading: true,
  liveTrading: false,
  closedCandleOnly: true,
  marginMode: 'ISOLATED' as const,
  leverageCap: 5,
  defaultLeverage: 3,
  riskPerTradeDefaultPercent: 0.25,
  riskPerTradeMaxPercent: 0.5,
  dailyLossLimitPercent: 1.5,
  dailyLossHardCapPercent: 2,
  weeklyDrawdownLimitPercent: 4,
  maxConsecutiveLosses: 3,
  fixedStopPercent: 1.5,
  atrStopMultipliers: [1.5, 2, 2.5] as const,
  defaultAtrStopMultiplier: 2,
  tp1Percent: 3.5,
  tp1ExitFraction: 0.5,
  trailingAtrMultiplier: 1.5,
  rvolCandidatesPercent: [300, 400, 500, 600] as const,
  selectedRvolPercent: 400,
  volumeContractionRatio: 0.75,
  pullbackToMa20MaxPercent: 0.6,
  maxSpreadPercent: 0.2,
  maxMarkIndexDislocationPercent: 0.5,
  maxAtrPercent: 6,
  stalePublicDataMs: 180_000,
  estimatedRoundTripFeePercent: 0.1,
  estimatedSlippagePercent: 0.05,
  stopSlippagePercent: 0.1,
  strategyEligibility: 'PAPER_READY' as const,
  aiFailurePolicy: 'IGNORE_AI_AND_CONTINUE_QUANT_RISK_FOR_PAPER_SHADOW' as const,
});

export type AutoTradingV2Mode = 'OFF' | 'PAPER' | 'SHADOW' | 'LIVE';
export type AutoTradingV2Regime = 'LONG_ONLY' | 'SHORT_ONLY' | 'NO_TRADE';
export type AutoTradingV2Direction = 'LONG' | 'SHORT';
export type AutoTradingV2StopMode = 'FIXED_STOP' | 'ATR_STOP';
export type AutoTradingV2Eligibility = 'RESEARCH_HOLD' | 'OOS_CANDIDATE' | 'SHADOW_CANDIDATE' | 'PAPER_READY' | 'LIVE_APPROVED';
export type AutoTradingV2ExecutionState =
  | 'SIGNAL_DETECTED'
  | 'SIGNAL_VALIDATED'
  | 'RISK_APPROVED'
  | 'ORDER_PLANNED'
  | 'ENTRY_SUBMITTED'
  | 'ENTRY_PARTIAL'
  | 'ENTRY_FILLED'
  | 'STOP_REGISTERED'
  | 'TP_REGISTERED'
  | 'POSITION_PROTECTED'
  | 'PARTIAL_TP'
  | 'TRAILING'
  | 'CLOSED'
  | 'ERROR'
  | 'SAFE_HALT';

export type AutoTradingV2Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AutoTradingV2MarketSnapshot = {
  symbol: string;
  observedAt: string;
  source: 'BINANCE_USDT_M_PUBLIC';
  publicOnly: true;
  closedCandleOnly: true;
  markPrice: number;
  indexPrice: number;
  bidPrice: number;
  askPrice: number;
  spreadPercent: number;
  markIndexDislocationPercent: number;
  fundingRate: number;
  nextFundingTime: number | null;
  btc1dClose: number;
  btc1dMa20: number;
  btc1hClose: number;
  btc1hMa20: number;
  symbol1hClose: number;
  symbol1hMa20: number;
  symbol5mClose: number;
  symbol5mMa20: number;
  atr14: number;
  atrPercent: number;
  oneMinuteMovePercent: number;
  expansionRvolPercent: number;
  volumeContraction: boolean;
  pullbackDistancePercent: number;
  continuationLong: boolean;
  continuationShort: boolean;
  lastClosedCandleTime: number;
  dataStale: boolean;
};

export type AutoTradingV2RiskInput = {
  equityKrw: number;
  riskPerTradePercent?: number;
  leverage?: number;
  feePercent?: number;
  slippagePercent?: number;
  fundingPercent?: number;
  spreadPercent?: number;
  entryPrice: number;
  stopPrice: number;
};

export type AutoTradingV2PositionSizing = {
  allowedLossKrw: number;
  stopDistancePercent: number;
  effectiveStopDistancePercent: number;
  positionNotionalKrw: number;
  requiredMarginKrw: number;
  quantity: number;
  leverage: number;
  riskPerTradePercent: number;
  cappedByAvailableMargin: boolean;
  estimatedCostPercent: number;
};

export type AutoTradingV2KillSwitchInput = {
  dailyPnlPercent?: number;
  weeklyDrawdownPercent?: number;
  consecutiveLosses?: number;
  marketDataStale?: boolean;
  websocketDisconnected?: boolean;
  apiErrorBurst?: boolean;
  orderStateMismatch?: boolean;
  positionStateMismatch?: boolean;
  spreadAbnormal?: boolean;
  volatilityAbnormal?: boolean;
  protectiveStopMissing?: boolean;
};

export type AutoTradingV2KillSwitchDecision = {
  newEntryDisabled: boolean;
  safeHalt: boolean;
  reasons: string[];
};

export type AutoTradingV2SignalDecision = {
  strategyId: string;
  strategyVersion: string;
  eligibility: AutoTradingV2Eligibility;
  signalId: string;
  idempotencyKey: string;
  symbol: string;
  timeframe: '5m';
  regime: AutoTradingV2Regime;
  direction: AutoTradingV2Direction | null;
  ownTrendGate: boolean;
  pullbackEligible: boolean;
  allowed: boolean;
  blockReasons: string[];
  reasons: string[];
  snapshot: AutoTradingV2MarketSnapshot;
  orderPlan: null | {
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    trailingDistance: number;
    position: AutoTradingV2PositionSizing;
    marginMode: 'ISOLATED';
    leverageCap: number;
  };
};

export type AutoTradingV2ExecutionSimulation = {
  mode: 'PAPER' | 'SHADOW';
  executionId: string;
  clientOrderId: string;
  signalId: string;
  idempotencyKey: string;
  states: AutoTradingV2ExecutionState[];
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  trailingDistance: number;
  quantity: number;
  notionalKrw: number;
  requiredMarginKrw: number;
  leverage: number;
  positionProtected: boolean;
  wouldEnter: boolean;
  wouldFill: boolean;
  wouldStop: boolean;
  wouldTP: boolean;
  wouldLiquidate: boolean | null;
  wouldPnlKrw: number;
  realOrderCount: 0;
  realCancelCount: 0;
  privateTradingApiCount: 0;
  errorCode: string | null;
};

const PUBLIC_BASE_URL = 'https://fapi.binance.com';
const PUBLIC_CACHE_TTL_MS = 8_000;
const publicCache = new Map<string, { expiresAt: number; value: unknown }>();

function finite(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`AUTO_TRADING_V2_INVALID_${label}`);
  return parsed;
}

function positive(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`AUTO_TRADING_V2_INVALID_${label}`);
  return parsed;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentDistance(left: number, right: number) {
  return Math.abs(left - right) / Math.max(Math.abs(right), Number.EPSILON) * 100;
}

function average(values: readonly number[]) {
  if (!values.length) throw new Error('AUTO_TRADING_V2_EMPTY_SERIES');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function autoTradingV2Sma(values: readonly number[], period: number) {
  if (!Number.isInteger(period) || period <= 0 || values.length < period) throw new Error('AUTO_TRADING_V2_SMA_INPUT');
  return average(values.slice(-period));
}

export function autoTradingV2Atr(candles: readonly AutoTradingV2Candle[], period = 14) {
  if (candles.length < period + 1) throw new Error('AUTO_TRADING_V2_ATR_INPUT');
  const rows = candles.slice(-(period + 1));
  const trueRanges = rows.slice(1).map((candle, index) => {
    const previousClose = rows[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return average(trueRanges);
}

export function autoTradingV2Regime(input: { btc1dClose: number; btc1dMa20: number; btc1hClose: number; btc1hMa20: number }): AutoTradingV2Regime {
  if (input.btc1dClose > input.btc1dMa20 && input.btc1hClose > input.btc1hMa20) return 'LONG_ONLY';
  if (input.btc1dClose < input.btc1dMa20 && input.btc1hClose < input.btc1hMa20) return 'SHORT_ONLY';
  return 'NO_TRADE';
}

export function autoTradingV2OwnTrendGate(regime: AutoTradingV2Regime, close: number, ma20: number) {
  if (regime === 'LONG_ONLY') return close > ma20;
  if (regime === 'SHORT_ONLY') return close < ma20;
  return false;
}

export function autoTradingV2PositionSizing(input: AutoTradingV2RiskInput): AutoTradingV2PositionSizing {
  const equityKrw = positive(input.equityKrw, 'EQUITY');
  const entryPrice = positive(input.entryPrice, 'ENTRY_PRICE');
  const stopPrice = positive(input.stopPrice, 'STOP_PRICE');
  const riskPerTradePercent = clamp(
    Number(input.riskPerTradePercent ?? AUTO_TRADING_V2_CONFIG.riskPerTradeDefaultPercent),
    0.01,
    AUTO_TRADING_V2_CONFIG.riskPerTradeMaxPercent,
  );
  const leverage = Math.round(clamp(Number(input.leverage ?? AUTO_TRADING_V2_CONFIG.defaultLeverage), 1, AUTO_TRADING_V2_CONFIG.leverageCap));
  const stopDistancePercent = percentDistance(entryPrice, stopPrice);
  if (stopDistancePercent <= 0) throw new Error('AUTO_TRADING_V2_STOP_DISTANCE_REQUIRED');
  const estimatedCostPercent = Math.max(0, Number(input.feePercent ?? AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent))
    + Math.max(0, Number(input.slippagePercent ?? AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent))
    + Math.max(0, Number(input.fundingPercent ?? 0))
    + Math.max(0, Number(input.spreadPercent ?? 0));
  const effectiveStopDistancePercent = stopDistancePercent + estimatedCostPercent;
  const allowedLossKrw = equityKrw * riskPerTradePercent / 100;
  const rawNotionalKrw = allowedLossKrw / (effectiveStopDistancePercent / 100);
  const maximumNotionalByMargin = equityKrw * leverage;
  const positionNotionalKrw = Math.min(rawNotionalKrw, maximumNotionalByMargin);
  const requiredMarginKrw = positionNotionalKrw / leverage;
  return {
    allowedLossKrw,
    stopDistancePercent,
    effectiveStopDistancePercent,
    positionNotionalKrw,
    requiredMarginKrw,
    quantity: positionNotionalKrw / entryPrice,
    leverage,
    riskPerTradePercent,
    cappedByAvailableMargin: positionNotionalKrw < rawNotionalKrw,
    estimatedCostPercent,
  };
}

export function autoTradingV2StopPrice(
  direction: AutoTradingV2Direction,
  entryPrice: number,
  atr14: number,
  mode: AutoTradingV2StopMode = 'ATR_STOP',
  atrMultiplier = AUTO_TRADING_V2_CONFIG.defaultAtrStopMultiplier,
) {
  const distance = mode === 'FIXED_STOP'
    ? entryPrice * AUTO_TRADING_V2_CONFIG.fixedStopPercent / 100
    : positive(atr14, 'ATR') * clamp(atrMultiplier, 1.5, 2.5);
  return direction === 'LONG' ? entryPrice - distance : entryPrice + distance;
}

export function autoTradingV2TargetPrice(direction: AutoTradingV2Direction, entryPrice: number) {
  const distance = entryPrice * AUTO_TRADING_V2_CONFIG.tp1Percent / 100;
  return direction === 'LONG' ? entryPrice + distance : entryPrice - distance;
}

export function evaluateAutoTradingV2KillSwitch(input: AutoTradingV2KillSwitchInput): AutoTradingV2KillSwitchDecision {
  const reasons: string[] = [];
  const daily = Number(input.dailyPnlPercent ?? 0);
  const weekly = Number(input.weeklyDrawdownPercent ?? 0);
  const consecutive = Math.max(0, Math.round(Number(input.consecutiveLosses ?? 0)));
  if (daily <= -AUTO_TRADING_V2_CONFIG.dailyLossLimitPercent) reasons.push('DAILY_LOSS_LIMIT');
  if (daily <= -AUTO_TRADING_V2_CONFIG.dailyLossHardCapPercent) reasons.push('DAILY_LOSS_HARD_CAP');
  if (weekly <= -AUTO_TRADING_V2_CONFIG.weeklyDrawdownLimitPercent) reasons.push('WEEKLY_DRAWDOWN_LIMIT');
  if (consecutive >= AUTO_TRADING_V2_CONFIG.maxConsecutiveLosses) reasons.push('CONSECUTIVE_LOSSES');
  if (input.marketDataStale) reasons.push('MARKET_DATA_STALE');
  if (input.websocketDisconnected) reasons.push('WEBSOCKET_DISCONNECTED');
  if (input.apiErrorBurst) reasons.push('API_ERROR_BURST');
  if (input.orderStateMismatch) reasons.push('ORDER_STATE_MISMATCH');
  if (input.positionStateMismatch) reasons.push('POSITION_STATE_MISMATCH');
  if (input.spreadAbnormal) reasons.push('SPREAD_ABNORMAL');
  if (input.volatilityAbnormal) reasons.push('VOLATILITY_ABNORMAL');
  if (input.protectiveStopMissing) reasons.push('PROTECTIVE_STOP_MISSING');
  const severe = new Set([
    'DAILY_LOSS_HARD_CAP', 'ORDER_STATE_MISMATCH', 'POSITION_STATE_MISMATCH',
    'PROTECTIVE_STOP_MISSING', 'API_ERROR_BURST',
  ]);
  return {
    newEntryDisabled: reasons.length > 0,
    safeHalt: reasons.some((reason) => severe.has(reason)),
    reasons,
  };
}

const EXECUTION_TRANSITIONS: Record<AutoTradingV2ExecutionState, readonly AutoTradingV2ExecutionState[]> = {
  SIGNAL_DETECTED: ['SIGNAL_VALIDATED', 'ERROR'],
  SIGNAL_VALIDATED: ['RISK_APPROVED', 'ERROR'],
  RISK_APPROVED: ['ORDER_PLANNED', 'ERROR'],
  ORDER_PLANNED: ['ENTRY_SUBMITTED', 'ERROR'],
  ENTRY_SUBMITTED: ['ENTRY_PARTIAL', 'ENTRY_FILLED', 'ERROR'],
  ENTRY_PARTIAL: ['ENTRY_FILLED', 'ERROR'],
  ENTRY_FILLED: ['STOP_REGISTERED', 'ERROR'],
  STOP_REGISTERED: ['TP_REGISTERED', 'ERROR'],
  TP_REGISTERED: ['POSITION_PROTECTED', 'ERROR'],
  POSITION_PROTECTED: ['PARTIAL_TP', 'TRAILING', 'CLOSED', 'ERROR'],
  PARTIAL_TP: ['TRAILING', 'CLOSED', 'ERROR'],
  TRAILING: ['CLOSED', 'ERROR'],
  CLOSED: [],
  ERROR: ['SAFE_HALT'],
  SAFE_HALT: [],
};

export function assertAutoTradingV2Transition(from: AutoTradingV2ExecutionState, to: AutoTradingV2ExecutionState) {
  if (!EXECUTION_TRANSITIONS[from].includes(to)) throw new Error(`AUTO_TRADING_V2_INVALID_STATE_TRANSITION:${from}:${to}`);
}

export function autoTradingV2SignalKey(input: {
  symbol: string;
  direction: AutoTradingV2Direction;
  candleCloseTime: number;
}) {
  const lifecycle = `${AUTO_TRADING_V2_STRATEGY_ID}:${AUTO_TRADING_V2_STRATEGY_VERSION}:USDT-M:${input.symbol}:5m:${input.direction}:${input.candleCloseTime}`;
  const signalId = `atv2-${createHash('sha256').update(lifecycle).digest('hex').slice(0, 24)}`;
  const idempotencyKey = createHash('sha256').update(`execution:${lifecycle}`).digest('hex');
  return { signalId, idempotencyKey };
}

function normalizeSymbol(value: unknown) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!(AUTO_TRADING_V2_SUPPORTED_SYMBOLS as readonly string[]).includes(symbol)) throw new Error('AUTO_TRADING_V2_UNSUPPORTED_SYMBOL');
  return symbol;
}

function parseKlines(payload: unknown): AutoTradingV2Candle[] {
  if (!Array.isArray(payload)) throw new Error('AUTO_TRADING_V2_PUBLIC_KLINES_INVALID');
  return payload.map((row) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error('AUTO_TRADING_V2_PUBLIC_KLINE_INVALID');
    return {
      openTime: finite(row[0], 'OPEN_TIME'),
      open: positive(row[1], 'OPEN'),
      high: positive(row[2], 'HIGH'),
      low: positive(row[3], 'LOW'),
      close: positive(row[4], 'CLOSE'),
      volume: Math.max(0, finite(row[5], 'VOLUME')),
      closeTime: finite(row[6], 'CLOSE_TIME'),
    };
  });
}

function closedCandles(candles: readonly AutoTradingV2Candle[], nowMs: number) {
  return candles.filter((candle) => candle.closeTime <= nowMs).sort((a, b) => a.openTime - b.openTime);
}

async function publicJson(path: string, signal?: AbortSignal) {
  const cached = publicCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${PUBLIC_BASE_URL}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`AUTO_TRADING_V2_PUBLIC_HTTP_${response.status}`);
  const value = await response.json();
  publicCache.set(path, { expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS, value });
  return value;
}

function query(params: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

function latest<T>(values: readonly T[], label: string) {
  const value = values.at(-1);
  if (value == null) throw new Error(`AUTO_TRADING_V2_${label}_MISSING`);
  return value;
}

export async function fetchAutoTradingV2PublicSnapshot(symbolInput: string, signal?: AbortSignal): Promise<AutoTradingV2MarketSnapshot> {
  const symbol = normalizeSymbol(symbolInput);
  const nowMs = Date.now();
  const [btc1dRaw, btc1hRaw, symbol1hRaw, symbol5mRaw, symbol1mRaw, bookRaw, premiumRaw] = await Promise.all([
    publicJson(`/fapi/v1/klines?${query({ symbol: 'BTCUSDT', interval: '1d', limit: 24 })}`, signal),
    publicJson(`/fapi/v1/klines?${query({ symbol: 'BTCUSDT', interval: '1h', limit: 24 })}`, signal),
    publicJson(`/fapi/v1/klines?${query({ symbol, interval: '1h', limit: 24 })}`, signal),
    publicJson(`/fapi/v1/klines?${query({ symbol, interval: '5m', limit: 40 })}`, signal),
    publicJson(`/fapi/v1/klines?${query({ symbol, interval: '1m', limit: 4 })}`, signal),
    publicJson(`/fapi/v1/ticker/bookTicker?${query({ symbol })}`, signal),
    publicJson(`/fapi/v1/premiumIndex?${query({ symbol })}`, signal),
  ]);
  const btc1d = closedCandles(parseKlines(btc1dRaw), nowMs);
  const btc1h = closedCandles(parseKlines(btc1hRaw), nowMs);
  const symbol1h = closedCandles(parseKlines(symbol1hRaw), nowMs);
  const symbol5m = closedCandles(parseKlines(symbol5mRaw), nowMs);
  const symbol1m = closedCandles(parseKlines(symbol1mRaw), nowMs);
  if (btc1d.length < 20 || btc1h.length < 20 || symbol1h.length < 20 || symbol5m.length < 23 || symbol1m.length < 2) {
    throw new Error('AUTO_TRADING_V2_PUBLIC_HISTORY_INSUFFICIENT');
  }
  const book = bookRaw && typeof bookRaw === 'object' ? bookRaw as Record<string, unknown> : {};
  const premium = premiumRaw && typeof premiumRaw === 'object' ? premiumRaw as Record<string, unknown> : {};
  const bidPrice = positive(book.bidPrice, 'BID_PRICE');
  const askPrice = positive(book.askPrice, 'ASK_PRICE');
  const markPrice = positive(premium.markPrice, 'MARK_PRICE');
  const indexPrice = positive(premium.indexPrice, 'INDEX_PRICE');
  const latest5m = latest(symbol5m, '5M');
  const latest1m = latest(symbol1m, '1M');
  const previous1m = symbol1m.at(-2)!;
  const pattern = symbol5m.slice(-23);
  const expansion = pattern[20];
  const pullback = pattern[21];
  const trigger = pattern[22];
  const baselineVolume = average(pattern.slice(0, 20).map((candle) => candle.volume));
  const pullbackMa20 = autoTradingV2Sma(pattern.slice(1, 22).map((candle) => candle.close), 20);
  const atr14 = autoTradingV2Atr(symbol1h, 14);
  const spreadPercent = (askPrice - bidPrice) / ((askPrice + bidPrice) / 2) * 100;
  return {
    symbol,
    observedAt: new Date(nowMs).toISOString(),
    source: 'BINANCE_USDT_M_PUBLIC',
    publicOnly: true,
    closedCandleOnly: true,
    markPrice,
    indexPrice,
    bidPrice,
    askPrice,
    spreadPercent,
    markIndexDislocationPercent: percentDistance(markPrice, indexPrice),
    fundingRate: finite(premium.lastFundingRate ?? 0, 'FUNDING_RATE'),
    nextFundingTime: Number.isFinite(Number(premium.nextFundingTime)) ? Number(premium.nextFundingTime) : null,
    btc1dClose: latest(btc1d, 'BTC_1D').close,
    btc1dMa20: autoTradingV2Sma(btc1d.map((candle) => candle.close), 20),
    btc1hClose: latest(btc1h, 'BTC_1H').close,
    btc1hMa20: autoTradingV2Sma(btc1h.map((candle) => candle.close), 20),
    symbol1hClose: latest(symbol1h, 'SYMBOL_1H').close,
    symbol1hMa20: autoTradingV2Sma(symbol1h.map((candle) => candle.close), 20),
    symbol5mClose: latest5m.close,
    symbol5mMa20: autoTradingV2Sma(symbol5m.map((candle) => candle.close), 20),
    atr14,
    atrPercent: atr14 / latest(symbol1h, 'ATR_REFERENCE').close * 100,
    oneMinuteMovePercent: (latest1m.close - previous1m.close) / previous1m.close * 100,
    expansionRvolPercent: baselineVolume > 0 ? expansion.volume / baselineVolume * 100 : 0,
    volumeContraction: pullback.volume <= expansion.volume * AUTO_TRADING_V2_CONFIG.volumeContractionRatio,
    pullbackDistancePercent: percentDistance(pullback.close, pullbackMa20),
    continuationLong: trigger.close > pullback.high,
    continuationShort: trigger.close < pullback.low,
    lastClosedCandleTime: latest1m.closeTime,
    dataStale: nowMs - latest1m.closeTime > AUTO_TRADING_V2_CONFIG.stalePublicDataMs,
  };
}

export function evaluateAutoTradingV2Signal(
  snapshot: AutoTradingV2MarketSnapshot,
  input: {
    equityKrw: number;
    mode: AutoTradingV2Mode;
    riskPerTradePercent?: number;
    leverage?: number;
    stopMode?: AutoTradingV2StopMode;
    atrMultiplier?: number;
    dailyPnlPercent?: number;
    weeklyDrawdownPercent?: number;
    consecutiveLosses?: number;
    websocketDisconnected?: boolean;
    apiErrorBurst?: boolean;
    orderStateMismatch?: boolean;
    positionStateMismatch?: boolean;
    protectiveStopMissing?: boolean;
  },
): AutoTradingV2SignalDecision {
  if (input.mode === 'LIVE') throw new Error('AUTO_TRADING_V2_LIVE_LOCKED');
  if (!['OFF', 'PAPER', 'SHADOW'].includes(input.mode)) throw new Error('AUTO_TRADING_V2_MODE_INVALID');
  const regime = autoTradingV2Regime(snapshot);
  const direction = regime === 'LONG_ONLY' ? 'LONG' : regime === 'SHORT_ONLY' ? 'SHORT' : null;
  const ownTrendGate = autoTradingV2OwnTrendGate(regime, snapshot.symbol1hClose, snapshot.symbol1hMa20);
  const threshold = AUTO_TRADING_V2_CONFIG.selectedRvolPercent;
  const pullbackEligible = snapshot.expansionRvolPercent >= threshold
    && snapshot.volumeContraction
    && snapshot.pullbackDistancePercent <= AUTO_TRADING_V2_CONFIG.pullbackToMa20MaxPercent
    && (direction === 'LONG' ? snapshot.continuationLong : direction === 'SHORT' ? snapshot.continuationShort : false);
  const flashCrash = {
    spreadAbnormal: snapshot.spreadPercent > AUTO_TRADING_V2_CONFIG.maxSpreadPercent,
    volatilityAbnormal: snapshot.atrPercent > AUTO_TRADING_V2_CONFIG.maxAtrPercent
      || snapshot.markIndexDislocationPercent > AUTO_TRADING_V2_CONFIG.maxMarkIndexDislocationPercent,
  };
  const killSwitch = evaluateAutoTradingV2KillSwitch({
    dailyPnlPercent: input.dailyPnlPercent,
    weeklyDrawdownPercent: input.weeklyDrawdownPercent,
    consecutiveLosses: input.consecutiveLosses,
    marketDataStale: snapshot.dataStale,
    websocketDisconnected: input.websocketDisconnected,
    apiErrorBurst: input.apiErrorBurst,
    orderStateMismatch: input.orderStateMismatch,
    positionStateMismatch: input.positionStateMismatch,
    spreadAbnormal: flashCrash.spreadAbnormal,
    volatilityAbnormal: flashCrash.volatilityAbnormal,
    protectiveStopMissing: input.protectiveStopMissing,
  });
  const fallbackDirection: AutoTradingV2Direction = direction ?? 'LONG';
  const keys = autoTradingV2SignalKey({ symbol: snapshot.symbol, direction: fallbackDirection, candleCloseTime: snapshot.lastClosedCandleTime });
  const blockReasons = [...killSwitch.reasons];
  if (input.mode === 'OFF') blockReasons.push('MODE_OFF');
  if (regime === 'NO_TRADE') blockReasons.push('BTC_REGIME_CONFLICT');
  if (!ownTrendGate) blockReasons.push('SYMBOL_TREND_GATE');
  if (!pullbackEligible) blockReasons.push('PULLBACK_PATTERN_NOT_READY');
  if (input.mode === 'PAPER' && AUTO_TRADING_V2_CONFIG.strategyEligibility !== 'PAPER_READY') blockReasons.push('STRATEGY_NOT_PAPER_READY');
  const reasons = [
    `BTC_REGIME=${regime}`,
    `OWN_1H_TREND=${ownTrendGate ? 'PASS' : 'BLOCK'}`,
    `RVOL=${snapshot.expansionRvolPercent.toFixed(1)}%/threshold=${threshold}%`,
    `VOLUME_CONTRACTION=${snapshot.volumeContraction}`,
    `MA20_PULLBACK_DISTANCE=${snapshot.pullbackDistancePercent.toFixed(3)}%`,
    `CLOSED_CANDLE_ONLY=${AUTO_TRADING_V2_CONFIG.closedCandleOnly}`,
  ];
  if (!direction || blockReasons.length > 0) {
    return {
      strategyId: AUTO_TRADING_V2_STRATEGY_ID,
      strategyVersion: AUTO_TRADING_V2_STRATEGY_VERSION,
      eligibility: AUTO_TRADING_V2_CONFIG.strategyEligibility,
      signalId: keys.signalId,
      idempotencyKey: keys.idempotencyKey,
      symbol: snapshot.symbol,
      timeframe: '5m',
      regime,
      direction,
      ownTrendGate,
      pullbackEligible,
      allowed: false,
      blockReasons: [...new Set(blockReasons)],
      reasons,
      snapshot,
      orderPlan: null,
    };
  }
  const entryPrice = snapshot.markPrice;
  const stopPrice = autoTradingV2StopPrice(
    direction,
    entryPrice,
    snapshot.atr14,
    input.stopMode ?? 'ATR_STOP',
    input.atrMultiplier ?? AUTO_TRADING_V2_CONFIG.defaultAtrStopMultiplier,
  );
  const position = autoTradingV2PositionSizing({
    equityKrw: input.equityKrw,
    riskPerTradePercent: input.riskPerTradePercent,
    leverage: input.leverage,
    entryPrice,
    stopPrice,
    feePercent: AUTO_TRADING_V2_CONFIG.estimatedRoundTripFeePercent,
    slippagePercent: AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent,
    spreadPercent: snapshot.spreadPercent,
    fundingPercent: Math.abs(snapshot.fundingRate) * 100,
  });
  return {
    strategyId: AUTO_TRADING_V2_STRATEGY_ID,
    strategyVersion: AUTO_TRADING_V2_STRATEGY_VERSION,
    eligibility: AUTO_TRADING_V2_CONFIG.strategyEligibility,
    signalId: keys.signalId,
    idempotencyKey: keys.idempotencyKey,
    symbol: snapshot.symbol,
    timeframe: '5m',
    regime,
    direction,
    ownTrendGate,
    pullbackEligible,
    allowed: true,
    blockReasons: [],
    reasons,
    snapshot,
    orderPlan: {
      entryPrice,
      stopPrice,
      targetPrice: autoTradingV2TargetPrice(direction, entryPrice),
      trailingDistance: snapshot.atr14 * AUTO_TRADING_V2_CONFIG.trailingAtrMultiplier,
      position,
      marginMode: 'ISOLATED',
      leverageCap: AUTO_TRADING_V2_CONFIG.leverageCap,
    },
  };
}

export function simulateAutoTradingV2Execution(
  decision: AutoTradingV2SignalDecision,
  mode: 'PAPER' | 'SHADOW',
  options: { partialFillFraction?: number; stopRegistrationFails?: boolean } = {},
): AutoTradingV2ExecutionSimulation {
  if (!decision.allowed || !decision.orderPlan || !decision.direction) throw new Error('AUTO_TRADING_V2_SIGNAL_NOT_EXECUTABLE');
  const states: AutoTradingV2ExecutionState[] = ['SIGNAL_DETECTED'];
  const move = (next: AutoTradingV2ExecutionState) => {
    assertAutoTradingV2Transition(states.at(-1)!, next);
    states.push(next);
  };
  move('SIGNAL_VALIDATED');
  move('RISK_APPROVED');
  move('ORDER_PLANNED');
  move('ENTRY_SUBMITTED');
  const fraction = clamp(Number(options.partialFillFraction ?? 1), 0.01, 1);
  if (fraction < 1) move('ENTRY_PARTIAL');
  move('ENTRY_FILLED');
  if (options.stopRegistrationFails) {
    move('ERROR');
    move('SAFE_HALT');
  } else {
    move('STOP_REGISTERED');
    move('TP_REGISTERED');
    move('POSITION_PROTECTED');
  }
  const spreadHalf = decision.snapshot.spreadPercent / 200;
  const slippage = AUTO_TRADING_V2_CONFIG.estimatedSlippagePercent / 100;
  const fillMultiplier = decision.direction === 'LONG' ? 1 + spreadHalf + slippage : 1 - spreadHalf - slippage;
  const fillPrice = decision.orderPlan.entryPrice * fillMultiplier;
  const executionId = `atv2-exec-${decision.idempotencyKey.slice(0, 24)}`;
  return {
    mode,
    executionId,
    clientOrderId: `atv2-${decision.idempotencyKey.slice(0, 28)}`,
    signalId: decision.signalId,
    idempotencyKey: decision.idempotencyKey,
    states,
    entryPrice: fillPrice,
    stopPrice: decision.orderPlan.stopPrice,
    targetPrice: decision.orderPlan.targetPrice,
    trailingDistance: decision.orderPlan.trailingDistance,
    quantity: decision.orderPlan.position.quantity,
    notionalKrw: decision.orderPlan.position.positionNotionalKrw,
    requiredMarginKrw: decision.orderPlan.position.requiredMarginKrw,
    leverage: decision.orderPlan.position.leverage,
    positionProtected: !options.stopRegistrationFails,
    wouldEnter: true,
    wouldFill: true,
    wouldStop: false,
    wouldTP: false,
    wouldLiquidate: null,
    wouldPnlKrw: 0,
    realOrderCount: 0,
    realCancelCount: 0,
    privateTradingApiCount: 0,
    errorCode: options.stopRegistrationFails ? 'PROTECTIVE_STOP_MISSING' : null,
  };
}

export function autoTradingV2SafetyEnvelope() {
  return {
    autoTradingUi: true as const,
    paperTrading: true as const,
    shadowTrading: true as const,
    liveTrading: false as const,
    liveLocked: true as const,
    privateTradingApiAllowed: false as const,
    realOrderCount: 0 as const,
    realCancelCount: 0 as const,
    privateTradingApiCount: 0 as const,
  };
}
