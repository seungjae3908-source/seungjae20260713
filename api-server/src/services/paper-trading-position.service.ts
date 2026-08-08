import { calculateTradingRisk, floorQuantityToRules, type RiskEngineResult } from './trading-risk-engine.service';
import type { CancelPaperOrderAction, MarkPaperPriceAction, PaperFill, PaperFillReason, PaperJournalEntry, PaperOrder, PaperOrderStatus, PaperPosition, PaperTradingActionResult, PaperTradingState, PlacePaperOrderAction } from './paper-trading.types';
import {
  EPSILON, MODE, PaperTradingError, adverseFillPrice, buildRiskInput, createId, expectedEntry, finite,
  hasDuplicateSymbol, makeOrder, positive, referencePrice, safeNumber, toIso, unique, validateOrderRequest,
} from './paper-trading-core.service';

export function transitionPaperOrder(order: PaperOrder, next: PaperOrderStatus, at: string) {
  const allowed: Record<PaperOrderStatus, PaperOrderStatus[]> = {
    pending: ['filled', 'cancelled', 'rejected', 'expired'],
    filled: [],
    cancelled: [],
    rejected: [],
    expired: [],
  };
  if (!allowed[order.status].includes(next)) {
    throw new PaperTradingError('INVALID_ORDER_TRANSITION', `${order.status} 주문은 ${next} 상태로 변경할 수 없습니다.`);
  }
  order.status = next;
  if (next === 'filled') order.filledAt = at;
  if (next === 'cancelled') order.cancelledAt = at;
}

export function recalculateAccount(state: PaperTradingState, at: string) {
  let unrealized = 0;
  let usedMargin = 0;
  for (const position of state.positions) {
    if (position.status === 'closed' || position.remainingQuantity <= EPSILON) continue;
    const pricePnl = position.side === 'long'
      ? (position.currentPrice - position.entryPrice) * position.remainingQuantity
      : (position.entryPrice - position.currentPrice) * position.remainingQuantity;
    position.unrealizedPnl = safeNumber(pricePnl);
    position.notionalValue = safeNumber(position.currentPrice * position.remainingQuantity);
    position.requiredMargin = safeNumber(position.entryPrice * position.remainingQuantity / position.leverage);
    unrealized += position.unrealizedPnl;
    usedMargin += position.requiredMargin;
  }
  state.account.unrealizedPnl = safeNumber(unrealized);
  state.account.usedMargin = safeNumber(usedMargin);
  state.account.equity = safeNumber(state.account.cashBalance + state.account.unrealizedPnl);
  state.account.availableMargin = safeNumber(state.account.equity - state.account.usedMargin);
  state.account.updatedAt = at;
  state.updatedAt = at;
}

