import { TRADING_RISK_POLICY, type RiskDataStatus, type RiskEngineInput, type RiskEngineResult } from './trading-risk-engine.service';
import type { PaperRiskState, PaperTradingState, PaperOrderRequest, PaperMarketData, PaperSide, PaperContractRules, PlacePaperOrderAction, PaperOrderStatus, PaperOrder } from './paper-trading.types';

export class PaperTradingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PaperTradingError';
  }
}

export const MODE = 'paper-only' as const;
export const MAX_PROCESSED_EVENTS = 500;
export const MARKET_FRESHNESS_MS = 60_000;
export const CONTRACT_FRESHNESS_MS = 20 * 60_000;
export const EPSILON = 1e-8;

export const unique = <T>(values: T[]) => [...new Set(values)];
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const positive = (value: unknown): value is number => finite(value) && value > 0;
export const nonNegative = (value: unknown): value is number => finite(value) && value >= 0;
export const safeNumber = (value: number) => Number.isFinite(value) ? value : 0;

export function cloneState(state: PaperTradingState): PaperTradingState {
  return JSON.parse(JSON.stringify(state)) as PaperTradingState;
}

export function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createId(prefix: string, seed: string) {
  return `${prefix}_${stableHash(seed)}`;
}

export function toIso(value: string | undefined, fallback: Date) {
  if (!value) return fallback.toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new PaperTradingError('INVALID_TIMESTAMP', '시각 값이 올바르지 않습니다.');
  return new Date(timestamp).toISOString();
}

export function dayKey(at: Date) {
  return at.toISOString().slice(0, 10);
}

