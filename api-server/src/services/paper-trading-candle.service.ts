import { floorQuantityToRules } from './trading-risk-engine.service';
import type { ClosePaperPositionAction, PaperCandle, PaperFill, PaperFillReason, PaperOrder, PaperPosition, PaperTradingActionResult, PaperTradingState, ProcessPaperCandleAction } from './paper-trading.types';
import { EPSILON, MARKET_FRESHNESS_MS, MODE, PaperTradingError, adverseFillPrice, finite, isFresh, limitFillPrice, positive, referencePrice, toIso, unique } from './paper-trading-core.service';
import { closePositionInternal, createPositionFromOrder, recalculateAccount, updateExcursions } from './paper-trading-position.service';

function pendingOrderTrigger(order: PaperOrder, candle: PaperCandle) {
  if (order.orderType === 'limit') {
    const limit = order.requestedPrice as number;
    const triggered = order.side === 'long' ? candle.low <= limit : candle.high >= limit;
    if (!triggered) return null;
    const reference = order.side === 'long'
      ? (candle.open <= limit ? candle.open : limit)
      : (candle.open >= limit ? candle.open : limit);
    return { reference, fill: limitFillPrice(reference, limit, order.side, order.slippageRate), reason: 'limit' as const };
  }
  if (order.orderType === 'stop_market') {
    const trigger = order.triggerPrice as number;
    const triggered = order.side === 'long' ? candle.high >= trigger : candle.low <= trigger;
    if (!triggered) return null;
    const reference = order.side === 'long'
      ? (candle.open >= trigger ? candle.open : trigger)
      : (candle.open <= trigger ? candle.open : trigger);
    return { reference, fill: adverseFillPrice(reference, order.side, order.slippageRate, 'entry'), reason: 'stop_trigger' as const };
  }
  return null;
}

function stopReference(position: PaperPosition, candle: PaperCandle) {
  return position.side === 'long'
    ? (candle.open <= position.stopLossPrice ? candle.open : position.stopLossPrice)
    : (candle.open >= position.stopLossPrice ? candle.open : position.stopLossPrice);
}

function targetReference(position: PaperPosition, candle: PaperCandle, target: number) {
  return position.side === 'long'
    ? (candle.open >= target ? candle.open : target)
    : (candle.open <= target ? candle.open : target);
}