export function createPositionFromOrder(
  state: PaperTradingState,
  order: PaperOrder,
  reference: number,
  fillPrice: number,
  reason: Extract<PaperFillReason, 'market' | 'limit' | 'stop_trigger'>,
  eventSeed: string,
  at: string,
): { position: PaperPosition; fill: PaperFill } {
  if (!positive(fillPrice) || !positive(reference) || !positive(order.quantity)) {
    throw new PaperTradingError('INVALID_FILL', '모의체결 계산값이 올바르지 않습니다.');
  }
  if (hasDuplicateSymbol({ ...state, orders: state.orders.filter((item) => item.id !== order.id) }, order.symbol)) {
    order.rejectionCodes = unique([...order.rejectionCodes, 'DUPLICATE_SYMBOL_POSITION']);
    transitionPaperOrder(order, 'rejected', at);
    throw new PaperTradingError('DUPLICATE_SYMBOL_POSITION', '동일 종목의 중복 포지션 또는 대기 주문이 있습니다.');
  }
  const notional = fillPrice * order.quantity;
  const requiredMargin = notional / order.leverage;
  const entryFee = notional * order.entryFeeRate;
  if (!finite(requiredMargin) || requiredMargin + entryFee > state.account.availableMargin + EPSILON) {
    order.rejectionCodes = unique([...order.rejectionCodes, 'INSUFFICIENT_MARGIN']);
    transitionPaperOrder(order, 'rejected', at);
    throw new PaperTradingError('INSUFFICIENT_MARGIN', '사용 가능 증거금이 부족합니다.');
  }
  const slippageCost = Math.abs(fillPrice - reference) * order.quantity;
  const positionId = createId('paper_position', order.id);
  const position: PaperPosition = {
    id: positionId,
    symbol: order.symbol,
    side: order.side,
    entryPrice: fillPrice,
    currentPrice: reference,
    quantity: order.quantity,
    remainingQuantity: order.quantity,
    leverage: order.leverage,
    notionalValue: reference * order.quantity,
    requiredMargin,
    stopLossPrice: order.stopLossPrice,
    takeProfitPrice1: order.takeProfitPrice1 ?? null,
    takeProfitPrice2: order.takeProfitPrice2 ?? null,
    unrealizedPnl: order.side === 'long'
      ? (reference - fillPrice) * order.quantity
      : (fillPrice - reference) * order.quantity,
    realizedPnl: -entryFee - slippageCost,
    totalFees: entryFee,
    totalSlippage: slippageCost,
    totalFunding: 0,
    openedAt: at,
    closedAt: null,
    status: 'open',
    orderId: order.id,
    entryReferencePrice: reference,
    initialRequiredMargin: requiredMargin,
    initialRiskAmount: order.riskResult?.estimatedMaximumLoss ?? 0,
    entryFee,
    entrySlippageCost: slippageCost,
    exitFeeRate: order.exitFeeRate,
    slippageRate: order.slippageRate,
    fundingRatePerInterval: order.fundingRatePerInterval,
    fundingIntervalHours: order.fundingIntervalHours,
    targetClosePercent1: order.targetClosePercent1,
    targetClosePercent2: order.targetClosePercent2,
    target1Executed: false,
    target2Executed: false,
    strategyName: order.strategyName,
    maximumFavorableExcursion: 0,
    maximumAdverseExcursion: Math.max(0, slippageCost),
    dataStatusAtEntry: order.dataStatusAtSubmission,
    marketRegimeAtEntry: order.marketRegimeAtSubmission,
    warnings: [...order.warnings],
  };
  const fill: PaperFill = {
    id: createId('paper_fill', `${eventSeed}:entry`),
    orderId: order.id,
    positionId,
    price: fillPrice,
    quantity: order.quantity,
    grossValue: fillPrice * order.quantity,
    fee: entryFee,
    slippageCost,
    fundingCost: 0,
    filledAt: at,
    fillReason: reason,
    side: order.side,
    referencePrice: reference,
    grossPnl: 0,
    netPnl: -entryFee - slippageCost,
  };
  transitionPaperOrder(order, 'filled', at);
  state.account.cashBalance -= entryFee;
  state.account.realizedPnl -= entryFee;
  state.positions.push(position);
  state.fills.push(fill);
  recalculateAccount(state, at);
  return { position, fill };
}