export function weekKey(at: Date) {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function normalizedRiskState(state: PaperRiskState, at: Date): PaperRiskState {
  const currentDay = dayKey(at);
  const currentWeek = weekKey(at);
  return {
    dayKey: currentDay,
    weekKey: currentWeek,
    dailyRealizedPnl: state.dayKey === currentDay ? state.dailyRealizedPnl : 0,
    weeklyRealizedPnl: state.weekKey === currentWeek ? state.weeklyRealizedPnl : 0,
    consecutiveLosses: state.consecutiveLosses,
  };
}

export function createPaperTradingState(initialBalance = 10_000, now = new Date()): PaperTradingState {
  if (!positive(initialBalance)) {
    throw new PaperTradingError('INVALID_INITIAL_BALANCE', '초기 자본은 0보다 커야 합니다.');
  }
  const at = now.toISOString();
  return {
    schemaVersion: 1,
    account: {
      id: createId('paper_account', at),
      initialBalance,
      cashBalance: initialBalance,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: initialBalance,
      usedMargin: 0,
      availableMargin: initialBalance,
      createdAt: at,
      updatedAt: at,
    },
    orders: [],
    positions: [],
    fills: [],
    journal: [],
    riskState: {
      dayKey: dayKey(now),
      weekKey: weekKey(now),
      dailyRealizedPnl: 0,
      weeklyRealizedPnl: 0,
      consecutiveLosses: 0,
    },
    processedEventIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

export function validateEventId(eventId: string) {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(eventId)) {
    throw new PaperTradingError('INVALID_EVENT_ID', '이벤트 ID 형식이 올바르지 않습니다.');
  }
}

export function markEvent(state: PaperTradingState, eventId: string) {
  state.processedEventIds = [...state.processedEventIds, eventId].slice(-MAX_PROCESSED_EVENTS);
}

export function isFresh(updatedAt: string, now: Date, limitMs: number) {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && now.getTime() >= timestamp && now.getTime() - timestamp <= limitMs;
}

export function validateState(state: PaperTradingState) {
  if (!state || state.schemaVersion !== 1 || !state.account) {
    throw new PaperTradingError('INVALID_PAPER_STATE', '모의거래 상태 형식이 올바르지 않습니다.');
  }
  const accountNumbers = [
    state.account.initialBalance,
    state.account.cashBalance,
    state.account.realizedPnl,
    state.account.unrealizedPnl,
    state.account.equity,
    state.account.usedMargin,
    state.account.availableMargin,
  ];
  if (accountNumbers.some((value) => !finite(value)) || !(state.account.initialBalance > 0)) {
    throw new PaperTradingError('INVALID_PAPER_STATE', '모의계좌 계산값이 올바르지 않습니다.');
  }
  if (!Array.isArray(state.orders) || !Array.isArray(state.positions) || !Array.isArray(state.fills) || !Array.isArray(state.journal)) {
    throw new PaperTradingError('INVALID_PAPER_STATE', '모의거래 목록 형식이 올바르지 않습니다.');
  }
}

export function validateOrderRequest(request: PaperOrderRequest) {
  const symbol = String(request.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) {
    throw new PaperTradingError('INVALID_SYMBOL', '종목 형식이 올바르지 않습니다.');
  }
  if (!['long', 'short'].includes(request.side)) {
    throw new PaperTradingError('INVALID_SIDE', '롱·숏 방향이 올바르지 않습니다.');
  }
  if (!['market', 'limit', 'stop_market'].includes(request.orderType)) {
    throw new PaperTradingError('INVALID_ORDER_TYPE', '모의주문 유형이 올바르지 않습니다.');
  }
  if (!positive(request.leverage) || !positive(request.stopLossPrice)) {
    throw new PaperTradingError('INVALID_ORDER_INPUT', '레버리지와 손절가는 0보다 커야 합니다.');
  }
  if (request.orderType === 'limit' && !positive(request.requestedPrice)) {
    throw new PaperTradingError('INVALID_LIMIT_PRICE', '지정가 모의주문에는 지정가가 필요합니다.');
  }
  if (request.orderType === 'stop_market' && !positive(request.triggerPrice)) {
    throw new PaperTradingError('INVALID_TRIGGER_PRICE', '스탑 시장가 모의주문에는 트리거 가격이 필요합니다.');
  }
  if (request.quantity != null && !positive(request.quantity)) {
    throw new PaperTradingError('INVALID_QUANTITY', '수량은 0보다 커야 합니다.');
  }
  for (const target of [request.takeProfitPrice1, request.takeProfitPrice2]) {
    if (target != null && !positive(target)) {
      throw new PaperTradingError('INVALID_TARGET_PRICE', '목표가는 0보다 커야 합니다.');
    }
  }
  const percent1 = request.targetClosePercent1 ?? (request.takeProfitPrice2 != null ? 50 : 100);
  const percent2 = request.targetClosePercent2 ?? (request.takeProfitPrice2 != null ? 50 : 0);
  if (!nonNegative(percent1) || !nonNegative(percent2) || percent1 > 100 || percent2 > 100 || percent1 + percent2 > 100 + EPSILON) {
    throw new PaperTradingError('INVALID_TARGET_ALLOCATION', '목표가별 청산 비율 합계는 100%를 넘을 수 없습니다.');
  }
  return {
    ...request,
    symbol,
    targetClosePercent1: percent1,
    targetClosePercent2: percent2,
  };
}

export function referencePrice(market: PaperMarketData, side: PaperSide, warnings: string[]) {
  const preferred = side === 'long' ? market.askPrice : market.bidPrice;
  if (positive(preferred)) return preferred;
  const fallback = [market.markPrice, market.price, market.lastPrice].find(positive) ?? null;
  if (fallback != null) {
    warnings.push('실제 호가를 확인하지 못해 기준가격과 슬리피지로 모의체결했습니다.');
    return fallback;
  }
  return null;
}

export function adverseFillPrice(reference: number, side: PaperSide, slippageRate: number, phase: 'entry' | 'exit') {
  const buy = (side === 'long' && phase === 'entry') || (side === 'short' && phase === 'exit');
  const value = buy ? reference * (1 + slippageRate) : reference * (1 - slippageRate);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

export function limitFillPrice(reference: number, limit: number, side: PaperSide, slippageRate: number) {
  const adverse = adverseFillPrice(reference, side, slippageRate, 'entry');
  return side === 'long' ? Math.min(limit, adverse) : Math.max(limit, adverse);
}

export function expectedEntry(
  request: ReturnType<typeof validateOrderRequest>,
  market: PaperMarketData,
  warnings: string[],
  slippageRate: number,
) {
  const currentReference = referencePrice(market, request.side, warnings);
  if (request.orderType === 'market') {
    return {
      reference: currentReference,
      fill: currentReference == null ? null : adverseFillPrice(currentReference, request.side, slippageRate, 'entry'),
      shouldFill: currentReference != null,
    };
  }
  if (request.orderType === 'limit') {
    const limit = request.requestedPrice as number;
    const shouldFill = currentReference != null && (request.side === 'long' ? currentReference <= limit : currentReference >= limit);
    const reference = shouldFill && currentReference != null ? currentReference : limit;
    return {
      reference,
      fill: limitFillPrice(reference, limit, request.side, slippageRate),
      shouldFill,
    };
  }
  const trigger = request.triggerPrice as number;
  const shouldFill = currentReference != null && (request.side === 'long' ? currentReference >= trigger : currentReference <= trigger);
  const reference = shouldFill && currentReference != null ? currentReference : trigger;
  return {
    reference,
    fill: adverseFillPrice(reference, request.side, slippageRate, 'entry'),
    shouldFill,
  };
}

export function openExposure(state: PaperTradingState) {
  return state.positions
    .filter((position) => position.status !== 'closed')
    .reduce((sum, position) => sum + position.notionalValue, 0);
}

export function sameDirectionExposure(state: PaperTradingState, side: PaperSide) {
  return state.positions
    .filter((position) => position.status !== 'closed' && position.side === side)
    .reduce((sum, position) => sum + position.notionalValue, 0);
}

export function hasDuplicateSymbol(state: PaperTradingState, symbol: string) {
  return state.positions.some((position) => position.symbol === symbol && position.status !== 'closed')
    || state.orders.some((order) => order.symbol === symbol && order.status === 'pending');
}

export function buildRiskInput(
  state: PaperTradingState,
  request: ReturnType<typeof validateOrderRequest>,
  market: PaperMarketData,
  rules: PaperContractRules,
  supplied: RiskEngineInput,
  entryPrice: number,
  now: Date,
): RiskEngineInput {
  const marketStatus: RiskDataStatus = market.status === 'live' && isFresh(market.updatedAt, now, MARKET_FRESHNESS_MS)
    ? 'live'
    : 'delayed';
  const rulesStatus: RiskDataStatus = rules.status === 'live' && isFresh(rules.updatedAt, now, CONTRACT_FRESHNESS_MS)
    ? 'live'
    : 'delayed';
  return {
    ...supplied,
    market: 'crypto-futures',
    symbol: request.symbol,
    side: request.side,
    accountBalance: state.account.equity,
    entryPrice,
    stopLossPrice: request.stopLossPrice,
    targetPrice1: request.takeProfitPrice1,
    targetPrice2: request.takeProfitPrice2,
    leverage: request.leverage,
    quantityStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    minimumQuantity: rules.minimumQuantity,
    minimumNotional: rules.minimumNotional,
    maintenanceMarginRate: rules.maintenanceMarginRate,
    maximumLeverage: rules.maximumLeverage,
    appMaximumLeverage: TRADING_RISK_POLICY.cryptoFuturesAppMaximumLeverage,
    contractRulesStatus: rulesStatus,
    dailyRealizedPnl: state.riskState.dailyRealizedPnl,
    weeklyRealizedPnl: state.riskState.weeklyRealizedPnl,
    consecutiveLosses: state.riskState.consecutiveLosses,
    openExposure: openExposure(state),
    sameDirectionExposure: sameDirectionExposure(state, request.side),
    dataStatus: marketStatus,
    estimatedFundingRate: finite(market.fundingRate) ? market.fundingRate : supplied.estimatedFundingRate,
  };
}

export function makeOrder(
  action: PlacePaperOrderAction,
  request: ReturnType<typeof validateOrderRequest>,
  reference: number | null,
  expectedFill: number | null,
  riskResult: RiskEngineResult | null,
  quantity: number,
  status: PaperOrderStatus,
  rejectionCodes: string[],
  warnings: string[],
  at: string,
): PaperOrder {
  return {
    id: createId('paper_order', action.eventId),
    symbol: request.symbol,
    side: request.side,
    orderType: request.orderType,
    status,
    requestedPrice: request.requestedPrice ?? null,
    triggerPrice: request.triggerPrice ?? null,
    quantity,
    leverage: request.leverage,
    stopLossPrice: request.stopLossPrice,
    takeProfitPrice1: request.takeProfitPrice1 ?? null,
    takeProfitPrice2: request.takeProfitPrice2 ?? null,
    submittedAt: at,
    filledAt: null,
    cancelledAt: null,
    rejectionCodes: unique(rejectionCodes),
    warnings: unique(warnings),
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    idempotencyKey: action.eventId,
    referencePrice: reference,
    expectedFillPrice: expectedFill,
    riskResult,
    entryFeeRate: action.riskInput.entryFeeRate,
    exitFeeRate: action.riskInput.exitFeeRate,
    slippageRate: action.riskInput.slippageRate,
    fundingRatePerInterval: finite(action.market.fundingRate)
      ? action.market.fundingRate
      : action.riskInput.estimatedFundingRate,
    fundingIntervalHours: 8,
    targetClosePercent1: request.targetClosePercent1 as number,
    targetClosePercent2: request.targetClosePercent2 as number,
    strategyName: String(request.strategyName ?? 'manual').slice(0, 80),
    dataStatusAtSubmission: action.market.status,
    contractRulesStatusAtSubmission: action.contractRules.status,
    marketRegimeAtSubmission: String(request.marketRegime ?? 'unknown').slice(0, 80),
  };
}