export function processCandle(state: PaperTradingState, action: ProcessPaperCandleAction, now: Date): PaperTradingActionResult {
  const candle = action.candle;
  if (!candle.isClosed) throw new PaperTradingError('CANDLE_NOT_CLOSED', '완료된 캔들만 모의체결에 사용할 수 있습니다.');
  if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(finite)
    || !(candle.timestamp > 0) || !(candle.low > 0) || candle.low > candle.high
    || candle.open < candle.low || candle.open > candle.high || candle.close < candle.low || candle.close > candle.high) {
    throw new PaperTradingError('INVALID_CANDLE', '완료 캔들 값이 올바르지 않습니다.');
  }
  const at = new Date(candle.timestamp).toISOString();
  const fills: PaperFill[] = [];
  const openedPositionIds = new Set<string>();
  let lastOrder: PaperOrder | null = null;
  let lastPosition: PaperPosition | null = null;

  for (const order of state.orders.filter((item) => item.status === 'pending' && item.symbol === candle.symbol)) {
    const trigger = pendingOrderTrigger(order, candle);
    if (!trigger) continue;
    try {
      const opened = createPositionFromOrder(state, order, trigger.reference, trigger.fill, trigger.reason, `${action.eventId}:${order.id}`, at);
      fills.push(opened.fill);
      openedPositionIds.add(opened.position.id);
      lastOrder = order;
      lastPosition = opened.position;
    } catch (error) {
      if (!(error instanceof PaperTradingError)) throw error;
      order.rejectionCodes = unique([...order.rejectionCodes, error.code]);
      order.warnings = unique([...order.warnings, error.message]);
      lastOrder = order;
    }
  }

  for (const position of state.positions.filter((item) => item.status !== 'closed' && item.symbol === candle.symbol)) {
    position.currentPrice = candle.close;
    updateExcursions(position, candle.high, candle.low);
    if (openedPositionIds.has(position.id)) continue;

    const stopHit = position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;
    const target1 = position.takeProfitPrice1 ?? null;
    const target2 = position.takeProfitPrice2 ?? null;
    const target1Hit = target1 != null && (position.side === 'long' ? candle.high >= target1 : candle.low <= target1);
    const target2Hit = target2 != null && (position.side === 'long' ? candle.high >= target2 : candle.low <= target2);

    if (stopHit) {
      fills.push(closePositionInternal(
        state,
        position,
        position.remainingQuantity,
        stopReference(position, candle),
        'stop_loss',
        `${action.eventId}:${position.id}:stop`,
        at,
      ));
      lastPosition = position;
      continue;
    }

    if (target1Hit && !position.target1Executed && position.remainingQuantity > EPSILON) {
      const targetQuantity = Math.min(
        position.remainingQuantity,
        floorQuantityToRules(position.quantity * position.targetClosePercent1 / 100, null, 8),
      );
      if (targetQuantity > EPSILON) {
        fills.push(closePositionInternal(
          state,
          position,
          targetQuantity,
          targetReference(position, candle, target1 as number),
          'take_profit',
          `${action.eventId}:${position.id}:tp1`,
          at,
        ));
      }
      position.target1Executed = true;
      lastPosition = position;
    }

    if (target2Hit && !position.target2Executed && position.remainingQuantity > EPSILON) {
      fills.push(closePositionInternal(
        state,
        position,
        position.remainingQuantity,
        targetReference(position, candle, target2 as number),
        'take_profit',
        `${action.eventId}:${position.id}:tp2`,
        at,
      ));
      position.target2Executed = true;
      lastPosition = position;
    }
  }

  recalculateAccount(state, at);
  return {
    ok: true,
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    state,
    order: lastOrder,
    position: lastPosition,
    fills,
    warnings: unique(action.market?.warnings ?? []),
    duplicateEvent: false,
  };
}

export function closePosition(state: PaperTradingState, action: ClosePaperPositionAction, now: Date): PaperTradingActionResult {
  const at = toIso(action.at, now);
  const position = state.positions.find((item) => item.id === action.positionId);
  if (!position) throw new PaperTradingError('POSITION_NOT_FOUND', '청산할 모의포지션을 찾을 수 없습니다.');
  if (action.market.status !== 'live' || !isFresh(action.market.updatedAt, now, MARKET_FRESHNESS_MS)) {
    throw new PaperTradingError('DATA_NOT_LIVE', '실시간 시장 데이터가 아니므로 모의청산을 처리하지 않습니다.');
  }
  const warnings = [...(action.market.warnings ?? [])];
  const reference = referencePrice(action.market, position.side === 'long' ? 'short' : 'long', warnings);
  if (reference == null) throw new PaperTradingError('MARKET_PRICE_UNAVAILABLE', '청산 기준가격을 확인할 수 없습니다.');
  let requestedQuantity: number = action.quantity ?? position.remainingQuantity;
  if (action.percentage != null) requestedQuantity = position.remainingQuantity * action.percentage / 100;
  const quantity = floorQuantityToRules(requestedQuantity, null, 8);
  const reason: PaperFillReason = quantity + EPSILON < position.remainingQuantity
    ? 'partial_close'
    : action.reason ?? 'manual_close';
  const fill = closePositionInternal(state, position, quantity, reference, reason, action.eventId, at);
  return {
    ok: true,
    mode: MODE,
    orderSubmitted: false,
    exchangeRequestSent: false,
    state,
    order: state.orders.find((item) => item.id === position.orderId) ?? null,
    position,
    fills: [fill],
    warnings: unique(warnings),
    duplicateEvent: false,
  };
}