export function evaluatePlacePaperOrder(state: PaperTradingState, action: PlacePaperOrderAction, now: Date): PaperTradingActionResult {
  const at = now.toISOString();
  const request = validateOrderRequest(action.request);
  const warnings = unique([
    ...(action.market.warnings ?? []),
    ...(action.contractRules.warnings ?? []),
  ]);

  const entry = expectedEntry(request, action.market, warnings, action.riskInput.slippageRate);

  const rejectionCodes: string[] = [];
  if (hasDuplicateSymbol(state, request.symbol)) rejectionCodes.push('DUPLICATE_SYMBOL_POSITION');
  if (!entry.reference || !entry.fill || !positive(entry.fill)) rejectionCodes.push('MARKET_PRICE_UNAVAILABLE');

  let riskResult: RiskEngineResult | null = null;
  let quantity = 0;
  if (entry.fill != null && positive(entry.fill)) {
    const riskInput = buildRiskInput(state, request, action.market, action.contractRules, action.riskInput, entry.fill, now);
    riskResult = calculateTradingRisk(riskInput, now);
    rejectionCodes.push(...riskResult.blockCodes);
    warnings.push(...riskResult.warnings);
    const recommended = riskResult.recommendedQuantity ?? 0;
    quantity = request.quantity == null
      ? recommended
      : floorQuantityToRules(request.quantity, action.contractRules.quantityStep, action.contractRules.quantityPrecision);
    if (request.quantity != null && quantity > recommended + EPSILON) {
      rejectionCodes.push('REQUESTED_QUANTITY_EXCEEDS_RISK');
    }
    if (!positive(quantity)) rejectionCodes.push('INVALID_QUANTITY');
    const requiredMargin = entry.fill * quantity / request.leverage;
    const entryFee = entry.fill * quantity * action.riskInput.entryFeeRate;
    if (!finite(requiredMargin) || requiredMargin + entryFee > state.account.availableMargin + EPSILON) {
      rejectionCodes.push('INSUFFICIENT_MARGIN');
    }
  }

  const rejected = rejectionCodes.length > 0 || !riskResult?.allowed;
  const order = makeOrder(
    action,
    request,
    entry.reference,
    entry.fill,
    riskResult,
    quantity,
    rejected ? 'rejected' : 'pending',
    rejectionCodes,
    warnings,
    at,
  );
  state.orders.push(order);

  const fills: PaperFill[] = [];
  let position: PaperPosition | null = null;
  if (!rejected && entry.shouldFill && entry.reference != null && entry.fill != null) {
    const fillReason = request.orderType === 'market'
      ? 'market'
      : request.orderType === 'limit'
        ? 'limit'
        : 'stop_trigger';
    const opened = createPositionFromOrder(state, order, entry.reference, entry.fill, fillReason, action.eventId, at);
    position = opened.position;
    fills.push(opened.fill);
  }

  return {
    ok: true,
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    state,
    order,
    position,
    fills,
    warnings: unique([...warnings, ...order.warnings]),
    duplicateEvent: false,
  };
}

function fundingCost(position: PaperPosition, quantity: number, at: string) {
  const elapsedHours = Math.max(0, (Date.parse(at) - Date.parse(position.openedAt)) / 3_600_000);
  const periods = position.fundingIntervalHours > 0 ? elapsedHours / position.fundingIntervalHours : 0;
  const signed = position.entryReferencePrice * quantity * position.fundingRatePerInterval * periods;
  return position.side === 'long' ? signed : -signed;
}

export function updateExcursions(position: PaperPosition, high: number, low: number) {
  if (![high, low].every(finite)) return;
  const favorable = position.side === 'long'
    ? Math.max(0, (high - position.entryReferencePrice) * position.remainingQuantity)
    : Math.max(0, (position.entryReferencePrice - low) * position.remainingQuantity);
  const adverse = position.side === 'long'
    ? Math.max(0, (position.entryReferencePrice - low) * position.remainingQuantity)
    : Math.max(0, (high - position.entryReferencePrice) * position.remainingQuantity);
  position.maximumFavorableExcursion = Math.max(position.maximumFavorableExcursion, favorable);
  position.maximumAdverseExcursion = Math.max(position.maximumAdverseExcursion, adverse);
}

function upsertJournal(
  state: PaperTradingState,
  position: PaperPosition,
  order: PaperOrder,
  fill: PaperFill,
  exitReason: PaperFillReason,
) {
  let entry = state.journal.find((item) => item.positionId === position.id);
  if (!entry) {
    entry = {
      id: createId('paper_journal', position.id),
      tradeId: createId('paper_trade', position.id),
      orderId: order.id,
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      orderType: order.orderType,
      strategyName: position.strategyName,
      submittedAt: order.submittedAt,
      filledAt: order.filledAt ?? position.openedAt,
      closedAt: position.closedAt,
      entryPrice: position.entryPrice,
      entryReferencePrice: position.entryReferencePrice,
      stopLossPrice: position.stopLossPrice,
      takeProfitPrice1: position.takeProfitPrice1 ?? null,
      takeProfitPrice2: position.takeProfitPrice2 ?? null,
      exitPrice: fill.price,
      initialQuantity: position.quantity,
      closedQuantity: fill.quantity,
      remainingQuantity: position.remainingQuantity,
      leverage: position.leverage,
      notionalValue: position.entryReferencePrice * position.quantity,
      requiredMargin: position.initialRequiredMargin,
      entryFee: position.entryFee,
      exitFee: fill.fee,
      slippageCost: position.entrySlippageCost + fill.slippageCost,
      fundingCost: fill.fundingCost,
      grossPnl: fill.grossPnl,
      netPnl: position.realizedPnl,
      rMultiple: position.initialRiskAmount > 0 ? position.realizedPnl / position.initialRiskAmount : null,
      maximumFavorableExcursion: position.maximumFavorableExcursion,
      maximumAdverseExcursion: position.maximumAdverseExcursion,
      exitReason,
      dataStatusAtEntry: position.dataStatusAtEntry,
      marketRegimeAtEntry: position.marketRegimeAtEntry,
      riskBlocked: false,
      warnings: unique(position.warnings),
      ruleViolation: false,
      status: position.status,
      note: '',
    };
    state.journal.push(entry);
  } else {
    entry.closedAt = position.closedAt;
    entry.exitPrice = fill.price;
    entry.closedQuantity += fill.quantity;
    entry.remainingQuantity = position.remainingQuantity;
    entry.exitFee += fill.fee;
    entry.slippageCost += fill.slippageCost;
    entry.fundingCost += fill.fundingCost;
    entry.grossPnl += fill.grossPnl;
    entry.netPnl = position.realizedPnl;
    entry.rMultiple = position.initialRiskAmount > 0 ? position.realizedPnl / position.initialRiskAmount : null;
    entry.maximumFavorableExcursion = position.maximumFavorableExcursion;
    entry.maximumAdverseExcursion = position.maximumAdverseExcursion;
    entry.exitReason = exitReason;
    entry.status = position.status;
    entry.warnings = unique([...entry.warnings, ...position.warnings]);
  }
}

export function closePositionInternal(
  state: PaperTradingState,
  position: PaperPosition,
  quantity: number,
  reference: number,
  reason: PaperFillReason,
  eventSeed: string,
  at: string,
): PaperFill {
  if (position.status === 'closed' || position.remainingQuantity <= EPSILON) {
    throw new PaperTradingError('POSITION_ALREADY_CLOSED', '이미 종료된 포지션입니다.');
  }
  if (!positive(quantity) || quantity > position.remainingQuantity + EPSILON) {
    throw new PaperTradingError('INVALID_CLOSE_QUANTITY', '청산 수량이 올바르지 않습니다.');
  }
  if (!positive(reference)) {
    throw new PaperTradingError('MARKET_PRICE_UNAVAILABLE', '청산 기준가격을 확인할 수 없습니다.');
  }
  const actualQuantity = Math.min(quantity, position.remainingQuantity);
  const fillPrice = adverseFillPrice(reference, position.side, position.slippageRate, 'exit');
  if (!positive(fillPrice)) throw new PaperTradingError('INVALID_FILL', '청산 모의체결 가격이 올바르지 않습니다.');

  const referenceGrossPnl = position.side === 'long'
    ? (reference - position.entryReferencePrice) * actualQuantity
    : (position.entryReferencePrice - reference) * actualQuantity;
  const fillGrossPnl = position.side === 'long'
    ? (fillPrice - position.entryPrice) * actualQuantity
    : (position.entryPrice - fillPrice) * actualQuantity;
  const exitFee = fillPrice * actualQuantity * position.exitFeeRate;
  const exitSlippage = Math.abs(fillPrice - reference) * actualQuantity;
  const entryFeeAllocation = position.entryFee * (actualQuantity / position.quantity);
  const entrySlippageAllocation = position.entrySlippageCost * (actualQuantity / position.quantity);
  const funding = fundingCost(position, actualQuantity, at);
  const netForJournal = referenceGrossPnl - entryFeeAllocation - exitFee - entrySlippageAllocation - exitSlippage - funding;
  const cashChange = fillGrossPnl - exitFee - funding;

  position.remainingQuantity = Math.max(0, position.remainingQuantity - actualQuantity);
  position.currentPrice = reference;
  position.realizedPnl += referenceGrossPnl - exitFee - exitSlippage - funding;
  position.totalFees += exitFee;
  position.totalSlippage += exitSlippage;
  position.totalFunding += funding;
  position.status = position.remainingQuantity <= EPSILON ? 'closed' : 'partially_closed';
  if (position.status === 'closed') {
    position.remainingQuantity = 0;
    position.unrealizedPnl = 0;
    position.closedAt = at;
  }

  state.account.cashBalance += cashChange;
  state.account.realizedPnl += cashChange;
  state.riskState.dailyRealizedPnl += netForJournal;
  state.riskState.weeklyRealizedPnl += netForJournal;

  const fill: PaperFill = {
    id: createId('paper_fill', `${eventSeed}:${reason}:${state.fills.length}`),
    orderId: position.orderId,
    positionId: position.id,
    price: fillPrice,
    quantity: actualQuantity,
    grossValue: fillPrice * actualQuantity,
    fee: exitFee,
    slippageCost: exitSlippage,
    fundingCost: funding,
    filledAt: at,
    fillReason: reason,
    side: position.side,
    referencePrice: reference,
    grossPnl: referenceGrossPnl,
    netPnl: netForJournal,
  };
  state.fills.push(fill);
  const order = state.orders.find((item) => item.id === position.orderId);
  if (!order) throw new PaperTradingError('ORDER_NOT_FOUND', '포지션의 원본 주문을 찾을 수 없습니다.');
  upsertJournal(state, position, order, fill, reason);

  if (position.status === 'closed') {
    state.riskState.consecutiveLosses = position.realizedPnl < 0
      ? state.riskState.consecutiveLosses + 1
      : 0;
  }
  recalculateAccount(state, at);
  return fill;
}

export function cancelOrder(state: PaperTradingState, action: CancelPaperOrderAction, now: Date): PaperTradingActionResult {
  const at = toIso(action.at, now);
  const order = state.orders.find((item) => item.id === action.orderId);
  if (!order) throw new PaperTradingError('ORDER_NOT_FOUND', '취소할 모의주문을 찾을 수 없습니다.');
  transitionPaperOrder(order, 'cancelled', at);
  state.updatedAt = at;
  return {
    ok: true,
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    state,
    order,
    position: null,
    fills: [],
    warnings: [],
    duplicateEvent: false,
  };
}

export function markPrice(state: PaperTradingState, action: MarkPaperPriceAction, now: Date): PaperTradingActionResult {
  if (!positive(action.price)) throw new PaperTradingError('INVALID_MARK_PRICE', '현재가는 0보다 커야 합니다.');
  const at = toIso(action.at, now);
  for (const position of state.positions) {
    if (position.symbol !== action.symbol || position.status === 'closed') continue;
    position.currentPrice = action.price;
    updateExcursions(position, action.price, action.price);
  }
  recalculateAccount(state, at);
  return {
    ok: true,
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    state,
    order: null,
    position: null,
    fills: [],
    warnings: [],
    duplicateEvent: false,
  };
}
